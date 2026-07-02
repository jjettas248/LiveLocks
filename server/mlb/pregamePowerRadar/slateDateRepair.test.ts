// Pre-Game Power Radar — slate-date repair planner invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/slateDateRepair.test.ts

import { planSlateDateRepair, type SlateDateRepairRow } from "./slateDateRepair";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function row(over: Partial<SlateDateRepairRow>): SlateDateRepairRow {
  return {
    signalId: "mlb-pregame:2026-06-28:g1:b1",
    sessionDate: "2026-06-28",
    gameDate: "2026-06-28",
    startsAt: null,
    gameId: "g1",
    batterId: "b1",
    ...over,
  };
}

// ── Correctly-stamped row: no-op ───────────────────────────────────────────
{
  const correct = row({
    signalId: "mlb-pregame:2026-06-27:g1:b1",
    sessionDate: "2026-06-27",
    gameDate: "2026-06-27",
    startsAt: "2026-06-27T23:05:00.000Z", // 7:05pm EDT — same ET calendar date
  });
  const plan = planSlateDateRepair([correct]);
  ok(plan.length === 0, "correctly-stamped row produces no plan entry (idempotent)");
}

// ── Mis-stamped row from a pre-fix midnight-cutover build ──────────────────
// Game actually started 2026-06-27 (evening ET), but sessionDate was stamped
// 2026-06-28 (as if todayET() ran after midnight without the slate rollover).
{
  const misStamped = row({
    signalId: "mlb-pregame:2026-06-28:g1:b1",
    sessionDate: "2026-06-28",
    gameDate: "2026-06-27",
    startsAt: "2026-06-28T00:05:00.000Z", // 8:05pm EDT on Jun 27 -> Jun 27 ET
  });
  const plan = planSlateDateRepair([misStamped]);
  ok(plan.length === 1, "mis-stamped row produces one plan entry");
  ok(plan[0]?.correctSessionDate === "2026-06-27", "corrected sessionDate uses game start time's ET date, not the stored one");
  ok(plan[0]?.correctSignalId === "mlb-pregame:2026-06-27:g1:b1", "corrected signalId embeds the corrected date");
  ok(plan[0]?.source === "startsAt", "correction sourced from startsAt");
  ok(plan[0]?.collision === false, "no collision when the corrected id is not already present");
}

// ── Fallback to gameDate when startsAt is missing ──────────────────────────
{
  const noStart = row({
    signalId: "mlb-pregame:2026-06-29:g2:b2",
    sessionDate: "2026-06-29",
    gameDate: "2026-06-28",
    startsAt: null,
    gameId: "g2",
    batterId: "b2",
  });
  const plan = planSlateDateRepair([noStart]);
  ok(plan.length === 1, "missing startsAt falls back to gameDate");
  ok(plan[0]?.correctSessionDate === "2026-06-28", "fallback uses gameDate");
  ok(plan[0]?.source === "gameDate", "correction sourced from gameDate");
}

// ── Unresolved: no game evidence at all — never guessed at ─────────────────
{
  const noEvidence: SlateDateRepairRow = {
    signalId: "mlb-pregame:2026-06-30:g3:b3",
    sessionDate: "2026-06-30",
    gameDate: "",
    startsAt: null,
    gameId: "g3",
    batterId: "b3",
  };
  const plan = planSlateDateRepair([noEvidence]);
  ok(plan.length === 0, "row with no game-date evidence is left unresolved (not blanket-corrected)");
}

// ── Collision: corrected id already exists among the row set ───────────────
{
  const misStamped = row({
    signalId: "mlb-pregame:2026-06-28:g4:b4",
    sessionDate: "2026-06-28",
    gameDate: "2026-06-27",
    startsAt: "2026-06-28T00:05:00.000Z",
    gameId: "g4",
    batterId: "b4",
  });
  const alreadyCorrect = row({
    signalId: "mlb-pregame:2026-06-27:g4:b4",
    sessionDate: "2026-06-27",
    gameDate: "2026-06-27",
    startsAt: "2026-06-27T23:05:00.000Z",
    gameId: "g4",
    batterId: "b4",
  });
  const plan = planSlateDateRepair([misStamped, alreadyCorrect]);
  const misEntry = plan.find((p) => p.signalId === misStamped.signalId);
  ok(misEntry !== undefined, "mis-stamped duplicate still produces a plan entry");
  ok(misEntry?.collision === true, "collision flagged when the corrected id already exists — never auto-merged");
}

// ── Regression fixture matching the reported bug ────────────────────────────
{
  const jun27 = row({
    signalId: "mlb-pregame:2026-06-28:gA:bA",
    sessionDate: "2026-06-28",
    gameDate: "2026-06-27",
    startsAt: "2026-06-28T02:10:00.000Z", // late West-coast start, still Jun 27 ET
    gameId: "gA",
    batterId: "bA",
  });
  const jun28 = row({
    signalId: "mlb-pregame:2026-06-29:gB:bB",
    sessionDate: "2026-06-29",
    gameDate: "2026-06-28",
    startsAt: "2026-06-29T02:10:00.000Z",
    gameId: "gB",
    batterId: "bB",
  });
  const jul1 = row({
    signalId: "mlb-pregame:2026-07-01:gC:bC",
    sessionDate: "2026-07-01",
    gameDate: "2026-07-01",
    startsAt: "2026-07-01T23:05:00.000Z",
    gameId: "gC",
    batterId: "bC",
  });
  const plan = planSlateDateRepair([jun27, jun28, jul1]);
  ok(plan.find((p) => p.gameId === "gA")?.correctSessionDate === "2026-06-27", "Jun 27 game corrects to Jun 27, not Jun 28");
  ok(plan.find((p) => p.gameId === "gB")?.correctSessionDate === "2026-06-28", "Jun 28 game corrects to Jun 28, not Jun 29");
  ok(plan.find((p) => p.gameId === "gC") === undefined, "Jul 1 game (already correct) produces no plan entry");
}

console.log(`\nslateDateRepair.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
