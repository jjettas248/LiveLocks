// HR Radar runtime smoke — read-only contract checks across the freshness +
// FIRE-only-record surfaces. Composes the REAL functions (no DB, no live
// server) so it can run in CI and catch contract regressions.
//   npx tsx server/mlb/hrRadarRuntimeSmoke.test.ts
//
// Covers (mapping to the reliability spec):
//   2/3. FIRE rows record-eligible; READY rows are not.
//   1/7. Overlaid live rows carry freshness provenance + age (timestamps).
//   6.   No duplicate active row by (gameId, playerId) after overlay.
//   8.   A resolved (cashed/dead) row is never overridden by a stale canonical.
//   4.   Official-miss set excludes uncalled_hr / expired / late_signal.
//   +.   READY-only (peak conv < FIRE band) is not FIRE-committed.
import { buildHrRadarDisplayContract } from "./hrRadarDisplayContract";
import { applyCanonicalFreshnessOverlay, type OverlayLadder } from "./hrRadarFreshnessOverlay";
import { CALLED_HIT_OUTCOME_STATUSES, reachedFireCommitment } from "./hrRadarSection";
import type { CanonicalHrRadarState } from "./hrRadarCanonicalStore";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond ? "" : ` — ${detail}`}`);
  cond ? pass++ : fail++;
}

const NOW = Date.parse("2026-06-24T18:00:00.000Z");
function iso(off: number) { return new Date(NOW + off).toISOString(); }
function canon(playerId: string, section: CanonicalHrRadarState["section"], extra: Partial<CanonicalHrRadarState> = {}): CanonicalHrRadarState {
  return {
    gameId: "G1", playerId, playerName: `P${playerId}`, team: "NYY", sessionDate: "2026-06-24",
    lifecycleState: "fire" as any, section, userStage: "fire" as any,
    displayScore10: 8, peakScore10: 8,
    detectedAt: iso(-60000), detectedInning: 3, latestEvidenceAt: iso(-4000), latestEvidenceInning: 5,
    triggerAbIndex: null, triggerReasons: ["barrel"], triggerTags: [], contactEvidence: [],
    active: true, terminal: false, updatedAt: iso(-4000), ...extra,
  };
}

console.log("\n=== HR Radar Runtime Smoke ===\n");

// 2/3 — record eligibility derives ONLY from FIRE.
ok("2. FIRE row is record-eligible",
  buildHrRadarDisplayContract({ currentSignalScore10: 9, officialSignalStage: "fire" } as any, "attackNow").displayRecordEligible === true);
ok("3. READY row (officialSignalStage=null) is NOT record-eligible",
  buildHrRadarDisplayContract({ currentSignalScore10: 8, officialSignalStage: null } as any, "ready").displayRecordEligible === false);

// 1/7 — overlay stamps provenance + ages on live rows.
{
  const ladder: OverlayLadder = { sections: { attackNow: [], ready: [], building: [{ playerId: "1", gameId: "G1" }], watch: [], cashed: [], dead: [] }, counts: {} };
  applyCanonicalFreshnessOverlay(ladder, [canon("1", "FIRE")], NOW);
  const row: any = ladder.sections.attackNow[0];
  ok("1. overlaid row carries freshSource=canonical", row?.freshSource === "canonical");
  ok("7. overlaid row carries freshAgeMs + freshEvidenceAgeMs", typeof row?.freshAgeMs === "number" && typeof row?.freshEvidenceAgeMs === "number");
}

// 6 — no duplicate (gameId,playerId) across sections after overlay (player in
// both DB-building and canonical-FIRE must collapse to one attackNow row).
{
  const ladder: OverlayLadder = { sections: { attackNow: [], ready: [], building: [{ playerId: "1", gameId: "G1" }], watch: [], cashed: [], dead: [] }, counts: {} };
  applyCanonicalFreshnessOverlay(ladder, [canon("1", "FIRE")], NOW);
  const keys: string[] = [];
  for (const b of ["attackNow", "ready", "building", "watch", "cashed", "dead"] as const) {
    for (const e of ladder.sections[b] as any[]) keys.push(`${e.gameId}_${e.playerId}`);
  }
  ok("6. no duplicate (game,player) after overlay", new Set(keys).size === keys.length, `keys=${keys.join(",")}`);
}

// 8 — a resolved row is never overridden by a stale active canonical.
{
  const ladder: OverlayLadder = { sections: { attackNow: [], ready: [], building: [], watch: [], cashed: [{ playerId: "9", gameId: "G1", gradingStatus: "called_hit" }], dead: [] }, counts: {} };
  applyCanonicalFreshnessOverlay(ladder, [canon("9", "FIRE")], NOW); // stale active FIRE for an already-cashed player
  const inCashed = (ladder.sections.cashed as any[]).some((e) => e.playerId === "9");
  const inLive = (ladder.sections.attackNow as any[]).some((e) => e.playerId === "9");
  ok("8. resolved (cashed) row stays cashed, not re-surfaced live", inCashed && !inLive);
}

// 4 — official-miss set excludes non-official resolutions.
{
  const nonOfficial = ["uncalled_hr", "expired", "late_signal", "early_window_hr"];
  ok("4. uncalled_hr/expired/late_signal/early are NOT called-hit outcomes",
    nonOfficial.every((s) => !CALLED_HIT_OUTCOME_STATUSES.has(s as any)));
}

// + — FIRE commitment gate: elite path or peak conv >= 0.14.
ok("+ FAST_PROMOTE_ELITE is FIRE-committed",
  reachedFireCommitment({ alertPath: "FAST_PROMOTE_ELITE", peakConversionProbability: null }) === true);
ok("+ peak conv 0.20 is FIRE-committed",
  reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: 0.20 }) === true);
ok("+ READY-only (peak conv 0.09, non-elite) is NOT FIRE-committed",
  reachedFireCommitment({ alertPath: "PATH_C", peakConversionProbability: 0.09 }) === false);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
