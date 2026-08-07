// Run: npx tsx server/pregameTargets/ingestion/nbaFeatureBuilder.test.ts
// Pregame Targets PR5 — feature builder: honest knownAt policy (knownAt=fetchedAt,
// validAt=game date, never game-date-as-knownAt), missing vs observed_zero vs
// not_applicable distinct, known-before-valid rejection, structural validity, no
// line/price/EV/outcome field.
import { buildNbaFeatureRows, NBA_MINUTES_FEATURE } from "./nbaFeatureBuilder";
import type { NbaNormalizedGameRecord } from "./nbaSourceContracts";
import { isStructurallyValidFeatureRow } from "../../../shared/pregameTargets/featureStore";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const ts = (fetchedAt: string) => ({ sourceEffectiveAt: "", sourcePublishedAt: null, fetchedAt, knownAtPolicyVersion: "nba_gamelog_knownAt_v1" });
function rec(over: Partial<NbaNormalizedGameRecord>): NbaNormalizedGameRecord {
  return { gameId: "0022300500", gameDate: "2024-01-15", teamTricode: "DEN", minutes: 34, points: 30, rebounds: 8, assists: 6, threePointersMade: 3, timestamps: ts("2026-08-05T18:00:00Z"), ...over };
}

// ── Honest knownAt policy: knownAt = fetchedAt, validAt = game date ─────────
{
  const { rows } = buildNbaFeatureRows({ season: 2024, playerNativeId: "201939", sourceId: "snap1", records: [rec({})] });
  const pts = rows.find((r) => r.featureKey === "nba.player.points_per_min")!;
  ok(pts.knownAt === "2026-08-05T18:00:00Z", "knownAt = fetchedAt (never the game date)");
  ok(pts.validAt === "2024-01-15T00:00:00Z", "validAt = source-effective game date");
  ok(pts.knownAt !== pts.validAt, "knownAt is NOT the game date");
  ok(Math.abs(pts.value! - 30 / 34) < 1e-9, "per-min rate = stat / minutes");
  ok(rows.every((r) => isStructurallyValidFeatureRow(r)), "all emitted rows structurally valid");
  ok(rows.every((r) => r.entityCanonicalId === "nba:player:201939"), "canonical player id");
  ok(rows.every((r) => (r.derivedFromGameIds ?? [])[0] === "nba:game:0022300500"), "derived-from canonical game id");
}

// ── missing vs observed_zero vs not_applicable distinct ─────────────────────
{
  // minutes 20, points 0 (observed_zero), FG3M null (missing).
  const { rows } = buildNbaFeatureRows({ season: 2024, playerNativeId: "1", sourceId: "s", records: [rec({ minutes: 20, points: 0, threePointersMade: null })] });
  ok(rows.find((r) => r.featureKey === "nba.player.points_per_min")!.state === "observed_zero", "points 0 → observed_zero");
  ok(rows.find((r) => r.featureKey === "nba.player.points_per_min")!.value === 0, "observed_zero carries finite 0");
  ok(rows.find((r) => r.featureKey === "nba.player.three_pointers_made_per_min")!.state === "missing", "omitted stat → missing");
  ok(rows.find((r) => r.featureKey === "nba.player.three_pointers_made_per_min")!.value === null, "missing carries null (never 0-for-absent)");
}

// ── DNP (minutes 0) → rate features not_applicable; minutes observed_zero ────
{
  const { rows } = buildNbaFeatureRows({ season: 2024, playerNativeId: "1", sourceId: "s", records: [rec({ minutes: 0, points: 0, rebounds: 0, assists: 0, threePointersMade: 0 })] });
  ok(rows.find((r) => r.featureKey === NBA_MINUTES_FEATURE)!.state === "observed_zero", "0 minutes → minutes observed_zero");
  ok(rows.find((r) => r.featureKey === "nba.player.points_per_min")!.state === "not_applicable", "DNP → rate not_applicable (no rate defined)");
}

// ── minutes null → all readings for the game are missing ────────────────────
{
  const { rows } = buildNbaFeatureRows({ season: 2024, playerNativeId: "1", sourceId: "s", records: [rec({ minutes: null })] });
  ok(rows.every((r) => r.state === "missing"), "null minutes → every reading missing (never fabricated)");
}

// ── known-before-valid rejected (impossible: observed before it became true) ─
{
  // fetchedAt BEFORE the game date.
  const { rows, skipped } = buildNbaFeatureRows({ season: 2024, playerNativeId: "1", sourceId: "s", records: [rec({ gameDate: "2024-01-15", timestamps: ts("2024-01-14T00:00:00Z") })] });
  ok(rows.length === 0, "known-before-valid game emits no rows");
  ok(skipped.some((s) => s.reason === "known_before_valid"), "reason recorded: known_before_valid");
}

// ── invalid game date → skipped with reason (no fabricated instant) ─────────
{
  const { rows, skipped } = buildNbaFeatureRows({ season: 2024, playerNativeId: "1", sourceId: "s", records: [rec({ gameDate: "nonsense" })] });
  ok(rows.length === 0 && skipped.some((s) => s.reason === "invalid_game_date"), "invalid game date → skipped, not fabricated");
}

// ── No line/price/EV/outcome key on any emitted row ─────────────────────────
{
  const { rows } = buildNbaFeatureRows({ season: 2024, playerNativeId: "1", sourceId: "s", records: [rec({})] });
  const forbidden = ["line", "price", "odds", "edge", "ev", "payout", "sportsbook", "result", "outcome", "settlement"];
  ok(rows.every((r) => !Object.keys(r).some((k) => forbidden.includes(k.toLowerCase()))), "no line/price/EV/outcome key on feature rows");
}

console.log(`\nnbaFeatureBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
