// Mound Radar — Contact/HR Susceptibility invariants.
//
// Locks (1) the two-chip, no-middle-ground threshold behavior, (2) the
// unconfirmed-lineup unweighted-fallback degrade-gracefully behavior, and
// (3) the critical isolation guarantee — scoring.ts (score10/tier composite)
// never references this module, mirroring matchupAdjustedKs.test.ts's
// isolation-guarantee pattern.
// Run: npx tsx server/mlb/pregame/mound/contactRisk.test.ts

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { computeContactRisk, type ContactRiskInputs } from "./contactRisk";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseInputs(overrides: Partial<ContactRiskInputs> = {}): ContactRiskInputs {
  return {
    pitcherKnown: true,
    opposingLineupConfirmed: false,
    hrPer9VsLHB: null,
    hrPer9VsRHB: null,
    eraVsLHB: null,
    eraVsRHB: null,
    opposingLineupHandedness: null,
    ...overrides,
  };
}

// ── Unknown pitcher → unavailable, no drivers ────────────────────────────────
const unknown = computeContactRisk(baseInputs({ pitcherKnown: false }));
ok(unknown.available === false, "unknown pitcher → unavailable");
ok(unknown.drivers.length === 0, "unknown pitcher → no drivers");

// ── No handedness splits at all → unavailable ────────────────────────────────
const noSplits = computeContactRisk(baseInputs());
ok(noSplits.available === false, "no HR/9 or ERA splits available → unavailable");

// ── High HR/9 + high ERA vs handedness → cr_high fires (negative) ───────────
const high = computeContactRisk(
  baseInputs({
    opposingLineupConfirmed: true,
    hrPer9VsLHB: 2.0, hrPer9VsRHB: 2.0,
    eraVsLHB: 5.5, eraVsRHB: 5.5,
    opposingLineupHandedness: { left: 4, right: 5, switchHit: 0 },
  }),
);
ok(high.available === true, "high-risk case is available");
ok(high.score10 >= 6.5, `high HR/9+ERA scores >= 6.5 (got ${high.score10})`);
ok(high.drivers.some((d) => d.key === "cr_high" && d.direction === "negative"), "cr_high fires with direction negative");
ok(!high.drivers.some((d) => d.key === "cr_low"), "cr_low does not also fire");

// ── Low HR/9 + low ERA vs handedness → cr_low fires (positive) ──────────────
const low = computeContactRisk(
  baseInputs({
    opposingLineupConfirmed: true,
    hrPer9VsLHB: 0.7, hrPer9VsRHB: 0.7,
    eraVsLHB: 3.0, eraVsRHB: 3.0,
    opposingLineupHandedness: { left: 4, right: 5, switchHit: 0 },
  }),
);
ok(low.score10 <= 3.5, `low HR/9+ERA scores <= 3.5 (got ${low.score10})`);
ok(low.drivers.some((d) => d.key === "cr_low" && d.direction === "positive"), "cr_low fires with direction positive");
ok(!low.drivers.some((d) => d.key === "cr_high"), "cr_high does not also fire");

// ── Mid-range values → neither chip fires (no middle ground) ────────────────
const mid = computeContactRisk(
  baseInputs({
    opposingLineupConfirmed: true,
    hrPer9VsLHB: 1.3, hrPer9VsRHB: 1.3,
    eraVsLHB: 4.3, eraVsRHB: 4.3,
    opposingLineupHandedness: { left: 4, right: 5, switchHit: 0 },
  }),
);
ok(mid.score10 > 3.5 && mid.score10 < 6.5, `mid-range score falls strictly between the two thresholds (got ${mid.score10})`);
ok(mid.drivers.length === 0, "mid-range score fires neither cr_high nor cr_low");

// ── Unconfirmed lineup → falls back to unweighted average, still available ──
const unconfirmed = computeContactRisk(
  baseInputs({
    opposingLineupConfirmed: false,
    hrPer9VsLHB: 2.0, hrPer9VsRHB: 2.0,
    eraVsLHB: 5.5, eraVsRHB: 5.5,
    opposingLineupHandedness: null,
  }),
);
ok(unconfirmed.available === true, "unconfirmed lineup still degrades gracefully to available (not blanked out)");
ok(unconfirmed.score10 === high.score10, "unweighted fallback matches the weighted result when both handedness splits are equal");

// ── Isolation guarantee: scoring.ts (score10/tier composite) never references contactRisk ──
const scoringSrc = readFileSync(join(HERE, "scoring.ts"), "utf8");
ok(!/contactRisk|computeContactRisk/.test(scoringSrc), "scoring.ts never references contactRisk.ts in any form");

console.log(`\ncontactRisk.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
