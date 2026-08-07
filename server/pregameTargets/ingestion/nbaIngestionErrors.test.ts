// Run: npx tsx server/pregameTargets/ingestion/nbaIngestionErrors.test.ts
// Pregame Targets PR5 — bounded, sanitized failure records. A thrown value that
// embeds a connection string, a raw provider-payload marker, an auth header, or a
// credential MUST NOT survive into the printed record; a benign message is kept
// (bounded). This is the guarantee the runner's "logs no payloads/credentials"
// claim rests on.
import { buildIngestErrorRecord, sanitizeIngestErrorMessage, classifyIngestError } from "./nbaIngestionErrors";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

// ── A message carrying a fake connection string + payload marker is dropped ──
{
  const nasty = new Error(
    'insert into pregame_raw_source_snapshots failed: connection to postgresql://ingest:s3cr3t@db.internal:5432/livelocks; ' +
    'payload={"resultSets":[{"rowSet":[["0022400500"]]}]}; Authorization: Bearer abc.def.ghi',
  );
  const rec = buildIngestErrorRecord({ stage: "persist", playerId: "201939", season: "2024-25", seasonType: "Regular Season", err: nasty });
  const dump = JSON.stringify(rec);
  ok(!dump.includes("postgresql://"), "no connection-string scheme leaks");
  ok(!dump.includes("s3cr3t"), "no password leaks");
  ok(!dump.includes("db.internal"), "no internal hostname leaks");
  ok(!dump.toLowerCase().includes("resultsets"), "no raw provider payload marker leaks");
  ok(!dump.includes("Bearer abc.def.ghi"), "no auth bearer token leaks");
  ok(rec.errorKind === "Error", "error kind (constructor name) preserved");
  ok(rec.stage === "persist" && rec.playerId === "201939" && rec.season === "2024-25" && rec.seasonType === "Regular Season", "bounded context fields preserved");
  ok(rec.message.startsWith("(redacted"), "sensitive message replaced with a redaction notice");
}

// ── URI in ANY scheme triggers redaction (redis://, https://, etc.) ─────────
{
  ok(sanitizeIngestErrorMessage("cache miss at redis://user:pw@host:6379") .startsWith("(redacted"), "redis:// redacted");
  ok(sanitizeIngestErrorMessage("fetch https://stats.nba.com/stats/playergamelog?PlayerID=1").startsWith("(redacted"), "https:// redacted (could carry query params)");
  ok(sanitizeIngestErrorMessage("DATABASE_URL is not set").startsWith("(redacted"), "DATABASE_URL marker redacted");
}

// ── A benign message is KEPT and bounded to 200 chars ───────────────────────
{
  const benign = sanitizeIngestErrorMessage("player season had zero rows this run");
  ok(benign === "player season had zero rows this run", "benign message preserved verbatim");
  const long = "x".repeat(500);
  ok(sanitizeIngestErrorMessage(long).length === 200, "message bounded to 200 chars");
}

// ── Non-Error throwables classified without throwing ────────────────────────
{
  ok(classifyIngestError("a string") === "string", "string throwable → typeof kind");
  ok(classifyIngestError(null) === "object", "null throwable → object kind (never throws)");
  ok(sanitizeIngestErrorMessage(undefined) === "(no message)", "undefined → (no message)");
  const rec = buildIngestErrorRecord({ stage: "fetch", playerId: "1", season: "2024-25", seasonType: "Playoffs", err: 42 });
  ok(rec.errorKind === "number" && rec.message === "(no message)", "number throwable produces a safe record");
}

console.log(`\nnbaIngestionErrors.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
