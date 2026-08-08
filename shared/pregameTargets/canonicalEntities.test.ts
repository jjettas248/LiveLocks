// Run: npx tsx shared/pregameTargets/canonicalEntities.test.ts
import {
  type EntityDirectoryEntry,
  buildCanonicalId,
  canonicalGameId,
  isoInstantMs,
  normalizeGameKey,
  parseCanonicalId,
  resolveCanonicalEntity,
} from "./canonicalEntities";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── build / parse round-trip ─────────────────────────────────────────────────
{
  const id = buildCanonicalId("nba", "player", "12345");
  ok(id === "nba:player:12345", "canonical id is sport:kind:nativeId");
  const p = parseCanonicalId(id);
  ok(p !== null && p.sport === "nba" && p.kind === "player" && p.nativeId === "12345", "round-trips");
  ok(parseCanonicalId("nba:player:") === null, "empty native id → null");
  ok(parseCanonicalId("nbaplayer12345") === null, "no separators → null");
  ok(parseCanonicalId("nba:sasquatch:1") === null, "unknown kind → null (parse)");
  ok(parseCanonicalId("xfl:player:1") === null, "unknown sport → null (parse)");
  // PR6: NFL is now a canonical pregame sport; MLB/NCAAB are NOT.
  const nflId = buildCanonicalId("nfl", "player", "00-0036355");
  ok(nflId === "nfl:player:00-0036355", "NFL canonical id (gsis-style native id) builds");
  const np = parseCanonicalId(nflId);
  ok(np !== null && np.sport === "nfl" && np.kind === "player" && np.nativeId === "00-0036355", "NFL id round-trips");
  ok(buildCanonicalId("nfl", "team", "KC") === "nfl:team:KC", "NFL team canonical id builds");
  ok(parseCanonicalId("mlb:player:1") === null, "MLB is not a pregame sport → null (parse)");
  ok(parseCanonicalId("ncaab:player:1") === null, "NCAAB is not a pregame sport → null (parse)");
  // Native id is trimmed so incidental whitespace can't split identity.
  ok(buildCanonicalId("nba", "player", "  123 ") === "nba:player:123", "buildCanonicalId trims native-id whitespace");
  const trimmedDir: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: "123", canonicalId: "nba:player:123", activeFrom: null, activeTo: null },
  ];
  const wsResolved = resolveCanonicalEntity(buildCanonicalId("nba", "player", " 123 "), trimmedDir, "2026-01-15T00:00:00.000Z");
  ok(wsResolved.ok && wsResolved.entity.canonicalId === "nba:player:123", "a whitespaced native id joins the same canonical entity");
  // The DIRECTORY row itself may carry a whitespaced native id while its
  // canonicalId is already normalized (built via buildCanonicalId). It is
  // self-consistent and must still match a normalized request — resolution
  // compares trimmed native ids, not raw ones.
  const wsDir: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: " 123 ", canonicalId: "nba:player:123", activeFrom: null, activeTo: null },
  ];
  const wsDirResolved = resolveCanonicalEntity("nba:player:123", wsDir, "2026-01-15T00:00:00.000Z");
  ok(wsDirResolved.ok && wsDirResolved.entity.canonicalId === "nba:player:123", "a directory row with a whitespaced native id still resolves the normalized request");
}

// ── fail-closed resolution ───────────────────────────────────────────────────
const asOf = "2026-01-15T00:00:00.000Z";
const dir: EntityDirectoryEntry[] = [
  { sport: "nba", kind: "player", nativeId: "1", canonicalId: "nba:player:1", displayName: "A", activeFrom: null, activeTo: null },
];
{
  const r = resolveCanonicalEntity("nba:player:1", dir, asOf);
  ok(r.ok && r.entity.canonicalId === "nba:player:1", "resolves a known id");
  const bad = resolveCanonicalEntity("nba:player:999", dir, asOf);
  ok(!bad.ok && bad.reason === "unknown_id", "unknown native id → unknown_id");
  const badSport = resolveCanonicalEntity("xfl:player:1", dir, asOf);
  ok(!badSport.ok && badSport.reason === "unknown_sport", "unknown sport → unknown_sport (xfl still rejected)");
  const badKind = resolveCanonicalEntity("nba:sasquatch:1", dir, asOf);
  ok(!badKind.ok && badKind.reason === "unknown_kind", "unknown kind → unknown_kind");
  const malformed = resolveCanonicalEntity("garbage", dir, asOf);
  ok(!malformed.ok && malformed.reason === "malformed_id", "malformed id → malformed_id");
  const badAsOf = resolveCanonicalEntity("nba:player:1", dir, "not-a-date");
  ok(!badAsOf.ok && badAsOf.reason === "malformed_id", "bad as-of instant → malformed_id");
}

// ── trade handoff: half-open windows, unique resolution per instant ──────────
{
  // Same nativeId, two disjoint windows (traded at 2026-01-10T00:00Z).
  const traded: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: "7", canonicalId: "nba:player:7", activeFrom: null, activeTo: "2026-01-10T00:00:00.000Z" },
    { sport: "nba", kind: "player", nativeId: "7", canonicalId: "nba:player:7", activeFrom: "2026-01-10T00:00:00.000Z", activeTo: null },
  ];
  const before = resolveCanonicalEntity("nba:player:7", traded, "2026-01-05T00:00:00.000Z");
  const after = resolveCanonicalEntity("nba:player:7", traded, "2026-01-20T00:00:00.000Z");
  ok(before.ok, "resolves uniquely before the trade");
  ok(after.ok, "resolves uniquely after the trade");
  // Exactly at the boundary: [from, to) is half-open so the handoff is clean (one match, not two).
  const atBoundary = resolveCanonicalEntity("nba:player:7", traded, "2026-01-10T00:00:00.000Z");
  ok(atBoundary.ok, "half-open windows give exactly one match at the trade instant");
}

// ── genuine ambiguity is rejected, never guessed ─────────────────────────────
{
  // Two consistent rows for the same identity with OVERLAPPING windows — the
  // temporal data doesn't cleanly partition, so resolution fails closed.
  const dupes: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: "9", canonicalId: "nba:player:9", activeFrom: null, activeTo: null },
    { sport: "nba", kind: "player", nativeId: "9", canonicalId: "nba:player:9", activeFrom: null, activeTo: null },
  ];
  const r = resolveCanonicalEntity("nba:player:9", dupes, asOf);
  ok(!r.ok && r.reason === "ambiguous", "two overlapping candidates → ambiguous (fail closed)");
}

// ── self-inconsistent directory row is never used (fail-closed identity) ─────
{
  // The redundant canonicalId contradicts the row's own (sport, kind, nativeId).
  const inconsistent: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: "1", canonicalId: "nba:player:2", activeFrom: null, activeTo: null },
  ];
  const r = resolveCanonicalEntity("nba:player:1", inconsistent, asOf);
  ok(!r.ok && r.reason === "unknown_id", "a row whose canonicalId contradicts its identity is skipped (never returned)");
  // A consistent row alongside the bad one still resolves — to the CORRECT identity.
  const mixed: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: "1", canonicalId: "nba:player:2", activeFrom: null, activeTo: null },
    { sport: "nba", kind: "player", nativeId: "1", canonicalId: "nba:player:1", activeFrom: null, activeTo: null },
  ];
  const r2 = resolveCanonicalEntity("nba:player:1", mixed, asOf);
  ok(r2.ok && r2.entity.canonicalId === "nba:player:1", "resolved canonicalId always equals the request, never a mismatched row's id");
}

// ── a corrupt directory row (non-string nativeId) never aborts resolution ────
{
  // A jsonb-backed directory could hand back a null / numeric nativeId; the
  // resolver must SKIP it (fail closed), never throw in trim()/buildCanonicalId.
  const corruptOnly: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: null as never, canonicalId: "nba:player:1", activeFrom: null, activeTo: null },
  ];
  let threw = false;
  let rc: ReturnType<typeof resolveCanonicalEntity> | undefined;
  try {
    rc = resolveCanonicalEntity("nba:player:1", corruptOnly, asOf);
  } catch {
    threw = true;
  }
  ok(!threw, "a non-string nativeId in the directory does not throw during resolution");
  ok(!!rc && !rc.ok && rc.reason === "unknown_id", "a corrupt-only directory fails closed → unknown_id");
  // A corrupt row alongside a valid one must not prevent the valid match.
  const corruptPlusValid: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: 1 as never, canonicalId: "nba:player:1", activeFrom: null, activeTo: null },
    { sport: "nba", kind: "player", nativeId: "1", canonicalId: "nba:player:1", activeFrom: null, activeTo: null },
  ];
  const rv = resolveCanonicalEntity("nba:player:1", corruptPlusValid, asOf);
  ok(rv.ok && rv.entity.canonicalId === "nba:player:1", "a corrupt row does not abort resolution — the valid row still matches");
}

// ── offsetless instants are rejected (timezone-independent cutoff) ──────────
{
  const r = resolveCanonicalEntity("nba:player:1", dir, "2026-01-15T00:00:00"); // no Z/offset
  ok(!r.ok && r.reason === "malformed_id", "offsetless as-of instant is rejected (would be process-TZ dependent)");
  const windowed: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: "1", canonicalId: "nba:player:1", activeFrom: "2026-01-01T00:00:00", activeTo: null },
  ];
  const r2 = resolveCanonicalEntity("nba:player:1", windowed, asOf);
  ok(!r2.ok, "an offsetless window bound makes the row ineligible (fail closed)");
}

// ── isoInstantMs rejects out-of-range calendar dates (no silent normalization)
{
  ok(Number.isFinite(isoInstantMs("2026-01-10T05:00:00.000Z")), "a real instant parses");
  ok(Number.isFinite(isoInstantMs("2026-01-10T05:00:00-05:00")), "explicit offset parses");
  ok(!Number.isFinite(isoInstantMs("2026-02-31T00:00:00Z")), "Feb 31 → NaN (V8 would normalize to Mar 3)");
  ok(!Number.isFinite(isoInstantMs("2026-00-10T00:00:00Z")), "month 00 → NaN");
  ok(!Number.isFinite(isoInstantMs("2026-01-00T00:00:00Z")), "day 00 → NaN");
  ok(!Number.isFinite(isoInstantMs("2026-04-31T00:00:00Z")), "Apr 31 → NaN (April has 30 days)");
  ok(!Number.isFinite(isoInstantMs("2026-01-10T24:00:00Z")), "hour 24 → NaN");
  ok(!Number.isFinite(isoInstantMs("2026-01-10T05:60:00Z")), "minute 60 → NaN");
  ok(Number.isFinite(isoInstantMs("2024-02-29T00:00:00Z")), "leap-year Feb 29 is a real date");
  ok(!Number.isFinite(isoInstantMs("2026-02-29T00:00:00Z")), "non-leap-year Feb 29 → NaN");
  // A resolution using an overflow as-of date fails closed as malformed.
  const rBad = resolveCanonicalEntity("nba:player:1", dir, "2026-02-31T00:00:00Z");
  ok(!rBad.ok && rBad.reason === "malformed_id", "an overflow as-of calendar date is rejected as malformed_id");
}

// ── canonicalGameId (strict) vs normalizeGameKey (lenient) ───────────────────
{
  ok(canonicalGameId("nba:game:123") === "nba:game:123", "a canonical game id returns its canonical form");
  ok(canonicalGameId("nba:game:123 ") === "nba:game:123", "a whitespaced canonical game id is normalized");
  ok(canonicalGameId("TARGET") === null, "a bare native id is NOT a canonical game id → null");
  ok(canonicalGameId("nba:player:1") === null, "a wrong-kind (player) canonical id → null");
  ok(canonicalGameId("garbage") === null, "an unparseable id → null");
  ok(canonicalGameId(123 as never) === null, "a non-string → null (never throws)");
  // A blank (whitespace-only) native segment must NOT normalize to "nba:game:" —
  // it has no identity and would silently pass the strict fail-closed guards.
  ok(parseCanonicalId("nba:game:   ") === null, "a whitespace-only native id does not parse");
  ok(canonicalGameId("nba:game:   ") === null, "a whitespace-only native game id → null (not \"nba:game:\")");
  ok(canonicalGameId("nba:game:") === null, "a truly empty native game id → null");
  // normalizeGameKey is lenient: canonical game ids normalize, everything else
  // is passed through trimmed (opaque key), and it never returns null.
  ok(normalizeGameKey("nba:game:123 ") === "nba:game:123", "normalizeGameKey canonicalizes a game id");
  ok(normalizeGameKey("  g1 ") === "g1", "normalizeGameKey trims a non-canonical opaque key");
}

console.log(`\ncanonicalEntities.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
