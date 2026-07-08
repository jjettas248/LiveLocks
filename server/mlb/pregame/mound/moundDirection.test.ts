// Mound Radar — Fade/Follow direction invariants.
//
// Locks computeMoundDirection()'s thresholds byte-for-byte against what the
// client used to hardcode client-side (before this module existed, direction
// was derived at render time from raw diagnostics fields — a violation of
// the "no UI-side lifecycle derivation" discipline HR Radar's canonical
// state machine already enforces elsewhere). No test previously existed for
// this logic since it was client-only.
// Run: npx tsx server/mlb/pregame/mound/moundDirection.test.ts

import { computeMoundDirection, type MoundDirectionInputs } from "./moundDirection";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseInputs(overrides: Partial<MoundDirectionInputs> = {}): MoundDirectionInputs {
  return {
    tier: "watch",
    pitcherSkillScore: null,
    dataCoverageScore: 0,
    opposingLineupConfirmed: false,
    pitcherSeasonStatsAvailable: false,
    primaryMarket: "pitcher_strikeouts",
    seasonKPer9: null,
    seasonAvgInningsPerStart: null,
    ...overrides,
  };
}

// ── Fade: track tier with real pitcher-skill data AND a gradeable settlement baseline ──
ok(
  computeMoundDirection(baseInputs({ tier: "track", pitcherSkillScore: 4.0, seasonKPer9: 8.0 })) === "fade",
  "track tier + real pitcherSkillScore + season K/9 (Ks market) → fade",
);
ok(
  computeMoundDirection(baseInputs({ tier: "track", pitcherSkillScore: null, seasonKPer9: 8.0 })) === null,
  "track tier WITHOUT pitcherSkillScore → null (data-missing artifact, not a genuine weak matchup)",
);

// ── Regression: pitcherSkillScore can be Savant-only, with no season K/9 on file ──
// (Codex review, PR #105.) Without a settlement baseline,
// moundOutcomeAttribution.ts's deriveMoundOutcome always grades a
// calibration_miss — a Fade Candidate shown for this pitcher could never
// actually be graded as a cash.
ok(
  computeMoundDirection(baseInputs({ tier: "track", pitcherSkillScore: 5.0, seasonKPer9: null, primaryMarket: "pitcher_strikeouts" })) === null,
  "track tier + Savant-only pitcherSkillScore (no season K/9) on the Ks market → null, never an ungradeable Fade",
);
ok(
  computeMoundDirection(
    baseInputs({ tier: "track", pitcherSkillScore: 5.0, primaryMarket: "pitcher_outs", seasonKPer9: null, seasonAvgInningsPerStart: null }),
  ) === null,
  "track tier on the Outs market with no seasonAvgInningsPerStart → null, never an ungradeable Fade",
);
ok(
  computeMoundDirection(
    baseInputs({ tier: "track", pitcherSkillScore: 5.0, primaryMarket: "pitcher_outs", seasonKPer9: null, seasonAvgInningsPerStart: 6.0 }),
  ) === "fade",
  "track tier on the Outs market WITH seasonAvgInningsPerStart (even though seasonKPer9 is null) → fade — the Outs baseline doesn't need K/9",
);

// ── Follow: strong/elite/nuclear tier clearing the full data-quality bar ────
for (const tier of ["strong", "elite", "nuclear"] as const) {
  ok(
    computeMoundDirection(
      baseInputs({ tier, dataCoverageScore: 0.6, opposingLineupConfirmed: true, pitcherSeasonStatsAvailable: true }),
    ) === "follow",
    `${tier} tier clearing the full data-quality bar → follow`,
  );
}

ok(
  computeMoundDirection(
    baseInputs({ tier: "strong", dataCoverageScore: 0.59, opposingLineupConfirmed: true, pitcherSeasonStatsAvailable: true }),
  ) === null,
  "strong tier just under the 0.6 dataCoverageScore floor → null, not follow",
);
ok(
  computeMoundDirection(
    baseInputs({ tier: "strong", dataCoverageScore: 0.9, opposingLineupConfirmed: false, pitcherSeasonStatsAvailable: true }),
  ) === null,
  "strong tier without a confirmed opposing lineup → null, not follow",
);
ok(
  computeMoundDirection(
    baseInputs({ tier: "strong", dataCoverageScore: 0.9, opposingLineupConfirmed: true, pitcherSeasonStatsAvailable: false }),
  ) === null,
  "strong tier without real season stats (Savant-only pitcherSkillScore) → null, not follow — nothing to grade an Over against",
);

// ── Neither Fade nor Follow → null (watch tier, or a data-missing artifact) ──
ok(computeMoundDirection(baseInputs({ tier: "watch" })) === null, "watch tier → null (neither fade nor follow)");

console.log(`\nmoundDirection.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
