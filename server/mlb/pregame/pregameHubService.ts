// MLB Pre-Game Hub — thin composition layer over The Plate + The Mound.
//
// Owns NO scoring logic of its own. Delegates to the existing, untouched
// Plate engine (server/mlb/pregamePowerRadar/**) for view="plate" and to the
// new Mound engine (server/mlb/pregame/mound/**) for view="mound", then
// reshapes each into the shared MlbPregameHubResponse envelope
// (shared/mlbPregameHub.ts). Neither engine's own internal types change to
// accommodate this file.

import { slateDateET } from "../../utils/dateUtils";
import { getRadarSnapshot } from "../pregamePowerRadar/pregamePowerRadarService";
import { buildResponse as buildPlateResponse } from "../pregamePowerRadar/diagnostics";
import { getPregameRadarPublicStats } from "../pregamePowerRadar/statsService";
import type { PregamePowerSignal } from "../pregamePowerRadar/types";

import { getMoundRadarSnapshot } from "./mound/mlbMoundRadarService";
import { buildMoundResponse } from "./mound/diagnostics";
import { getMoundRadarPublicStats } from "./mound/moundStatsService";
import type { MoundSignal } from "./mound/types";

import type {
  MlbPregameHubResponse,
  PregameRadarFilter,
  PregameRadarRecord,
  PregameRadarTarget,
  PregameRadarView,
  PregameRadarViewKey,
} from "../../../shared/mlbPregameHub";
import { validateTargets } from "./pregameHubContractValidation";

const PLATE_FILTERS: PregameRadarFilter[] = [
  { key: "all", label: "All" },
  { key: "hr", label: "HR" },
  { key: "hits", label: "Hits" },
  { key: "tb", label: "Total Bases" },
  { key: "elite", label: "Elite+" },
  { key: "confirmed", label: "Confirmed Lineups" },
  { key: "park", label: "Park Boost" },
  { key: "pitcher", label: "Pitcher Vulnerability" },
];

const MOUND_FILTERS: PregameRadarFilter[] = [
  { key: "all", label: "All" },
  { key: "strikeouts", label: "Strikeouts" },
  { key: "outs", label: "Outs" },
  { key: "elite", label: "Elite+" },
  { key: "confirmed_starters", label: "Confirmed Starters" },
  { key: "high_k", label: "High K%" },
  { key: "long_leash", label: "Long Leash" },
  { key: "weak_lineup", label: "Weak Lineup" },
  { key: "run_suppression", label: "Run Suppression" },
  { key: "risk", label: "Risk Warnings" },
];

function tierSetupLabel(tier: string): string {
  if (tier === "nuclear") return "Nuclear Setup";
  if (tier === "elite") return "Elite Setup";
  if (tier === "strong") return "Strong Setup";
  if (tier === "power_watch") return "Batter Power Only";
  if (tier === "watch") return "Watch";
  return "Track";
}

function toPublicTier(tier: string): "watch" | "strong" | "elite" {
  if (tier === "nuclear" || tier === "elite") return "elite";
  if (tier === "strong") return "strong";
  return "watch";
}

/**
 * Plate's PregamePowerMarket type is wider than the hub's PregameRadarMarketKey
 * (it declares "rbi"/"hrr" as future Phase-5 values that marketTagger.ts never
 * actually emits today). Map defensively rather than assuming the wider type
 * narrows for free — unmapped values fall back to "hits" (a valid hub key)
 * rather than producing an invalid market key.
 */
function toPlateMarketKey(m: string): "home_runs" | "hits" | "total_bases" {
  if (m === "home_runs") return "home_runs";
  if (m === "total_bases") return "total_bases";
  if (m !== "hits") {
    // Unreachable today (marketTagger.ts only emits home_runs/total_bases),
    // but if Plate ever ships its Phase-5 rbi/hrr markets without a matching
    // update here, this makes the mislabel observable instead of silent.
    console.warn(`[MLB_PREGAME_CONTRACT_VALIDATION] unexpected Plate market "${m}" — falling back to "hits" in the hub response`);
  }
  return "hits";
}

function plateMarketLabel(key: "home_runs" | "hits" | "total_bases"): string {
  if (key === "home_runs") return "HR";
  if (key === "total_bases") return "Total Bases";
  return "Hits";
}

function plateTargetFromSignal(signal: PregamePowerSignal, rank: number): PregameRadarTarget {
  const positives = signal.drivers.filter((d) => d.direction === "positive").map((d) => d.label);
  const negatives = signal.drivers.filter((d) => d.direction === "negative").map((d) => d.label);
  const badges: string[] = [];
  if (signal.outcomes?.hitHr) badges.push("HOMERED");
  if (signal.status === "locked") badges.push("Locked at first pitch");
  if (signal.becameLiveFire) badges.push("Now Live FIRE");
  else if (signal.becameLiveReady) badges.push("Now Live-Ready");

  const outcomeType =
    signal.outcomes?.outcome === "pregame_win"
      ? "plate_hit"
      : signal.outcomes?.outcome === "calibration_miss"
        ? "plate_miss_calibration"
        : null;

  return {
    id: signal.signalId,
    view: "plate",
    actorType: "batter",
    playerId: signal.batterId,
    playerName: signal.batterName,
    team: signal.team,
    opponent: signal.opponent,
    matchupLabel: `${signal.team} vs ${signal.opponent}`,
    handednessLabel: signal.handednessMatchup,
    rank,
    score10: signal.score10,
    tier: toPublicTier(signal.tier),
    setupLabel: tierSetupLabel(signal.tier),
    primaryMarket: {
      key: toPlateMarketKey(signal.primaryMarket),
      label: plateMarketLabel(toPlateMarketKey(signal.primaryMarket)),
      side: "OVER",
      line: null,
      projection: null,
      probability: null,
      tier: toPublicTier(signal.tier),
    },
    markets: signal.marketSetups.map((m) => {
      const key = toPlateMarketKey(m.market);
      return {
        key,
        label: plateMarketLabel(key),
        side: "OVER" as const,
        line: null,
        projection: null,
        probability: null,
        tier: toPublicTier(signal.tier),
      };
    }),
    badges,
    drivers: positives,
    warnings: negatives,
    context: {
      venue: signal.parkContext?.venueName ?? null,
      temperature: signal.parkContext?.temperatureF ?? null,
      windLabel: signal.parkContext?.windDirectionLabel ?? null,
      parkLabel: signal.parkContext?.carryLabel ?? null,
      weatherLabel: signal.parkContext?.driverText ?? null,
    },
    tracking: {
      flaggedBeforeFirstPitch: signal.everPubliclyFlagged,
      outcomeStatus: signal.outcomes?.hitHr === true ? "hit" : signal.outcomes ? "calibration" : "pending",
      outcomeType,
      firstAbCashEligible: true,
    },
  };
}

function moundTargetFromSignal(signal: MoundSignal, rank: number): PregameRadarTarget {
  const positives = signal.drivers.filter((d) => d.direction === "positive").map((d) => d.label);
  const negatives = signal.drivers.filter((d) => d.direction === "negative").map((d) => d.label);
  const badges: string[] = [];
  if (signal.outcomes?.outcome === "mound_win") badges.push("CASHED");
  if (signal.status === "locked") badges.push("Locked at first pitch");

  const outcomeType =
    signal.outcomes?.outcome === "mound_win"
      ? "mound_hit"
      : signal.outcomes?.outcome === "mound_calibration_miss"
        ? "mound_miss_calibration"
        : null;

  return {
    id: signal.signalId,
    view: "mound",
    actorType: "pitcher",
    playerId: signal.pitcherId,
    playerName: signal.pitcherName,
    team: signal.team,
    opponent: signal.opponent,
    matchupLabel: `${signal.team} vs ${signal.opponent}`,
    handednessLabel: signal.throws ? `${signal.throws}HP` : null,
    rank,
    score10: signal.score10,
    tier: toPublicTier(signal.tier),
    setupLabel: tierSetupLabel(signal.tier),
    primaryMarket: {
      key: signal.primaryMarket,
      label: signal.primaryMarket === "pitcher_strikeouts" ? "Pitcher Ks" : "Pitcher Outs",
      side: "OVER",
      line: null,
      projection: null,
      probability: null,
      tier: toPublicTier(signal.tier),
    },
    markets: signal.marketSetups.map((m) => ({
      key: m.market,
      label: m.market === "pitcher_strikeouts" ? "Pitcher Ks" : "Pitcher Outs",
      side: "OVER" as const,
      line: null,
      projection: null,
      probability: null,
      tier: toPublicTier(signal.tier),
    })),
    badges,
    drivers: positives,
    warnings: negatives,
    context: {
      venue: signal.parkContext?.venueName ?? null,
      temperature: signal.parkContext?.temperatureF ?? null,
      windLabel: signal.parkContext?.windDirectionLabel ?? null,
      parkLabel: signal.parkContext?.runEnvironmentLabel ?? null,
      weatherLabel: signal.parkContext?.driverText ?? null,
    },
    tracking: {
      flaggedBeforeFirstPitch: signal.everPubliclyFlagged,
      outcomeStatus: signal.outcomes?.outcome === "mound_win" ? "hit" : signal.outcomes ? "calibration" : "pending",
      outcomeType,
      // Hard-coded, never derived — The Mound has no per-AB concept.
      firstAbCashEligible: false,
    },
  };
}

function rankTargets(targets: PregameRadarTarget[]): PregameRadarTarget[] {
  return targets
    .slice()
    .sort((a, b) => b.score10 - a.score10)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

/**
 * Derives slateStatus from the RAW gameStatus values both engines already
 * compute per-signal — not from the reshaped PregameRadarTarget's badges/
 * outcomeStatus, which are a lossy proxy (e.g. a live game with a still-
 * pending, badge-less target used to read identically to a fully-scheduled
 * slate). Takes plain strings so it works uniformly across Plate's
 * PregameGameStatus and Mound's MoundGameStatus (same literal value set).
 */
function deriveSlateStatus(gameStatuses: string[]): MlbPregameHubResponse["slateStatus"] {
  if (gameStatuses.length === 0) return "pre_first_pitch";
  if (gameStatuses.some((s) => s === "live")) return "in_progress";
  if (gameStatuses.every((s) => s === "final" || s === "postponed")) return "final";
  return "pre_first_pitch";
}

async function buildPlateView(): Promise<{ view: PregameRadarView; source: MlbPregameHubResponse["source"]; gameStatuses: string[] }> {
  const { snapshot, source } = await getRadarSnapshot();
  const dateET = slateDateET();
  const signals = snapshot ? Array.from(snapshot.signals.values()) : [];
  const response = buildPlateResponse(
    dateET,
    snapshot?.buildId ?? "none",
    snapshot?.generatedAt ?? new Date().toISOString(),
    source === "rebuilt" ? "rebuilt" : source === "db_fallback" ? "db_fallback" : "memory",
    signals,
    {
      gamesScanned: snapshot?.gamesScanned ?? 0,
      battersEvaluated: snapshot?.battersEvaluated ?? 0,
      lineupCoverage: snapshot?.coverage.lineupCoverage ?? 0,
      weatherCoverage: snapshot?.coverage.weatherCoverage ?? 0,
      batterCoverage: snapshot?.coverage.batterCoverage ?? 0,
      pitcherCoverage: snapshot?.coverage.pitcherCoverage ?? 0,
    },
    false,
  );

  const targets = rankTargets(response.signals.map((s, i) => plateTargetFromSignal(s, i + 1)));
  const publicStats = await getPregameRadarPublicStats(dateET).catch(() => null);
  const record: PregameRadarRecord = {
    winsToday: publicStats?.pregameWinsToday ?? 0,
    firstAbCashesToday: publicStats?.firstAbPregameWinsToday ?? 0,
    flaggedBeforeFirstPitchToday: publicStats?.flaggedBeforeFirstPitchToday ?? 0,
    winsLast7Days: publicStats?.pregameWinsLast7Days ?? 0,
  };

  console.log(`[MLB_PREGAME_PLATE_TARGETS] count=${targets.length} source=${source}`);

  return {
    view: {
      key: "plate",
      label: "The Plate",
      actorType: "batter",
      title: "The Plate",
      subtitle: "Hitter targets from today's confirmed lineups — power and production setups, not guarantees.",
      targets,
      filters: PLATE_FILTERS,
      record,
      diagnostics: response.diagnostics,
    },
    source: source === "rebuilt" ? "api" : source === "db_fallback" ? "cache" : "memory",
    // Raw, authoritative per-signal gameStatus — includes suppressed/non-public
    // signals too, since slateStatus reflects the whole slate's game state,
    // not just the publicly-flagged subset.
    gameStatuses: signals.map((s) => s.gameStatus),
  };
}

async function buildMoundView(): Promise<{ view: PregameRadarView; source: MlbPregameHubResponse["source"]; gameStatuses: string[] }> {
  const { snapshot, source } = await getMoundRadarSnapshot();
  const dateET = slateDateET();
  const signals = snapshot ? Array.from(snapshot.signals.values()) : [];
  const response = buildMoundResponse(
    dateET,
    snapshot?.buildId ?? "none",
    snapshot?.generatedAt ?? new Date().toISOString(),
    source === "rebuilt" ? "rebuilt" : source === "db_fallback" ? "db_fallback" : "memory",
    signals,
    {
      gamesScanned: snapshot?.gamesScanned ?? 0,
      pitchersEvaluated: snapshot?.pitchersEvaluated ?? 0,
      starterCoverage: snapshot?.coverage.starterCoverage ?? 0,
      weatherCoverage: snapshot?.coverage.weatherCoverage ?? 0,
      pitcherCoverage: snapshot?.coverage.pitcherCoverage ?? 0,
      lineupCoverage: snapshot?.coverage.lineupCoverage ?? 0,
    },
    false,
  );

  const targets = rankTargets(response.signals.map((s, i) => moundTargetFromSignal(s, i + 1)));
  const publicStats = await getMoundRadarPublicStats(dateET).catch(() => null);
  const record: PregameRadarRecord = {
    winsToday: publicStats?.moundWinsToday ?? 0,
    pitcherPropsCashedToday: publicStats?.pitcherPropsCashedToday ?? 0,
    flaggedBeforeFirstPitchToday: publicStats?.flaggedBeforeFirstPitchToday ?? 0,
    winsLast7Days: publicStats?.moundWinsLast7Days ?? 0,
  };

  console.log(`[MLB_PREGAME_MOUND_TARGETS] count=${targets.length} source=${source}`);

  return {
    view: {
      key: "mound",
      label: "The Mound",
      actorType: "pitcher",
      title: "The Mound",
      subtitle: "Pitcher targets from today's probable starters — strikeout and workload setups, not guarantees.",
      targets,
      filters: MOUND_FILTERS,
      record,
      diagnostics: response.diagnostics,
    },
    source: source === "rebuilt" ? "api" : source === "db_fallback" ? "cache" : "memory",
    gameStatuses: signals.map((s) => s.gameStatus),
  };
}

export async function buildPregameHubResponse(): Promise<MlbPregameHubResponse> {
  const dateET = slateDateET();
  console.log(`[MLB_PREGAME_HUB_BUILD] start date=${dateET}`);

  const [plate, mound] = await Promise.all([buildPlateView(), buildMoundView()]);

  plate.view.targets = validateTargets(plate.view.targets, "plate");
  mound.view.targets = validateTargets(mound.view.targets, "mound");

  const overall: PregameRadarRecord = {
    winsToday: plate.view.record.winsToday + mound.view.record.winsToday,
    flaggedBeforeFirstPitchToday:
      plate.view.record.flaggedBeforeFirstPitchToday + mound.view.record.flaggedBeforeFirstPitchToday,
    winsLast7Days: plate.view.record.winsLast7Days + mound.view.record.winsLast7Days,
  };

  const slateStatus = deriveSlateStatus([...plate.gameStatuses, ...mound.gameStatuses]);

  const source: MlbPregameHubResponse["source"] =
    plate.source === "api" || mound.source === "api" ? "api" : plate.source === "cache" || mound.source === "cache" ? "cache" : "memory";

  console.log(`[MLB_PREGAME_HUB_BUILD] complete date=${dateET} plate=${plate.view.targets.length} mound=${mound.view.targets.length}`);

  return {
    dateET,
    updatedAt: new Date().toISOString(),
    source,
    slateStatus,
    activeViewDefault: "plate",
    views: { plate: plate.view, mound: mound.view },
    records: { overall, plate: plate.view.record, mound: mound.view.record },
    diagnostics: { plate: plate.view.diagnostics, mound: mound.view.diagnostics },
  };
}
