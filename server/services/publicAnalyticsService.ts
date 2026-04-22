import { db } from "../db";
import { persistedPlays } from "@shared/schema";
import { sql, desc } from "drizzle-orm";
import { daysAgoET } from "../utils/dateUtils";

export type PublicAnalyticsSummary = {
  last7Days: { winRate: number; roi: number; plays: number };
  bySport: Array<{ sport: string; winRate: number; roi: number; plays: number }>;
  // ── Playoff segmentation (PHASE 7) ──────────────────────────────────────
  // NBA-only breakdown of regular season vs. playoff performance, plus
  // probability-bucket win rates restricted to playoffs. Used by admin
  // analytics to verify the playoff calibration fix is actually moving
  // the needle (not just compiling).
  nbaSeasonSegmentation: {
    regularSeason: NbaSegment;
    playoffs: NbaSegment;
  };
  recentResults: Array<{
    id: string;
    sport: string;
    player: string;
    market: string;
    side: string;
    line: string;
    probability: number;
    result: string;
    finalStat: number | null;
    settledAt: string;
  }>;
};

export type NbaSegment = {
  sport: "NBA";
  isPlayoffs: boolean;
  totalPlays: number;
  winRate: number;
  roi: number;
  avgProbability: number;
  avgEdge: number;
  topBucketWinRate: number; // 80-100 prob bucket win rate
  buckets: Array<{ bucket: string; plays: number; winRate: number }>;
  // ── Phase 8: Playoff role-truth breakdowns (only populated when isPlayoffs) ─
  // Derived from calibrationTrack markers stamped by the role gate / fragility
  // pipeline. Lets admin verify the new layer is actually moving the high-bucket
  // accuracy in the right direction.
  roleGateBuckets?: Array<{ bucket: string; plays: number; winRate: number }>;
  comboVsSingle?: Array<{ bucket: string; plays: number; winRate: number }>;
};

// NBA playoff cutover (mirrors storage.getNbaSeasonContext): regular season
// ends ~Apr 10 of the season-end calendar year. Same logic as the engine,
// duplicated minimally here because analytics doesn't import storage.ts.
function isNbaPlayoffDate(gameDate: string): boolean {
  if (!gameDate) return false;
  const d = new Date(gameDate);
  if (isNaN(d.getTime())) return false;
  const m = d.getUTCMonth() + 1;
  const seasonStartYear = m >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const playoffsStart = new Date(Date.UTC(seasonStartYear + 1, 3, 10));
  return d >= playoffsStart;
}

function bucketForProbability(p: number): string {
  if (p >= 80) return "80-100";
  if (p >= 70) return "70-79";
  if (p >= 60) return "60-69";
  if (p >= 50) return "50-59";
  return "<50";
}

function buildNbaSegment(plays: any[], isPlayoffs: boolean): NbaSegment {
  const wins = plays.filter(p => p.result === "hit").length;
  const losses = plays.filter(p => p.result === "miss").length;
  const decided = wins + losses;
  const total = plays.length;
  const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0;
  const roi = decided > 0 ? Math.round(((wins * 0.909 - losses) / decided) * 1000) / 10 : 0;

  let probSum = 0, probCount = 0;
  let edgeSum = 0, edgeCount = 0;
  for (const p of plays) {
    const prob = p.prob != null ? parseFloat(String(p.prob)) : null;
    if (prob != null && Number.isFinite(prob)) { probSum += prob; probCount++; }
    const edge = p.edgeGap != null ? parseFloat(String(p.edgeGap)) : null;
    if (edge != null && Number.isFinite(edge)) { edgeSum += edge; edgeCount++; }
  }

  const bucketMap = new Map<string, { wins: number; losses: number; total: number }>();
  for (const p of plays) {
    const prob = p.prob != null ? parseFloat(String(p.prob)) : null;
    if (prob == null || !Number.isFinite(prob)) continue;
    const b = bucketForProbability(prob);
    if (!bucketMap.has(b)) bucketMap.set(b, { wins: 0, losses: 0, total: 0 });
    const e = bucketMap.get(b)!;
    e.total++;
    if (p.result === "hit") e.wins++;
    if (p.result === "miss") e.losses++;
  }

  const buckets = Array.from(bucketMap.entries()).map(([bucket, data]) => {
    const d = data.wins + data.losses;
    return { bucket, plays: data.total, winRate: d > 0 ? Math.round((data.wins / d) * 1000) / 10 : 0 };
  });
  const top = bucketMap.get("80-100");
  const topDecided = top ? top.wins + top.losses : 0;
  const topBucketWinRate = top && topDecided > 0 ? Math.round((top.wins / topDecided) * 1000) / 10 : 0;

  // ── Phase 8: Playoff role-truth breakdowns ──────────────────────────────
  // Bucket plays by whether the role gate clamped them (no_rotation_data,
  // rotation_rs_fallback, role_gate_70/80) vs. plays that passed the gate.
  // Win rate gap between these tiers tells us the role layer is real signal.
  let roleGateBuckets: Array<{ bucket: string; plays: number; winRate: number }> | undefined;
  let comboVsSingle: Array<{ bucket: string; plays: number; winRate: number }> | undefined;
  if (isPlayoffs) {
    const tally = (label: string) => ({ label, wins: 0, losses: 0, total: 0 });
    const gateClean = tally("role_passed");
    const gate70 = tally("gated_to_68");
    const gate80 = tally("gated_to_70_74");
    const noRot = tally("no_rotation_data");
    const rsFallback = tally("rotation_rs_fallback");
    const playoffFallback = tally("playoff_data_rs_fallback");

    const combo = tally("combo");
    const single = tally("single");

    for (const p of plays) {
      const ct: string = p.calibrationTrack ?? "";
      let bucketRef = gateClean;
      if (ct.includes("playoff_role_gate_80") || ct.includes(":cap80")) bucketRef = gate80;
      else if (ct.includes("playoff_role_gate_70")) bucketRef = gate70;
      else if (ct.includes("rotation_rs_fallback")) bucketRef = rsFallback;
      else if (ct.includes("no_rotation_data")) bucketRef = noRot;
      else if (ct.includes("playoff_data_rs_fallback") || ct.includes("playoff_fallback_cap")) bucketRef = playoffFallback;
      bucketRef.total++;
      if (p.result === "hit") bucketRef.wins++;
      if (p.result === "miss") bucketRef.losses++;

      const isCombo = (p.market ?? "").toLowerCase().includes("+") || (p.market ?? "").toLowerCase().includes("pra");
      const cs = isCombo ? combo : single;
      cs.total++;
      if (p.result === "hit") cs.wins++;
      if (p.result === "miss") cs.losses++;
    }

    const toBucket = (t: { label: string; wins: number; losses: number; total: number }) => {
      const d = t.wins + t.losses;
      return { bucket: t.label, plays: t.total, winRate: d > 0 ? Math.round((t.wins / d) * 1000) / 10 : 0 };
    };
    roleGateBuckets = [gateClean, gate70, gate80, noRot, rsFallback, playoffFallback].map(toBucket);
    comboVsSingle = [combo, single].map(toBucket);
  }

  return {
    sport: "NBA",
    isPlayoffs,
    totalPlays: total,
    winRate,
    roi,
    avgProbability: probCount > 0 ? Math.round((probSum / probCount) * 10) / 10 : 0,
    avgEdge: edgeCount > 0 ? Math.round((edgeSum / edgeCount) * 100) / 100 : 0,
    topBucketWinRate,
    buckets,
    roleGateBuckets,
    comboVsSingle,
  };
}

export async function getPublicAnalyticsSummary(): Promise<PublicAnalyticsSummary> {
  const sevenDaysStr = daysAgoET(7);

  const settled = await db
    .select()
    .from(persistedPlays)
    .where(sql`${persistedPlays.result} IS NOT NULL AND ${persistedPlays.gameDate} >= ${sevenDaysStr}`)
    .orderBy(desc(persistedPlays.settledAt))
    .limit(2000);

  const totalPlays = settled.length;
  const wins = settled.filter(p => p.result === "hit").length;
  const losses = settled.filter(p => p.result === "miss").length;
  const decidedPlays = wins + losses;
  const winRate = decidedPlays > 0 ? Math.round((wins / decidedPlays) * 1000) / 10 : 0;
  const roi = decidedPlays > 0 ? Math.round(((wins * 0.909 - losses) / decidedPlays) * 1000) / 10 : 0;

  const sportMap = new Map<string, { wins: number; losses: number; total: number }>();
  for (const p of settled) {
    const sport = (p.sport ?? "nba").toUpperCase();
    if (!sportMap.has(sport)) sportMap.set(sport, { wins: 0, losses: 0, total: 0 });
    const entry = sportMap.get(sport)!;
    entry.total++;
    if (p.result === "hit") entry.wins++;
    if (p.result === "miss") entry.losses++;
  }

  const bySport = Array.from(sportMap.entries()).map(([sport, data]) => {
    const decided = data.wins + data.losses;
    return {
      sport,
      winRate: decided > 0 ? Math.round((data.wins / decided) * 1000) / 10 : 0,
      roi: decided > 0 ? Math.round(((data.wins * 0.909 - data.losses) / decided) * 1000) / 10 : 0,
      plays: data.total,
    };
  });

  // ── PHASE 7: NBA regular vs. playoffs segmentation ──────────────────────
  const nbaPlays = settled.filter(p => (p.sport ?? "nba").toLowerCase() === "nba");
  const nbaPlayoffs = nbaPlays.filter(p => isNbaPlayoffDate(p.gameDate));
  const nbaRegular = nbaPlays.filter(p => !isNbaPlayoffDate(p.gameDate));
  const nbaSeasonSegmentation = {
    regularSeason: buildNbaSegment(nbaRegular, false),
    playoffs: buildNbaSegment(nbaPlayoffs, true),
  };

  const recentResults = settled.slice(0, 5).map(p => ({
    id: p.id,
    sport: (p.sport ?? "nba").toUpperCase(),
    player: p.playerName,
    market: p.market,
    side: p.direction,
    line: String(p.line),
    probability: p.prob ? parseFloat(String(p.prob)) : 0,
    result: p.result ?? "pending",
    finalStat: p.finalStat ? parseFloat(String(p.finalStat)) : null,
    settledAt: p.settledAt ? p.settledAt.toISOString() : "",
  }));

  return { last7Days: { winRate, roi, plays: totalPlays }, bySport, nbaSeasonSegmentation, recentResults };
}
