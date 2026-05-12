// HR Radar State Machine — unit tests for the canonical lifecycle.
// Run: npx tsx server/mlb/hrRadarStateMachine.test.ts

import {
  applyHrRadarLifecycleEvent,
  isActive,
  isTerminal,
  type HrRadarLifecycleState,
} from "./hrRadarStateMachine";

import {
  upsertCanonicalHrRadarState,
  getCanonicalHrRadarState,
  getActiveCanonicalHrRadarStates,
  _resetCanonicalHrRadarStoreForTests,
} from "./hrRadarCanonicalStore";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[HR_RADAR_STATE_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// ─── Terminal lock ─────────────────────────────────────────────────────
for (const t of ["cashed", "missed", "model_review", "expired"] as HrRadarLifecycleState[]) {
  const r = applyHrRadarLifecycleEvent(t, "CONTACT_EVIDENCE");
  check(`terminal lock — ${t} rejects CONTACT_EVIDENCE`, !r.ok && r.rejectedReason === "terminal_state_locked");
  const r2 = applyHrRadarLifecycleEvent(t, "PROMOTE", { promoteTo: "fire" });
  check(`terminal lock — ${t} rejects PROMOTE`, !r2.ok);
  const r3 = applyHrRadarLifecycleEvent(t, "HR_HIT");
  check(`terminal lock — ${t} rejects HR_HIT`, !r3.ok);
}

// ─── Forward promotions ────────────────────────────────────────────────
let r = applyHrRadarLifecycleEvent("inactive", "CONTACT_EVIDENCE");
check("inactive → watch via CONTACT_EVIDENCE", r.ok && r.nextState === "watch" && r.section === "WATCH");

r = applyHrRadarLifecycleEvent("watch", "BARREL");
check("watch → build via BARREL", r.ok && r.nextState === "build" && r.section === "BUILD");

r = applyHrRadarLifecycleEvent("build", "REPEATED_DANGER");
check("build → ready via REPEATED_DANGER", r.ok && r.nextState === "ready");

r = applyHrRadarLifecycleEvent("ready", "PITCHER_FADE");
check("ready stays ready (idempotent) via PITCHER_FADE", r.ok && r.nextState === "ready");

r = applyHrRadarLifecycleEvent("ready", "PROMOTE", { promoteTo: "fire" });
check("ready → fire via PROMOTE", r.ok && r.nextState === "fire" && r.userStage === "fire");

// ─── Idempotent at-or-above ────────────────────────────────────────────
r = applyHrRadarLifecycleEvent("fire", "BARREL");
check("fire stays fire on BARREL (idempotent)", r.ok && r.nextState === "fire");

r = applyHrRadarLifecycleEvent("ready", "CONTACT_EVIDENCE");
check("ready stays ready on CONTACT_EVIDENCE (idempotent)", r.ok && r.nextState === "ready");

// ─── Illegal PROMOTE ───────────────────────────────────────────────────
r = applyHrRadarLifecycleEvent("ready", "PROMOTE", { promoteTo: "watch" });
check("PROMOTE rejects strictly-lower target", !r.ok && /promote_not_strictly_higher/.test(r.rejectedReason ?? ""));

r = applyHrRadarLifecycleEvent("watch", "PROMOTE", { promoteTo: "cashed" });
check("PROMOTE rejects non-active target", !r.ok && r.rejectedReason === "promote_target_not_active");

r = applyHrRadarLifecycleEvent("watch", "PROMOTE");
check("PROMOTE rejects missing target", !r.ok && r.rejectedReason === "promote_missing_target");

// ─── DECAY ─────────────────────────────────────────────────────────────
r = applyHrRadarLifecycleEvent("fire", "DECAY");
check("fire decays to ready", r.ok && r.nextState === "ready");

r = applyHrRadarLifecycleEvent("watch", "DECAY");
check("watch decays to expired (terminal)", r.ok && r.nextState === "expired" && isTerminal(r.nextState));

r = applyHrRadarLifecycleEvent("inactive", "DECAY");
check("DECAY from inactive rejected", !r.ok);

r = applyHrRadarLifecycleEvent("fire", "DECAY", { decayTo: "fire" });
check("DECAY rejects same-or-higher target", !r.ok);

// ─── HR_HIT ────────────────────────────────────────────────────────────
r = applyHrRadarLifecycleEvent("watch", "HR_HIT");
check("watch + HR_HIT → cashed_from_watch", r.ok && r.nextState === "cashed" && r.reason === "cashed_from_watch");

r = applyHrRadarLifecycleEvent("build", "HR_HIT");
check("build + HR_HIT → cashed_from_build", r.ok && r.nextState === "cashed" && r.reason === "cashed_from_build");

r = applyHrRadarLifecycleEvent("ready", "HR_HIT");
check("ready + HR_HIT → cashed_from_ready", r.ok && r.nextState === "cashed");

r = applyHrRadarLifecycleEvent("fire", "HR_HIT");
check("fire + HR_HIT → cashed_from_fire", r.ok && r.nextState === "cashed");

r = applyHrRadarLifecycleEvent("inactive", "HR_HIT", { hadPriorEvidence: true });
check("inactive + HR_HIT + hadPriorEvidence → cashed_synthesized", r.ok && r.nextState === "cashed");

r = applyHrRadarLifecycleEvent("inactive", "HR_HIT", { hadPriorEvidence: false });
check("inactive + HR_HIT + no evidence → model_review (true_uncalled)", r.ok && r.nextState === "model_review" && r.reason === "true_uncalled_hr");

r = applyHrRadarLifecycleEvent("inactive", "HR_HIT", { hadPriorEvidence: false, earlyHrInsufficientSample: true });
check("inactive + HR_HIT + earlyHr → model_review (early_hr_insufficient_sample)", r.ok && r.nextState === "model_review" && r.reason === "early_hr_insufficient_sample");

// ─── GAME_FINAL ────────────────────────────────────────────────────────
r = applyHrRadarLifecycleEvent("ready", "GAME_FINAL");
check("active + GAME_FINAL → missed", r.ok && r.nextState === "missed");

r = applyHrRadarLifecycleEvent("inactive", "GAME_FINAL");
check("inactive + GAME_FINAL → no-op", r.ok && r.nextState === "inactive");

// ─── EXPIRE ────────────────────────────────────────────────────────────
r = applyHrRadarLifecycleEvent("build", "EXPIRE");
check("active + EXPIRE → expired", r.ok && r.nextState === "expired");

// ─── MODEL_REVIEW ──────────────────────────────────────────────────────
r = applyHrRadarLifecycleEvent("watch", "MODEL_REVIEW");
check("active + MODEL_REVIEW → model_review", r.ok && r.nextState === "model_review");

// ─── Section / userStage / displayScore10 derivation ──────────────────
r = applyHrRadarLifecycleEvent("inactive", "BARREL");
check("BARREL from inactive — section=BUILD userStage=build score>=5.5",
  r.ok && r.section === "BUILD" && r.userStage === "build" && (r.displayScore10 ?? 0) >= 5.5);

r = applyHrRadarLifecycleEvent("inactive", "REPEATED_DANGER");
check("REPEATED_DANGER from inactive — section=READY score>=7.5",
  r.ok && r.section === "READY" && (r.displayScore10 ?? 0) >= 7.5);

// Caller-supplied score wins when > 0
r = applyHrRadarLifecycleEvent("inactive", "BARREL", { displayScore10: 8.2 });
check("BARREL with caller score 8.2 honored", r.ok && r.displayScore10 === 8.2);

// ─── isActive / isTerminal helpers ────────────────────────────────────
check("isActive(fire)=true", isActive("fire"));
check("isActive(cashed)=false", !isActive("cashed"));
check("isTerminal(missed)=true", isTerminal("missed"));
check("isTerminal(watch)=false", !isTerminal("watch"));

// ─── Canonical store integration ──────────────────────────────────────
_resetCanonicalHrRadarStoreForTests();
const u1 = upsertCanonicalHrRadarState({
  gameId: "g1",
  playerId: "p1",
  playerName: "Test Hitter",
  team: "NYY",
  event: "BARREL",
  context: { reason: "barrel_t3", inning: 3 },
  triggerAbIndex: 1,
  triggerReasons: ["100.6 EV / 26 LA / 374 ft barrel"],
  triggerTags: ["barrel", "high-xba"],
});
check("store: created on first BARREL", u1.created && u1.state.lifecycleState === "build" && u1.state.active);
check("store: section=BUILD", u1.state.section === "BUILD");
check("store: triggerAbIndex persisted", u1.state.triggerAbIndex === 1);
check("store: peakScore10 set on first event", (u1.state.peakScore10 ?? 0) >= 5.5);

const u2 = upsertCanonicalHrRadarState({
  gameId: "g1",
  playerId: "p1",
  playerName: "Test Hitter",
  event: "REPEATED_DANGER",
  context: { reason: "two_hards_one_elite", inning: 4 },
});
check("store: build + REPEATED_DANGER → ready", !u2.created && u2.state.lifecycleState === "ready");
check("store: peakScore10 monotonic non-decreasing",
  (u2.state.peakScore10 ?? 0) >= (u1.state.peakScore10 ?? 0));
check("store: latestEvidenceInning bumped to 4", u2.state.latestEvidenceInning === 4);
check("store: detectedInning preserved (3)", u2.state.detectedInning === 3);

const u3 = upsertCanonicalHrRadarState({
  gameId: "g1",
  playerId: "p1",
  playerName: "Test Hitter",
  event: "HR_HIT",
  context: { reason: "hr_t4", inning: 4 },
});
check("store: ready + HR_HIT → cashed_from_ready", u3.state.lifecycleState === "cashed" && u3.apply.reason === "cashed_from_ready");
check("store: terminal=true active=false", u3.state.terminal && !u3.state.active);
check("store: cashed displayScore10 = 10", u3.state.displayScore10 === 10);

// Subsequent events must be rejected (terminal lock)
const u4 = upsertCanonicalHrRadarState({
  gameId: "g1",
  playerId: "p1",
  playerName: "Test Hitter",
  event: "BARREL",
  context: { reason: "post_hr_noise" },
});
check("store: post-cashed BARREL rejected (terminal lock)", !u4.apply.ok);
check("store: state unchanged after rejected event", u4.state.lifecycleState === "cashed");

// Active query
const u5 = upsertCanonicalHrRadarState({
  gameId: "g2",
  playerId: "p2",
  playerName: "Active Hitter",
  event: "BARREL",
  context: { inning: 2 },
});
check("store: g2 player active", u5.state.active);
const actives = getActiveCanonicalHrRadarStates();
check("store: getActiveCanonicalHrRadarStates returns only active rows",
  actives.length === 1 && actives[0].playerId === "p2",
  `got ${actives.length} actives`);

const fetched = getCanonicalHrRadarState("g1", "p1");
check("store: getCanonicalHrRadarState returns terminal cashed row", fetched != null && fetched.lifecycleState === "cashed");

console.log(`[HR_RADAR_STATE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HR_RADAR_STATE_TEST] OK");
