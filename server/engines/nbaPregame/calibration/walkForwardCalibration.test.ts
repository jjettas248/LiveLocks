// Run: npx tsx server/engines/nbaPregame/calibration/walkForwardCalibration.test.ts
// Pregame Targets PR4 — walk-forward calibration: strict as-of temporal isolation
// (a test that FAILS if future observations leak backward), per-market/model
// provenance, documented identity fallback for insufficient evidence, quality
// report by market+bucket, determinism.
import {
  calibrateProbability,
  calibrationQualityReport,
  DEFAULT_CALIBRATION_CONFIG,
  type CalibrationObservation,
} from "./walkForwardCalibration";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const CFG = { ...DEFAULT_CALIBRATION_CONFIG, minTotalSamples: 20, priorStrength: 5 };
const iso = (day: number) => `2026-02-${String(day).padStart(2, "0")}T12:00:00Z`;

// Build N observations for a market at rawProb p, `winRate` fraction wins, on `day`.
function obs(market: "points", p: number, winRate: number, n: number, day: number, modelVersion = "v1"): CalibrationObservation[] {
  const out: CalibrationObservation[] = [];
  const wins = Math.round(n * winRate);
  for (let i = 0; i < n; i++) {
    out.push({ market, modelVersion, rawProbability: p, outcome: i < wins ? 1 : 0, knownAt: iso(day) });
  }
  return out;
}

// ── Sufficient evidence: calibrated pulls the raw toward the empirical rate ──
{
  // 40 obs at rawProb 0.7 but only 50% actually won → calibrated < 0.7.
  const observations = obs("points", 0.7, 0.5, 40, 5);
  const res = calibrateProbability(observations, "points", "v1", 0.7, iso(10), CFG);
  ok(res.fallback === "none", "sufficient evidence → no fallback");
  ok(res.calibratedProbability < 0.7 && res.calibratedProbability > 0.5, "calibrated pulled from 0.7 toward the 0.5 empirical");
  ok(res.totalSamples === 40 && res.bucketSamples === 40, "reports in-window sample counts");
}

// ── Documented fallback: insufficient evidence → identity ───────────────────
{
  const observations = obs("points", 0.7, 0.5, 5, 5); // below minTotalSamples (20)
  const res = calibrateProbability(observations, "points", "v1", 0.7, iso(10), CFG);
  ok(res.fallback === "identity_insufficient_evidence", "insufficient evidence → documented identity fallback");
  ok(approx(res.calibratedProbability, 0.7), "fallback returns the raw probability unchanged");
}

// ── Invalid input → fail-closed identity ────────────────────────────────────
{
  const observations = obs("points", 0.7, 0.5, 40, 5);
  ok(calibrateProbability(observations, "points", "v1", 1.5, iso(10), CFG).fallback === "identity_invalid_input", "out-of-range raw → invalid_input");
  ok(calibrateProbability(observations, "points", "v1", NaN, iso(10), CFG).fallback === "identity_invalid_input", "NaN raw → invalid_input");
  ok(calibrateProbability(observations, "points", "v1", 0.7, "not-an-instant", CFG).fallback === "identity_invalid_input", "bad asOf → invalid_input");
}

// ── STRICT walk-forward isolation: a future observation must NOT leak back ───
{
  // 40 past obs at 0.7 with 50% win rate (as of day 10).
  const past = obs("points", 0.7, 0.5, 40, 5);
  const asOf = iso(10);
  const withoutFuture = calibrateProbability(past, "points", "v1", 0.7, asOf, CFG);
  // Add 400 FUTURE obs (day 20 > asOf 10) that all WON — if these leaked in, the
  // empirical rate (and calibrated value) would jump toward 1.0.
  const future = obs("points", 0.7, 1.0, 400, 20);
  const withFuture = calibrateProbability([...past, ...future], "points", "v1", 0.7, asOf, CFG);
  ok(withoutFuture.calibratedProbability === withFuture.calibratedProbability, "future observations (knownAt ≥ asOf) do NOT affect calibration — no leakage");
  ok(withFuture.totalSamples === 40, "training count excludes the 400 future observations");
  // Sanity: if we advance asOf PAST the future obs, they now count (proving the
  // isolation is temporal, not a filter bug that drops them forever).
  const later = calibrateProbability([...past, ...future], "points", "v1", 0.7, iso(25), CFG);
  ok(later.totalSamples === 440 && later.calibratedProbability > withFuture.calibratedProbability, "same obs DO count once as-of advances past them");
}

// ── Boundary: knownAt EXACTLY == asOf is excluded (strict <) ────────────────
{
  const sameInstant = obs("points", 0.7, 1.0, 40, 10); // knownAt == asOf day 10
  const res = calibrateProbability(sameInstant, "points", "v1", 0.7, iso(10), CFG);
  ok(res.fallback === "identity_insufficient_evidence" && res.totalSamples === 0, "knownAt == asOf is excluded (training must strictly precede)");
}

// ── Per-market / per-model provenance is preserved (never mixed) ─────────────
{
  const pts = obs("points", 0.7, 0.5, 40, 5, "v1");
  const ptsV2 = obs("points", 0.7, 1.0, 40, 5, "v2");
  const combined = [...pts, ...ptsV2];
  const v1 = calibrateProbability(combined, "points", "v1", 0.7, iso(10), CFG);
  const v2 = calibrateProbability(combined, "points", "v2", 0.7, iso(10), CFG);
  ok(v1.totalSamples === 40 && v2.totalSamples === 40, "model versions are not mixed");
  ok(v2.calibratedProbability > v1.calibratedProbability, "each model version calibrates on its own outcomes");
}

// ── Quality report by market + bucket ───────────────────────────────────────
{
  const observations = [
    ...obs("points", 0.75, 0.5, 40, 5), // bucket 7: predicted .75, empirical .5 → gap .25
    ...obs("points", 0.25, 0.25, 40, 5), // bucket 2: predicted .25, empirical .25 → gap 0
  ];
  const rep = calibrationQualityReport(observations, "points", "v1", iso(10), CFG);
  ok(rep.totalSamples === 80, "report counts all in-window obs");
  const b7 = rep.byBucket[7];
  ok(b7.count === 40 && approx(b7.meanPredicted, 0.75) && approx(b7.empiricalRate, 0.5), "bucket 7 predicted/empirical reported");
  ok(rep.expectedCalibrationError > 0.1, "ECE reflects the miscalibrated bucket");
  ok(rep.byBucket.length === CFG.numBuckets, "one entry per probability bucket");
}

// ── Determinism ─────────────────────────────────────────────────────────────
{
  const observations = obs("points", 0.6, 0.55, 60, 5);
  const a = calibrateProbability(observations, "points", "v1", 0.6, iso(10), CFG);
  const b = calibrateProbability(observations, "points", "v1", 0.6, iso(10), CFG);
  ok(JSON.stringify(a) === JSON.stringify(b), "calibration deterministic");
}

console.log(`\nwalkForwardCalibration.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
