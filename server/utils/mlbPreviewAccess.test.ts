// resolveMlbPreviewConsumeKey — invariants.
//
// requireMLBAccess itself (server/auth.ts) needs a real Express req/res +
// database and is covered by server/mlbAccessControl.integration.test.ts
// instead (mirrors server/services/liveEdgeAccess.integration.test.ts's
// convention) — this file covers only the extracted pure fallback logic,
// dependency-free so it runs without a live database.
//
// Run: npx tsx server/utils/mlbPreviewAccess.test.ts

import { resolveMlbPreviewConsumeKey } from "./mlbPreviewAccess";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── A real gameId produces the existing per-game key, unchanged ────────────
{
  ok(resolveMlbPreviewConsumeKey("777123") === "mlb-777123", "a real gameId produces the same 'mlb-<id>' key as before the fix");
  ok(resolveMlbPreviewConsumeKey("abc") === "mlb-abc", "a non-numeric gameId still produces the same key shape");
}

// ── A missing gameId no longer 400s — it falls back to a shared daily key ──
{
  ok(resolveMlbPreviewConsumeKey(null) === "mlb-general", "a null gameId falls back to the shared 'mlb-general' key instead of erroring");
  ok(resolveMlbPreviewConsumeKey(undefined) === "mlb-general", "an undefined gameId falls back to the shared 'mlb-general' key instead of erroring");
  ok(resolveMlbPreviewConsumeKey("") === "mlb-general", "an empty-string gameId falls back to the shared key (falsy, same as missing)");
}

console.log(`\nmlbPreviewAccess.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
