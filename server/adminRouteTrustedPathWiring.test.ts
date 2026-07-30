// Admin/internal route trusted-path structural proof (Final Pre-Push
// Integrity Pass, Section 7: "internal calls use explicit trusted path").
//
// requireMLBAccess's free-preview fallback treats ANY paid MLB subscriber
// OR admin identically (access.hasMLB true for both — see
// server/auth.ts's requireMLBAccess). That means an admin-only diagnostic
// route accidentally gated by requireMLBAccess alone (instead of
// requireAdmin) would ALSO be reachable by any ordinary PAID subscriber —
// not just admins. The correct, explicit trusted path for admin/internal
// endpoints is requireAdmin, never a reliance on requireMLBAccess's
// paid-or-admin bypass as a substitute admin check.
//
// This reads the actual source of every file that registers Express routes
// in this codebase and proves EVERY "/api/admin/..." route registration
// includes requireAdmin as a middleware argument — a durable regression
// guard, not a one-off audit finding.
//
// Run: npx tsx server/adminRouteTrustedPathWiring.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const dir = path.dirname(fileURLToPath(import.meta.url));

// Every file in this codebase observed to call app.get/post/put/delete/patch
// with a real route string, per a repo-wide grep for that call shape.
const ROUTE_REGISTRATION_FILES = [
  "routes.ts",
  "auth.ts",
  "static.ts",
  "swHandler.ts",
  "stripeService.ts",
  "growth/hrBoardStudioRoutes.ts",
  "mlb/pregame/mound/moundStatsRoutes.ts",
  "mlb/pregamePowerRadar/statsRoutes.ts",
];

// Matches app.get("/api/admin/...", ...)  /  app.post(...)  / etc., capturing
// the full argument list between the route string and the closing paren of
// the call so we can check whether requireAdmin appears among the
// middleware arguments. Handles both a plain function reference
// (requireAdmin) and a namespaced one (guards.requireAdmin).
const ADMIN_ROUTE_CALL = /app\.(get|post|put|delete|patch)\(\s*"(\/api\/admin\/[^"]*)"\s*,([^)]*)\)/g;

let totalAdminRoutesChecked = 0;
const missingRequireAdmin: string[] = [];

for (const relPath of ROUTE_REGISTRATION_FILES) {
  const filePath = path.join(dir, relPath);
  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch (e) {
    ok(false, `expected route-registration file not found: ${relPath} (${e instanceof Error ? e.message : e})`);
    continue;
  }

  let match: RegExpExecArray | null;
  ADMIN_ROUTE_CALL.lastIndex = 0;
  while ((match = ADMIN_ROUTE_CALL.exec(source)) !== null) {
    const [, method, routePath, argsBeforeHandler] = match;
    totalAdminRoutesChecked++;
    const hasRequireAdmin = /(^|[.\s,(])requireAdmin\b/.test(argsBeforeHandler);
    if (!hasRequireAdmin) {
      missingRequireAdmin.push(`${relPath}: ${method.toUpperCase()} ${routePath}`);
    }
  }
}

ok(totalAdminRoutesChecked > 0, `found at least one /api/admin/ route registration to check (sanity check on the regex/file list itself — got ${totalAdminRoutesChecked})`);
ok(
  missingRequireAdmin.length === 0,
  `every /api/admin/ route registration includes requireAdmin as an explicit middleware argument (found ${missingRequireAdmin.length} without it: ${missingRequireAdmin.join("; ")})`,
);

console.log(`  checked ${totalAdminRoutesChecked} /api/admin/ route registrations across ${ROUTE_REGISTRATION_FILES.length} files`);
console.log(`\nadminRouteTrustedPathWiring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
