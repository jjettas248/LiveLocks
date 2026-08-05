// Run: npx tsx server/engines/nbaPregame/minutes/teamMinutesAllocator.test.ts
// Pregame Targets PR3 — team minutes allocator: conservation (240 + 25·E[OT])
// asserted against the REAL allocator output; DNP atom distinct from role
// variance; OT as probability mass; bounds; determinism; fail-closed.
import {
  allocateTeamMinutes,
  playerMinutes,
  REGULATION_TEAM_MINUTES,
  OT_TEAM_MINUTES_PER_PERIOD,
  REGULATION_PLAYER_MAX,
  OT_PLAYER_MINUTES_PER_PERIOD,
  type TeamMinutesInput,
} from "./teamMinutesAllocator";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// A realistic 9-man rotation summing to ~240 regulation minutes.
const ROSTER: TeamMinutesInput = {
  players: [
    { playerId: "p1", playProbability: 1.0, projectedMinutesIfActive: 36 },
    { playerId: "p2", playProbability: 1.0, projectedMinutesIfActive: 34 },
    { playerId: "p3", playProbability: 0.95, projectedMinutesIfActive: 32 },
    { playerId: "p4", playProbability: 1.0, projectedMinutesIfActive: 30 },
    { playerId: "p5", playProbability: 0.9, projectedMinutesIfActive: 28 },
    { playerId: "p6", playProbability: 1.0, projectedMinutesIfActive: 22 },
    { playerId: "p7", playProbability: 0.85, projectedMinutesIfActive: 18 },
    { playerId: "p8", playProbability: 0.8, projectedMinutesIfActive: 14 },
    { playerId: "p9", playProbability: 0.6, projectedMinutesIfActive: 10 },
  ],
};

// ── Conservation (no OT): Σ E[minutes] == 240, from the REAL allocator ──────
{
  const alloc = allocateTeamMinutes(ROSTER);
  ok(approx(alloc.minuteBudget, 240), "no-OT budget = 240");
  ok(approx(alloc.expectedTeamMinutes, 240, 1e-6), "Σ expected player minutes == 240 (conservation)");
  ok(approx(alloc.expectedTeamMinutes, alloc.minuteBudget, 1e-6), "expected team minutes == budget");
  ok(approx(alloc.expectedOtPeriods, 0), "expected OT periods = 0 without OT input");
}

// ── Conservation WITH OT: budget = 240 + 25·E[OT], asserted on real output ──
{
  const otInput: TeamMinutesInput = { ...ROSTER, otPeriodProbabilities: [0.8, 0.15, 0.05] };
  const alloc = allocateTeamMinutes(otInput);
  const eOt = 0.15 * 1 + 0.05 * 2; // 0.25
  ok(approx(alloc.expectedOtPeriods, eOt, 1e-9), "E[OT] computed from the OT distribution");
  ok(approx(alloc.minuteBudget, REGULATION_TEAM_MINUTES + OT_TEAM_MINUTES_PER_PERIOD * eOt, 1e-9), "budget = 240 + 25·E[OT]");
  ok(approx(alloc.expectedTeamMinutes, alloc.minuteBudget, 1e-6), "Σ expected minutes == 240 + 25·E[OT] (conservation with OT)");
  // OT lifts the budget above regulation.
  ok(alloc.expectedTeamMinutes > 240, "OT increases the conserved team-minute total");
}

// ── Each player's support is a valid distribution within physical bounds ────
{
  const otInput: TeamMinutesInput = { ...ROSTER, otPeriodProbabilities: [0.8, 0.15, 0.05] };
  const alloc = allocateTeamMinutes(otInput);
  const maxOt = otInput.otPeriodProbabilities!.length - 1;
  const physicalMax = REGULATION_PLAYER_MAX + OT_PLAYER_MINUTES_PER_PERIOD * maxOt;
  for (const p of alloc.players) {
    const sum = p.support.reduce((a, s) => a + s.prob, 0);
    ok(approx(sum, 1, 1e-9), `${p.playerId} support probabilities sum to 1`);
    ok(p.support.every((s) => s.minutes >= 0 && s.minutes <= physicalMax), `${p.playerId} minutes within [0, ${physicalMax}]`);
    ok(p.expectedMinutes >= 0 && p.expectedMinutes <= physicalMax, `${p.playerId} expected minutes in bounds`);
  }
}

// ── DNP/inactive mass is a DISTINCT atom at 0, sized by 1 − playProb ────────
{
  const alloc = allocateTeamMinutes(ROSTER);
  const p9 = playerMinutes(alloc, "p9")!; // playProbability 0.6 → 0.4 DNP
  ok(approx(p9.dnpProbability, 0.4, 1e-9), "p9 DNP probability = 1 − playProb");
  const zeroAtom = p9.support.find((s) => s.minutes === 0);
  ok(zeroAtom !== undefined && approx(zeroAtom.prob, 0.4, 1e-9), "p9 carries a distinct 0-minute atom of mass 0.4");
  // A certain starter has NO DNP atom (mass only in active support).
  const p1 = playerMinutes(alloc, "p1")!;
  ok(approx(p1.dnpProbability, 0, 1e-9), "certain starter has no DNP mass");
  ok(!p1.support.some((s) => s.minutes === 0), "certain starter has no 0-minute atom");
  // Active role variance is present and separate: the non-zero support has >1 point.
  const activePts = p1.support.filter((s) => s.minutes > 0);
  ok(activePts.length >= 3, "active mass carries role variance (multiple support points)");
}

// ── OT is probability mass, not a blanket bonus ─────────────────────────────
{
  const noOt = allocateTeamMinutes(ROSTER);
  const withOt = allocateTeamMinutes({ ...ROSTER, otPeriodProbabilities: [0.7, 0.2, 0.1] });
  const p1No = playerMinutes(noOt, "p1")!;
  const p1Ot = playerMinutes(withOt, "p1")!;
  // A rotation player's max support minute is strictly higher WITH OT (mass at
  // higher minutes appears only via the OT-period probabilities).
  const maxNo = Math.max(...p1No.support.map((s) => s.minutes));
  const maxOt = Math.max(...p1Ot.support.map((s) => s.minutes));
  ok(maxOt > maxNo, "OT introduces higher-minute support points for a rotation player");
  // But it is not a flat add to everyone: expected-minute lift scales with the
  // player's OT participation share (a starter gains more than a deep-bench player).
  const liftStarter = playerMinutes(withOt, "p1")!.expectedMinutes - playerMinutes(noOt, "p1")!.expectedMinutes;
  const liftBench = playerMinutes(withOt, "p9")!.expectedMinutes - playerMinutes(noOt, "p9")!.expectedMinutes;
  ok(liftStarter > liftBench, "OT minute lift scales with participation (starter > bench), not a blanket bonus");
}

// ── Determinism ─────────────────────────────────────────────────────────────
{
  const a = allocateTeamMinutes({ ...ROSTER, otPeriodProbabilities: [0.8, 0.15, 0.05] });
  const b = allocateTeamMinutes({ ...ROSTER, otPeriodProbabilities: [0.8, 0.15, 0.05] });
  ok(JSON.stringify(a) === JSON.stringify(b), "allocation is deterministic");
}

// ── Fail closed on absent / degenerate roster info ──────────────────────────
{
  ok(throws(() => allocateTeamMinutes({ players: [] })), "throws on empty roster");
  ok(throws(() => allocateTeamMinutes(undefined as unknown as TeamMinutesInput)), "throws on absent input");
  ok(
    throws(() => allocateTeamMinutes({ players: [{ playerId: "x", playProbability: 0, projectedMinutesIfActive: 30 }] })),
    "throws when no allocatable active minutes",
  );
  ok(
    throws(() => allocateTeamMinutes({ players: [{ playerId: "x", playProbability: 1.2, projectedMinutesIfActive: 30 }] })),
    "throws on out-of-range playProbability",
  );
  ok(
    throws(() => allocateTeamMinutes({ ...ROSTER, otPeriodProbabilities: [0, 0] })),
    "throws when OT probabilities sum to zero",
  );
}

console.log(`\nteamMinutesAllocator.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
