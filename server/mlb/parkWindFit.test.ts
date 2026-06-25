// [MLB shared park/wind fit] Validation for the shared parkWindFit module + its
// HR Radar integration guarantees.
// Run with: npx tsx server/mlb/parkWindFit.test.ts
//
// Covers PR1's 12 required behaviors:
//  1. Every known MLB venue returns a valid park profile.
//  2. Unknown venue returns neutral and does not crash.
//  3. Wind out to LF favors RHH pull profile.
//  4. Wind out to RF favors LHH pull profile.
//  5. Wind out to CF gives broad carry boost.
//  6. Wind blowing in suppresses.
//  7. Crosswind does not create strong boost unless confidently mapped.
//  8. Missing player spray data returns neutral.
//  9. Unknown batter hand returns neutral.
// 10. Good wind fit cannot create FIRE without batter-side evidence.
// 11. Good wind fit cannot bypass the FIRE-only ledger.
// 12. (run alongside the existing HR Radar suites — see CLAUDE.md §1.)

import {
  computePlayerParkWindFit,
  getParkWindProfile,
  FIT_MIN,
  FIT_MAX,
  type PlayerParkWindFitInput,
} from "./parkWindFit";
import { getKnownVenueNames } from "./dataSources";
import { maybePromoteReadyToFire, CONTACT_HR_DRIVER_SIGNALS } from "./hrRadarUserStage";

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fit(over: Partial<PlayerParkWindFitInput>) {
  return computePlayerParkWindFit({ windSpeedMph: 15, ...over });
}

console.log("\n[parkWindFit] running cases\n");

// ── Test 1 — every known venue returns a valid profile ───────────────────────
{
  const venues = getKnownVenueNames();
  assert("registry exposes venues", venues.length >= 28, `got ${venues.length}`);
  let allValid = true;
  let firstBad = "";
  for (const v of venues) {
    const p = getParkWindProfile(v);
    const ok = p.resolved && !p.isFallback &&
      Number.isFinite(p.hrFactor) &&
      ["boost", "suppress", "neutral"].includes(p.classification);
    if (!ok) { allValid = false; firstBad = v; break; }
  }
  assert("every known venue → valid park profile", allValid, firstBad ? `bad venue: ${firstBad}` : undefined);
  // Alias / alternate venue still resolves (does not crash, maps to a real park).
  const alias = getParkWindProfile("Camden Yards");
  assert("alias venue resolves to a real park", alias.resolved && !alias.isFallback);
}

// ── Test 2 — unknown venue → neutral, no crash ───────────────────────────────
{
  const p = getParkWindProfile("Some Temporary Pop-Up Stadium 2026");
  assert("unknown venue → fallback profile", p.isFallback && !p.resolved);
  assert("unknown venue → neutral classification", p.classification === "neutral");
  assert("unknown venue → hrFactor 1.0", p.hrFactor === 1.0);
  const f = fit({ venueName: "Some Temporary Pop-Up Stadium 2026", batterHand: "R", pullRatePercent: 50, windString: "15 mph, Out To LF" });
  assert("unknown venue still computes a fit without crashing", Number.isFinite(f.fitMultiplier));
}

// ── Test 3 — wind out to LF favors RHH pull over LHH pull ─────────────────────
{
  const rhh = fit({ venueName: "Wrigley Field", batterHand: "R", pullRatePercent: 52, windString: "15 mph, Out To LF" });
  const lhh = fit({ venueName: "Wrigley Field", batterHand: "L", pullRatePercent: 52, windString: "15 mph, Out To LF" });
  assert("out-to-LF: RHH pull gets a boost", rhh.fitMultiplier > 1.0, `rhh=${rhh.fitMultiplier}`);
  assert("out-to-LF: RHH favored over LHH", rhh.fitMultiplier > lhh.fitMultiplier, `rhh=${rhh.fitMultiplier} lhh=${lhh.fitMultiplier}`);
  assert("out-to-LF: RHH classified boost", rhh.classification === "boost");
  assert("out-to-LF: label mentions RHH pull", /RHH pull/.test(rhh.label), rhh.label);
}

// ── Test 4 — wind out to RF favors LHH pull over RHH pull ─────────────────────
{
  const lhh = fit({ venueName: "Yankee Stadium", batterHand: "L", pullRatePercent: 52, windString: "15 mph, Out To RF" });
  const rhh = fit({ venueName: "Yankee Stadium", batterHand: "R", pullRatePercent: 52, windString: "15 mph, Out To RF" });
  assert("out-to-RF: LHH pull gets a boost", lhh.fitMultiplier > 1.0, `lhh=${lhh.fitMultiplier}`);
  assert("out-to-RF: LHH favored over RHH", lhh.fitMultiplier > rhh.fitMultiplier, `lhh=${lhh.fitMultiplier} rhh=${rhh.fitMultiplier}`);
  // Yankee Stadium short RF porch → geometry-flavored label for LHH pull.
  assert("out-to-RF: Yankee short-porch fit label", /Short RF fit/.test(lhh.label), lhh.label);
}

// ── Test 5 — wind out to CF gives broad carry boost (hand-agnostic) ───────────
{
  const rhh = fit({ venueName: "Target Field", batterHand: "R", pullRatePercent: 45, windString: "15 mph, Out To CF" });
  const lhh = fit({ venueName: "Target Field", batterHand: "L", pullRatePercent: 45, windString: "15 mph, Out To CF" });
  assert("out-to-CF: RHH gets broad boost", rhh.fitMultiplier > 1.0, `rhh=${rhh.fitMultiplier}`);
  assert("out-to-CF: LHH gets broad boost", lhh.fitMultiplier > 1.0, `lhh=${lhh.fitMultiplier}`);
  assert("out-to-CF: roughly hand-agnostic", Math.abs(rhh.fitMultiplier - lhh.fitMultiplier) < 0.01);
  assert("out-to-CF: components are broad (not directional)", rhh.components.broad > 0 && rhh.components.directional === 0);
}

// ── Test 6 — wind blowing in suppresses ──────────────────────────────────────
{
  const f = fit({ venueName: "Fenway Park", batterHand: "R", pullRatePercent: 50, windString: "16 mph, In From CF" });
  assert("wind in: fit < 1.0 (suppressed)", f.fitMultiplier < 1.0, `mult=${f.fitMultiplier}`);
  assert("wind in: classified suppress", f.classification === "suppress");
  assert("wind in: suppression component negative", f.components.suppression < 0);
}

// ── Test 7 — crosswind does not create strong boost unless confidently mapped ─
{
  const cross = fit({ venueName: "Wrigley Field", batterHand: "R", pullRatePercent: 52, windString: "18 mph, L To R" });
  assert("crosswind → neutral (no boost)", cross.fitMultiplier === 1.0, `mult=${cross.fitMultiplier}`);
  assert("crosswind classified neutral", cross.classification === "neutral");
  // Low-confidence coarse 'out' (no sector) cannot manufacture a directional fit.
  // The module defers to the engine's generic env term → strictly neutral, so it
  // never double-counts wind and leaves the goldmaster baseline untouched.
  const coarse = fit({ venueName: "Wrigley Field", batterHand: "R", pullRatePercent: 52, windDirectionCoarse: "out", windSpeedMph: 18 });
  assert("coarse-out: no directional component (low confidence)", coarse.components.directional === 0);
  assert("coarse-out: defers to generic env → neutral (no double-count)", coarse.fitMultiplier === 1.0, `mult=${coarse.fitMultiplier}`);
}

// ── Test 8 — missing player spray data returns neutral (directional wind) ─────
{
  const f = fit({ venueName: "Wrigley Field", batterHand: "R", pullRatePercent: null, batterArchetype: "stable_regular", windString: "15 mph, Out To LF" });
  assert("missing spray + directional wind → neutral", f.fitMultiplier === 1.0, `mult=${f.fitMultiplier}`);
  assert("missing spray → no directional component", f.components.directional === 0);
}

// ── Test 9 — unknown batter hand returns neutral ─────────────────────────────
{
  const nullHand = fit({ venueName: "Yankee Stadium", batterHand: null, pullRatePercent: 50, windString: "15 mph, Out To LF" });
  assert("unknown hand → neutral", nullHand.fitMultiplier === 1.0, `mult=${nullHand.fitMultiplier}`);
  assert("unknown hand → classification unknown", nullHand.classification === "unknown");
  const switchHand = fit({ venueName: "Yankee Stadium", batterHand: "S", pullRatePercent: 50, windString: "15 mph, Out To LF" });
  assert("switch hitter (no resolvable pull side) → neutral", switchHand.fitMultiplier === 1.0, `mult=${switchHand.fitMultiplier}`);
}

// ── Bounds invariant — fit is always clamped, every combination ──────────────
{
  let inBounds = true;
  const venues = getKnownVenueNames().concat(["Unknown Park"]);
  const winds = ["20 mph, Out To LF", "20 mph, Out To RF", "20 mph, Out To CF", "20 mph, In From CF", "15 mph, L To R", "Calm"];
  for (const v of venues) {
    for (const h of ["L", "R", "S", null]) {
      for (const pr of [null, 30, 55]) {
        for (const w of winds) {
          const m = computePlayerParkWindFit({ venueName: v, batterHand: h, pullRatePercent: pr, windString: w, windSpeedMph: 20 }).fitMultiplier;
          if (!(m >= FIT_MIN - 1e-9 && m <= FIT_MAX + 1e-9)) { inBounds = false; break; }
        }
      }
    }
  }
  assert("fit multiplier always within [FIT_MIN, FIT_MAX]", inBounds, `[${FIT_MIN}, ${FIT_MAX}]`);
}

// ── Test 10 — good wind fit cannot create FIRE without batter-side evidence ───
{
  // A maxed-out park/wind fit feeds PROBABILITY only. Even at top conviction,
  // a row with NO contact HR driver (no bat evidence) cannot reach FIRE.
  const stage = maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW",
    canonicalStage: "attack",
    consecutivePromoteTicks: 10,
    currentReadinessScore: 100,
    peakReadinessScore: 100,
    displayScore10: 10,
    qualifyingSignals: [], // no contact driver — only "great wind"
  });
  assert("BET_NOW + perfect score + NO contact driver → stays ready (no FIRE)", stage === "ready", `got ${stage}`);

  // Park/wind is never even in the contact-driver set, so it cannot qualify.
  const parkKeys = ["park_wind_fit", "wind_out", "park_geometry", "carry_boost"];
  const overlaps = parkKeys.filter(k => (CONTACT_HR_DRIVER_SIGNALS as readonly string[]).includes(k));
  assert("park/wind keys are NOT contact HR drivers", overlaps.length === 0, overlaps.join(","));
}

// ── Test 11 — good wind fit cannot bypass the FIRE-only ledger ────────────────
{
  // "Pitcher fade + good wind" — a non-contact strong driver plus great context
  // still cannot FIRE on its own (FIRE requires a CONTACT driver).
  const stage = maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW",
    canonicalStage: "attack",
    consecutivePromoteTicks: 10,
    currentReadinessScore: 100,
    peakReadinessScore: 100,
    displayScore10: 10,
    qualifyingSignals: ["pitcher_collapse_power"], // pitcher fade, not bat contact
  });
  assert("pitcher fade + good wind (no contact) → stays ready", stage === "ready", `got ${stage}`);

  // Sanity: a real CONTACT driver under the same context DOES promote — proving
  // the gate keys on bat evidence, not on the wind/score.
  const fireStage = maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW",
    canonicalStage: "attack",
    consecutivePromoteTicks: 10,
    currentReadinessScore: 100,
    peakReadinessScore: 100,
    displayScore10: 10,
    qualifyingSignals: ["elite_barrel"], // tangible bat evidence
  });
  assert("real contact driver under same context → FIRE (gate keys on bat evidence)", fireStage === "fire", `got ${fireStage}`);
}

console.log(`\n[parkWindFit] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
