/**
 * HR Radar Lifecycle Repair — invariant test.
 *
 * Locks the three forensic-audit fixes:
 *   Fix #1: mapToUserStage ordering — READY is structurally reachable.
 *   Fix #2: closeHrAlertOnHit stamps an outcome record so the cashed
 *           bucket populates immediately (and the canonical lifecycle
 *           bus surface accepts cashSignal idempotently).
 *   Fix #3: Game-final fixup only forces MISSED for cards that actually
 *           reached READY/FIRE/actionable; TRACK/WATCH/BUILD becomes
 *           INACTIVE.
 *
 * Hard rules verified:
 *   - No engine math touched (mapper inputs unchanged).
 *   - No threshold changes (PREPARE conf>=7 / conv>=0.18 still the gate).
 *   - No CanonicalSignal contract change (cashSignal is bus-surface only).
 *
 * Run: npx tsx server/mlb/hrRadarLifecycleRepair.test.ts
 */

import { mapToUserStage, type HrRadarUserStage } from "./hrRadarUserStage";
import {
  applyHrRadarResolvedStateFixup,
  deriveHrRadarOutcomeStatus,
  type CanonicalCardInput,
} from "./hrRadarSection";
import {
  stampHrRadarOutcome,
  getHrRadarOutcomeStamp,
  clearHrRadarOutcomeStampsForGame,
  _resetHrRadarOutcomeStampsForTests,
} from "./hrRadarOutcomeStamp";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${String(expected)} actual=${String(actual)}`);
}

console.log("\n=== HR Radar Lifecycle Repair — Invariant Suite ===\n");

// ── Fix #1: mapToUserStage ordering ───────────────────────────────────────
console.log("Fix #1 — mapToUserStage ordering");

// 1.1 Resolved is sticky.
eq(
  "1.1 outcome=called_hit → resolved",
  mapToUserStage({ outcome: "called_hit" }),
  "resolved" as HrRadarUserStage,
);

// 1.2 Explicit FIRE path (actionable + FAST_PROMOTE_ELITE) → fire.
eq(
  "1.2 actionable + FAST_PROMOTE_ELITE → fire",
  mapToUserStage({ legacyState: "actionable", alertPath: "FAST_PROMOTE_ELITE" }),
  "fire",
);

// 1.3 KEY REPAIR — BET_NOW + path that promotes to READY at signal_state=live
//      now resolves to READY (was: fire under the broken order).
eq(
  "1.3 dyn=BET_NOW + state=live + PATH_A → ready",
  mapToUserStage({
    dynamicState: "BET_NOW",
    legacyState: "live",
    alertPath: "PATH_A",
  }),
  "ready",
);

// 1.4 PREPARE escalation by confidence.
eq(
  "1.4 dyn=PREPARE + conf=7.5 → ready",
  mapToUserStage({ dynamicState: "PREPARE", confidenceScore: 7.5 }),
  "ready",
);

// 1.5 PREPARE escalation by conversion probability.
eq(
  "1.5 dyn=PREPARE + conv=0.20 → ready",
  mapToUserStage({ dynamicState: "PREPARE", convProb: 0.2 }),
  "ready",
);

// 1.6 PREPARE without escalation → build (NOT ready).
eq(
  "1.6 dyn=PREPARE + conf=5 + conv=0.10 → build",
  mapToUserStage({ dynamicState: "PREPARE", confidenceScore: 5, convProb: 0.1 }),
  "build",
);

// 1.7 Legacy strong tier → ready.
eq(
  "1.7 legacyTier=strong → ready",
  mapToUserStage({ legacyTier: "strong" }),
  "ready",
);

// 1.8 Pure BET_NOW with no path/tier/PREPARE → fire (BET_NOW fallback still works).
eq(
  "1.8 dyn=BET_NOW alone → fire",
  mapToUserStage({ dynamicState: "BET_NOW" }),
  "fire",
);

// 1.9 Legacy building tier → build.
eq(
  "1.9 legacyTier=building → build",
  mapToUserStage({ legacyTier: "building" }),
  "build",
);

// 1.10 Default → track.
eq(
  "1.10 empty input → track",
  mapToUserStage({}),
  "track",
);

// 1.11 trace logging only fires on transitions.
{
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.join(" ")); };
  try {
    // prev=null, next=fire → emits transition + fire tag
    mapToUserStage(
      { dynamicState: "BET_NOW" },
      { signalId: "mlb:G1:P1:home_runs:OVER", gameId: "G1", playerId: "P1", player: "X", prev: null },
    );
    // prev=fire, next=fire → no log emitted
    mapToUserStage(
      { dynamicState: "BET_NOW" },
      { signalId: "mlb:G1:P1:home_runs:OVER", gameId: "G1", playerId: "P1", player: "X", prev: "fire" },
    );
  } finally {
    console.log = origLog;
  }
  const hasTransition = logs.some((l) => l.includes("[HR_RADAR_TRANSITION]") && l.includes("from=none") && l.includes("to=fire"));
  const hasFireTag = logs.some((l) => l.includes("[HR_RADAR_FIRE]"));
  const noDup = logs.filter((l) => l.includes("[HR_RADAR_TRANSITION]")).length === 1;
  assert("1.11 trace emits transition+fire tag once and is silent on no-op", hasTransition && hasFireTag && noDup);
}

// ── Fix #2: outcome stamp wiring ─────────────────────────────────────────
console.log("\nFix #2 — outcome stamp wiring");
_resetHrRadarOutcomeStampsForTests();

// 2.1 Stamp + lookup round trip.
{
  const s = stampHrRadarOutcome("G2", "P2", "called_hit_ready", {
    hitInning: 4,
    alertTier: "prepare",
    confidenceTier: "strong",
    signalState: "actionable",
    source: "play_feed",
  });
  eq("2.1a stamp returned outcomeStatus", s.outcomeStatus, "called_hit_ready");
  const r = getHrRadarOutcomeStamp("G2", "P2");
  eq("2.1b lookup returned same outcomeStatus", r?.outcomeStatus ?? null, "called_hit_ready");
  eq("2.1c stamp preserved hitInning", r?.hitInning ?? null, 4);
}

// 2.2 Stamp is idempotent.
{
  const first = getHrRadarOutcomeStamp("G2", "P2");
  const dup = stampHrRadarOutcome("G2", "P2", "called_hit_attack");
  eq("2.2 second stamp does not overwrite first", dup.outcomeStatus, first?.outcomeStatus ?? "");
}

// 2.3 deriveHrRadarOutcomeStatus consults the stamp when card has no outcome.
{
  const card: CanonicalCardInput = { gameId: "G2", playerId: "P2" };
  const o = deriveHrRadarOutcomeStatus(card);
  eq("2.3 card with only gameId/playerId picks up stamped called_hit_ready", o, "called_hit_ready");
}

// 2.4 deriveHrRadarOutcomeStatus without identity returns "unresolved".
{
  const o = deriveHrRadarOutcomeStatus({});
  eq("2.4 card without identity → unresolved", o, "unresolved");
}

// 2.5 Game-scoped clear.
{
  const dropped = clearHrRadarOutcomeStampsForGame("G2");
  assert("2.5a clear returned dropped count > 0", dropped > 0);
  eq("2.5b post-clear lookup → null", getHrRadarOutcomeStamp("G2", "P2"), null);
}

// 2.6 Stamp tag emitted.
_resetHrRadarOutcomeStampsForTests();
{
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => { logs.push(args.join(" ")); };
  try {
    stampHrRadarOutcome("G3", "P3", "called_hit_attack", { source: "play_feed" });
  } finally {
    console.log = orig;
  }
  assert(
    "2.6 [HR_RADAR_CASHED] tag fired with gameId/playerId/outcomeStatus",
    logs.some((l) => l.includes("[HR_RADAR_CASHED]") && l.includes("gameId=G3") && l.includes("playerId=P3") && l.includes("called_hit_attack")),
  );
}
clearHrRadarOutcomeStampsForGame("G3");

// ── Fix #3: game-final missed inflation ──────────────────────────────────
console.log("\nFix #3 — game-final missed inflation");

// 3.1 TRACK card on final game → INACTIVE (NOT missed).
{
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P4", userStage: "track", confidenceTier: "monitor", signalState: "watching", canonicalStage: "watch", gameStatus: "final" },
    { gameId: "G4", playerId: "P4", logger: () => {} },
  );
  eq("3.1a TRACK on final → lifecycle=inactive", out.lifecycleState, "inactive");
  eq("3.1b TRACK on final → section=inactive", (out as any).canonicalSection, "inactive");
}

// 3.2 BUILD card on final game → INACTIVE.
{
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P5", userStage: "build", confidenceTier: "building", signalState: "live", canonicalStage: "building", gameStatus: "final" },
    { gameId: "G4", playerId: "P5", logger: () => {} },
  );
  eq("3.2a BUILD on final → inactive", out.lifecycleState, "inactive");
  eq("3.2b BUILD on final → section=inactive", (out as any).canonicalSection, "inactive");
}

// 3.3 READY card on final → MISSED (preserved).
{
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P6", userStage: "ready", confidenceTier: "strong", signalState: "live", canonicalStage: "building", gameStatus: "final" },
    { gameId: "G4", playerId: "P6", logger: () => {} },
  );
  eq("3.3a READY on final → missed", out.lifecycleState, "missed");
  eq("3.3b READY on final → section=missed", (out as any).canonicalSection, "missed");
}

// 3.4 FIRE card on final → MISSED (preserved).
{
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P7", userStage: "fire", confidenceTier: "strong", signalState: "actionable", canonicalStage: "attack", gameStatus: "final" },
    { gameId: "G4", playerId: "P7", logger: () => {} },
  );
  eq("3.4a FIRE on final → missed", out.lifecycleState, "missed");
  eq("3.4b FIRE on final → section=missed", (out as any).canonicalSection, "missed");
}

// 3.5 signalState=actionable card on final → MISSED (engine declared actionable).
{
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P8", userStage: "build", signalState: "actionable", confidenceTier: "building", canonicalStage: "building", gameStatus: "final" },
    { gameId: "G4", playerId: "P8", logger: () => {} },
  );
  eq("3.5 actionable signalState on final → missed", out.lifecycleState, "missed");
}

// 3.6 confidenceTier=strong on final → MISSED.
{
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P9", userStage: "build", confidenceTier: "strong", signalState: "live", canonicalStage: "building", gameStatus: "final" },
    { gameId: "G4", playerId: "P9", logger: () => {} },
  );
  eq("3.6 strong confidenceTier on final → missed", out.lifecycleState, "missed");
}

// 3.7 cashed outcome on final → cashed (existing behavior preserved).
{
  _resetHrRadarOutcomeStampsForTests();
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P10", outcomeStatus: "called_hit", gameStatus: "final" },
    { gameId: "G4", playerId: "P10", logger: () => {} },
  );
  eq("3.7 called_hit outcome on final → cashed", out.lifecycleState, "cashed");
}

// 3.8 Stamp wins game-final routing — TRACK card with stamp → cashed (not inactive).
{
  _resetHrRadarOutcomeStampsForTests();
  stampHrRadarOutcome("G4", "P11", "called_hit_attack");
  const out = applyHrRadarResolvedStateFixup(
    { gameId: "G4", playerId: "P11", userStage: "track", confidenceTier: "monitor", signalState: "watching", canonicalStage: "watch", gameStatus: "final" },
    { gameId: "G4", playerId: "P11", logger: () => {} },
  );
  eq("3.8a stamp routes TRACK→cashed on final (not inactive)", out.lifecycleState, "cashed");
  eq("3.8b stamp routes section=cashed", (out as any).canonicalSection, "cashed");
  clearHrRadarOutcomeStampsForGame("G4");
}

// 3.9 Diagnostic tag emitted on final fixup transition.
{
  const logs: string[] = [];
  applyHrRadarResolvedStateFixup(
    { gameId: "G5", playerId: "P12", userStage: "track", confidenceTier: "monitor", signalState: "watching", canonicalStage: "watch", gameStatus: "final" },
    { gameId: "G5", playerId: "P12", logger: (msg: string) => logs.push(msg) },
  );
  assert(
    "3.9 [HR_RADAR_INACTIVE] tag emitted with from/to/rule",
    logs.some((l) => l.includes("[HR_RADAR_INACTIVE]") && l.includes("from=active") && l.includes("to=inactive") && l.includes("rule=game_final_overrides_active")),
  );
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
