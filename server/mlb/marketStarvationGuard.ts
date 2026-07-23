// MLB Market Starvation Guard
//
// Passive observation layer that detects when a market's live signals are
// being systematically starved by missing sportsbook lines — the failure
// mode that makes Live Edge look like a market was "removed" even though
// nothing in the qualification pipeline changed underneath it. Reads the
// existing qualificationAudit rolling window; never mutates it.
//
// This module NEVER:
//   - mutates engine math, qualification thresholds, or resolveBookLine()'s
//     fallback behavior (including the home_runs odds-independent exemption,
//     which is untouched and stays exactly as-is)
//   - blocks, alters, or suppresses any signal
//   - surfaces to non-admin users
//
// [MLB_MARKET_STARVED] / [MLB_MARKET_STARVED_RECOVERED] are log-only.
// Thresholds below are reasoned starting points, not empirically tuned —
// watch real slates before wiring this into any external alerting.

import { getAuditSummary, type AuditSummary } from "./qualificationAudit";

const SAMPLE_FLOOR = 20;                    // min (rejected+qualified) attempts before judging a market
const RATE_THRESHOLD_PCT = 70;              // staleOddsRejectRate that trips the tag
const REFIRE_COOLDOWN_MS = 10 * 60 * 1000;  // per-market re-fire suppression

export interface MarketStarvationFinding {
  market: string;
  rejected: number;
  qualified: number;
  staleOddsRejected: number;
  staleOddsRejectRate: number;
}

/**
 * Pure evaluator — no I/O, no module state. Given an audit summary snapshot,
 * returns the markets currently past the starvation threshold. A market only
 * qualifies once it has enough sampled attempts (SAMPLE_FLOOR) to be
 * meaningful — a single early-inning tick can't trip this on its own.
 */
export function evaluateMarketStarvation(
  summary: AuditSummary | null | undefined,
  opts?: { sampleFloor?: number; rateThresholdPct?: number },
): MarketStarvationFinding[] {
  if (!summary || !Array.isArray(summary.qualificationBottlenecks)) return [];
  const sampleFloor = opts?.sampleFloor ?? SAMPLE_FLOOR;
  const rateThresholdPct = opts?.rateThresholdPct ?? RATE_THRESHOLD_PCT;

  const findings: MarketStarvationFinding[] = [];
  for (const entry of summary.qualificationBottlenecks) {
    if (!entry || typeof entry.market !== "string") continue;
    const rejected = entry.rejected ?? 0;
    const qualified = entry.qualified ?? 0;
    const staleOddsRejectRate = entry.staleOddsRejectRate ?? 0;
    const sampleSize = rejected + qualified;
    if (sampleSize < sampleFloor) continue;
    if (staleOddsRejectRate < rateThresholdPct) continue;
    findings.push({
      market: entry.market,
      rejected,
      qualified,
      staleOddsRejected: entry.staleOddsRejected ?? 0,
      staleOddsRejectRate,
    });
  }
  return findings;
}

// Per-market last-fired timestamp, for cooldown suppression.
const _lastFired = new Map<string, number>();
// Markets considered starved as of the last check — used to emit a one-time
// RECOVERED log when a market drops back out of the findings.
const _currentlyStarved = new Set<string>();

/**
 * Impure runner — call once per qualification cycle end (mirrors
 * goldmasterGuard's recordDriftSnapshot wiring). Reads the live audit
 * summary, evaluates starvation, and logs findings with a per-market cooldown
 * so a sustained condition doesn't spam logs every cycle. Never throws — a
 * failure here must never break the qualification cycle.
 *
 * `getSummary` defaults to the real qualificationAudit reader; tests pass a
 * throwing/stub function to verify the never-throws guarantee and control
 * the input shape without a mocking framework.
 */
export function checkMarketStarvation(getSummary: () => AuditSummary = getAuditSummary): void {
  try {
    const summary = getSummary();
    const findings = evaluateMarketStarvation(summary);
    const foundMarkets = new Set(findings.map((f) => f.market));
    const now = Date.now();

    for (const finding of findings) {
      const lastFired = _lastFired.get(finding.market) ?? 0;
      if (now - lastFired < REFIRE_COOLDOWN_MS) continue;
      _lastFired.set(finding.market, now);
      _currentlyStarved.add(finding.market);
      console.warn("[MLB_MARKET_STARVED]", JSON.stringify({
        market: finding.market,
        staleOddsRejectRate: finding.staleOddsRejectRate,
        staleOddsRejected: finding.staleOddsRejected,
        rejected: finding.rejected,
        qualified: finding.qualified,
        windowMs: summary.windowMs,
      }));
    }

    for (const market of Array.from(_currentlyStarved)) {
      if (!foundMarkets.has(market)) {
        _currentlyStarved.delete(market);
        _lastFired.delete(market);
        console.log("[MLB_MARKET_STARVED_RECOVERED]", JSON.stringify({ market }));
      }
    }
  } catch (err) {
    console.warn("[MLB_MARKET_STARVED] check_failed:", (err as Error).message);
  }
}

// Test/debug only — never call in prod request paths.
export function _resetMarketStarvationGuardForTests(): void {
  _lastFired.clear();
  _currentlyStarved.clear();
}
