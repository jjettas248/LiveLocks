// HR Radar — Phase 2 EV gate unit tests.
// Verifies the actionable HR Max Window (officialAlert) tier only holds when
// the model's game P(HR) beats the de-vigged market-implied probability.
// Run: npx tsx server/mlb/hrEvGate.test.ts

import {
  americanToImpliedProb,
  deviggedMarketHrProb,
  HR_EV_EDGE_MARGIN,
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

// ─── EV-gate decision math (mirrors evaluateHRAlert wrapper) ────────────────
// model beats de-vigged market by ≥ margin → PASS (keep officialAlert);
// otherwise DEMOTE to prepare.
function gate(modelProb: number, overOdds: number | null, underOdds: number | null): "officialAlert" | "prepare" {
  const mkt = deviggedMarketHrProb(overOdds, underOdds);
  if (mkt == null) return "officialAlert"; // no price → no-op
  return modelProb >= mkt * (1 + HR_EV_EDGE_MARGIN) ? "officialAlert" : "prepare";
}
// Market over +300 two-sided ≈ 0.238; required = 0.238 * 1.10 ≈ 0.262.
check("model 30% vs +300/-400 mkt (~23.8%) → PASS (keeps HR Max Window)",
  gate(0.30, 300, -400) === "officialAlert");
check("model 24% vs +300/-400 mkt (~23.8%) → DEMOTE (edge below margin)",
  gate(0.24, 300, -400) === "prepare");
check("model 12% vs short -120 favorite mkt → DEMOTE",
  gate(0.12, -120, 100) === "prepare");
check("no market price → no-op, stays officialAlert",
  gate(0.06, null, null) === "officialAlert");

console.log(`[HR_EV_GATE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HR_EV_GATE_TEST] OK");
