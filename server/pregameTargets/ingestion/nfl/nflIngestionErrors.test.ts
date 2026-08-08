// Run: npx tsx server/pregameTargets/ingestion/nfl/nflIngestionErrors.test.ts
// PR6 — NFL bounded/redacted failure records: a message embedding a connection string /
// provider-payload marker / auth bearer / DATABASE_URL is dropped (never leaks); benign
// message kept + bounded; non-Error throwables classified without throwing.
import { buildNflIngestErrorRecord, sanitizeNflIngestErrorMessage, classifyNflIngestError } from "./nflIngestionErrors";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

{
  const nasty = new Error('insert failed: connection to postgresql://ingest:s3cr3t@db.internal:5432/livelocks; player_id=00-0036355; Authorization: Bearer abc.def');
  const rec = buildNflIngestErrorRecord({ stage: "persist", season: "2024", err: nasty });
  const dump = JSON.stringify(rec);
  ok(!dump.includes("postgresql://") && !dump.includes("s3cr3t") && !dump.includes("db.internal"), "no connection string / password / host leaks");
  ok(!dump.includes("player_id") && !dump.includes("Bearer abc.def"), "no provider-payload marker / auth token leaks");
  ok(rec.errorKind === "Error" && rec.stage === "persist" && rec.season === "2024", "bounded context preserved");
  ok(rec.message.startsWith("(redacted"), "sensitive message replaced with a redaction notice");
}
{
  ok(sanitizeNflIngestErrorMessage("DATABASE_URL missing").startsWith("(redacted"), "DATABASE_URL redacted");
  ok(sanitizeNflIngestErrorMessage("fetch https://github.com/nflverse/x.csv").startsWith("(redacted"), "URL redacted (could carry query/paths)");
  ok(sanitizeNflIngestErrorMessage("season had zero rows this run") === "season had zero rows this run", "benign message kept verbatim");
  ok(sanitizeNflIngestErrorMessage("x".repeat(500)).length === 200, "bounded to 200 chars");
  ok(classifyNflIngestError("s") === "string" && classifyNflIngestError(null) === "object", "non-Error throwables classified");
  ok(sanitizeNflIngestErrorMessage(undefined) === "(no message)", "undefined → (no message)");
}

console.log(`\nnflIngestionErrors.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
