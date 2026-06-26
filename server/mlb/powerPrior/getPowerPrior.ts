// ─────────────────────────────────────────────────────────────────────────────
// getPowerPrior — map the existing standalone Pre-Game Power Radar signal into the
// canonical `PowerPrior` shape. READ-ONLY: it reads the in-memory pregame snapshot
// (the same store the HR review classifier already reads) and computes nothing new.
//
// • No DB writes, no table changes, no scoring, no Monte Carlo.
// • When no standalone signal is found, returns a `source: "none"` prior.
// ─────────────────────────────────────────────────────────────────────────────

import { getSnapshotForDate } from "../pregamePowerRadar/pregamePowerRadarStore";
import type { PregamePowerSignal, PregamePowerTier } from "../pregamePowerRadar/types";
import type { PowerPrior, PowerPriorLookupInput, PowerPriorTier } from "./types";

const ALL_POWER_PRIOR_FIELDS = [
  "preGamePowerScore10",
  "preGamePowerScore100",
  "preGameTier",
  "estimatedHrProbability",
  "confidenceScore",
  "topDrivers",
  "topSuppressors",
  "generatedAt",
] as const;

const normName = (v: unknown): string =>
  String(v ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const normTeam = (v: unknown): string => String(v ?? "").toLowerCase().trim();

/** Map the standalone pregame tier (+ suppressed flag) onto the canonical tier. */
export function mapStandaloneTier(
  tier: PregamePowerTier | null | undefined,
  suppressed: boolean,
): PowerPriorTier | null {
  if (suppressed) return "suppressed";
  switch (tier) {
    case "nuclear":
    case "elite":
      return "elite";
    case "strong":
      return "strong";
    case "power_watch":
    case "watch":
      return "watch";
    case "track":
      return "neutral";
    default:
      return null;
  }
}

/**
 * Resolve the full standalone signal for an identity, mirroring the read-only
 * identity order used by `getPregameSignalFor`: MLBAM key → batterId → name+team.
 * Returns null when the snapshot is for a different date / empty / no match.
 */
function resolveStandaloneSignal(input: PowerPriorLookupInput): PregamePowerSignal | null {
  const snap = getSnapshotForDate(input.gameDateET);
  if (!snap) return null;

  const id = input.playerId != null ? String(input.playerId) : null;

  // 1) MLBAM-keyed direct lookup (store key = `${date}_${gameId}_${batterId}`).
  if (id) {
    const direct = snap.signals.get(`${input.gameDateET}_${input.gameId}_${id}`);
    if (direct) return direct;
  }

  const gameSignals = Array.from(snap.signals.values()).filter((s) => s.gameId === input.gameId);

  // 2) batterId scan.
  if (id) {
    const byId = gameSignals.find((s) => String(s.batterId) === id);
    if (byId) return byId;
  }

  // 3) normalized name + team.
  const name = normName(input.playerName);
  const team = normTeam(input.teamAbbr);
  if (name) {
    const byNameTeam = gameSignals.find(
      (s) => normName(s.batterName) === name && (!team || normTeam(s.team) === team),
    );
    if (byNameTeam) return byNameTeam;
  }

  return null;
}

/** Build the empty `source: "none"` prior (no standalone signal available). */
function emptyPrior(playerId: string, gameId: string): PowerPrior {
  return {
    playerId,
    gameId,
    source: "none",
    preGamePowerScore10: null,
    preGamePowerScore100: null,
    preGameTier: null,
    estimatedHrProbability: null,
    confidenceScore: null,
    topDrivers: [],
    topSuppressors: [],
    generatedAt: null,
    diagnostics: {
      hasStandalonePregameSignal: false,
      hasInlineFallback: false,
      mappedFromStandaloneFields: [],
      missingFields: [...ALL_POWER_PRIOR_FIELDS],
    },
  };
}

/**
 * Map an already-resolved standalone signal into a `PowerPrior`. Exported for
 * direct unit testing without a live snapshot. Pure — does not mutate `signal`.
 */
export function mapSignalToPowerPrior(
  signal: PregamePowerSignal,
  playerId: string,
  gameId: string,
): PowerPrior {
  const score10 = typeof signal.score10 === "number" ? signal.score10 : null;
  const score100 = score10 != null ? Math.round(score10 * 10 * 10) / 10 : null;
  const tier = mapStandaloneTier(signal.tier, signal.suppressed === true);

  const coverage = signal.diagnostics?.dataCoverageScore;
  const confidenceScore =
    typeof coverage === "number" ? Math.round(Math.max(0, Math.min(1, coverage)) * 100) : null;

  const drivers = Array.isArray(signal.drivers) ? signal.drivers : [];
  const byWeightDesc = (a: { weight?: number }, b: { weight?: number }) =>
    (b.weight ?? 0) - (a.weight ?? 0);
  const topDrivers = drivers
    .filter((d) => d.direction === "positive")
    .slice()
    .sort(byWeightDesc)
    .map((d) => d.label)
    .filter(Boolean)
    .slice(0, 5);
  const topSuppressors = drivers
    .filter((d) => d.direction === "negative")
    .slice()
    .sort(byWeightDesc)
    .map((d) => d.label)
    .filter(Boolean)
    .slice(0, 5);

  const mapped: string[] = [];
  const missing: string[] = [];
  const track = (field: string, present: boolean) =>
    present ? mapped.push(field) : missing.push(field);

  track("preGamePowerScore10", score10 != null);
  track("preGamePowerScore100", score100 != null);
  track("preGameTier", tier != null);
  // estimatedHrProbability is never computed in Phase 1 → always "missing".
  track("estimatedHrProbability", false);
  track("confidenceScore", confidenceScore != null);
  track("topDrivers", topDrivers.length > 0);
  track("topSuppressors", topSuppressors.length > 0);
  track("generatedAt", typeof signal.generatedAt === "string" && signal.generatedAt.length > 0);

  return {
    playerId,
    gameId,
    source: "pregame_power_radar",
    preGamePowerScore10: score10,
    preGamePowerScore100: score100,
    preGameTier: tier,
    estimatedHrProbability: null,
    confidenceScore,
    topDrivers,
    topSuppressors,
    generatedAt: typeof signal.generatedAt === "string" ? signal.generatedAt : null,
    diagnostics: {
      hasStandalonePregameSignal: true,
      hasInlineFallback: false,
      mappedFromStandaloneFields: mapped,
      missingFields: missing,
    },
  };
}

/**
 * Read-only: resolve and map the standalone Pre-Game Power Radar signal for an
 * identity into a canonical `PowerPrior`. Returns a `source: "none"` prior when
 * no signal is found. Never throws on a missing snapshot.
 */
export function getPowerPrior(input: PowerPriorLookupInput): PowerPrior {
  const playerId = input.playerId != null ? String(input.playerId) : "";
  const gameId = input.gameId ?? "";
  const signal = resolveStandaloneSignal(input);
  if (!signal) return emptyPrior(playerId, gameId);
  return mapSignalToPowerPrior(signal, playerId, gameId);
}
