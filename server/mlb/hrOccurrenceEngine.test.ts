// HR occurrence engine hotfix — invariants for the edge-decoupling /
// calibration-rail / pitcher-fade-only fixes (2026-06).
//   npx tsx server/mlb/hrOccurrenceEngine.test.ts
import { classifyBatterEvidenceQuality, OCCURRENCE_CEILING } from "./hrConversionModel";
import { deriveCanonicalPromotionIntent, clampPersistedCanonicalStage, type HRAlertSnapshot } from "./hrAlertEngine";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

// Minimal snapshot factory — deriveCanonicalPromotionIntent reads only a
// handful of fields; the rest are filled with inert defaults.
function snap(p: Partial<HRAlertSnapshot>): HRAlertSnapshot {
  return {
    isInitialized: true,
    currentState: "BET_NOW",
    canonicalStage: "attack",
    consecutivePromoteTicks: 5,
    pitcherHrVulnerability: 0,
    batterEvidenceQuality: "none",
    currentInning: 6,
    detectedInning: 6,
    // inert fillers
    detectedHalf: "top", detectedAtMs: 0, lastStateChangeAt: 0, dataFreshnessMs: 0,
    tickCount: 5, lastRecomputeAt: 0, decayFactor: 1, buildScore: null,
    hrReadinessScore: 0, peakReadinessScore: 0, hrConversionProbabilityRaw: 0,
    hrConversionProbabilityCalibrated: 0, hrOccurrenceProbability: 0,
    peakConversionProbability: 0, peakScore: 0, remainingPAExpectation: 0,
    positiveDrivers: [], negativeSuppressors: [], cooldownReason: null,
    peakState: "BET_NOW", peakAt: 0, alertResult: {} as any,
    ...p,
  } as HRAlertSnapshot;
}

const factors = (o: Record<string, number>): any => ({
  contactClasses: [], hrShapedCount: 0, missedHrCount: 0, eliteHrCount: 0,
  qualifiedEVMean: 0, maxDistance: 0, ...o,
});

console.log("\n=== HR Occurrence Engine — edge decouple / calibration rail / pitcher-fade ===\n");

// ── Fix 5/7 — calibration rail capped by batter evidence ──────────────────
eq("evidence none (no qualified contact)", classifyBatterEvidenceQuality(factors({})), "none");
eq("evidence fresh (1 HR-shaped)", classifyBatterEvidenceQuality(factors({ hrShapedCount: 1 })), "fresh");
eq("evidence elite (near-HR / missedHr)", classifyBatterEvidenceQuality(factors({ missedHrCount: 1 })), "elite");
eq("evidence elite (390ft+ blast)", classifyBatterEvidenceQuality(factors({ maxDistance: 405 })), "elite");
// #7 — convRaw 0.32 → 0.947 (empirical rail) cannot survive with no batter evidence.
const railedNoEvidence = Math.min(0.947, OCCURRENCE_CEILING[classifyBatterEvidenceQuality(factors({}))]);
eq("#7 convCal 0.947 capped to 0.35 with no batter evidence", railedNoEvidence, 0.35);
eq("#7b ceiling none=0.35", OCCURRENCE_CEILING.none, 0.35);
eq("#7c elite may exceed (0.60)", OCCURRENCE_CEILING.elite, 0.60);

// ── Fix 6 — pitcher-fade-only cannot promote to READY ──────────────────────
// #8/#9 inning-1 pitcher-fade-only (vuln=100, no batter evidence) → NOT ready.
const inning1Fade = deriveCanonicalPromotionIntent(snap({
  currentInning: 1, detectedInning: 1, pitcherHrVulnerability: 100, batterEvidenceQuality: "none", canonicalStage: "build", currentState: "PREPARE",
}));
eq("#8 inning-1 pitcher-fade-only floor != ready", inning1Fade.floor !== "ready", true);

// #9 BET_NOW + attack but no batter evidence → capped at build, never ready.
const betNowNoEvidence = deriveCanonicalPromotionIntent(snap({
  currentState: "BET_NOW", canonicalStage: "attack", pitcherHrVulnerability: 100, batterEvidenceQuality: "none", currentInning: 2,
}));
eq("#9 BET_NOW attack no-evidence floor=build", betNowNoEvidence.floor, "build");
eq("#9b reason notes the cap", /no_batter_evidence/.test(betNowNoEvidence.reason), true);

// Pitcher-fade WITH batter evidence in a late inning → READY (legit).
const fadeWithEvidence = deriveCanonicalPromotionIntent(snap({
  currentState: "PREPARE", canonicalStage: "build", pitcherHrVulnerability: 100, batterEvidenceQuality: "elite", currentInning: 6,
}));
eq("pitcher-fade + elite evidence (inning 6) → ready", fadeWithEvidence.floor, "ready");

// Early inning pitcher-fade even WITH evidence → not ready (innings 1-3 gate).
const fadeEarlyWithEvidence = deriveCanonicalPromotionIntent(snap({
  currentState: "PREPARE", canonicalStage: "build", pitcherHrVulnerability: 100, batterEvidenceQuality: "elite", currentInning: 2,
}));
eq("pitcher-fade + evidence but inning 2 → not ready", fadeEarlyWithEvidence.floor !== "ready", true);

// BET_NOW attack WITH evidence → ready (the engine still fires for real signals).
const betNowEvidence = deriveCanonicalPromotionIntent(snap({
  currentState: "BET_NOW", canonicalStage: "attack", batterEvidenceQuality: "fresh", currentInning: 7,
}));
eq("BET_NOW attack + fresh evidence → ready", betNowEvidence.floor, "ready");

// ── P1 (Codex review) — persisted canonical stage is also clamped ─────────
// The DB ladder/board read snapshot.canonicalStage, not the FSM upsert, so a
// no-evidence attack must be demoted to building there too.
eq("P1 attack + no evidence → building (persisted stage)", clampPersistedCanonicalStage("attack", "none"), "building");
eq("P1 attack + fresh evidence → attack (kept)", clampPersistedCanonicalStage("attack", "fresh"), "attack");
eq("P1 attack + elite evidence → attack (kept)", clampPersistedCanonicalStage("attack", "elite"), "attack");
eq("P1 building stays building", clampPersistedCanonicalStage("building", "none"), "building");
eq("P1 watch stays watch", clampPersistedCanonicalStage("watch", "none"), "watch");

// ── Fix 2/3/5 — promotion takes no edge/side/odds input (structural) ───────
// deriveCanonicalPromotionIntent's only inputs are the snapshot's occurrence
// probability, evidence class, pitcher vuln, stage, and inning — there is no
// edge / recommendedSide / bookLine / odds parameter to influence it.
eq("#3/#4/#5 promotion ignores edge/side (no such field read)",
  deriveCanonicalPromotionIntent(snap({ currentState: "WATCH", canonicalStage: "watch", batterEvidenceQuality: "none" })).floor, "watch");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
