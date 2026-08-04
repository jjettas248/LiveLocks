// Run: npx tsx shared/pregameTargets/featureStore.test.ts
import {
  type AsOfFeatureRow,
  FEATURE_STATES,
  VALUE_BEARING_STATES,
  asOfRowFromPersisted,
  instantMs,
  isFeatureState,
  isStructurallyValidFeatureRow,
  readableValue,
} from "./featureStore";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function row(over: Partial<AsOfFeatureRow> = {}): AsOfFeatureRow {
  return {
    sport: "nba",
    entityCanonicalId: "nba:player:1",
    entityKind: "player",
    featureKey: "nba.player.reb_per_min",
    featureVersion: "v1",
    season: 2026,
    validAt: "2026-01-10T02:30:00.000Z",
    knownAt: "2026-01-10T05:00:00.000Z",
    state: "observed",
    value: 0.18,
    sourceId: "snap-1",
    ...over,
  };
}

// ── State enum ───────────────────────────────────────────────────────────────
{
  ok(FEATURE_STATES.length === 7, "seven feature states defined");
  ok(isFeatureState("observed_zero") && isFeatureState("missing"), "known states recognized");
  ok(!isFeatureState("bogus") && !isFeatureState(null), "unknown/non-string rejected");
  ok(
    VALUE_BEARING_STATES.has("observed") &&
      VALUE_BEARING_STATES.has("observed_zero") &&
      VALUE_BEARING_STATES.has("imputed"),
    "observed / observed_zero / imputed are value-bearing",
  );
  ok(
    !VALUE_BEARING_STATES.has("missing") &&
      !VALUE_BEARING_STATES.has("not_applicable") &&
      !VALUE_BEARING_STATES.has("stale") &&
      !VALUE_BEARING_STATES.has("disagreement"),
    "missing / n-a / stale / disagreement are NOT value-bearing",
  );
}

// ── missing vs observed_zero are structurally distinct ───────────────────────
{
  const observedZero = row({ state: "observed_zero", value: 0 });
  const missing = row({ state: "missing", value: null });
  ok(isStructurallyValidFeatureRow(observedZero), "observed_zero with value 0 is valid");
  ok(isStructurallyValidFeatureRow(missing), "missing with null value is valid");
  ok(readableValue(observedZero) === 0, "observed_zero reads as a real 0");
  ok(readableValue(missing) === null, "missing reads as null, never 0");
  ok(readableValue(observedZero) !== readableValue(missing), "observed_zero and missing are never conflated");
  // observed_zero must be EXACTLY 0 — a nonzero/null value under this state
  // would defeat the measured-zero distinction the contract exists to protect.
  ok(!isStructurallyValidFeatureRow(row({ state: "observed_zero", value: 0.3 })), "observed_zero with a nonzero value is invalid");
  ok(!isStructurallyValidFeatureRow(row({ state: "observed_zero", value: null })), "observed_zero with null is invalid (must be 0)");
}

// ── Structural validity of state↔value pairing ───────────────────────────────
{
  ok(!isStructurallyValidFeatureRow(row({ state: "observed", value: null })), "value-bearing state with null value is invalid");
  ok(!isStructurallyValidFeatureRow(row({ state: "observed", value: NaN })), "value-bearing state with NaN is invalid");
  ok(!isStructurallyValidFeatureRow(row({ state: "observed", value: Infinity })), "value-bearing state with Infinity is invalid");
  ok(!isStructurallyValidFeatureRow(row({ state: "missing", value: 0 })), "non-value-bearing state with 0 value is invalid (must be null)");
  ok(!isStructurallyValidFeatureRow(row({ state: "stale", value: 5 })), "stale with a numeric value is invalid");
  ok(isStructurallyValidFeatureRow(row({ state: "not_applicable", value: null })), "not_applicable with null is valid");
  // A state OUTSIDE the enum (typo) must be rejected — it has no semantics and
  // must never slip through the non-value-bearing path into the firewall.
  ok(!isStructurallyValidFeatureRow(row({ state: "observd" as never, value: null })), "typo state (not in enum) is invalid even with null value");
  ok(!isStructurallyValidFeatureRow(row({ state: "" as never, value: null })), "empty state is invalid");
}

// ── Instant + field validity ─────────────────────────────────────────────────
{
  ok(!isStructurallyValidFeatureRow(row({ validAt: "not-a-date" })), "unparseable validAt is invalid");
  ok(!isStructurallyValidFeatureRow(row({ knownAt: "" })), "empty knownAt is invalid");
  ok(!isStructurallyValidFeatureRow(row({ featureKey: "" })), "empty featureKey is invalid");
  ok(!isStructurallyValidFeatureRow(row({ featureVersion: "" })), "empty featureVersion is invalid");
  ok(!isStructurallyValidFeatureRow(row({ season: 2026.5 })), "non-integer season is invalid");
  // Identity fields must be internally consistent with the canonical id.
  ok(!isStructurallyValidFeatureRow(row({ entityKind: "team" })), "entityKind not matching the canonical id's kind is invalid");
  ok(!isStructurallyValidFeatureRow(row({ entityCanonicalId: "nba:team:1", entityKind: "player" })), "canonical-id kind vs entityKind mismatch is invalid");
  ok(!isStructurallyValidFeatureRow(row({ entityCanonicalId: "garbage" })), "unparseable canonical id is invalid");
  ok(!isStructurallyValidFeatureRow(row({ sourceId: "" })), "empty sourceId is invalid");
  ok(isStructurallyValidFeatureRow(row({ entityCanonicalId: "nba:team:5", entityKind: "team" })), "a consistent team identity is valid");
  // Provenance, when present, must be an array of NORMALIZED CANONICAL game ids
  // (jsonb-safe) — not merely strings. The firewall's exact self-update match
  // only recognizes the canonical, trimmed form, so anything else is rejected.
  ok(!isStructurallyValidFeatureRow(row({ derivedFromGameIds: {} as never })), "non-array derivedFromGameIds is invalid");
  ok(!isStructurallyValidFeatureRow(row({ derivedFromGameIds: "nba:game:1" as never })), "string derivedFromGameIds is invalid");
  ok(!isStructurallyValidFeatureRow(row({ derivedFromGameIds: [1, 2] as never })), "array of non-strings is invalid");
  ok(!isStructurallyValidFeatureRow(row({ derivedFromGameIds: ["g1", "g2"] })), "bare (non-canonical) game ids are invalid");
  ok(!isStructurallyValidFeatureRow(row({ derivedFromGameIds: ["nba:player:1"] })), "a non-game canonical id in provenance is invalid");
  ok(!isStructurallyValidFeatureRow(row({ derivedFromGameIds: ["nba:game:1 "] })), "an un-normalized (trailing-space) game id is invalid — the firewall's exact match would miss it");
  ok(!isStructurallyValidFeatureRow(row({ sport: "nba", derivedFromGameIds: ["mlb:game:1" as never] })), "a cross-sport provenance game id is invalid");
  ok(isStructurallyValidFeatureRow(row({ derivedFromGameIds: ["nba:game:1", "nba:game:2"] })), "array of normalized canonical game ids is valid");
  ok(isStructurallyValidFeatureRow(row({ derivedFromGameIds: [] })), "empty provenance array is valid");
  ok(isStructurallyValidFeatureRow(row()), "absent derivedFromGameIds is valid");
  ok(isStructurallyValidFeatureRow(row({ derivedFromGameIds: null as never })), "null provenance (nullable DB column round-trip) is treated as absent → valid");
  ok(Number.isFinite(instantMs("2026-01-10T05:00:00.000Z")), "ISO instant with Z parses to finite ms");
  ok(Number.isFinite(instantMs("2026-01-10T05:00:00-05:00")), "ISO instant with explicit offset parses");
  ok(!Number.isFinite(instantMs("garbage")), "garbage instant → NaN");
  // Offsetless datetime → NaN: Date.parse would read it in the process-local
  // zone, making knownAt <= predictionAt depend on where the process runs.
  ok(!Number.isFinite(instantMs("2026-01-10T05:00:00")), "offsetless datetime → NaN (timezone-unsafe)");
  ok(!Number.isFinite(instantMs("2026-01-10T05:00:00.000")), "offsetless datetime with millis → NaN");
  ok(!isStructurallyValidFeatureRow(row({ validAt: "2026-01-10T02:30:00" })), "offsetless validAt is structurally invalid");
  ok(!isStructurallyValidFeatureRow(row({ knownAt: "2026-01-10T05:00:00" })), "offsetless knownAt is structurally invalid");
}

// ── DB-persisted row normalization (Date instants + numeric-as-string value) ─
{
  // The exact shapes Drizzle returns: timestamptz → Date, numeric → string.
  const mapped = asOfRowFromPersisted({
    sport: "nba",
    entityCanonicalId: "nba:player:1",
    entityKind: "player",
    featureKey: "nba.player.reb_per_min",
    featureVersion: "v1",
    season: 2026,
    validAt: new Date("2026-01-10T02:30:00.000Z"),
    knownAt: new Date("2026-01-10T05:00:00.000Z"),
    state: "observed",
    value: "0.18",
    sourceId: "snap-1",
    derivedFromGameIds: null,
  });
  ok(typeof mapped.validAt === "string" && mapped.validAt === "2026-01-10T02:30:00.000Z", "Date instant → offset-bearing ISO string");
  ok(typeof mapped.knownAt === "string", "knownAt Date → ISO string");
  ok(mapped.value === 0.18, "numeric-as-string value → number");
  ok(mapped.derivedFromGameIds === undefined, "null provenance → undefined (absent)");
  ok(isStructurallyValidFeatureRow(mapped), "a normalized persisted row passes the shared contract");
  ok(Number.isFinite(instantMs(mapped.validAt)), "normalized validAt parses via instantMs (not malformed_instants)");
  // A measured-zero persisted as numeric "0" normalizes to 0 and stays valid.
  const zero = asOfRowFromPersisted({
    sport: "nba", entityCanonicalId: "nba:player:1", entityKind: "player",
    featureKey: "f", featureVersion: "v1", season: 2026,
    validAt: "2026-01-10T02:30:00.000Z", knownAt: "2026-01-10T05:00:00.000Z",
    state: "observed_zero", value: "0", sourceId: "s",
  });
  ok(zero.value === 0 && isStructurallyValidFeatureRow(zero), "observed_zero numeric \"0\" → 0, still valid");
  // Already-string instants pass through untouched.
  ok(asOfRowFromPersisted({ sport: "nba", entityCanonicalId: "nba:player:1", entityKind: "player", featureKey: "f", featureVersion: "v1", season: 2026, validAt: "2026-01-10T02:30:00.000Z", knownAt: "2026-01-10T05:00:00.000Z", state: "missing", value: null, sourceId: "s" }).knownAt === "2026-01-10T05:00:00.000Z", "string instants pass through unchanged");
}

console.log(`\nfeatureStore.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
