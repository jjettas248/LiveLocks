// Run: npx tsx server/pregameTargets/ingestion/rawSnapshotIdentity.test.ts
// Pregame Targets PR5 — raw-snapshot identity: deterministic content hash +
// snapshotId, identical content → same id (idempotent), correction → new id +
// supersession classification.
import { canonicalJson, computeContentHash, computeSnapshotId, buildRawSnapshotIdentity, classifySupersession } from "./rawSnapshotIdentity";
import { buildNbaGameLogSourceKey } from "./nbaSourceContracts";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const payloadA = { resultSets: [{ headers: ["GAME_ID", "PTS"], rowSet: [["1", 20]] }] };
const payloadAreordered = { resultSets: [{ rowSet: [["1", 20]], headers: ["GAME_ID", "PTS"] }] };
const payloadB = { resultSets: [{ headers: ["GAME_ID", "PTS"], rowSet: [["1", 21]] }] }; // corrected PTS

// ── Canonical serialization is key-order-independent + lossy-value-explicit ──
{
  ok(canonicalJson(payloadA) === canonicalJson(payloadAreordered), "canonicalJson is key-order-independent");
  ok(canonicalJson(NaN) === "@NaN" && canonicalJson(undefined) === "@undefined", "explicit lossy sentinels");
  ok(canonicalJson(NaN) !== canonicalJson("@NaN"), "NaN token != string @NaN (no collision)");
}

// ── Content hash + snapshotId deterministic; identical content → same id ─────
{
  ok(computeContentHash(payloadA) === computeContentHash(payloadAreordered), "identical content (any key order) → same content hash");
  const id1 = buildRawSnapshotIdentity("k", "sk", payloadA);
  const id2 = buildRawSnapshotIdentity("k", "sk", payloadAreordered);
  ok(id1.snapshotId === id2.snapshotId, "identical content → same snapshotId (idempotent capture)");
  ok(id1.snapshotId.length === 64 && id1.contentHash.length === 64, "sha256 hex ids");
}

// ── Correction → different content hash → different snapshotId ───────────────
{
  const idA = buildRawSnapshotIdentity("k", "sk", payloadA);
  const idB = buildRawSnapshotIdentity("k", "sk", payloadB);
  ok(idA.contentHash !== idB.contentHash, "corrected content → different content hash");
  ok(idA.snapshotId !== idB.snapshotId, "corrected content → different snapshotId (new immutable snapshot)");
  // Different sourceKey also separates identity even for identical content.
  ok(buildRawSnapshotIdentity("k", "sk2", payloadA).snapshotId !== idA.snapshotId, "different sourceKey → different snapshotId");
}

// ── Supersession classification ─────────────────────────────────────────────
{
  const idA = buildRawSnapshotIdentity("k", "sk", payloadA);
  const idAagain = buildRawSnapshotIdentity("k", "sk", payloadAreordered);
  const idB = buildRawSnapshotIdentity("k", "sk", payloadB);
  ok(classifySupersession(null, idA) === "first_capture", "no prior → first_capture");
  ok(classifySupersession(idA, idAagain) === "identical", "same content → identical (no-op)");
  ok(classifySupersession(idA, idB) === "correction", "changed content → correction");
}

// ── Canonical sourceKey: every locked semantic component separates identity ─
{
  const sid = (over: Partial<Parameters<typeof buildNbaGameLogSourceKey>[0]>) => {
    const key = buildNbaGameLogSourceKey({ sourceKind: "nba_stats_playergamelog", entityCanonicalId: "nba:player:1", season: 2026, seasonType: "Regular Season", ...over });
    return buildRawSnapshotIdentity("nba_stats_playergamelog", key, payloadA).snapshotId;
  };
  const baseId = sid({});
  // Two SEASONS with identical provider identifiers cannot collide.
  ok(sid({ season: 2025 }) !== baseId, "different season → different snapshotId");
  // Two SOURCE-VERSION interpretations of the same payload cannot collide.
  ok(sid({ sourceVersion: "nba_stats_gamelog_v2" }) !== baseId, "different source version → different snapshotId (same bytes)");
  // Player vs TEAM identity cannot collide.
  ok(sid({ sourceKind: "nba_stats_teamgamelog", entityCanonicalId: "nba:team:1" }) !== baseId, "player vs team → different snapshotId");
  // Different canonical ENTITY cannot collide.
  ok(sid({ entityCanonicalId: "nba:player:2" }) !== baseId, "different entity → different snapshotId");
  // Identical everything → SAME id (idempotent).
  ok(sid({}) === baseId, "identical semantic key + content → same snapshotId");
  // Two DIFFERENT games with identical stat CONTENT cannot collide (GAME_ID in payload).
  const gameX = { resultSets: [{ headers: ["GAME_ID", "PTS"], rowSet: [["GAME_X", 20]] }] };
  const gameY = { resultSets: [{ headers: ["GAME_ID", "PTS"], rowSet: [["GAME_Y", 20]] }] };
  ok(computeContentHash(gameX) !== computeContentHash(gameY), "two games with identical stats but different GAME_ID → different content hash (no collision)");
}

console.log(`\nrawSnapshotIdentity.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
