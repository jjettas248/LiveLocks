// ── HR Radar match-decision unit tests ────────────────────────────────────
// Run with `tsx server/validation/hrRadar/matchDecision.test.ts`. Mirrors the
// test pattern in server/ncaabEngine.test.ts (no external test runner).
//
// Guards the called_hit / timestamp-rescue / late_signal classification
// branches in `matchHrRadarAlertToHrEvent` (server/storage.ts) so a future
// regression in the late-vs-cashed grading bug class is caught without a
// live database.

import {
  decideHrRadarMatch,
  TICK_TOLERANCE_MS,
  type MatchDecisionAlert,
  type MatchDecisionQualifyingEvent,
} from "./matchDecision";

function makeAlert(overrides: Partial<MatchDecisionAlert> = {}): MatchDecisionAlert {
  const detectedAt = overrides.detectedAt ?? new Date("2026-04-23T22:00:00.000Z");
  return {
    id: "alert-001",
    signalDetectedAt: detectedAt,
    detectedAt,
    signalInning: 4,
    signalHalf: "T",
    detectedInning: 4,
    detectedHalf: "T",
    ...overrides,
  };
}

function makeQualifyingEvent(
  overrides: Partial<MatchDecisionQualifyingEvent> = {},
): MatchDecisionQualifyingEvent {
  return {
    id: 42,
    eventType: "qualified_detected",
    detectedAt: new Date("2026-04-23T22:00:30.000Z"),
    inning: 4,
    half: "T",
    ...overrides,
  };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      passed++;
      console.log(`  ✓ ${testName}`);
    } else {
      failed++;
      console.error(`  ✗ ${testName}`);
    }
  }

  console.log("\n=== HR Radar match-decision tests ===\n");

  // T1 — Strict qualifying event + row crossed out of WATCH ⇒ called_hit.
  console.log("T1: qualifying event + rowEverQualified ⇒ called_hit");
  {
    const alert = makeAlert();
    const ev = makeQualifyingEvent();
    const hrEnd = new Date("2026-04-23T22:05:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: ev, hrEnd });
    assert(r.gradingStatus === "called_hit", `gradingStatus=${r.gradingStatus}`);
    assert(r.matchMethod === "direct_pre_hr_signal", `matchMethod=${r.matchMethod}`);
    assert(r.signalEventId === 42, `signalEventId=${r.signalEventId}`);
    assert(r.matchedBeforeHr === true, "matchedBeforeHr=true");
    assert(r.isLateSignal === false, "isLateSignal=false");
  }

  // T2 — Timestamp-rescue: alert exists, NO qualifying signal_event row,
  //      but signalDetectedAt < hrEnd by more than TICK_TOLERANCE_MS.
  console.log("\nT2: timestamp-rescue ⇒ called_hit (no qualifying event)");
  {
    const alert = makeAlert({
      signalDetectedAt: new Date("2026-04-23T22:00:00.000Z"),
      detectedAt: new Date("2026-04-23T22:00:00.000Z"),
      // Row never crossed out of WATCH (detectedInning is null) — yet the
      // persisted signalDetectedAt clearly precedes the HR. The matcher
      // must rescue this as called_hit.
      detectedInning: null,
      detectedHalf: null,
    });
    const hrEnd = new Date("2026-04-23T22:03:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: null, hrEnd });
    assert(r.gradingStatus === "called_hit", `gradingStatus=${r.gradingStatus} (expected called_hit)`);
    assert(r.matchMethod === "direct_pre_hr_signal", `matchMethod=${r.matchMethod}`);
    assert(r.signalEventId === null, `signalEventId=${r.signalEventId} (expected null)`);
    assert(r.matchedBeforeHr === true, "matchedBeforeHr=true");
    assert(r.isLateSignal === false, "isLateSignal=false");
    assert(/timestamp-rescue/i.test(r.gradingReason), `reason mentions timestamp-rescue: ${r.gradingReason}`);
  }

  // T3 — Timestamp-rescue still fires even when the qualifying event row is
  //      missing AND detectedInning IS populated on the alert.
  console.log("\nT3: timestamp-rescue when only the event row is missing");
  {
    const alert = makeAlert({
      signalDetectedAt: new Date("2026-04-23T22:00:00.000Z"),
      detectedAt: new Date("2026-04-23T22:00:00.000Z"),
      detectedInning: 4,
      detectedHalf: "T",
    });
    const hrEnd = new Date("2026-04-23T22:04:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: null, hrEnd });
    assert(r.gradingStatus === "called_hit", `gradingStatus=${r.gradingStatus}`);
    assert(r.matchMethod === "direct_pre_hr_signal", `matchMethod=${r.matchMethod}`);
  }

  // T4 — Genuine late signal (detection AFTER hrEnd) ⇒ late_signal.
  console.log("\nT4: detection after HR ⇒ late_signal");
  {
    const alert = makeAlert({
      signalDetectedAt: new Date("2026-04-23T22:10:00.000Z"),
      detectedAt: new Date("2026-04-23T22:10:00.000Z"),
    });
    const hrEnd = new Date("2026-04-23T22:05:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: null, hrEnd });
    assert(r.gradingStatus === "late_signal", `gradingStatus=${r.gradingStatus}`);
    assert(r.isLateSignal === true, "isLateSignal=true");
    assert(r.matchMethod === "post_hr_fallback", `matchMethod=${r.matchMethod}`);
    assert(r.signalEventId === null, "signalEventId=null");
  }

  // T5 — Same engine tick (delta within tolerance) ⇒ late_signal, NOT
  //      timestamp-rescue. Prevents false-positive cashed credits when the
  //      HR and the signal land in the same poll.
  console.log("\nT5: within tick tolerance ⇒ late_signal");
  {
    const sigAt = new Date("2026-04-23T22:00:00.000Z");
    const hrEnd = sigAt.getTime() + (TICK_TOLERANCE_MS - 100);
    const alert = makeAlert({
      signalDetectedAt: sigAt,
      detectedAt: sigAt,
      detectedInning: null,
      detectedHalf: null,
    });
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: null, hrEnd });
    assert(r.gradingStatus === "late_signal", `gradingStatus=${r.gradingStatus} (within tolerance must NOT rescue)`);
  }

  // T6 — Qualifying event exists but row never qualified (detectedInning
  //      is null). Falls through to the timestamp branch; if timestamp
  //      qualifies, becomes called_hit via rescue.
  console.log("\nT6: qualifying event but row never qualified ⇒ timestamp-rescue path");
  {
    const alert = makeAlert({
      signalDetectedAt: new Date("2026-04-23T22:00:00.000Z"),
      detectedAt: new Date("2026-04-23T22:00:00.000Z"),
      detectedInning: null,
      detectedHalf: null,
    });
    const ev = makeQualifyingEvent({ id: 99 });
    const hrEnd = new Date("2026-04-23T22:05:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: ev, hrEnd });
    assert(r.gradingStatus === "called_hit", `gradingStatus=${r.gradingStatus}`);
    // Rescue branch keeps the qualifying event id when present.
    assert(r.signalEventId === 99, `signalEventId=${r.signalEventId}`);
  }

  // T7 — hrEnd unknown (null) and no qualifying event ⇒ late_signal
  //      (the rescue branch requires a known hrEnd to make a decision).
  console.log("\nT7: unknown hrEnd ⇒ late_signal fallback");
  {
    const alert = makeAlert({ detectedInning: null, detectedHalf: null });
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: null, hrEnd: null });
    assert(r.gradingStatus === "late_signal", `gradingStatus=${r.gradingStatus}`);
  }

  // T8 — Result preserves the ORIGINAL detection inning rather than the
  //      latest qualifying event's inning when both are present.
  console.log("\nT8: preserves original signalInning over event inning");
  {
    const alert = makeAlert({
      signalInning: 3,
      signalHalf: "T",
      detectedInning: 3,
      detectedHalf: "T",
    });
    const ev = makeQualifyingEvent({ inning: 6, half: "B" });
    const hrEnd = new Date("2026-04-23T22:30:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: ev, hrEnd });
    assert(r.signalInning === 3, `signalInning=${r.signalInning} (expected original 3)`);
    assert(r.signalHalf === "T", `signalHalf=${r.signalHalf}`);
  }

  // T9 — Task #126 presence-only floor. detectedInning IS NULL AND
  //      signalDetectedAt IS NULL AND no qualifying event ⇒ called_miss
  //      (presence-only). Must NEVER promote to called_hit via
  //      timestamp-rescue, even though hrEnd is well after detectedAt.
  console.log("\nT9: presence-only ⇒ called_miss (never promotes to called_hit)");
  {
    const alert = makeAlert({
      signalDetectedAt: null,
      detectedAt: new Date("2026-04-23T22:00:00.000Z"),
      detectedInning: null,
      detectedHalf: null,
      signalInning: null,
      signalHalf: null,
    });
    const hrEnd = new Date("2026-04-23T22:30:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: null, hrEnd });
    assert(r.gradingStatus === "called_miss", `gradingStatus=${r.gradingStatus} (expected called_miss)`);
    assert(r.matchMethod === "player_game_only", `matchMethod=${r.matchMethod}`);
    assert(r.matched === true, "matched=true");
    assert(r.matchedBeforeHr === false, "matchedBeforeHr=false");
    assert(r.isLateSignal === false, "isLateSignal=false");
    assert(r.signalEventId === null, "signalEventId=null");
    assert(/presence-only/i.test(r.gradingReason), `reason mentions presence-only: ${r.gradingReason}`);
  }

  // T10 — Presence-only row but a qualifying event arrived later ⇒ Branch 0
  //       no longer applies (lastQualifyingEvent != null), falls to normal
  //       branches. With detectedInning still null + no rescue tolerance,
  //       this would land in late_signal — which is correct because the
  //       row has been promoted out of presence-only at that point.
  console.log("\nT10: presence-only row with later qualifying event no longer triggers Branch 0");
  {
    const alert = makeAlert({
      signalDetectedAt: null,
      detectedAt: new Date("2026-04-23T22:00:00.000Z"),
      detectedInning: null,
      detectedHalf: null,
      signalInning: null,
      signalHalf: null,
    });
    const ev = makeQualifyingEvent({ id: 7 });
    const hrEnd = new Date("2026-04-23T22:05:00.000Z").getTime();
    const r = decideHrRadarMatch({ alert, lastQualifyingEvent: ev, hrEnd });
    assert(r.gradingStatus !== "called_miss", `gradingStatus=${r.gradingStatus} (must NOT be presence-only when a qualifying event exists)`);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runTests();
