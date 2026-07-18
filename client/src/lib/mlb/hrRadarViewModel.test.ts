// HR Radar canonical view model — invariants.
// Run: npx tsx client/src/lib/mlb/hrRadarViewModel.test.ts
//
// Guards the UX-v1 contract: the client view model maps server-stamped stage /
// score / drivers into display fields and NEVER computes an engine score, infers
// a stage, or leaks raw diagnostics. Also covers the Hot Seat selection rules
// (single hero, ≤5 queue, Track hidden) and stage-movement detection.

import {
  buildHrRadarCardViewModel,
  buildConsumerViewModels,
  selectQuickDecide,
  selectTopPriority,
  topPriorityReasonLabel,
  compareByImportance,
  HR_PUBLIC_STAGE_LABEL,
} from "@/lib/mlb/hrRadarViewModel";
import { detectStageMovements } from "@/components/mlb/hr-radar/HrRadarStageToast";
import type { HrRadarLadderEntry } from "@/components/mlb/HrRadarLadder";
import type { HrRadarConsumerEntry, HrRadarDecisionView } from "@shared/hrRadarDecisionView";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Minimal HrRadarLadderEntry factory — only the fields the mapper reads matter;
// the rest are filled with inert defaults so the shape type-checks.
function entry(p: Partial<HrRadarLadderEntry>): HrRadarLadderEntry {
  return {
    playerId: "p", playerName: "Test Player", team: "TST", gameId: "g",
    state: null, confidenceTier: null, peakScore: null, signalStrengthScore: null,
    whyNowReasons: [], nextAbEstimate: null, detectedInning: null, detectedHalf: null,
    hitInning: null, hitHalf: null, outcomeStatus: "", userVisible: true,
    signalDetectedAt: null, hitDetectedAt: null, resolvedAt: null, alertPath: null,
    ...p,
  } as unknown as HrRadarLadderEntry;
}

console.log("\n=== HR Radar View Model — Invariant Suite ===\n");

// ── 1. Stage mapping (legacy fallback path — no `consumer` supplied) ───────
console.log("stage mapping (legacy fallback path)");
{
  const fire = buildHrRadarCardViewModel(entry({ userStage: "fire", officialSignalStage: "fire", displayCurrentScore10: 9.2 }));
  assert("fire userStage → fire", fire.stage === "fire");
  assert("fire is official call", fire.isOfficialCall === true);
  assert("fire is hero eligible", fire.isHeroEligible === true);
  assert("fire CTA is take_now", fire.primaryCta === "take_now");
  assert("fire canAddToSlip true", fire.canAddToSlip === true);
  assert("fire canWatchNextAb false", fire.canWatchNextAb === false);
  assert("fire promotionRequirement null", fire.promotionRequirement === null);

  const ready = buildHrRadarCardViewModel(entry({ userStage: "ready", displayCurrentScore10: 7.8 }));
  assert("ready userStage → ready", ready.stage === "ready");
  assert("ready is hero eligible", ready.isHeroEligible === true);
  assert("ready is NOT official", ready.isOfficialCall === false);
  assert("ready CTA is watch_next_ab (never take_now)", ready.primaryCta === "watch_next_ab");
  assert("ready canAddToSlip false — Ready is never a bet", ready.canAddToSlip === false);
  assert("ready canWatchNextAb true", ready.canWatchNextAb === true);

  const build = buildHrRadarCardViewModel(entry({ userStage: "build", displayCurrentScore10: 4.5 }));
  assert("build → build, not hero, no CTA", build.stage === "build" && !build.isHeroEligible && build.primaryCta === "none");
  assert("build canAddToSlip/canWatchNextAb both false", build.canAddToSlip === false && build.canWatchNextAb === false);

  const track = buildHrRadarCardViewModel(entry({ userStage: "track", displayCurrentScore10: 2.1 }));
  assert("track → track, not hero, no CTA", track.stage === "track" && !track.isHeroEligible && track.primaryCta === "none");
  assert("track canAddToSlip/canWatchNextAb both false", track.canAddToSlip === false && track.canWatchNextAb === false);

  const cashed = buildHrRadarCardViewModel(entry({ userStage: "resolved", outcome: "called_hit", displayCurrentScore10: 8 }), { sectionHint: "cashed" });
  assert("resolved + cashed hint → cashed, resolved, no CTA", cashed.stage === "cashed" && cashed.isResolved && cashed.primaryCta === "none");
  assert("resolved rows never carry canAddToSlip/canWatchNextAb", cashed.canAddToSlip === false && cashed.canWatchNextAb === false);

  const missed = buildHrRadarCardViewModel(entry({ userStage: "resolved", outcome: "called_miss" }), { sectionHint: "missed" });
  assert("resolved + missed hint → missed", missed.stage === "missed" && missed.isResolved);

  // Outcome-derived cashed/missed without a hint (Full Ladder keeps all rows).
  const cashedNoHint = buildHrRadarCardViewModel(entry({ currentStatus: "resolved", outcome: "called_hit_ready" }));
  assert("resolved outcome called_hit_* → cashed (no hint)", cashedNoHint.stage === "cashed");
  const missedNoHint = buildHrRadarCardViewModel(entry({ currentStatus: "resolved", outcome: "called_miss" }));
  assert("resolved outcome miss → missed (no hint)", missedNoHint.stage === "missed");
}

// ── 1b. Stage mapping (decision-view consumer path — the normal path) ──────
console.log("\nstage mapping (decision-view consumer path)");
{
  function consumerFor(
    e: HrRadarLadderEntry,
    overrides: Partial<HrRadarConsumerEntry<HrRadarLadderEntry>>,
  ): HrRadarConsumerEntry<HrRadarLadderEntry> {
    return {
      entryId: `${e.gameId}:${e.playerId}`,
      source: e,
      liveStage: null,
      resultType: null,
      consumerAction: "none",
      isResolved: false,
      hasFireCommitment: false,
      canAddToSlip: false,
      canWatchNextAb: false,
      promotionRequirement: null,
      ...overrides,
    };
  }

  const fireEntry = entry({ userStage: "fire", displayCurrentScore10: 9.2 });
  const fireConsumer = consumerFor(fireEntry, {
    liveStage: "fire", consumerAction: "take_now", hasFireCommitment: true, canAddToSlip: true,
  });
  const fireVm = buildHrRadarCardViewModel(fireEntry, { consumer: fireConsumer });
  assert("consumer-path Fire → stage fire, take_now, canAddToSlip true",
    fireVm.stage === "fire" && fireVm.primaryCta === "take_now" && fireVm.canAddToSlip === true);
  assert("consumer-path Fire → isOfficialCall true", fireVm.isOfficialCall === true);

  const readyEntry = entry({ userStage: "ready", displayCurrentScore10: 7.5 });
  const readyConsumer = consumerFor(readyEntry, {
    liveStage: "ready", consumerAction: "watch_next_ab", canWatchNextAb: true,
    promotionRequirement: "Needs one more qualifying contact event.",
  });
  const readyVm = buildHrRadarCardViewModel(readyEntry, { consumer: readyConsumer });
  assert("consumer-path Ready → watch_next_ab, canWatchNextAb true, canAddToSlip false",
    readyVm.primaryCta === "watch_next_ab" && readyVm.canWatchNextAb === true && readyVm.canAddToSlip === false);
  assert("consumer-path Ready → promotionRequirement verbatim from server",
    readyVm.promotionRequirement === "Needs one more qualifying contact event.");

  const buildEntry = entry({ userStage: "build", displayCurrentScore10: 4.0 });
  const buildConsumer = consumerFor(buildEntry, { liveStage: "build" });
  const buildVm = buildHrRadarCardViewModel(buildEntry, { consumer: buildConsumer });
  assert("consumer-path Build → no CTA, never canAddToSlip",
    buildVm.primaryCta === "none" && buildVm.canAddToSlip === false && buildVm.canWatchNextAb === false);

  // A Fire row whose server said canAddToSlip=false (invalid bet payload)
  // must still surface take_now (it IS an official call) but never let the
  // client add it to the slip.
  const brokenFireEntry = entry({ userStage: "fire", displayCurrentScore10: 9.5 });
  const brokenFireConsumer = consumerFor(brokenFireEntry, {
    liveStage: "fire", consumerAction: "take_now", hasFireCommitment: true, canAddToSlip: false,
  });
  const brokenFireVm = buildHrRadarCardViewModel(brokenFireEntry, { consumer: brokenFireConsumer });
  assert("Fire with invalid bet payload: still take_now but canAddToSlip false",
    brokenFireVm.primaryCta === "take_now" && brokenFireVm.canAddToSlip === false);

  const signalHitEntry = entry({ currentStatus: "resolved", outcome: "called_hit" });
  const signalHitConsumer = consumerFor(signalHitEntry, {
    isResolved: true, resultType: "signal_hit", hasFireCommitment: true,
  });
  const signalHitVm = buildHrRadarCardViewModel(signalHitEntry, { consumer: signalHitConsumer });
  assert("consumer-path signal_hit → stage cashed, resolved, no CTA",
    signalHitVm.stage === "cashed" && signalHitVm.isResolved && signalHitVm.primaryCta === "none");

  const officialMissEntry = entry({ currentStatus: "resolved", outcome: "miss" });
  const officialMissConsumer = consumerFor(officialMissEntry, {
    isResolved: true, resultType: "official_miss", hasFireCommitment: true,
  });
  const officialMissVm = buildHrRadarCardViewModel(officialMissEntry, { consumer: officialMissConsumer });
  assert("consumer-path official_miss → stage missed", officialMissVm.stage === "missed" && officialMissVm.isResolved);

  // model_review resolved rows are never passed to buildHrRadarCardViewModel
  // by callers (filtered before reaching a consumer VM) — not exercised here.

  // buildConsumerViewModels — reads straight from a decisionView shape.
  const decisionView: HrRadarDecisionView<HrRadarLadderEntry> = {
    version: "hr-radar-decision-v1",
    status: "ok",
    sessionDate: "2026-07-18",
    generatedAt: "2026-07-18T00:00:00.000Z",
    entries: {
      "g:fire-id": consumerFor(entry({ gameId: "g", playerId: "fire-id" }), {
        liveStage: "fire", consumerAction: "take_now", canAddToSlip: true, hasFireCommitment: true,
      }),
    },
    groups: {
      takeNow: ["g:fire-id"], watchNextAb: [], build: [], watch: [],
      waitingForFirstAb: [], signalHits: [], officialMisses: [], modelReview: [],
    },
    counts: {
      takeNow: 1, watchNextAb: 0, build: 0, watch: 0, forming: 0,
      waitingForFirstAb: 0, liveTracked: 1, fireHitsToday: 0, fireMissesToday: 0, modelReview: 0,
    },
  };
  const vms = buildConsumerViewModels(decisionView, decisionView.groups.takeNow);
  assert("buildConsumerViewModels returns one VM for the one takeNow id",
    vms.length === 1 && vms[0].stage === "fire" && vms[0].canAddToSlip === true);
  assert("buildConsumerViewModels skips an unknown id instead of throwing",
    buildConsumerViewModels(decisionView, ["missing:id"]).length === 0);
  assert("buildConsumerViewModels returns [] for an undefined decisionView",
    buildConsumerViewModels(undefined, ["anything"]).length === 0);
}

// ── 2. No client-side score calculation / no raw-diagnostic leak ───────────
console.log("\nno client score calc / no raw leak");
{
  // Server /10 display score is read verbatim.
  const v = buildHrRadarCardViewModel(entry({ userStage: "ready", displayCurrentScore10: 7.8 }));
  assert("score10 reads server display score", v.score10 === 7.8 && v.scoreLabel === "7.8");

  // A 0-100 readiness is divided to /10 (formatting), never recomputed.
  const r = buildHrRadarCardViewModel(entry({ userStage: "build", currentReadinessScore: 70 }));
  assert("0-100 readiness → 7.0 (formatting only)", r.score10 === 7.0);

  // Missing all score fields → 0, NOT an invented number.
  const z = buildHrRadarCardViewModel(entry({ userStage: "track" }));
  assert("missing score → 0 (not fabricated)", z.score10 === 0);

  // A raw readiness of 95 must NOT surface as a 95% HR chance.
  const leak = buildHrRadarCardViewModel(entry({ userStage: "fire", officialSignalStage: "fire", currentReadinessScore: 95 }));
  assert("raw readiness never leaks as hrChancePct", leak.hrChancePct == null);
  assert("non-fire stages expose no hrChancePct", buildHrRadarCardViewModel(entry({ userStage: "ready", displayHrChancePct: 22 })).hrChancePct == null);
}

// ── 3. Trigger chips from server badges ────────────────────────────────────
console.log("\ntrigger chips");
{
  const v = buildHrRadarCardViewModel(entry({ userStage: "ready", badges: ["hr_max_window", "near_hr_contact"] as any, displayCurrentScore10: 8 }));
  const labels = v.driverChips.map((c) => c.label);
  assert("chips include HR MAX WINDOW", labels.includes("HR MAX WINDOW"));
  assert("chips include NEAR HR", labels.includes("NEAR HR"));
  assert("chips capped at 3", v.driverChips.length <= 3);
  const hrMaxWindowChip = v.driverChips.find((c) => c.label === "HR MAX WINDOW");
  assert("HR MAX WINDOW carries its own tone (fire)", hrMaxWindowChip?.tone === "fire");
  const nearHrChip = v.driverChips.find((c) => c.label === "NEAR HR");
  assert("NEAR HR carries its own tone (warn), distinct from HR MAX WINDOW", nearHrChip?.tone === "warn");
}

// ── 4. Importance ordering ─────────────────────────────────────────────────
console.log("\nimportance ordering");
{
  const fire = buildHrRadarCardViewModel(entry({ playerId: "f", userStage: "fire", officialSignalStage: "fire", displayCurrentScore10: 6 }));
  const ready = buildHrRadarCardViewModel(entry({ playerId: "r", userStage: "ready", displayCurrentScore10: 9.9 }));
  const build = buildHrRadarCardViewModel(entry({ playerId: "b", userStage: "build", displayCurrentScore10: 9.9 }));
  assert("fire outranks higher-scored ready", compareByImportance(fire, ready) < 0);
  assert("ready outranks higher-scored build", compareByImportance(ready, build) < 0);
}

// ── 5. Hot Seat selection ──────────────────────────────────────────────────
console.log("\nhot seat selection");
{
  const vms = [
    buildHrRadarCardViewModel(entry({ playerId: "a", userStage: "ready", displayCurrentScore10: 7.0 })),
    buildHrRadarCardViewModel(entry({ playerId: "b", userStage: "fire", officialSignalStage: "fire", displayCurrentScore10: 5.0 })),
    buildHrRadarCardViewModel(entry({ playerId: "c", userStage: "ready", displayCurrentScore10: 8.7 })),
  ];
  const sel = selectQuickDecide(vms);
  assert("hero = the FIRE row (stage beats score)", sel.hero?.playerId === "b");
  assert("hero excluded from queue", !sel.queue.some((q) => q.id === sel.hero?.id));

  // Queue caps at 5.
  const many = Array.from({ length: 9 }, (_, i) =>
    buildHrRadarCardViewModel(entry({ playerId: `q${i}`, userStage: "ready", displayCurrentScore10: i })),
  );
  assert("queue capped at 5", selectQuickDecide(many).queue.length === 5);

  // Track hidden when something higher exists.
  const mixed = [
    buildHrRadarCardViewModel(entry({ playerId: "t1", userStage: "track", displayCurrentScore10: 2 })),
    buildHrRadarCardViewModel(entry({ playerId: "bd", userStage: "build", displayCurrentScore10: 4 })),
  ];
  const mixedSel = selectQuickDecide(mixed);
  assert("track hidden from queue when build exists", !mixedSel.queue.some((q) => q.stage === "track"));

  // Track shown when it's all there is.
  const onlyTrack = [
    buildHrRadarCardViewModel(entry({ playerId: "o1", userStage: "track", displayCurrentScore10: 2 })),
    buildHrRadarCardViewModel(entry({ playerId: "o2", userStage: "track", displayCurrentScore10: 1 })),
  ];
  const onlyTrackSel = selectQuickDecide(onlyTrack);
  assert("track shown when nothing higher (no hero, queue has track)", onlyTrackSel.hero == null && onlyTrackSel.queue.length === 2);
}

// ── 5b. Momentum/urgency tie-breaking within a stage ───────────────────────
console.log("\nmomentum/urgency tie-breaking");
{
  const cooling = buildHrRadarCardViewModel(entry({ playerId: "cool", userStage: "ready", displayCurrentScore10: 7.0, momentumLabel: "cooling_off" }));
  const heating = buildHrRadarCardViewModel(entry({ playerId: "hot", userStage: "ready", displayCurrentScore10: 7.0, momentumLabel: "heating_up" }));
  assert("same score, heating up outranks cooling off", compareByImportance(heating, cooling) < 0);

  const flatFar = buildHrRadarCardViewModel(entry({ playerId: "far", userStage: "build", displayCurrentScore10: 5.0, remainingPAExpectation: 4 }));
  const flatUrgent = buildHrRadarCardViewModel(entry({ playerId: "urgent", userStage: "build", displayCurrentScore10: 5.0, remainingPAExpectation: 0.5 }));
  assert("same score, ~1 PA left outranks plenty of PAs left", compareByImportance(flatUrgent, flatFar) < 0);

  // Bonuses can never cross a stage boundary — a red-hot TRACK row still
  // never outranks the flattest BUILD row.
  const hottestTrack = buildHrRadarCardViewModel(entry({ playerId: "hottrack", userStage: "track", displayCurrentScore10: 10, momentumLabel: "heating_up", remainingPAExpectation: 0.5 }));
  const flattestBuild = buildHrRadarCardViewModel(entry({ playerId: "flatbuild", userStage: "build", displayCurrentScore10: 0 }));
  assert("momentum/urgency never crosses a stage boundary", compareByImportance(flattestBuild, hottestTrack) < 0);
}

// ── 5c. Cross-tier board priority pick (Full Ladder, not just Hot Seat) ────
console.log("\ncross-tier board priority");
{
  // With no FIRE/READY on the board, the best BUILD row is still #1 overall —
  // not just #1 inside its own section.
  const noFireBoard = [
    buildHrRadarCardViewModel(entry({ playerId: "t1", userStage: "track", displayCurrentScore10: 9 })),
    buildHrRadarCardViewModel(entry({ playerId: "b1", userStage: "build", displayCurrentScore10: 3 })),
  ];
  const pick = selectTopPriority(noFireBoard);
  assert("best BUILD beats best TRACK even with a lower score", pick?.playerId === "b1");

  // Resolved rows (cashed/missed) never win the live priority pick.
  const withResolved = [
    buildHrRadarCardViewModel(entry({ playerId: "cashed1", userStage: "resolved", outcome: "called_hit", displayCurrentScore10: 10 }), { sectionHint: "cashed" }),
    buildHrRadarCardViewModel(entry({ playerId: "t2", userStage: "track", displayCurrentScore10: 1 })),
  ];
  assert("resolved rows never win the live priority pick", selectTopPriority(withResolved)?.playerId === "t2");

  // Empty / all-resolved board → no pick, not a crash.
  assert("no live rows → no top priority", selectTopPriority([withResolved[0]]) == null);

  const labeled = buildHrRadarCardViewModel(entry({ playerId: "l1", userStage: "ready", displayCurrentScore10: 8, momentumLabel: "heating_up" }));
  assert("reason label includes stage and momentum", topPriorityReasonLabel(labeled) === "Ready · heating up");
}

// ── 6. Stage-movement detection (dopamine layer) ───────────────────────────
console.log("\nstage movement detection");
{
  const prev = new Map<any, any>([["x|g", "build"], ["y|g", "ready"], ["z|g", "track"]]);
  const moves = detectStageMovements(prev, [
    { id: "x|g", playerName: "X", stage: "ready" },   // build→ready: upward → toast
    { id: "y|g", playerName: "Y", stage: "build" },   // ready→build: downward → ignore
    { id: "z|g", playerName: "Z", stage: "track" },   // unchanged → ignore
    { id: "new|g", playerName: "N", stage: "fire" },  // brand new → not a "movement"
  ]);
  assert("only upward move surfaces", moves.length === 1 && moves[0].id === "x|g" && moves[0].to === "ready");
}

// ── 7. Stage labels consistent — the ONE consumer vocabulary ───────────────
console.log("\nstage labels");
assert("public labels use the one consumer vocabulary (no Attack/Playable/Lean/Watchlist/Cashed)",
  HR_PUBLIC_STAGE_LABEL.track === "Watch" && HR_PUBLIC_STAGE_LABEL.build === "Build" &&
  HR_PUBLIC_STAGE_LABEL.ready === "Ready" && HR_PUBLIC_STAGE_LABEL.fire === "Fire" &&
  HR_PUBLIC_STAGE_LABEL.cashed === "Signal Hit" && HR_PUBLIC_STAGE_LABEL.missed === "Missed");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) { for (const f of failures) console.log(` - ${f}`); process.exit(1); }
process.exit(0);
