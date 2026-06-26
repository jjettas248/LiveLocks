// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: market confirmation → log-odds term
//
// Pure. Market can CONFIRM/RANK but never CREATE a candidate (task §O). When HR
// odds are unavailable (the current state of the codebase — there is no odds
// source wired), this is a full no-op. When present, it nudges the per-PA logit
// toward the market's implied game HR probability, with a small cap.
//
// IMPORTANT: this term is intentionally small and capped so the model stays a
// skill/matchup model that the market merely confirms — it does not become a
// market-follower. Prefer the no-vig implied probability when available.
// ─────────────────────────────────────────────────────────────────────────────

import type { MarketConfirmationInputs, LogOddsTerm } from "./mathTypes";
import { clamp, logit } from "./normalizeStats";

export const MARKET_CONFIRMATION_CAP = 0.25;

/** League-ish baseline GAME HR probability used as the neutral market reference. */
const MARKET_REF_GAME_HR_PROB = 0.11;

export function scoreMarketConfirmation(
  inp: MarketConfirmationInputs | null | undefined,
): LogOddsTerm {
  if (!inp || !inp.hrOddsAvailable) {
    return { key: "marketConfirmation", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  const p = inp.noVigImpliedHrProbability ?? inp.impliedHrProbability;
  if (p == null || !Number.isFinite(p) || p <= 0 || p >= 1) {
    return { key: "marketConfirmation", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  // Difference of log-odds between market-implied and the neutral reference,
  // applied at the per-PA level with a small gain and a hard cap.
  const delta = logit(p) - logit(MARKET_REF_GAME_HR_PROB);
  const logOdds = clamp(0.35 * delta, -MARKET_CONFIRMATION_CAP, MARKET_CONFIRMATION_CAP);

  return {
    key: "marketConfirmation",
    logOdds,
    available: true,
    shrinkWeight: 1,
    note: `impliedP=${p.toFixed(3)} delta=${delta.toFixed(2)}`,
  };
}
