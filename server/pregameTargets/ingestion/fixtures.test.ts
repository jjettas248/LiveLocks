// Run: npx tsx server/pregameTargets/ingestion/fixtures.test.ts
// Pregame Targets PR5 — committed feasibility fixtures (cases.json): each of the
// nine representative cases validated against the real adapter / feature builder /
// coverage / snapshot-identity, so the frozen source shapes and their expected
// normalized outputs stay honest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseNbaGameLog } from "./nbaGameLogAdapter";
import { buildNbaFeatureRows } from "./nbaFeatureBuilder";
import { classifySourceCoverage } from "./ingestionCoverage";
import { computeContentHash } from "./rawSnapshotIdentity";
import type { NbaSourceKind } from "./nbaSourceContracts";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(resolve(here, "__fixtures__/cases.json"), "utf8")) as {
  cases: Array<{
    id: string; kind: NbaSourceKind; season: number; entityNativeId: string; fetchedAtIso: string;
    raw: unknown; rawCorrected?: unknown;
    expected: {
      adapter: { ok: boolean; reason?: string; recordCount?: number };
      knownAtSupport?: string; features?: Record<string, string>; teamTricodes?: string[]; correctionChangesContentHash?: boolean;
    };
  }>;
};

const CURRENT_SEASON = 2026;
ok(doc.cases.length >= 8, `at least eight fixtures present (${doc.cases.length})`);

for (const c of doc.cases) {
  const parsed = parseNbaGameLog({ kind: c.kind, season: c.season, sourceKey: `fixture:${c.id}`, entityNativeId: c.entityNativeId, rawPayload: c.raw, fetchedAt: c.fetchedAtIso });
  ok(parsed.ok === c.expected.adapter.ok, `[${c.id}] adapter ok=${c.expected.adapter.ok}`);

  if (!c.expected.adapter.ok) {
    ok(!parsed.ok && parsed.reason === c.expected.adapter.reason, `[${c.id}] adapter reason = ${c.expected.adapter.reason}`);
    continue;
  }
  if (!parsed.ok) continue;

  if (c.expected.adapter.recordCount !== undefined) {
    ok(parsed.records.length === c.expected.adapter.recordCount, `[${c.id}] recordCount = ${c.expected.adapter.recordCount}`);
  }
  if (c.expected.knownAtSupport) {
    const cov = classifySourceCoverage(parsed, CURRENT_SEASON);
    ok(cov.knownAtSupport === c.expected.knownAtSupport, `[${c.id}] knownAtSupport = ${c.expected.knownAtSupport}`);
  }
  if (c.expected.teamTricodes) {
    const got = new Set(parsed.records.map((r) => r.teamTricode));
    ok(c.expected.teamTricodes.every((t) => got.has(t)), `[${c.id}] team tricodes ${c.expected.teamTricodes.join(",")} retained`);
  }
  if (c.expected.features && c.kind === "nba_stats_playergamelog") {
    const { rows } = buildNbaFeatureRows({ season: c.season, playerNativeId: c.entityNativeId, sourceId: `snap:${c.id}`, records: parsed.records });
    for (const [featureKey, state] of Object.entries(c.expected.features)) {
      const row = rows.find((r) => r.featureKey === featureKey);
      ok(row?.state === state, `[${c.id}] ${featureKey} state = ${state}`);
    }
  }
  if (c.expected.correctionChangesContentHash && c.rawCorrected !== undefined) {
    ok(computeContentHash(c.raw) !== computeContentHash(c.rawCorrected), `[${c.id}] correction changes the content hash (new immutable snapshot)`);
  }
}

console.log(`\nfixtures.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
