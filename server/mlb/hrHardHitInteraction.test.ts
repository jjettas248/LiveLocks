// HR Radar — Phase 3 hard-hit × angle × bat-speed × IBB interaction booster.
// Verifies the multiplicative interaction triggers only on a hard-hit/high-xBA
// ball and compounds with favorable angle, elite bat speed, and IBB respect —
// and is a strict no-op when the trigger or inputs are absent.
// Run: npx tsx server/mlb/hrHardHitInteraction.test.ts

import { computeHardHitInteractionMultiplier } from "./hrConversionModel";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[HHI_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// Minimal factors builder — only the fields the booster reads.
function inp(over: {
  contactClasses?: any[];
  maxEV?: number | null;
  maxXBA?: number | null;
  qualifiedEVMean?: number | null;
  batSpeedMph?: number | null;
  seasonIBBRate?: number | null;
}): any {
  return {
    seasonIBBRate: over.seasonIBBRate ?? null,
    factors: {
      maxEV: over.maxEV ?? null,
      maxXBA: over.maxXBA ?? null,
      qualifiedEVMean: over.qualifiedEVMean ?? null,
      batSpeedMph: over.batSpeedMph ?? null,
      contactClasses: over.contactClasses ?? [],
    },
  };
}
function contact(ev: number, la: number, isBarrel = false): any {
  return { contactClass: "x", exitVelocity: ev, launchAngle: la, distance: 0, outcome: "out", isBarrel };
}

// ─── No-op cases ───────────────────────────────────────────────────────────
check("empty contact → 1.0", computeHardHitInteractionMultiplier(inp({})) === 1.0);
check("contact but no hard-hit / high-xBA trigger → 1.0",
  computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(92, 25)], maxEV: 92, maxXBA: 0.3 })) === 1.0);

// ─── Trigger present ───────────────────────────────────────────────────────
const hardOnly = computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(105, 10)], maxEV: 105, maxXBA: 0.2 }));
check("hard-hit only (no high xBA, no sweet angle) → ~1.06", Math.abs(hardOnly - 1.06) < 1e-9, `got ${hardOnly}`);

const hardAndXba = computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(105, 10)], maxEV: 105, maxXBA: 0.70 }));
check("hard-hit AND high-xBA → 1.10 base (stronger than single)", Math.abs(hardAndXba - 1.10) < 1e-9, `got ${hardAndXba}`);
check("hard+xBA > hard only", hardAndXba > hardOnly);

// ─── Amplifiers compound ───────────────────────────────────────────────────
const withAngle = computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(105, 26)], maxEV: 105, maxXBA: 0.70 }));
check("favorable angle compounds (1.10*1.05)", Math.abs(withAngle - 1.10 * 1.05) < 1e-9, `got ${withAngle}`);

const withAngleBatSpeed = computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(105, 26)], maxEV: 105, maxXBA: 0.70, batSpeedMph: 76 }));
check("elite bat speed compounds further", withAngleBatSpeed > withAngle);

const allFour = computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(105, 26, true)], maxEV: 105, maxXBA: 0.70, batSpeedMph: 76, seasonIBBRate: 0.03 }));
check("all four amplifiers compound highest", allFour > withAngleBatSpeed);

// ─── Cap ───────────────────────────────────────────────────────────────────
check("interaction capped at 1.25", allFour <= 1.25 + 1e-9, `got ${allFour}`);

// ─── High-xBA-only trigger (no hard EV) still fires ────────────────────────
const xbaOnly = computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(98, 24)], maxEV: 98, maxXBA: 0.72 }));
check("high-xBA-only (EV below hard threshold) triggers", xbaOnly > 1.0, `got ${xbaOnly}`);

// ─── Favorable angle only credited when carried by a damage ball ───────────
const sweetButSoft = computeHardHitInteractionMultiplier(inp({ contactClasses: [contact(85, 26)], maxEV: 105, maxXBA: 0.70 }));
check("trigger via maxEV but sweet angle on a SOFT ball → no angle amp",
  Math.abs(sweetButSoft - 1.10) < 1e-9, `got ${sweetButSoft}`);

console.log(`[HHI_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HHI_TEST] OK");
