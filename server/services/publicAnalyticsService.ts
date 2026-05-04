import { db } from "../db";
import { persistedPlays, type PersistedPlay } from "@shared/schema";
import { sql, desc } from "drizzle-orm";
import { daysAgoET } from "../utils/dateUtils";
import {
  getROIMetrics,
  getPrimaryROIMetrics,
  filterPrimaryRoiPlays,
  getRoiByMarket,
  logRoiFilterApplied,
  EXCLUDED_FROM_PRIMARY_ROI,
  type MarketROIBreakdownRow,
} from "./roiEngine";

export type PublicAnalyticsSummary = {
  /**
   * [PRIMARY ROI EXCLUSION v1] Headline ROI / win rate / play count for the
   * last 7 days. Excludes home_runs + batter_strikeouts so the user-facing
   * "Core Engine ROI" reflects markets the engine is actually optimized for.
   * The full all-markets numbers stay available on `last7DaysFull` for admin
   * / internal observability.
   */
  last7Days: { winRate: number; roi: number; plays: number };
  last7DaysFull: { winRate: number; roi: number; plays: number };
  excludedFromPrimary: readonly string[];
  /**
   * Per-market breakdown for the same 7-day window with the
   * `excludedFromPrimary` flag stamped per row, so admin dashboards can
   * surface "where did the ROI come from / where did it leak".
   */
  byMarket: MarketROIBreakdownRow[];
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
  // ── Phase 8: rotation-profile-derived buckets (playoffs only) ─────────
  // Read from the `+rotsnap:` tag stamped into calibrationTrack at calc
  // time. Lets admin verify the role layer is actually predicting outcomes.
  playoffRoleCertaintyBuckets?: Array<{ bucket: string; plays: number; winRate: number }>;
  rotationRankBuckets?: Array<{ bucket: string; plays: number; winRate: number }>;
  closeGameTrustBuckets?: Array<{ bucket: string; plays: number; winRate: number }>;
  coachShortBenchBuckets?: Array<{ bucket: string; plays: number; winRate: number }>;
};

// Parse the +rotsnap: snapshot tag stamped by storage.calculateProbability.
// Returns null if the tag is absent or malformed.
function parseRotSnap(track: string | null | undefined): {
  rank: number | null;
  cert: number | null;       // 0-100
  ctrust: number | null;     // 0-100
  sbench: number | null;     // 0-100
  starride: number | null;   // 0-100
  src: string | null;
} | null {
  if (!track) return null;
  const m = track.match(/\+rotsnap:([^+]+)/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const part of m[1].split(",")) {
    const [k, v] = part.split("=");
    if (k && v != null) out[k] = v;
  }
  const num = (s: string | undefined) => (s == null || s === "na" || s === "") ? null : (Number.isFinite(Number(s)) ? Number(s) : null);
  return {
    rank: num(out.rank),
    cert: num(out.cert),
    ctrust: num(out.ctrust),
    sbench: num(out.sbench),
    starride: num(out.starride),
    src: out.src ?? null,
  };
}

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
  // Audit finding 1.4: use the canonical roiEngine helper so admin analytics ROI
  // matches the rest of the system (per-play odds, -110 fallback only when odds
  // missing, pending excluded). Previously hardcoded `wins * 0.909 - losses`
  // assumed every play was -110 and disagreed with roiEngine.calculatePayout.
  const roi = getROIMetrics(plays as PersistedPlay[]).roi;

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
  let playoffRoleCertaintyBuckets: Array<{ bucket: string; plays: number; winRate: number }> | undefined;
  let rotationRankBuckets: Array<{ bucket: string; plays: number; winRate: number }> | undefined;
  let closeGameTrustBuckets: Array<{ bucket: string; plays: number; winRate: number }> | undefined;
  let coachShortBenchBuckets: Array<{ bucket: string; plays: number; winRate: number }> | undefined;
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

    // ── Phase 8: rotation profile snapshot buckets ─────────────────────────
    type Tally = { label: string; wins: number; losses: number; total: number };
    const mk = (label: string): Tally => ({ label, wins: 0, losses: 0, total: 0 });
    const cert: Tally[] = [mk("cert_high_75-100"), mk("cert_mid_50-74"), mk("cert_low_<50"), mk("cert_unknown")];
    const rank: Tally[] = [mk("rank_top3"), mk("rank_4-5"), mk("rank_6-7"), mk("rank_8+"), mk("rank_unknown")];
    const ctrust: Tally[] = [mk("ctrust_high_70+"), mk("ctrust_mid_40-69"), mk("ctrust_low_<40"), mk("ctrust_unknown")];
    const sbench: Tally[] = [mk("shortbench_high_65+"), mk("shortbench_mid_40-64"), mk("shortbench_low_<40"), mk("shortbench_unknown")];

    const record = (t: Tally, p: any) => {
      t.total++;
      if (p.result === "hit") t.wins++;
      if (p.result === "miss") t.losses++;
    };
    for (const p of plays) {
      const snap = parseRotSnap(p.calibrationTrack);
      // certainty
      if (snap?.cert == null) record(cert[3], p);
      else if (snap.cert >= 75) record(cert[0], p);
      else if (snap.cert >= 50) record(cert[1], p);
      else record(cert[2], p);
      // rotation rank
      if (snap?.rank == null) record(rank[4], p);
      else if (snap.rank <= 3) record(rank[0], p);
      else if (snap.rank <= 5) record(rank[1], p);
      else if (snap.rank <= 7) record(rank[2], p);
      else record(rank[3], p);
      // close-game trust
      if (snap?.ctrust == null) record(ctrust[3], p);
      else if (snap.ctrust >= 70) record(ctrust[0], p);
      else if (snap.ctrust >= 40) record(ctrust[1], p);
      else record(ctrust[2], p);
      // coach short-bench
      if (snap?.sbench == null) record(sbench[3], p);
      else if (snap.sbench >= 65) record(sbench[0], p);
      else if (snap.sbench >= 40) record(sbench[1], p);
      else record(sbench[2], p);
    }
    playoffRoleCertaintyBuckets = cert.map(toBucket);
    rotationRankBuckets = rank.map(toBucket);
    closeGameTrustBuckets = ctrust.map(toBucket);
    coachShortBenchBuckets = sbench.map(toBucket);
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
    playoffRoleCertaintyBuckets,
    rotationRankBuckets,
    closeGameTrustBuckets,
    coachShortBenchBuckets,
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

  // [PRIMARY ROI EXCLUSION v1] Compute both the headline (primary) and the
  // full all-markets numbers. Headline excludes home_runs + batter_strikeouts;
  // full keeps everything for internal observability.
  const primaryPlays = filterPrimaryRoiPlays(settled as PersistedPlay[]);
  logRoiFilterApplied({
    surface: "publicAnalyticsService.last7Days",
    totalPlays: settled.length,
    primaryPlays: primaryPlays.length,
  });

  // Helper — winRate uses (hits / (hits + misses)), pushes excluded from the
  // denominator. This preserves the prior numeric semantics of the public
  // surface; only the input set changes between primary and full.
  const computeWinRate = (rows: PersistedPlay[]): number => {
    const w = rows.filter(p => p.result === "hit").length;
    const l = rows.filter(p => p.result === "miss").length;
    const d = w + l;
    return d > 0 ? Math.round((w / d) * 1000) / 10 : 0;
  };

  const winRate = computeWinRate(primaryPlays);
  const winRateFull = computeWinRate(settled as PersistedPlay[]);
  // Canonical roiEngine helpers — per-play odds, -110 fallback only when odds
  // missing, pending excluded.
  const roi = getPrimaryROIMetrics(settled as PersistedPlay[]).roi;
  const roiFull = getROIMetrics(settled as PersistedPlay[]).roi;

  const byMarket = getRoiByMarket(settled as PersistedPlay[]);

  // Group plays by sport keeping full-row references so the canonical ROI helper
  // can read per-play `odds` instead of assuming a flat -110 vig. For each
  // sport we report the PRIMARY (headline) numbers; HR + K are MLB-only
  // markets so NBA/NCAAB rows are unaffected, but MLB rows now reflect the
  // exclusion. `plays` keeps the full count so users see total volume.
  const sportMap = new Map<string, PersistedPlay[]>();
  for (const p of settled) {
    const sport = (p.sport ?? "nba").toUpperCase();
    if (!sportMap.has(sport)) sportMap.set(sport, []);
    sportMap.get(sport)!.push(p as PersistedPlay);
  }

  const bySport = Array.from(sportMap.entries()).map(([sport, sportPlays]) => {
    const sportPrimary = filterPrimaryRoiPlays(sportPlays);
    return {
      sport,
      winRate: computeWinRate(sportPrimary),
      roi: getPrimaryROIMetrics(sportPlays).roi,
      plays: sportPlays.length,
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

  return {
    last7Days: { winRate, roi, plays: primaryPlays.length },
    last7DaysFull: { winRate: winRateFull, roi: roiFull, plays: totalPlays },
    excludedFromPrimary: EXCLUDED_FROM_PRIMARY_ROI,
    byMarket,
    bySport,
    nbaSeasonSegmentation,
    recentResults,
  };
}
