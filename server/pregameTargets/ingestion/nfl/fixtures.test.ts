// Run: npx tsx server/pregameTargets/ingestion/nfl/fixtures.test.ts
// PR6 — committed SYNTHETIC feasibility fixtures (__fixtures__/cases.json, "synthetic": true).
// Every representative NFL (nflverse) case — weekly parse, schedule multi-season filter,
// weekly→schedule join by game_id, and coverage classification — is validated against the
// REAL adapter / feature builder / coverage so the frozen source shapes and their honest
// normalized/classified outputs stay faithful. These mirror the real weekly + schedule CSV
// SCHEMAS; they are NOT captured live nflverse payloads (no nflverse access in this env).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseNflWeeklyStats, parseNflSchedule } from "./nflCsvAdapter";
import { buildNflFeatureRows } from "./nflFeatureBuilder";
import { buildNflCoverage } from "./nflIngestionCoverage";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const here = dirname(fileURLToPath(import.meta.url));
type WeeklyCase = { id: string; requestedSeason: number; raw: string; expected: { adapter: { ok: boolean; reason?: string; recordCount?: number; duplicateRowsCollapsed?: number; blankKeyRows?: number }; record0?: Record<string, number | null>; teamTricodes?: string[] } };
type ScheduleCase = { id: string; requestedSeason: number; raw: string; expected: { adapter: { ok: boolean; reason?: string; recordCount?: number; seasonFilteredRows?: number } } };
type JoinCase = { id: string; requestedSeason: number; weekly: string; schedule: string; fetchedAtIso: string; expected: { featureRows: number; featureBearingPlayers?: number; featureStates?: Record<string, string>; validAt?: string; unresolvedGameIds?: number; contradictoryRows?: number; skipReason?: string } };
type CoverageCase = { id: string; season: number; currentSeason: number; coverage: "adapter_retrievable" | "incomplete"; expected: { knownAtSupport: string } };
const doc = JSON.parse(readFileSync(resolve(here, "__fixtures__/cases.json"), "utf8")) as {
  synthetic: boolean; weeklyCases: WeeklyCase[]; scheduleCases: ScheduleCase[]; joinCases: JoinCase[]; coverageCases: CoverageCase[];
};

ok(doc.synthetic === true, "fixtures explicitly declared synthetic (not captured live payloads)");
ok(doc.weeklyCases.length + doc.scheduleCases.length + doc.joinCases.length + doc.coverageCases.length >= 13, "at least thirteen representative cases present");

const FETCHED = "2026-08-05T18:00:00Z";

// ── Weekly adapter cases ─────────────────────────────────────────────────────
for (const c of doc.weeklyCases) {
  const r = parseNflWeeklyStats({ requestedSeason: c.requestedSeason, sourceKey: `fixture:${c.id}`, rawPayload: c.raw, fetchedAt: FETCHED });
  ok(r.ok === c.expected.adapter.ok, `[${c.id}] weekly adapter ok=${c.expected.adapter.ok}`);
  if (!c.expected.adapter.ok) { ok(!r.ok && r.reason === c.expected.adapter.reason, `[${c.id}] reason=${c.expected.adapter.reason}`); continue; }
  if (!r.ok) continue;
  if (c.expected.adapter.recordCount !== undefined) ok(r.records.length === c.expected.adapter.recordCount, `[${c.id}] recordCount=${c.expected.adapter.recordCount}`);
  if (c.expected.adapter.duplicateRowsCollapsed !== undefined) ok(r.diagnostics.duplicateRowsCollapsed === c.expected.adapter.duplicateRowsCollapsed, `[${c.id}] duplicateRowsCollapsed=${c.expected.adapter.duplicateRowsCollapsed}`);
  if (c.expected.adapter.blankKeyRows !== undefined) ok(r.diagnostics.blankKeyRows === c.expected.adapter.blankKeyRows, `[${c.id}] blankKeyRows=${c.expected.adapter.blankKeyRows}`);
  if (c.expected.record0) {
    for (const [k, v] of Object.entries(c.expected.record0)) ok((r.records[0] as unknown as Record<string, number | null>)[k] === v, `[${c.id}] record0.${k}=${v}`);
  }
  if (c.expected.teamTricodes) {
    const got = new Set(r.records.map((x) => x.teamTricode));
    ok(c.expected.teamTricodes.every((t) => got.has(t)), `[${c.id}] team tricodes ${c.expected.teamTricodes.join(",")} retained (traded player)`);
  }
}

// ── Schedule adapter cases (multi-season filter) ─────────────────────────────
for (const c of doc.scheduleCases) {
  const r = parseNflSchedule({ requestedSeason: c.requestedSeason, sourceKey: `fixture:${c.id}`, rawPayload: c.raw, fetchedAt: FETCHED });
  ok(r.ok === c.expected.adapter.ok, `[${c.id}] schedule adapter ok=${c.expected.adapter.ok}`);
  if (!c.expected.adapter.ok) { ok(!r.ok && r.reason === c.expected.adapter.reason, `[${c.id}] reason=${c.expected.adapter.reason}`); continue; }
  if (!r.ok) continue;
  if (c.expected.adapter.recordCount !== undefined) ok(r.records.length === c.expected.adapter.recordCount, `[${c.id}] recordCount=${c.expected.adapter.recordCount}`);
  if (c.expected.adapter.seasonFilteredRows !== undefined) ok(r.diagnostics.seasonFilteredRows === c.expected.adapter.seasonFilteredRows, `[${c.id}] seasonFilteredRows=${c.expected.adapter.seasonFilteredRows}`);
}

// ── Join cases (weekly→schedule by game_id, real feature builder) ────────────
for (const c of doc.joinCases) {
  const wk = parseNflWeeklyStats({ requestedSeason: c.requestedSeason, sourceKey: `fixture:${c.id}:wk`, rawPayload: c.weekly, fetchedAt: c.fetchedAtIso });
  const sc = parseNflSchedule({ requestedSeason: c.requestedSeason, sourceKey: `fixture:${c.id}:sc`, rawPayload: c.schedule, fetchedAt: c.fetchedAtIso });
  ok(wk.ok && sc.ok, `[${c.id}] weekly + schedule both parse`);
  if (!wk.ok || !sc.ok) continue;
  const built = buildNflFeatureRows({ season: c.requestedSeason, sourceId: `join:${c.id}`, weeklyRecords: wk.records, scheduleRecords: sc.records });
  ok(built.rows.length === c.expected.featureRows, `[${c.id}] featureRows=${c.expected.featureRows}`);
  if (c.expected.featureBearingPlayers !== undefined) ok(built.stats.featureBearingPlayers === c.expected.featureBearingPlayers, `[${c.id}] featureBearingPlayers=${c.expected.featureBearingPlayers}`);
  if (c.expected.unresolvedGameIds !== undefined) ok(built.stats.unresolvedGameIds === c.expected.unresolvedGameIds, `[${c.id}] unresolvedGameIds=${c.expected.unresolvedGameIds}`);
  if (c.expected.contradictoryRows !== undefined) ok(built.stats.contradictoryRows === c.expected.contradictoryRows, `[${c.id}] contradictoryRows=${c.expected.contradictoryRows}`);
  if (c.expected.skipReason) ok(built.skipped.some((s) => s.reason === c.expected.skipReason), `[${c.id}] skip reason ${c.expected.skipReason}`);
  if (c.expected.validAt) ok(built.rows.every((r) => r.validAt === c.expected.validAt), `[${c.id}] validAt=${c.expected.validAt} (schedule gameday, never fabricated)`);
  if (c.expected.featureStates) {
    const byKey = new Map(built.rows.map((r) => [r.featureKey, r]));
    for (const [k, st] of Object.entries(c.expected.featureStates)) ok(byKey.get(k)?.state === st, `[${c.id}] ${k} state=${st}`);
  }
}

// ── Coverage cases ───────────────────────────────────────────────────────────
const zeroCounts = { rawWeeklyRows: 10, structurallyAcceptedWeeklyRows: 10, scheduleRawRows: 200, scheduleRowsForSeason: 20, scheduleResolvedRows: 10, unresolvedGameIds: 0, contradictoryRows: 0, featureBearingPlayers: 5, rawCapturesPersisted: 3, featureRowsPersisted: 50 };
for (const c of doc.coverageCases) {
  const cov = buildNflCoverage({ season: c.season, currentSeason: c.currentSeason, coverage: c.coverage, counts: zeroCounts });
  ok(cov.knownAtSupport === c.expected.knownAtSupport, `[${c.id}] knownAtSupport=${c.expected.knownAtSupport}`);
}

console.log(`\nnfl/fixtures.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
