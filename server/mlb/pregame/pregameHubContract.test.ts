// MLB Pre-Game Hub — contract invariants.
//
// Asserts the MlbPregameHubResponse/PregameRadarTarget contract: finite
// score10, actorType/view always present, firstAbCashEligible===false on
// every mound-view target and true on every plate-view target, no allowed
// markets on mound targets.
//
// Run: npx tsx server/mlb/pregame/pregameHubContract.test.ts

import { validateTargets } from "./pregameHubContractValidation";
import type { PregameRadarTarget } from "../../../shared/mlbPregameHub";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseTarget(overrides: Partial<PregameRadarTarget> = {}): PregameRadarTarget {
  return {
    id: "t1",
    view: "plate",
    actorType: "batter",
    playerId: "1",
    playerName: "Test Player",
    team: "KC",
    opponent: "TB",
    matchupLabel: "KC vs TB",
    handednessLabel: null,
    rank: 1,
    score10: 7.5,
    tier: "strong",
    setupLabel: "Strong Setup",
    primaryMarket: { key: "home_runs", label: "HR", side: "OVER", tier: "strong" },
    markets: [],
    badges: [],
    drivers: [],
    warnings: [],
    context: {},
    tracking: { flaggedBeforeFirstPitch: true, firstAbCashEligible: true },
    ...overrides,
  };
}

// ── Valid plate target passes ─────────────────────────────────────────────────
const validPlate = validateTargets([baseTarget()], "plate");
ok(validPlate.length === 1, "valid plate target survives validation");

// ── Non-finite score10 is dropped ─────────────────────────────────────────────
const nanTarget = baseTarget({ score10: NaN });
const dropped = validateTargets([nanTarget], "plate");
ok(dropped.length === 0, "non-finite score10 is dropped");

// ── Missing actorType/view is dropped ─────────────────────────────────────────
const noActorType = baseTarget({ actorType: undefined as any });
ok(validateTargets([noActorType], "plate").length === 0, "missing actorType is dropped");

const noView = baseTarget({ view: undefined as any });
ok(validateTargets([noView], "plate").length === 0, "missing view is dropped");

// ── Mound targets must have firstAbCashEligible === false ────────────────────
const moundWithFirstAb = baseTarget({
  view: "mound",
  actorType: "pitcher",
  primaryMarket: { key: "pitcher_strikeouts", label: "Pitcher Ks", side: "OVER", tier: "strong" },
  tracking: { flaggedBeforeFirstPitch: true, firstAbCashEligible: true }, // violates the rule
});
ok(
  validateTargets([moundWithFirstAb], "mound").length === 0,
  "mound target with firstAbCashEligible=true is dropped",
);

const moundValid = baseTarget({
  view: "mound",
  actorType: "pitcher",
  primaryMarket: { key: "pitcher_outs", label: "Pitcher Outs", side: "OVER", tier: "strong" },
  tracking: { flaggedBeforeFirstPitch: true, firstAbCashEligible: false },
});
ok(validateTargets([moundValid], "mound").length === 1, "valid mound target (firstAbCashEligible=false) survives");

// ── Mound targets may never carry an "allowed" market ─────────────────────────
const moundWithAllowedMarket = baseTarget({
  view: "mound",
  actorType: "pitcher",
  primaryMarket: { key: "hits_allowed" as any, label: "Hits Allowed", side: "OVER", tier: "strong" },
  tracking: { flaggedBeforeFirstPitch: true, firstAbCashEligible: false },
});
ok(
  validateTargets([moundWithAllowedMarket], "mound").length === 0,
  "mound target with a disallowed 'allowed' market is dropped",
);

console.log(`\npregameHubContract.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
