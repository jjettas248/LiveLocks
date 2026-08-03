// The Plate — slate-level champion-invariance lock.
//
// A multi-hitter slate spanning different champion scores/tiers/suppression AND
// different ISO display tiers. Locks the champion evaluation (ranked identities,
// score, tier, suppression, qualification/positiveDriverCount, publication) to a
// golden snapshot so any future regression is caught, and separately asserts the
// ISO DISPLAY tier per hitter. The ISO display metadata is the ONLY thing the
// universal-tag repair was allowed to change; the champion core is frozen.
//
// The same fixture is replayed parent-vs-branch in verification (worktree) to
// prove exact equality of every champion-core field.
//
// Run: npx tsx server/mlb/pregamePowerRadar/plateChampionSlateInvariance.test.ts

import { freezePlateInput, type FrozenPlateInput } from "./frozenPlateInput";
import { evaluatePlateModel } from "./evaluatePlateModel";
import { PLATE_CHAMPION_POLICY } from "./modelVersions/plateChampionJul20";
import { computeBatterPowerProfile } from "./batterPowerProfile";
import type { PlatePublicationContext } from "./modelVersions/plateModelTypes";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const CTX: PlatePublicationContext = { lineupStatus: "posted", isOfficialPlay: false, isPregameTarget: true };

interface SlateHitter {
  id: string;
  trueIso: number | null;
  frozen: FrozenPlateInput;
}

function mk(id: string, batterOver: Record<string, unknown>, over: Record<string, any>, trueIso: number | null): SlateHitter {
  return {
    id,
    trueIso,
    frozen: freezePlateInput({
      sessionDate: "2026-07-24", gameId: "g1", batterId: id, pitcherId: "p1",
      batter: { xISO: 0.24, xSLG: 0.54, barrelRatePct: 14, hardHitRatePct: 49, exitVelocity: 92, maxEV: 114, flyBallPct: 42, hrFBRatioPct: 22, pullRatePct: 48, sweetSpotPct: 38, xwOBA: 0.4, battedBallEvents: 200, bats: "R", ...batterOver },
      pitcher: { pitcherKnown: true, throws: "R", hrPer9VsLHB: 1.2, hrPer9VsRHB: 1.9, eraVsLHB: 3.9, eraVsRHB: 5.1 },
      research: { collected: true, unavailableReason: null, barrelAllowedPct: 11, hardHitAllowedPct: 46, flyBallAllowedPct: 44, last3StartERA: 7.1, daysSinceLastStart: 3 },
      matchup: { batterOpsVsHand: 0.88, batterXslgVsDominantFamily: null, parkFavorsPull: true, bvpPlateAppearances: null, bvpAtBats: null, bvpHr: null, bvpHits: null, bvpStrikeouts: null, bvpOps: null, bvpAvg: null, ...(over.matchup || {}) },
      parkWeather: { parkHrFactor: 1.15, isIndoors: false, weatherAvailable: true, temperature: 84, windSpeed: 12, windDirection: "out", ...(over.parkWeather || {}) },
      lineup: { battingOrderSlot: 3, lineupPosted: true, teamImpliedRuns: null, obpAhead: null, ...(over.lineup || {}) },
      precomputed: { nearHrRecentForm: { score10: 7.2, available: true, drivers: [] }, batterOrderSplit: { score10: 5, direction: "unavailable", drivers: [] }, pitcherOrderSplit: { score10: 5, available: false, direction: "unavailable", drivers: [] } },
      dataQuality: { savantQuality: "full", venueResolved: true, pitcherHandResolved: true },
    } as FrozenPlateInput),
  };
}

// Fixture — exported shape so the parent-vs-branch verification harness can reuse
// the identical inputs.
export const SLATE: SlateHitter[] = [
  mk("a_elite", {}, {}, 0.3),
  mk("b_strong", { xISO: 0.22, barrelRatePct: 11, hardHitRatePct: 45, maxEV: 112, hrFBRatioPct: 18 }, {}, 0.25),
  mk("c_average", { xISO: 0.21, barrelRatePct: 8, hardHitRatePct: 40, maxEV: 109, hrFBRatioPct: 14, pullRatePct: 40 }, {}, 0.15),
  mk("d_unavail", { xISO: 0.23, barrelRatePct: 12 }, {}, 24),
  mk("e_weak", { xISO: 0.205, barrelRatePct: 3, hardHitRatePct: 30, maxEV: 103, hrFBRatioPct: 6, pullRatePct: 33, exitVelocity: 87, sweetSpotPct: 29, xwOBA: 0.3, xSLG: 0.38 },
    { matchup: { batterOpsVsHand: 0.6, parkFavorsPull: false }, parkWeather: { parkHrFactor: 0.9, temperature: 55, windSpeed: 10, windDirection: "in" }, lineup: { battingOrderSlot: 8 } }, 0.08),
];

interface ChampionRow {
  id: string; score10: number; tier: string; suppressed: boolean;
  reasons: string[]; pdc: number; pub: boolean;
}

export function evaluateSlateChampion(): ChampionRow[] {
  return SLATE.map((s) => {
    const ev = evaluatePlateModel(s.frozen, PLATE_CHAMPION_POLICY, CTX);
    return { id: s.id, score10: ev.score10, tier: ev.tier, suppressed: ev.suppressed, reasons: [...ev.suppressedReasons].sort(), pdc: ev.positiveDriverCount, pub: ev.publicEligible };
  }).sort((a, b) => b.score10 - a.score10 || a.id.localeCompare(b.id));
}

// Golden champion snapshot (frozen inputs → deterministic champion outputs).
const GOLDEN: ChampionRow[] = [
  { id: "a_elite", score10: 7.6, tier: "elite", suppressed: false, reasons: [], pdc: 13, pub: true },
  { id: "d_unavail", score10: 7.5, tier: "elite", suppressed: false, reasons: [], pdc: 13, pub: true },
  { id: "b_strong", score10: 7.3, tier: "elite", suppressed: false, reasons: [], pdc: 10, pub: true },
  { id: "c_average", score10: 6.8, tier: "strong", suppressed: false, reasons: [], pdc: 8, pub: true },
  { id: "e_weak", score10: 3.7, tier: "track", suppressed: true, reasons: ["below_threshold_after_full_data"], pdc: 4, pub: false },
];

// ── Champion core matches the golden snapshot ──────────────────────────────
{
  const rows = evaluateSlateChampion();
  ok(rows.map((r) => r.id).join(",") === GOLDEN.map((r) => r.id).join(","), `ranked identity order (got ${rows.map((r) => r.id).join(",")})`);
  for (let i = 0; i < GOLDEN.length; i++) {
    const r = rows[i], g = GOLDEN[i];
    ok(r.score10 === g.score10, `[${g.id}] score10 ${r.score10} === ${g.score10}`);
    ok(r.tier === g.tier, `[${g.id}] tier ${r.tier} === ${g.tier}`);
    ok(r.suppressed === g.suppressed, `[${g.id}] suppressed ${r.suppressed} === ${g.suppressed}`);
    ok(JSON.stringify(r.reasons) === JSON.stringify(g.reasons), `[${g.id}] suppressedReasons match`);
    ok(r.pdc === g.pdc, `[${g.id}] positiveDriverCount ${r.pdc} === ${g.pdc}`);
    ok(r.pub === g.pub, `[${g.id}] publicEligible ${r.pub} === ${g.pub}`);
  }
}

// ── Determinism: champion output is a pure function of frozen input ─────────
{
  ok(JSON.stringify(evaluateSlateChampion()) === JSON.stringify(evaluateSlateChampion()), "champion evaluation is deterministic across runs");
}

// ── ISO display tiers vary across the slate (all five reachable here) ───────
{
  const isoByHitter = SLATE.map((s) => {
    const bp = computeBatterPowerProfile({ ...(s.frozen.batter as any), trueIso: s.trueIso, trueIsoSampleAB: 500, trueIsoSplit: "vs_rhp", trueIsoSource: s.trueIso == null ? "league_fallback" : "current_split" } as any);
    const iso = bp.drivers.find((d) => d.key === "power_iso");
    return { id: s.id, tier: iso?.tier ?? "NO_EMIT", elig: iso?.displayEligible ?? null, label: iso?.label ?? null };
  });
  const byId = Object.fromEntries(isoByHitter.map((x) => [x.id, x]));
  ok(byId["a_elite"].tier === "ELITE" && byId["a_elite"].elig === true && byId["a_elite"].label === "Elite Isolated Power", "a_elite → ELITE ISO chip shown");
  ok(byId["b_strong"].tier === "STRONG" && byId["b_strong"].elig === true && byId["b_strong"].label === "Strong Isolated Power", "b_strong → STRONG ISO chip shown");
  ok(byId["c_average"].tier === "AVERAGE" && byId["c_average"].elig === false, "c_average → AVERAGE, no promotional chip");
  ok(byId["e_weak"].tier === "WEAK" && byId["e_weak"].elig === false, "e_weak → WEAK, no promotional chip");
  ok(byId["d_unavail"].tier === "UNAVAILABLE" && byId["d_unavail"].elig === false && byId["d_unavail"].label !== "Elite Isolated Power", "d_unavail (pct-scale) → UNAVAILABLE, never Elite");
  const distinct = new Set(isoByHitter.map((x) => x.tier));
  ok(distinct.size === 5, `all five ISO display tiers reachable in one slate (got ${distinct.size})`);
  const eliteCount = isoByHitter.filter((x) => x.label === "Elite Isolated Power" && x.elig).length;
  ok(eliteCount === 1, "only ONE hitter earns the Elite ISO chip across the slate");
}

console.log(`\nplateChampionSlateInvariance.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
