// HR Radar — EV/edge decoupling unit tests (2026-06).
// HR Radar is a HR-OCCURRENCE engine: sportsbook edge/value is observability
// only and must NEVER change the alert tier/level. The de-vig helpers are kept
// (used by the [HR_EDGE_DECOUPLED] log); the wrapper no longer demotes on edge.
// Run: npx tsx server/mlb/hrEvGate.test.ts

import {
  americanToImpliedProb,
  deviggedMarketHrProb,
  evaluateHRAlert,
  type HRAlertInput,
} from "./evaluateHRAlert";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[HR_EV_GATE_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// ─── americanToImpliedProb ─────────────────────────────────────────────────
check("+300 → 0.25 implied", approx(americanToImpliedProb(300)!, 0.25));
check("-150 → 0.60 implied", approx(americanToImpliedProb(-150)!, 150 / 250));
check("+100 → 0.50 implied", approx(americanToImpliedProb(100)!, 0.5));
check("null odds → null", americanToImpliedProb(null) === null);
check("NaN odds → null", americanToImpliedProb(NaN as any) === null);

// ─── deviggedMarketHrProb ──────────────────────────────────────────────────
// Two-sided removes the hold. Over +300 (0.25), Under -400 (0.80): raw sum 1.05
// → no-vig over = 0.25/1.05 ≈ 0.2381.
const dv = deviggedMarketHrProb(300, -400)!;
check("de-vig two-sided ≈ 0.238", approx(dv, 0.25 / (0.25 + 0.8), 1e-4), `got ${dv}`);
check("de-vig over < raw over implied (hold removed)", dv < americanToImpliedProb(300)!);
// One-sided falls back to raw over implied (conservative).
check("de-vig one-sided = raw over implied", approx(deviggedMarketHrProb(300, null)!, 0.25));
check("de-vig no over price → null", deviggedMarketHrProb(null, -400) === null);

// ─── Edge decoupling — evaluateHRAlert tier is odds-INDEPENDENT ─────────────
// Spec #3/#4: edge cannot promote AND cannot suppress HR Radar. The wrapper
// must return the SAME tier/level/signalState regardless of the sportsbook
// price (including a negative-edge short favorite that previously DEMOTED).
function mkInput(overOdds: number | null, underOdds: number | null): HRAlertInput {
  return {
    playerId: "p1", playerName: "Test Slugger", teamAbbr: "NYY", gameId: "G1",
    hrBuildScore: 7, hrIntensity: "high",
    factors: {
      contactClasses: [], hrShapedCount: 2, missedHrCount: 1, eliteHrCount: 1,
      qualifiedEVMean: 105, maxDistance: 410, maxEV: 108,
    } as any,
    inning: 6, isTopInning: true, battingOrderSlot: 3, remainingPA: 2.2,
    pitchCount: 85, timesThrough: 3, parkFactor: 1.05,
    batterHand: "R", pitcherThrows: "L", era: 5.2,
    barrelRate: 0.14, hardHitRate: 0.48, xSLG: 0.62, seasonHRRate: 0.06,
    overOdds, underOdds,
    priorABResults: [
      { exitVelocity: 106, launchAngle: 28, distance: 405, outcome: "flyout" },
      { exitVelocity: 103, launchAngle: 24, distance: 360, outcome: "double" },
    ],
  } as HRAlertInput;
}
// A short -120 favorite is a NEGATIVE-edge price for most model probabilities —
// the old gate would have demoted officialAlert. Now it must not.
const withOdds = evaluateHRAlert(mkInput(-120, 100));
const noOdds = evaluateHRAlert(mkInput(null, null));
const richOdds = evaluateHRAlert(mkInput(550, -700)); // long price / different edge
check("#3 edge cannot promote: tier identical with vs without odds",
  withOdds.alertTier === noOdds.alertTier, `withOdds=${withOdds.alertTier} noOdds=${noOdds.alertTier}`);
check("#4 edge cannot suppress: level identical with vs without odds",
  withOdds.level === noOdds.level, `withOdds=${withOdds.level} noOdds=${noOdds.level}`);
check("edge-independent signalState (negative vs long price)",
  withOdds.signalState === richOdds.signalState, `neg=${withOdds.signalState} long=${richOdds.signalState}`);
check("no triggerReason mentions EV/edge gating",
  !/EV-gated|edge/i.test(withOdds.triggerReason), withOdds.triggerReason);

console.log(`[HR_EV_GATE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HR_EV_GATE_TEST] OK");
