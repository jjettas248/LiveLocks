// Unit test — HR Radar canonical freshness overlay.
//   npx tsx server/mlb/hrRadarFreshnessOverlay.test.ts
import { applyCanonicalFreshnessOverlay, computeHrRadarFreshnessReport, type OverlayLadder } from "./hrRadarFreshnessOverlay";
import type { CanonicalHrRadarState } from "./hrRadarCanonicalStore";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

const NOW = Date.parse("2026-06-24T18:00:00.000Z");
function iso(offsetMs: number) { return new Date(NOW + offsetMs).toISOString(); }

function entry(playerId: string, gameId: string, extra: Record<string, any> = {}): any {
  return { playerId, gameId, playerName: `P${playerId}`, team: "NYY", currentStatus: "live", ...extra };
}

function canon(playerId: string, gameId: string, section: CanonicalHrRadarState["section"], extra: Partial<CanonicalHrRadarState> = {}): CanonicalHrRadarState {
  return {
    gameId, playerId, playerName: `P${playerId}`, team: "NYY", sessionDate: "2026-06-24",
    lifecycleState: "watch" as any, section, userStage: "fire" as any,
    displayScore10: 8.0, peakScore10: 8.0,
    detectedAt: iso(-60000), detectedInning: 3, latestEvidenceAt: iso(-5000), latestEvidenceInning: 5,
    triggerAbIndex: null, triggerReasons: ["hot contact"], triggerTags: [], contactEvidence: [],
    active: true, terminal: false, updatedAt: iso(-5000),
    ...extra,
  };
}

function emptyLadder(): OverlayLadder {
  return { sections: { attackNow: [], ready: [], building: [], watch: [], cashed: [], dead: [] }, counts: {} };
}

console.log("HR Radar freshness overlay");

// 1. No canonical states → ladder unchanged (additive no-op).
{
  const l = emptyLadder();
  l.sections.building.push(entry("1", "g1"));
  const { diagnostics } = applyCanonicalFreshnessOverlay(l, [], NOW);
  eq("1. no canonical → building row stays", l.sections.building.map((e: any) => e.playerId), ["1"]);
  eq("1b. no canonical → not rebucketed", diagnostics.rebucketed, 0);
  eq("1c. db row stamped freshSource=db", (l.sections.building[0] as any).freshSource, "db");
}

// 2. Promotion: DB has row in building, canonical says FIRE → moves to attackNow.
{
  const l = emptyLadder();
  l.sections.building.push(entry("2", "g1"));
  const { diagnostics } = applyCanonicalFreshnessOverlay(l, [canon("2", "g1", "FIRE")], NOW);
  eq("2. building→attackNow on canonical FIRE", l.sections.attackNow.map((e: any) => e.playerId), ["2"]);
  eq("2b. building now empty", l.sections.building.length, 0);
  eq("2c. rebucketed counted", diagnostics.rebucketed, 1);
  eq("2d. score refreshed from canonical", (l.sections.attackNow[0] as any).currentSignalScore10, 8.0);
  eq("2e. freshSource=canonical", (l.sections.attackNow[0] as any).freshSource, "canonical");
  // C2 (review) — promoted FIRE row gets fresh display contract, not stale BUILD copy.
  eq("2f. promoted row officialSignalStage=fire", (l.sections.attackNow[0] as any).officialSignalStage, "fire");
  eq("2g. promoted row displayRecordEligible=true", (l.sections.attackNow[0] as any).displayRecordEligible, true);
  eq("2h. promoted row has a stage label", typeof (l.sections.attackNow[0] as any).displayStageLabel, "string");
}

// 3. Demotion: DB has row in attackNow, canonical cooled to BUILD → moves down
//    (canonical is fresher, so it wins for live rows).
{
  const l = emptyLadder();
  l.sections.attackNow.push(entry("3", "g1"));
  applyCanonicalFreshnessOverlay(l, [canon("3", "g1", "BUILD", { userStage: "build" as any })], NOW);
  eq("3. attackNow→building on canonical cool-off", l.sections.building.map((e: any) => e.playerId), ["3"]);
  eq("3b. attackNow empty", l.sections.attackNow.length, 0);
  // C2 (review) — demoted row loses record-eligibility (no longer FIRE).
  eq("3c. demoted row displayRecordEligible=false", (l.sections.building[0] as any).displayRecordEligible, false);
  eq("3d. demoted row officialSignalStage=null", (l.sections.building[0] as any).officialSignalStage, null);
}

// 4. Surface: canonical has a FIRE row with NO DB row → synthesized into attackNow.
{
  const l = emptyLadder();
  const { diagnostics } = applyCanonicalFreshnessOverlay(l, [canon("4", "g1", "FIRE")], NOW);
  eq("4. canonical-only FIRE surfaced", l.sections.attackNow.map((e: any) => e.playerId), ["4"]);
  eq("4b. fireSurfaced counted", diagnostics.fireSurfaced, 1);
  eq("4c. surfaced row record-eligible", (l.sections.attackNow[0] as any).displayRecordEligible, true);
  eq("4d. surfaced row provenance", (l.sections.attackNow[0] as any).freshSource, "canonical_only");
}

// 5. Surface gating: canonical-only BUILD/WATCH are NOT injected (only FIRE/READY).
{
  const l = emptyLadder();
  const { diagnostics } = applyCanonicalFreshnessOverlay(l, [canon("5", "g1", "BUILD", { userStage: "build" as any })], NOW);
  eq("5. canonical-only BUILD not surfaced", diagnostics.surfaced, 0);
  eq("5b. building stays empty", l.sections.building.length, 0);
}

// 6. Terminal rows are never touched, and terminal canonical states are ignored.
{
  const l = emptyLadder();
  l.sections.cashed.push(entry("6", "g1", { gradingStatus: "called_hit" }));
  l.sections.dead.push(entry("7", "g1", { gradingStatus: "called_miss" }));
  const cashedCanon = canon("6", "g1", "CASHED", { active: false, terminal: true });
  const { diagnostics } = applyCanonicalFreshnessOverlay(l, [cashedCanon], NOW);
  eq("6. cashed row untouched", l.sections.cashed.map((e: any) => e.playerId), ["6"]);
  eq("6b. dead row untouched", l.sections.dead.map((e: any) => e.playerId), ["7"]);
  eq("6c. terminal canonical ignored", diagnostics.canonicalActive, 0);
}

// 7. Counts recomputed across all buckets.
{
  const l = emptyLadder();
  l.sections.building.push(entry("8", "g1"));
  l.sections.cashed.push(entry("9", "g1"));
  applyCanonicalFreshnessOverlay(l, [canon("8", "g1", "FIRE"), canon("10", "g1", "READY", { userStage: "ready" as any })], NOW);
  eq("7. attackNow count", l.counts!.attackNow, 1);   // row 8 promoted
  eq("7b. ready count (surfaced 10)", l.counts!.ready, 1);
  eq("7c. cashed count preserved", l.counts!.cashed, 1);
  eq("7d. total", l.counts!.total, 3);
}

// 8. Read-only freshness report — does NOT mutate, and reports per-row provenance.
{
  const l = emptyLadder();
  l.sections.building.push(entry("1", "g1"));      // DB row, canonical says FIRE → rebucket/stale
  l.sections.watch.push(entry("2", "g1"));          // DB-only, no canonical
  l.sections.cashed.push(entry("9", "g1", { gradingStatus: "called_hit" }));
  const states = [
    canon("1", "g1", "FIRE"),
    canon("3", "g1", "FIRE"),                        // canonical-only → surfaced in report
    canon("9", "g1", "FIRE", { active: false, terminal: true }), // terminal → ignored
  ];
  const report = computeHrRadarFreshnessReport(l, states, NOW);
  eq("8. report does NOT mutate ladder (building still has 1)", l.sections.building.map((e: any) => e.playerId), ["1"]);
  eq("8b. liveDbRows = 2", report.summary.liveDbRows, 2);
  eq("8c. canonicalActive = 2 (terminal ignored)", report.summary.canonicalActive, 2);
  eq("8d. rebucketed/stale = 1 (player 1)", report.summary.rebucketed, 1);
  eq("8e. canonicalOnly = 1 (player 3)", report.summary.canonicalOnly, 1);
  const r1 = report.rows.find((r) => r.playerId === "1")!;
  eq("8f. player 1 source=canonical, overlayApplied", [r1.source, r1.overlayApplied], ["canonical", true]);
  eq("8g. player 1 has fresh ages + canonicalUpdatedAt", [typeof r1.freshAgeMs, typeof r1.freshEvidenceAgeMs, r1.canonicalUpdatedAt != null], ["number", "number", true]);
  const r2 = report.rows.find((r) => r.playerId === "2")!;
  eq("8h. player 2 db-only, reasonSkipped", [r2.source, r2.reasonSkipped], ["db", "no_active_canonical"]);
  const r3 = report.rows.find((r) => r.playerId === "3")!;
  eq("8i. player 3 canonical_only, dbStage null", [r3.source, r3.dbStage], ["canonical_only", null]);
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
