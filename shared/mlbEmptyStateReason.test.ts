// MLB Empty-State Reason contract — invariants.
//
// Run: npx tsx shared/mlbEmptyStateReason.test.ts

import {
  MLB_EMPTY_REASONS,
  MLB_EMPTY_REASON_MESSAGES,
  buildMlbEmptyStateResponse,
} from "./mlbEmptyStateReason";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Every reason has a non-empty, user-safe default message ────────────────
{
  for (const reason of MLB_EMPTY_REASONS) {
    const msg = MLB_EMPTY_REASON_MESSAGES[reason];
    ok(typeof msg === "string" && msg.trim().length > 0, `${reason} has a non-empty default message`);
  }
  ok(Object.keys(MLB_EMPTY_REASON_MESSAGES).length === MLB_EMPTY_REASONS.length,
    "MLB_EMPTY_REASON_MESSAGES has exactly one entry per reason code (no orphans, no gaps)");
}

// ── Builder applies safe defaults ───────────────────────────────────────────
{
  const resp = buildMlbEmptyStateResponse("NO_QUALIFIED_SETUPS");
  ok(resp.reason === "NO_QUALIFIED_SETUPS", "reason code passes through");
  ok(resp.message === MLB_EMPTY_REASON_MESSAGES.NO_QUALIFIED_SETUPS, "default message is used when none is supplied");
  ok(resp.lastSuccessfulUpdate === null, "lastSuccessfulUpdate defaults to null");
  ok(resp.nextExpectedUpdate === null, "nextExpectedUpdate defaults to null");
  ok(resp.feedHealth === "healthy", "feedHealth defaults to healthy");
}

// ── Builder honors overrides ─────────────────────────────────────────────
{
  const resp = buildMlbEmptyStateResponse("PROVIDER_DEGRADED", {
    message: "DraftKings feed has been down for 4 minutes.",
    lastSuccessfulUpdate: "2026-07-29T22:00:00.000Z",
    nextExpectedUpdate: "2026-07-29T22:05:00.000Z",
    feedHealth: "degraded",
  });
  ok(resp.message === "DraftKings feed has been down for 4 minutes.", "custom message overrides the default");
  ok(resp.lastSuccessfulUpdate === "2026-07-29T22:00:00.000Z", "lastSuccessfulUpdate override is honored");
  ok(resp.nextExpectedUpdate === "2026-07-29T22:05:00.000Z", "nextExpectedUpdate override is honored");
  ok(resp.feedHealth === "degraded", "feedHealth override is honored");
}

console.log(`\nmlbEmptyStateReason.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
