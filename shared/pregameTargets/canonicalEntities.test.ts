// Run: npx tsx shared/pregameTargets/canonicalEntities.test.ts
import {
  type EntityDirectoryEntry,
  buildCanonicalId,
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
  ok(!badSport.ok && badSport.reason === "unknown_sport", "unknown sport → unknown_sport");
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
  const dupes: EntityDirectoryEntry[] = [
    { sport: "nba", kind: "player", nativeId: "9", canonicalId: "nba:player:9a", activeFrom: null, activeTo: null },
    { sport: "nba", kind: "player", nativeId: "9", canonicalId: "nba:player:9b", activeFrom: null, activeTo: null },
  ];
  const r = resolveCanonicalEntity("nba:player:9", dupes, asOf);
  ok(!r.ok && r.reason === "ambiguous", "two overlapping candidates → ambiguous (fail closed)");
}

console.log(`\ncanonicalEntities.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
