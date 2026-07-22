// Mound Radar PR 2/5 — upstream RawContactSupportingInputs construction.
// Exercises the REAL construction logic (buildRawContactSupportingInputs,
// extracted verbatim from buildMlbMoundRadar.ts's per-pitcher loop) rather
// than a hand-mirrored copy — proves the fetch-failed-entirely vs.
// fetch-succeeded-but-field-null distinction survives the actual upstream
// wiring, not just the pure aggregator's own unit tests.
// Run: npx tsx server/mlb/pregame/mound/rawContactSnapshotUpstreamAvailability.test.ts

import { buildRawContactSupportingInputs } from "./buildMlbMoundRadar";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── seasonStats fetch failed entirely (null) ──
const fetchFailed = buildRawContactSupportingInputs(null, { ipVarianceLast3: 1.2 });
ok(fetchFailed.seasonStatsAvailable === false, "seasonStats=null (fetch failure) → seasonStatsAvailable=false");
ok(fetchFailed.inningsPitchedSeason === null, "seasonStats=null → inningsPitchedSeason null");
ok(fetchFailed.homeRunsAllowedSeason === null, "seasonStats=null → homeRunsAllowedSeason null");
ok(fetchFailed.bb9Season === null, "seasonStats=null → bb9Season null");

// ── seasonStats fetch SUCCEEDED but the field itself is null ──
const fetchSucceededFieldMissing = buildRawContactSupportingInputs(
  { inningsPitched: null, homeRunsAllowed: null, bbPer9: null },
  { ipVarianceLast3: 1.2 },
);
ok(fetchSucceededFieldMissing.seasonStatsAvailable === true, "seasonStats={...} (fetch succeeded) → seasonStatsAvailable=true, even with null fields");
ok(fetchSucceededFieldMissing.inningsPitchedSeason === null, "field itself still surfaces as null when the fetched object carries no value");

// ── The two cases are genuinely distinguishable — the core requirement ──
ok(
  fetchFailed.seasonStatsAvailable !== fetchSucceededFieldMissing.seasonStatsAvailable,
  "fetch-failed-entirely and fetch-succeeded-but-field-null produce DIFFERENT seasonStatsAvailable values",
);

// ── seasonStats fully populated ──
const fullyPopulated = buildRawContactSupportingInputs(
  { inningsPitched: 120.1, homeRunsAllowed: 14, bbPer9: 2.8 },
  { ipVarianceLast3: 0.9 },
);
ok(fullyPopulated.seasonStatsAvailable === true, "fully populated seasonStats → seasonStatsAvailable=true");
ok(fullyPopulated.inningsPitchedSeason === 120.1, "inningsPitchedSeason passed through verbatim");
ok(fullyPopulated.homeRunsAllowedSeason === 14, "homeRunsAllowedSeason passed through verbatim");
ok(fullyPopulated.bb9Season === 2.8, "bb9Season passed through verbatim");

// ── recentStarts mirrors the identical pattern ──
const recentStartsFailed = buildRawContactSupportingInputs({ inningsPitched: 100, homeRunsAllowed: 10, bbPer9: 3 }, null);
ok(recentStartsFailed.recentStartsAvailable === false, "recentStarts=null (fetch failure) → recentStartsAvailable=false");
ok(recentStartsFailed.ipVarianceLast3 === null, "recentStarts=null → ipVarianceLast3 null");

const recentStartsSucceededFieldMissing = buildRawContactSupportingInputs(
  { inningsPitched: 100, homeRunsAllowed: 10, bbPer9: 3 },
  { ipVarianceLast3: null },
);
ok(recentStartsSucceededFieldMissing.recentStartsAvailable === true, "recentStarts={...} (fetch succeeded) → recentStartsAvailable=true, even with a null field");
ok(recentStartsSucceededFieldMissing.ipVarianceLast3 === null, "ipVarianceLast3 still surfaces as null when the fetched object carries no value");

console.log(`\nrawContactSnapshotUpstreamAvailability.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
