// Run: npx tsx server/engines/nbaPregame/minutes/teamMinutesAllocator.test.ts
// Pregame Targets PR3 — team minutes allocator: conservation (240 + 25·E[OT])
// asserted against the REAL allocator output; DNP atom distinct from role
// variance; OT as probability mass; bounds; determinism; fail-closed.
import {
  allocateTeamMinutes,
  playerMinutes,
  waterFillConditionalMeans,
  CONSERVATION_TOLERANCE,
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

// ── Water-filling conserves under player caps + hard postcondition ──────────
{
  // A roster whose top players would blow past 48 min under naive scaling: the
  // budget must still be conserved (excess water-fills to the rest), never clipped
  // away. Two stars + thin bench.
  const alloc = allocateTeamMinutes({
    players: [
      { playerId: "s1", playProbability: 1, projectedMinutesIfActive: 60 },
      { playerId: "s2", playProbability: 1, projectedMinutesIfActive: 58 },
      { playerId: "r1", playProbability: 1, projectedMinutesIfActive: 30 },
      { playerId: "r2", playProbability: 1, projectedMinutesIfActive: 28 },
      { playerId: "r3", playProbability: 1, projectedMinutesIfActive: 26 },
      { playerId: "r4", playProbability: 1, projectedMinutesIfActive: 24 },
    ],
  });
  ok(approx(alloc.expectedTeamMinutes, 240, 1e-6), "water-fill conserves 240 despite cap pressure");
  for (const p of alloc.players) {
    ok(p.support.every((s) => s.minutes <= REGULATION_PLAYER_MAX + 1e-9), `${p.playerId} respects the 48-min cap`);
  }
  // The two stars are pinned at the cap (their desired share exceeds 48).
  const s1 = playerMinutes(alloc, "s1")!;
  ok(Math.max(...s1.support.map((s) => s.minutes)) <= REGULATION_PLAYER_MAX + 1e-9, "capped star never exceeds 48");
}

// ── Infeasible one-player roster → throws (fail closed, never non-conserved) ─
{
  ok(
    throws(() => allocateTeamMinutes({ players: [{ playerId: "solo", playProbability: 1, projectedMinutesIfActive: 40 }] })),
    "one-player roster (capacity 48 < 240) throws instead of returning 48",
  );
  // Two players also cannot physically cover 240 (2·48 = 96 < 240).
  ok(
    throws(() => allocateTeamMinutes({ players: [
      { playerId: "a", playProbability: 1, projectedMinutesIfActive: 40 },
      { playerId: "b", playProbability: 1, projectedMinutesIfActive: 40 },
    ] })),
    "two-player roster (capacity 96 < 240) throws",
  );
}

// ── Low aggregate availability → throws (capacity below budget) ─────────────
{
  // 9 players each only 10% likely to play: Σ π·cap = 9·0.1·48 = 43.2 < 240.
  ok(
    throws(() => allocateTeamMinutes({
      players: Array.from({ length: 9 }, (_, i) => ({ playerId: `p${i}`, playProbability: 0.1, projectedMinutesIfActive: 25 })),
    })),
    "low aggregate availability (capacity < budget) throws",
  );
  // A borderline-feasible roster still conserves exactly.
  const feasible = allocateTeamMinutes({
    players: Array.from({ length: 9 }, (_, i) => ({ playerId: `p${i}`, playProbability: 0.9, projectedMinutesIfActive: [30, 30, 28, 28, 26, 24, 22, 12, 10][i] })),
  });
  ok(approx(feasible.expectedTeamMinutes, feasible.minuteBudget, 1e-6), "feasible reduced-availability roster conserves");
}

// ── OT cap pressure → conserves at every OT count (or throws) ───────────────
{
  const alloc = allocateTeamMinutes({
    players: [
      { playerId: "s1", playProbability: 1, projectedMinutesIfActive: 52 },
      { playerId: "s2", playProbability: 1, projectedMinutesIfActive: 50 },
      { playerId: "r1", playProbability: 1, projectedMinutesIfActive: 30 },
      { playerId: "r2", playProbability: 1, projectedMinutesIfActive: 28 },
      { playerId: "r3", playProbability: 1, projectedMinutesIfActive: 26 },
      { playerId: "r4", playProbability: 1, projectedMinutesIfActive: 24 },
    ],
    otPeriodProbabilities: [0.6, 0.3, 0.1],
  });
  ok(approx(alloc.expectedTeamMinutes, alloc.minuteBudget, 1e-6), "OT cap-pressure roster conserves 240+25·E[OT]");
  const maxOt = 2;
  const physicalMax = REGULATION_PLAYER_MAX + OT_PLAYER_MINUTES_PER_PERIOD * maxOt; // 58
  for (const p of alloc.players) {
    ok(p.support.every((s) => s.minutes <= physicalMax + 1e-9), `${p.playerId} within OT physical max`);
  }
}

// ── waterFillConditionalMeans: direct unit behavior ─────────────────────────
{
  // Uncapped: μ_i = λ·w_i with Σ π_i μ_i = budget.
  const mu = waterFillConditionalMeans([1, 1, 1], [30, 20, 10], 240 / 4, 48); // budget 60
  ok(approx(mu[0] + mu[1] + mu[2], 60, 1e-9), "water-fill Σμ = budget (π=1)");
  ok(approx(mu[0] / mu[1], 30 / 20, 1e-9), "uncapped shares proportional to weight");
  // Infeasible throws.
  ok(throws(() => waterFillConditionalMeans([1], [30], 240, 48)), "single-player water-fill infeasible throws");
  ok(CONSERVATION_TOLERANCE < 1e-3, "conservation tolerance is tight");
}

// ── otParticipation is OVERTIME-only: no OT mass ⇒ it changes nothing ────────
{
  const rosterA: TeamMinutesInput = {
    players: [
      { playerId: "a", playProbability: 1, projectedMinutesIfActive: 34 },
      { playerId: "b", playProbability: 1, projectedMinutesIfActive: 30 },
      { playerId: "c", playProbability: 1, projectedMinutesIfActive: 28 },
      { playerId: "d", playProbability: 1, projectedMinutesIfActive: 26 },
      { playerId: "e", playProbability: 1, projectedMinutesIfActive: 24 },
      { playerId: "f", playProbability: 1, projectedMinutesIfActive: 22 },
      { playerId: "g", playProbability: 1, projectedMinutesIfActive: 20 },
      { playerId: "h", playProbability: 1, projectedMinutesIfActive: 18 },
      { playerId: "i", playProbability: 1, projectedMinutesIfActive: 14 },
    ],
  };
  // Same roster, but with wildly different otParticipation on every player.
  const rosterB: TeamMinutesInput = {
    players: rosterA.players.map((p, idx) => ({ ...p, otParticipation: idx === 0 ? 0 : idx * 3 })),
  };
  const a = allocateTeamMinutes(rosterA); // no OT mass (default [1])
  const b = allocateTeamMinutes(rosterB);
  ok(JSON.stringify(a.players) === JSON.stringify(b.players), "with no OT mass, otParticipation changes NOTHING (regulation is otParticipation-independent)");
}

// ── A player with projectedMinutes>0 but otParticipation:0 KEEPS regulation ──
{
  const alloc = allocateTeamMinutes({
    players: [
      { playerId: "starter", playProbability: 1, projectedMinutesIfActive: 34, otParticipation: 0 },
      { playerId: "b", playProbability: 1, projectedMinutesIfActive: 32 },
      { playerId: "c", playProbability: 1, projectedMinutesIfActive: 30 },
      { playerId: "d", playProbability: 1, projectedMinutesIfActive: 28 },
      { playerId: "e", playProbability: 1, projectedMinutesIfActive: 26 },
      { playerId: "f", playProbability: 1, projectedMinutesIfActive: 24 },
      { playerId: "g", playProbability: 1, projectedMinutesIfActive: 22 },
      { playerId: "h", playProbability: 1, projectedMinutesIfActive: 20 },
    ],
  });
  const starter = playerMinutes(alloc, "starter")!;
  ok(starter.expectedMinutes > 30, "otParticipation:0 player still gets its full regulation role (not zeroed)");
}

// ── Under OT: zero-OT player keeps regulation baseline, no lift; increment ────
//    redistributes to eligible players; team conservation still holds. ────────
{
  const players = [
    { playerId: "noOt", playProbability: 1, projectedMinutesIfActive: 30, otParticipation: 0 },
    { playerId: "s1", playProbability: 1, projectedMinutesIfActive: 34 },
    { playerId: "s2", playProbability: 1, projectedMinutesIfActive: 32 },
    { playerId: "r1", playProbability: 1, projectedMinutesIfActive: 28 },
    { playerId: "r2", playProbability: 1, projectedMinutesIfActive: 26 },
    { playerId: "r3", playProbability: 1, projectedMinutesIfActive: 24 },
    { playerId: "r4", playProbability: 1, projectedMinutesIfActive: 22 },
    { playerId: "r5", playProbability: 1, projectedMinutesIfActive: 14 },
  ];
  const noOtMass = allocateTeamMinutes({ players });
  const withOt = allocateTeamMinutes({ players, otPeriodProbabilities: [0.6, 0.3, 0.1] });
  const noOtPlayerBase = playerMinutes(noOtMass, "noOt")!.expectedMinutes;
  const noOtPlayerWithOt = playerMinutes(withOt, "noOt")!.expectedMinutes;
  // Zero-OT player: identical regulation baseline, no lift from OT mass.
  ok(approx(noOtPlayerBase, noOtPlayerWithOt, 1e-6), "zero-OT-participation player gets NO OT lift (same regulation baseline)");
  // An eligible player DOES gain from OT.
  const s1Base = playerMinutes(noOtMass, "s1")!.expectedMinutes;
  const s1WithOt = playerMinutes(withOt, "s1")!.expectedMinutes;
  ok(s1WithOt > s1Base, "an eligible player absorbs the redistributed OT increment");
  // Team conservation still holds with a zero-OT player present.
  ok(approx(withOt.expectedTeamMinutes, withOt.minuteBudget, 1e-6), "team conservation holds with a zero-OT player");
}

// ── otParticipation reshapes ONLY the OT increment, not regulation ──────────
{
  const players = [
    { playerId: "a", playProbability: 1, projectedMinutesIfActive: 30 },
    { playerId: "b", playProbability: 1, projectedMinutesIfActive: 30 },
    { playerId: "c", playProbability: 1, projectedMinutesIfActive: 30 },
    { playerId: "d", playProbability: 1, projectedMinutesIfActive: 30 },
    { playerId: "e", playProbability: 1, projectedMinutesIfActive: 30 },
    { playerId: "f", playProbability: 1, projectedMinutesIfActive: 30 },
    { playerId: "g", playProbability: 1, projectedMinutesIfActive: 30 },
    { playerId: "h", playProbability: 1, projectedMinutesIfActive: 30 },
  ];
  const flat = allocateTeamMinutes({ players, otPeriodProbabilities: [0.5, 0.5] });
  const skewed = allocateTeamMinutes({
    players: players.map((p, i) => ({ ...p, otParticipation: i === 0 ? 100 : 1 })),
    otPeriodProbabilities: [0.5, 0.5],
  });
  // Player a (heavy OT weight) gains MORE OT than in the flat case; total still conserved.
  ok(playerMinutes(skewed, "a")!.expectedMinutes > playerMinutes(flat, "a")!.expectedMinutes, "high otParticipation → more OT increment");
  ok(approx(skewed.expectedTeamMinutes, skewed.minuteBudget, 1e-6), "skewed OT weights still conserve the team budget");
}

console.log(`\nteamMinutesAllocator.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
