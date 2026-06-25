// ─────────────────────────────────────────────────────────────────────────────
// HR Board Studio — admin workflow analytics (read-only, in-memory)
//
// Tracks admin copy / download / generate actions for the HR Board Studio.
// Deliberately isolated from the canonical Batch E analytics buffer
// (`server/analytics/`) — those events are signal-scoped engine telemetry; these
// are growth/UX workflow events with their own shape. This module never touches
// the engine, the bus, or any canonical field — it only appends to a bounded
// ring buffer and rolls up a summary for the admin dashboard.
// ─────────────────────────────────────────────────────────────────────────────

import { todayET } from "../utils/dateUtils";
import type {
  HrBoardAnalyticsEvent,
  HrBoardAnalyticsEventType,
  HrBoardAnalyticsSummary,
  HrBoardImageTemplate,
} from "../../shared/hrBoardStudio";

const MAX_EVENTS = 10_000;
const _store: HrBoardAnalyticsEvent[] = [];
let _seq = 0;

export interface RecordHrBoardEventInput {
  eventType: HrBoardAnalyticsEventType;
  date?: string;
  assetType?: HrBoardAnalyticsEvent["assetType"];
  template?: HrBoardImageTemplate | null;
  player?: string | null;
  signalId?: string | null;
  count?: number | null;
}

/**
 * Append an HR Board Studio workflow event. Never throws — analytics must not
 * break the admin flow. Returns the persisted event.
 */
export function recordHrBoardEvent(input: RecordHrBoardEventInput): HrBoardAnalyticsEvent {
  const evt: HrBoardAnalyticsEvent = {
    eventId: `${++_seq}-${Date.now().toString(36)}`,
    eventType: input.eventType,
    timestamp: Date.now(),
    date: input.date ?? todayET(),
    assetType: input.assetType ?? null,
    template: input.template ?? null,
    player: input.player ?? null,
    signalId: input.signalId ?? null,
    count: input.count ?? null,
  };
  _store.push(evt);
  if (_store.length > MAX_EVENTS) {
    _store.splice(0, _store.length - MAX_EVENTS);
  }
  return evt;
}

export function getHrBoardEvents(date?: string): HrBoardAnalyticsEvent[] {
  if (!date) return _store.slice();
  return _store.filter((e) => e.date === date);
}

function topByCount<T extends string>(counts: Map<T, number>): T | null {
  let best: T | null = null;
  let bestN = -1;
  counts.forEach((n, k) => {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  });
  return best;
}

/**
 * Roll up the admin summary for `date` (defaults to today). `movementAssets`
 * and `recapGenerated` are supplied by the caller from live state so the
 * summary reflects current availability without the analytics layer reaching
 * into the engine itself.
 */
export function getHrBoardSummary(opts: {
  date?: string;
  movementAssetsAvailable?: number;
}): HrBoardAnalyticsSummary {
  const date = opts.date ?? todayET();
  const events = getHrBoardEvents(date);

  let assetsGeneratedToday = 0;
  let assetsCopiedToday = 0;
  const playerCopies = new Map<string, number>();
  const templateCopies = new Map<HrBoardImageTemplate, number>();
  let recapGenerated = false;

  for (const e of events) {
    switch (e.eventType) {
      case "hr_board_pack_generated":
        assetsGeneratedToday += e.count ?? 1;
        break;
      case "hr_movement_asset_generated":
        assetsGeneratedToday += e.count ?? 1;
        break;
      case "hr_recap_generated":
        assetsGeneratedToday += e.count ?? 1;
        recapGenerated = true;
        break;
      case "hr_board_asset_copied":
      case "hr_movement_asset_copied":
      case "hr_recap_copied":
        assetsCopiedToday += 1;
        if (e.player) playerCopies.set(e.player, (playerCopies.get(e.player) ?? 0) + 1);
        if (e.template)
          templateCopies.set(e.template, (templateCopies.get(e.template) ?? 0) + 1);
        break;
      default:
        break;
    }
  }

  return {
    date,
    generatedAt: new Date().toISOString(),
    assetsGeneratedToday,
    assetsCopiedToday,
    mostCopiedPlayer: topByCount(playerCopies),
    mostCopiedTemplate: topByCount(templateCopies),
    movementAssetsAvailable: opts.movementAssetsAvailable ?? 0,
    recapStatus: recapGenerated ? "generated" : "not_generated",
    recentEvents: events.slice(-25).reverse(),
  };
}

/** Test-only reset. */
export function _resetHrBoardAnalyticsForTests(): void {
  _store.length = 0;
  _seq = 0;
}
