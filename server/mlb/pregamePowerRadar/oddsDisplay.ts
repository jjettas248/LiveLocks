// Pre-Game Power Radar — best-odds display enrichment.
//
// PURELY a presentation/response-layer concern: reads already-cached sportsbook
// lines (written by the live MLB orchestrator's existing odds fetches) and
// stamps a `marketEdgeContext` onto each signal for the card UI. It NEVER
// calls a live odds API itself — event-id resolution uses the cache-only
// `resolveMLBOddsEventIdFromCache` (returns null rather than fetching when the
// events list isn't already warm) and line lookups use `readOddsSnapshot`
// (`allowStale: true`). It never touches score10/tier/drivers, and never
// mutates the canonical in-memory snapshot — it returns shallow clones for the
// HTTP response only.

import { resolveMLBOddsEventIdFromCache } from "../../oddsService";
import { readOddsSnapshot } from "../../odds/oddsCache";
import type { PregamePowerSignal, PregameMarketEdgeContext } from "./types";

// gameId → resolved odds-provider event id. Process-lifetime cache; a given
// game's odds-event id never changes once resolved from the cached events list.
const eventIdByGameId = new Map<string, string>();

function resolveEventIdCached(gameId: string, team: string, opponent: string): string | null {
  const cached = eventIdByGameId.get(gameId);
  if (cached) return cached;
  const id = resolveMLBOddsEventIdFromCache(team, opponent);
  if (id) eventIdByGameId.set(gameId, id);
  return id;
}

function pickBestOverBook(
  books: Record<string, { line: number; overOdds: number | null; underOdds: number | null }>,
): { book: string; line: number; odds: number } | null {
  let best: { book: string; line: number; odds: number } | null = null;
  for (const [book, snap] of Object.entries(books)) {
    if (snap.overOdds == null || !isFinite(snap.overOdds)) continue;
    if (!best || snap.overOdds > best.odds) {
      best = { book, line: snap.line, odds: snap.overOdds };
    }
  }
  return best;
}

function americanToImpliedProbability(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return -odds / (-odds + 100);
}

/**
 * Stamps `marketEdgeContext` (best book / odds / line / implied probability)
 * onto each signal, read-only from the existing odds cache. Best-effort and
 * fully isolated per signal — a lookup failure for one batter never affects
 * another, and the function can never throw.
 */
export async function attachBestOddsDisplay(
  signals: PregamePowerSignal[],
): Promise<PregamePowerSignal[]> {
  if (signals.length === 0) return signals;

  return Promise.all(
    signals.map(async (signal) => {
      try {
        const market = signal.primaryMarket;
        if (market !== "home_runs" && market !== "total_bases") return signal;

        const eventId = resolveEventIdCached(signal.gameId, signal.team, signal.opponent);
        if (!eventId) return signal;

        const snap = readOddsSnapshot({
          sport: "mlb",
          eventId,
          market,
          player: signal.batterName,
          isLive: false,
          allowStale: true,
        });
        if (!snap) return signal;

        const best = pickBestOverBook(snap.books);
        if (!best) return signal;

        const marketEdgeContext: PregameMarketEdgeContext = {
          line: best.line,
          odds: best.odds,
          impliedProbability: Math.round(americanToImpliedProbability(best.odds) * 1000) / 1000,
          sportsbook: best.book,
          oddsUpdatedAt: new Date(snap.fetchedAt).toISOString(),
        };

        return { ...signal, marketEdgeContext };
      } catch {
        return signal;
      }
    }),
  );
}
