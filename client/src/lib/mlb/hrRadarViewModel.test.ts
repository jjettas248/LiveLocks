// HR Radar canonical view model — invariants.
// Run: npx tsx client/src/lib/mlb/hrRadarViewModel.test.ts
//
// Guards the UX-v1 contract: the client view model maps server-stamped stage /
// score / drivers into display fields and NEVER computes an engine score, infers
// a stage, or leaks raw diagnostics. Also covers the Hot Seat selection rules
// (single hero, ≤5 queue, Track hidden) and stage-movement detection.

import {
  buildHrRadarCardViewModel,
  selectQuickDecide,
  compareByImportance,
  HR_PUBLIC_STAGE_LABEL,
} from "@/lib/mlb/hrRadarViewModel";
import { detectStageMovements } from "@/components/mlb/hr-radar/HrRadarStageToast";
import type { HrRadarLadderEntry } from "@/components/mlb/HrRadarLadder";

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

// ── 1. Stage mapping ───────────────────────────────────────────────────────
console.log("stage mapping");
{
  const fire = buildHrRadarCardViewModel(entry({ userStage: "fire", officialSignalStage: "fire", displayCurrentScore10: 9.2 }));
  assert("fire userStage → fire", fire.stage === "fire");
  assert("fire is official call", fire.isOfficialCall === true);
  assert("fire is hero eligible", fire.isHeroEligible === true);
  assert("fire CTA is take_it", fire.primaryCta === "take_it");

  const ready = buildHrRadarCardViewModel(entry({ userStage: "ready", displayCurrentScore10: 7.8 }));
  assert("ready userStage → ready", ready.stage === "ready");
  assert("ready is hero eligible", ready.isHeroEligible === true);
  assert("ready is NOT official", ready.isOfficialCall === false);
  assert("ready CTA is watch_next_ab (never take_it)", ready.primaryCta === "watch_next_ab");

  const build = buildHrRadarCardViewModel(entry({ userStage: "build", displayCurrentScore10: 4.5 }));
  assert("build → build, not hero, track_next_ab", build.stage === "build" && !build.isHeroEligible && build.primaryCta === "track_next_ab");

  const track = buildHrRadarCardViewModel(entry({ userStage: "track", displayCurrentScore10: 2.1 }));
  assert("track → track, not hero, add_to_watch", track.stage === "track" && !track.isHeroEligible && track.primaryCta === "add_to_watch");

  const cashed = buildHrRadarCardViewModel(entry({ userStage: "resolved", outcome: "called_hit", displayCurrentScore10: 8 }), { sectionHint: "cashed" });
  assert("resolved + cashed hint → cashed, resolved, view_hit", cashed.stage === "cashed" && cashed.isResolved && cashed.primaryCta === "view_hit");

  const missed = buildHrRadarCardViewModel(entry({ userStage: "resolved", outcome: "called_miss" }), { sectionHint: "missed" });
  assert("resolved + missed hint → missed", missed.stage === "missed" && missed.isResolved);

  // Outcome-derived cashed/missed without a hint (Full Ladder keeps all rows).
  const cashedNoHint = buildHrRadarCardViewModel(entry({ currentStatus: "resolved", outcome: "called_hit_ready" }));
  assert("resolved outcome called_hit_* → cashed (no hint)", cashedNoHint.stage === "cashed");
  const missedNoHint = buildHrRadarCardViewModel(entry({ currentStatus: "resolved", outcome: "called_miss" }));
  assert("resolved outcome miss → missed (no hint)", missedNoHint.stage === "missed");
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
  assert("chips include HR MAX WINDOW", v.driverChips.includes("HR MAX WINDOW"));
  assert("chips include NEAR HR", v.driverChips.includes("NEAR HR"));
  assert("chips capped at 3", v.driverChips.length <= 3);
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

// ── 7. Stage labels consistent ─────────────────────────────────────────────
console.log("\nstage labels");
assert("public labels cover the one ladder",
  HR_PUBLIC_STAGE_LABEL.track === "Track" && HR_PUBLIC_STAGE_LABEL.build === "Build" &&
  HR_PUBLIC_STAGE_LABEL.ready === "Ready" && HR_PUBLIC_STAGE_LABEL.fire === "Fire" &&
  HR_PUBLIC_STAGE_LABEL.cashed === "Cashed" && HR_PUBLIC_STAGE_LABEL.missed === "Missed");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) { for (const f of failures) console.log(` - ${f}`); process.exit(1); }
process.exit(0);
