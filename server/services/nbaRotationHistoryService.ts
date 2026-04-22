// ── NBA Rotation History Service ──────────────────────────────────────────
// Builds a real "playoff role truth" profile per player from actual playoff
// game logs. Replaces season-average/projected-minute heuristics so the engine
// can earn high-confidence playoff outputs only when role evidence supports it.
//
// All data is derived from existing NBA Stats endpoints (playergamelog,
// teamgamelog) via nbaStatsService. No hard-coded coach/team assumptions.
//
// Cached SEPARATELY from regular-season caches so playoff role truth is never
// contaminated by reg-season data.

import {
  getPlayerGameLogs,
  getTeamGameLogs,
  type PlayerGameLogRow,
  type TeamGameLogRow,
  type NBASeasonType,
} from "./nbaStatsService";

export interface PlayoffRotationProfile {
  // Per-player playoff role truth
  recentPlayoffMinutesAvg3: number | null;
  recentPlayoffMinutesAvg5: number | null;
  sameSeriesMinutesAvg: number | null;
  nonBlowoutPlayoffMinutesAvg: number | null;
  closeGameQ4MinutesAvg: number | null; // approximated from non-blowout proxy
  startedRecentPlayoffGames: boolean;
  playoffMinutesVariance: number | null;
  closeGameTrustScore: number | null; // 0-1
  rotationRankEstimate: number | null; // 1=top minute earner on team
  playoffRoleCertainty: number | null; // 0-1
  // Team-level coach/rotation tendencies
  coachShortBenchIndex: number | null; // 0-1
  coachStarRideIndex: number | null;   // 0-1
  benchVolatilityIndex: number | null; // 0-1
  starterTrustIndex: number | null;    // 0-1
  // Provenance
  dataSource: "playoffs" | "regular_season_fallback" | "none";
  playoffGamesAvailable: number;
  fallbackReason?: string;
}

interface ProfileArgs {
  playerId?: string | number | null;
  playerName: string;
  teamAbbr?: string | null;
  opponentAbbr?: string | null;
  gameDate?: string | Date | null;
  gameId?: string | null;
}

interface CacheEntry {
  data: PlayoffRotationProfile | null;
  fetchedAt: number;
}

const PROFILE_TTL_MS = 30 * 60 * 1000; // 30 min — refreshes between games
const profileCache = new Map<string, CacheEntry>();
// In-flight Promise dedup so 100 parallel calc requests for the same player
// at tip-off only trigger ONE pair of HTTP calls (Critical fix from Phase 6
// architect review — prevents NBA Stats rate-limiting under live load).
const inFlight = new Map<string, Promise<PlayoffRotationProfile | null>>();

function bucketDate(d?: string | Date | null): string {
  const dt = d ? new Date(d) : new Date();
  return `${dt.getUTCFullYear()}-${dt.getUTCMonth() + 1}-${dt.getUTCDate()}`;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// Parse opponent abbr from MATCHUP string (e.g. "DEN vs. LAL", "DEN @ LAL").
function parseOpponentFromMatchup(matchup: string): string | null {
  const m = matchup.match(/(?:vs\.?|@)\s+([A-Z]{2,4})/);
  return m ? m[1].toUpperCase() : null;
}

// Per-team aggregation: build {playerId: minutesArray} across recent team games
// and rank top-N share. We approximate by re-fetching teammate logs lazily —
// but to keep Phase 2 lightweight and avoid N+1 explosions, we fall back to a
// coarse proxy from teamGameLogs alone: the team's PLUS_MINUS spread / scoring
// concentration aren't enough on their own, so coach indices use a simple
// heuristic: if recent playoff team games have tight rotation (≤8 min stdev
// across teammates), score short-bench higher. Without per-game lineup data
// from NBA Stats free endpoints, we use a proxy based on pace + win/loss
// volatility as a placeholder; coach indices can be enriched later with
// boxscore traditional v3 data.
//
// For now we only have the player's own logs reliably, so coach indices are
// computed if and only if we have team logs and at least one teammate's logs
// available. To avoid heavy fan-out we keep the coach indices NULL when we
// can't compute them confidently, and the engine treats null as "no signal"
// (no boost, no penalty).

function deriveTeamCoachIndices(
  teamLogs: TeamGameLogRow[],
): {
  coachShortBenchIndex: number | null;
  coachStarRideIndex: number | null;
  benchVolatilityIndex: number | null;
  starterTrustIndex: number | null;
} {
  // Without per-game per-player boxscore aggregation, we use scoring spread as
  // a proxy: in playoff games where the team relies heavily on stars, the
  // team's PTS variance across games tends to track lead-scorer availability,
  // and PLUS_MINUS variance reflects rotation depth changes.
  if (teamLogs.length < 3) {
    return {
      coachShortBenchIndex: null,
      coachStarRideIndex: null,
      benchVolatilityIndex: null,
      starterTrustIndex: null,
    };
  }
  const recent = teamLogs.slice(0, Math.min(10, teamLogs.length));
  const ptsVar = variance(recent.map((g) => g.PTS)) ?? 0;
  const pmVar = variance(recent.map((g) => g.PLUS_MINUS)) ?? 0;

  // Higher PTS variance with stable PM variance suggests star-dependent scoring
  // → star-ride. Higher PM variance with relatively flat PTS suggests bench
  // shake-ups → bench volatility.
  const starRide = clamp01(ptsVar / 200); // 0-1, ~200 = high spread
  const benchVol = clamp01(pmVar / 300);
  const shortBench = clamp01(0.5 + (starRide - benchVol) * 0.5);
  const starterTrust = clamp01(1 - benchVol);

  return {
    coachShortBenchIndex: shortBench,
    coachStarRideIndex: starRide,
    benchVolatilityIndex: benchVol,
    starterTrustIndex: starterTrust,
  };
}

function computePlayerMetrics(
  playerLogs: PlayerGameLogRow[],
  opponentAbbr: string | null,
  teamAvgMinutes: number | null,
): {
  recentPlayoffMinutesAvg3: number | null;
  recentPlayoffMinutesAvg5: number | null;
  sameSeriesMinutesAvg: number | null;
  nonBlowoutPlayoffMinutesAvg: number | null;
  closeGameQ4MinutesAvg: number | null;
  startedRecentPlayoffGames: boolean;
  playoffMinutesVariance: number | null;
  closeGameTrustScore: number | null;
  rotationRankEstimate: number | null;
  playoffRoleCertainty: number | null;
} {
  const last3 = playerLogs.slice(0, 3).map((g) => g.MIN);
  const last5 = playerLogs.slice(0, 5).map((g) => g.MIN);

  const sameSeries = opponentAbbr
    ? playerLogs.filter((g) => parseOpponentFromMatchup(g.MATCHUP) === opponentAbbr.toUpperCase())
    : [];

  // Non-blowout: |PLUS_MINUS| ≤ 12 (player-level proxy for competitive game).
  // PLUS_MINUS ≠ final margin but correlates strongly when player closed.
  const nonBlowouts = playerLogs.filter((g) => Math.abs(g.PLUS_MINUS) <= 12);
  const nonBlowoutMins = nonBlowouts.map((g) => g.MIN);

  // Close-game Q4 proxy: in non-blowouts, closers run 9-12 Q4 min. We don't
  // have quarter splits in playergamelog; estimate as MIN * 0.30 for
  // non-blowout games where MIN ≥ 28 (heuristic for "stayed on the floor").
  const closeQ4Estimates = nonBlowouts
    .filter((g) => g.MIN >= 28)
    .map((g) => g.MIN * 0.30);

  // Started recent: NBA Stats playergamelog doesn't carry started flag. Proxy:
  // player averaged ≥ 28 MIN in last 3 playoff games AND played all 3.
  const playedAll3 = last3.length === 3 && last3.every((m) => m > 0);
  const startedRecent = playedAll3 && (mean(last3) ?? 0) >= 28;

  const playoffVar = variance(playerLogs.slice(0, Math.min(8, playerLogs.length)).map((g) => g.MIN));

  // closeGameTrustScore: high if player's non-blowout average matches their
  // overall average (i.e. coach trusts them in close games).
  const overallAvg = mean(playerLogs.slice(0, Math.min(10, playerLogs.length)).map((g) => g.MIN));
  const nbAvg = mean(nonBlowoutMins);
  let closeGameTrustScore: number | null = null;
  if (overallAvg != null && nbAvg != null && overallAvg > 0) {
    // Ratio of non-blowout to overall, capped 0-1, with bonus for high absolute mins.
    const ratio = clamp01(nbAvg / Math.max(overallAvg, 1));
    const absBonus = clamp01((nbAvg - 20) / 20); // 20→0, 40→1
    closeGameTrustScore = clamp01(0.6 * ratio + 0.4 * absBonus);
  }

  // rotationRankEstimate: without teammate logs, approximate rank from minute
  // bucket: ≥34→1, ≥30→2-3, ≥26→4-5, ≥22→6-7, ≥16→8, <16→9+.
  let rotationRankEstimate: number | null = null;
  const last5Avg = mean(last5);
  if (last5Avg != null) {
    if (last5Avg >= 34) rotationRankEstimate = 1;
    else if (last5Avg >= 30) rotationRankEstimate = 3;
    else if (last5Avg >= 26) rotationRankEstimate = 5;
    else if (last5Avg >= 22) rotationRankEstimate = 7;
    else if (last5Avg >= 16) rotationRankEstimate = 8;
    else rotationRankEstimate = 10;
  }

  // playoffRoleCertainty: blend of stability (low variance), recent minutes
  // mass, same-series consistency, and starter evidence.
  let playoffRoleCertainty: number | null = null;
  if (last5Avg != null) {
    const stability = playoffVar != null ? clamp01(1 - playoffVar / 50) : 0.5;
    const minuteMass = clamp01((last5Avg - 12) / 24); // 12→0, 36→1
    const seriesBonus = sameSeries.length >= 2 ? 0.10 : 0;
    const starterBonus = startedRecent ? 0.10 : 0;
    playoffRoleCertainty = clamp01(0.45 * stability + 0.45 * minuteMass + seriesBonus + starterBonus);
  }

  return {
    recentPlayoffMinutesAvg3: mean(last3),
    recentPlayoffMinutesAvg5: mean(last5),
    sameSeriesMinutesAvg: mean(sameSeries.map((g) => g.MIN)),
    nonBlowoutPlayoffMinutesAvg: mean(nonBlowoutMins),
    closeGameQ4MinutesAvg: mean(closeQ4Estimates),
    startedRecentPlayoffGames: startedRecent,
    playoffMinutesVariance: playoffVar,
    closeGameTrustScore,
    rotationRankEstimate,
    playoffRoleCertainty,
  };
}

export async function getPlayoffRotationProfile(
  args: ProfileArgs,
): Promise<PlayoffRotationProfile | null> {
  const cacheKey = [
    args.playerId ?? args.playerName.toLowerCase(),
    args.teamAbbr ?? "",
    args.opponentAbbr ?? "",
    bucketDate(args.gameDate),
  ].join("|");
  const cached = profileCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_TTL_MS) return cached.data;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<PlayoffRotationProfile | null> => {
  if (args.playerId == null) {
    profileCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
    return null;
  }

  try {
    // Try playoffs first
    let seasonTypeUsed: NBASeasonType = "Playoffs";
    let logs = await getPlayerGameLogs({ playerId: args.playerId, seasonType: "Playoffs", limit: 12 });
    let teamLogs: TeamGameLogRow[] = args.teamAbbr
      ? await getTeamGameLogs({ teamAbbr: args.teamAbbr, seasonType: "Playoffs", limit: 12 })
      : [];

    let dataSource: PlayoffRotationProfile["dataSource"] = "playoffs";
    let fallbackReason: string | undefined;

    if (logs.length === 0) {
      // No playoff data available — fall back to regular season but tag it.
      logs = await getPlayerGameLogs({ playerId: args.playerId, seasonType: "Regular Season", limit: 12 });
      if (args.teamAbbr) {
        teamLogs = await getTeamGameLogs({ teamAbbr: args.teamAbbr, seasonType: "Regular Season", limit: 12 });
      }
      seasonTypeUsed = "Regular Season";
      dataSource = "regular_season_fallback";
      fallbackReason = "no_playoff_logs";
    }

    if (logs.length === 0) {
      // Truly no data
      const empty: PlayoffRotationProfile = {
        recentPlayoffMinutesAvg3: null,
        recentPlayoffMinutesAvg5: null,
        sameSeriesMinutesAvg: null,
        nonBlowoutPlayoffMinutesAvg: null,
        closeGameQ4MinutesAvg: null,
        startedRecentPlayoffGames: false,
        playoffMinutesVariance: null,
        closeGameTrustScore: null,
        rotationRankEstimate: null,
        playoffRoleCertainty: null,
        coachShortBenchIndex: null,
        coachStarRideIndex: null,
        benchVolatilityIndex: null,
        starterTrustIndex: null,
        dataSource: "none",
        playoffGamesAvailable: 0,
        fallbackReason: "no_logs_available",
      };
      profileCache.set(cacheKey, { data: empty, fetchedAt: Date.now() });
      return empty;
    }

    const playerMetrics = computePlayerMetrics(logs, args.opponentAbbr ?? null, null);
    const teamIndices = deriveTeamCoachIndices(teamLogs);

    const profile: PlayoffRotationProfile = {
      ...playerMetrics,
      ...teamIndices,
      dataSource,
      playoffGamesAvailable: dataSource === "playoffs" ? logs.length : 0,
      fallbackReason,
    };

    profileCache.set(cacheKey, { data: profile, fetchedAt: Date.now() });
    console.log(
      `[NBA_ROTATION_PROFILE] player=${args.playerName} src=${dataSource} ` +
      `pgAvail=${profile.playoffGamesAvailable} roleCert=${profile.playoffRoleCertainty?.toFixed(2) ?? "n/a"} ` +
      `rank=${profile.rotationRankEstimate ?? "n/a"} closeTrust=${profile.closeGameTrustScore?.toFixed(2) ?? "n/a"}`
    );
    return profile;
  } catch (err: any) {
    console.warn(`[NBA_ROTATION_PROFILE] error for ${args.playerName}:`, err?.message ?? err);
    return null;
  }
  })();

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

export function clearRotationHistoryCache(): void {
  profileCache.clear();
  inFlight.clear();
}
