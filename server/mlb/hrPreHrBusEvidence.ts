/**
 * SAFE ADDITIVE MODULE — pre-HR bus / lifecycle evidence lookup for the HR
 * review classifier. Read-only against the LiveSignalBus + lifecycleStore.
 *
 * Answers, for a graded HR: did a HR Radar signal for this player actually get
 * SURFACED (shown to the user) or reach an official lifecycle state BEFORE the
 * HR timestamp?
 *
 * Critical correctness rules (v3.1):
 *   - `signalBusHadPreHrRecord` is true ONLY when `surfacedAt < hrEndTimeMs`.
 *     An internal `engineGeneratedAt` touch was never shown to the user and
 *     must NOT prove attribution — it is captured separately as
 *     `engineGeneratedBeforeHr` for diagnostics only.
 *   - `lifecycleHadPreHrRecord` requires a created/upgraded transition into a
 *     strong/elite (official) state strictly before the HR.
 */

import { getRegisteredById } from "../services/liveSignalBus";
import { getHistory } from "../services/lifecycleStore";

export interface PreHrBusEvidence {
  signalBusHadPreHrRecord: boolean;
  lifecycleHadPreHrRecord: boolean;
  engineGeneratedBeforeHr: boolean;
  checkedSignalIds: string[];
}

const OFFICIAL_LIFECYCLE_STATES = new Set(["strong", "elite"]);
const OFFICIAL_LIFECYCLE_EVENTS = new Set(["created", "upgraded"]);

export function getPreHrHrRadarBusEvidence(input: {
  gameId: string;
  playerId: string | number;
  hrEndTimeMs: number | null;
}): PreHrBusEvidence {
  const { gameId, playerId, hrEndTimeMs } = input;
  // Settlement bug #1: the HR Radar market token is `hrr`; the legacy form is
  // `home_runs`. Check both so a market mismatch surfaces as attribution, not
  // a silent miss.
  const checkedSignalIds = [
    `mlb:${gameId}:${playerId}:hrr:OVER`,
    `mlb:${gameId}:${playerId}:home_runs:OVER`,
  ];

  const result: PreHrBusEvidence = {
    signalBusHadPreHrRecord: false,
    lifecycleHadPreHrRecord: false,
    engineGeneratedBeforeHr: false,
    checkedSignalIds,
  };

  if (hrEndTimeMs == null) return result;

  for (const signalId of checkedSignalIds) {
    let record;
    try {
      record = getRegisteredById(signalId);
    } catch {
      record = null;
    }
    if (record) {
      // Surfaced (user-visible) before HR — the only thing that proves the
      // user could have seen the signal.
      if (typeof record.surfacedAt === "number" && record.surfacedAt > 0 && record.surfacedAt < hrEndTimeMs) {
        result.signalBusHadPreHrRecord = true;
      }
      // Diagnostic only — engine generated before HR but maybe never surfaced.
      if (
        typeof record.engineGeneratedAt === "number" &&
        record.engineGeneratedAt > 0 &&
        record.engineGeneratedAt < hrEndTimeMs
      ) {
        result.engineGeneratedBeforeHr = true;
      }
    }

    let history: ReturnType<typeof getHistory>;
    try {
      history = getHistory(signalId);
    } catch {
      history = [];
    }
    for (const ev of history ?? []) {
      if (
        typeof ev.at === "number" &&
        ev.at < hrEndTimeMs &&
        OFFICIAL_LIFECYCLE_EVENTS.has(String(ev.event)) &&
        OFFICIAL_LIFECYCLE_STATES.has(String(ev.to))
      ) {
        result.lifecycleHadPreHrRecord = true;
        break;
      }
    }
  }

  return result;
}
