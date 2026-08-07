// Run: npx tsx server/pregameTargets/ingestion/replayParity.test.ts
// Pregame Targets PR5 — as-of replay over ingested feature rows: byte-equivalent
// reconstruction, honest knownAt (a prediction before fetchedAt sees nothing),
// equal-timestamp follows the PR1 firewall (knownAt <= predictionAt), missing vs
// observed_zero distinct through replay, and a correction is invisible to a replay
// before it.
import { createInMemoryAsOfFeatureStore } from "../featureStore/asOfFeatureStore";
import { replayOrigin, serializeReplayResult } from "../replay/historicalReplayHarness";
import { buildNbaFeatureRows } from "./nbaFeatureBuilder";
import type { NbaNormalizedGameRecord } from "./nbaSourceContracts";
import type { AsOfFeatureRow } from "../../../shared/pregameTargets/featureStore";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const ts = (fetchedAt: string) => ({ sourceEffectiveAt: "", sourcePublishedAt: null, fetchedAt, knownAtPolicyVersion: "v1" });
function record(over: Partial<NbaNormalizedGameRecord>): NbaNormalizedGameRecord {
  return { gameId: "0022300500", gameDate: "2026-01-15", teamTricode: "DEN", minutes: 34, points: 30, rebounds: 8, assists: 6, threePointersMade: 3, timestamps: ts("2026-08-05T18:00:00Z"), ...over };
}
const RATE_KEYS = ["nba.player.points_per_min", "nba.player.rebounds_per_min", "nba.player.assists_per_min", "nba.player.three_pointers_made_per_min", "nba.player.minutes"];
const origin = (predictionAt: string) => ({ sport: "nba" as const, entityCanonicalId: "nba:player:201939", predictionAt, featureKeys: RATE_KEYS });

function buildStore(rows: AsOfFeatureRow[]) {
  const s = createInMemoryAsOfFeatureStore();
  s.writeMany(rows);
  return s;
}

// ── Byte-equivalent reconstruction from identically-ingested rows ───────────
{
  const rows1 = buildNbaFeatureRows({ season: 2026, playerNativeId: "201939", sourceId: "snap", records: [record({})] }).rows;
  const rows2 = buildNbaFeatureRows({ season: 2026, playerNativeId: "201939", sourceId: "snap", records: [record({})] }).rows;
  const a = serializeReplayResult(replayOrigin(buildStore(rows1), origin("2026-08-06T00:00:00Z")));
  const b = serializeReplayResult(replayOrigin(buildStore(rows2), origin("2026-08-06T00:00:00Z")));
  ok(a === b, "byte-equivalent replay over identically-ingested feature rows");
}

// ── Honest knownAt: a prediction BEFORE fetchedAt sees nothing (not leaked) ──
{
  const rows = buildNbaFeatureRows({ season: 2026, playerNativeId: "201939", sourceId: "snap", records: [record({})] }).rows;
  const store = buildStore(rows);
  // fetchedAt = 2026-08-05T18:00Z. A prediction AFTER the game but BEFORE the fetch:
  const before = replayOrigin(store, origin("2026-03-01T00:00:00Z"));
  ok(RATE_KEYS.every((k) => before.missing.includes(k)), "prediction before fetchedAt sees every feature as missing (honest knownAt, no game-date leak)");
  const after = replayOrigin(store, origin("2026-08-06T00:00:00Z"));
  ok(after.features["nba.player.points_per_min"] !== undefined, "prediction after fetchedAt sees the feature");
}

// ── Equal timestamp: knownAt == predictionAt is admissible (PR1 firewall) ────
{
  const rows = buildNbaFeatureRows({ season: 2026, playerNativeId: "201939", sourceId: "snap", records: [record({ timestamps: ts("2026-08-05T18:00:00Z") })] }).rows;
  const res = replayOrigin(buildStore(rows), origin("2026-08-05T18:00:00Z")); // predictionAt == knownAt
  ok(res.features["nba.player.points_per_min"] !== undefined, "knownAt == predictionAt is included (knownAt <= predictionAt)");
}

// ── Missing vs observed_zero distinct through replay ────────────────────────
{
  const rows = buildNbaFeatureRows({ season: 2026, playerNativeId: "201939", sourceId: "snap", records: [record({ minutes: 20, points: 0, threePointersMade: null })] }).rows;
  const res = replayOrigin(buildStore(rows), origin("2026-08-06T00:00:00Z"));
  ok(res.features["nba.player.points_per_min"]?.state === "observed_zero", "observed_zero survives replay distinctly");
  ok(res.features["nba.player.three_pointers_made_per_min"]?.state === "missing", "missing survives replay distinctly");
  ok(res.features["nba.player.points_per_min"]?.value === 0 && res.features["nba.player.three_pointers_made_per_min"]?.value === null, "0 vs null preserved through replay");
}

// ── Correction invisible to a replay BEFORE it ──────────────────────────────
{
  // Two feature rows for the SAME game: original (fetched T1, value 30/34) then a
  // correction (fetched T2 > T1, value 33/34).
  const orig = buildNbaFeatureRows({ season: 2026, playerNativeId: "201939", sourceId: "snapA", records: [record({ points: 30, timestamps: ts("2026-08-05T18:00:00Z") })] }).rows;
  const corr = buildNbaFeatureRows({ season: 2026, playerNativeId: "201939", sourceId: "snapB", records: [record({ points: 33, timestamps: ts("2026-08-06T18:00:00Z") })] }).rows;
  const store = buildStore([...orig, ...corr]);
  // Replay BETWEEN the two fetches → sees the ORIGINAL value only.
  const between = replayOrigin(store, origin("2026-08-06T00:00:00Z"));
  ok(Math.abs((between.features["nba.player.points_per_min"]?.value ?? -1) - 30 / 34) < 1e-9, "replay before the correction sees the ORIGINAL value");
  // Replay AFTER the correction → sees the corrected value.
  const after = replayOrigin(store, origin("2026-08-07T00:00:00Z"));
  ok(Math.abs((after.features["nba.player.points_per_min"]?.value ?? -1) - 33 / 34) < 1e-9, "replay after the correction sees the corrected value");
}

console.log(`\nreplayParity.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
