// persisted_plays safety-core columns migration — idempotence + no-DROP guard.
//
// Run: npx tsx server/dbMigrations/persistedPlaysSafetyCoreColumns.test.ts

import {
  PERSISTED_PLAYS_SAFETY_CORE_STATEMENTS,
  ensurePersistedPlaysSafetyCoreColumns,
  type SqlExecutor,
} from "./persistedPlaysSafetyCoreColumns";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Every statement is additive ADD COLUMN IF NOT EXISTS — never destructive.
const DESTRUCTIVE = /\b(DROP|DELETE|TRUNCATE|ALTER\s+COLUMN|RENAME|DROP\s+COLUMN)\b/i;
{
  ok(PERSISTED_PLAYS_SAFETY_CORE_STATEMENTS.length === 4, "four columns declared");
  for (const s of PERSISTED_PLAYS_SAFETY_CORE_STATEMENTS) {
    ok(/ADD COLUMN IF NOT EXISTS/i.test(s), `additive IF NOT EXISTS: ${s.slice(0, 60)}`);
    ok(!DESTRUCTIVE.test(s), `no destructive SQL: ${s.slice(0, 60)}`);
    ok(/^ALTER TABLE persisted_plays/i.test(s.trim()), "targets persisted_plays only");
  }
  // The four expected canonical columns are present.
  const joined = PERSISTED_PLAYS_SAFETY_CORE_STATEMENTS.join(" ");
  for (const col of ["edge_version", "no_vig_book_probability", "probability_semantics", "lane"]) {
    ok(joined.includes(col), `declares column ${col}`);
  }
}

// Idempotence: running the bootstrap twice issues the same statements each time
// and never throws (IF NOT EXISTS makes the second run a no-op at the DB layer).
{
  const runs: string[][] = [];
  const makeClient = (): { client: SqlExecutor; seen: string[] } => {
    const seen: string[] = [];
    return { client: { query: async (sql: string) => { seen.push(sql); return undefined; } }, seen };
  };
  const run = async () => {
    const { client, seen } = makeClient();
    await ensurePersistedPlaysSafetyCoreColumns(client);
    runs.push(seen);
  };
  await run();
  await run();
  ok(runs.length === 2, "bootstrap ran twice without throwing");
  ok(runs[0].length === 4 && runs[1].length === 4, "each run issues all four statements");
  ok(JSON.stringify(runs[0]) === JSON.stringify(runs[1]), "idempotent: identical statements each run");
}

console.log(`\npersistedPlaysSafetyCoreColumns.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
