// The Plate — ISO tier distribution + tag-prevalence guardrail (READ-ONLY).
//
// A precision guardrail: a selective tag is valuable, a universal one is not. This
// aggregates the ISO tier distribution and displayed-tag prevalence across a slate
// and warns when the "Elite Isolated Power" tag (or any supposedly selective tag)
// re-inflates toward universality — the exact failure this repair fixes.
//
// It NEVER mutates a signal, never blocks the response, and never auto-retunes a
// threshold at runtime. It only reports. Every entry point is wrapped so a defect
// here can never break the Plate build/response.

import type { PregamePowerSignal } from "./types";
import { ISO_ASSESSMENT_VERSION } from "./isoAssessmentConfig";

export const ISO_ELITE_PREVALENCE_WARN = 0.25; // >25% ELITE of eligible → warn
export const TAG_PREVALENCE_WARN = 0.5; // >50% of displayed cards on consecutive slates → warn

export interface IsoDistributionReport {
  version: string;
  // Denominator #1 — EVERY ISO-assessed hitter across the full evaluated set
  // (public AND suppressed). A hitter is ISO-assessed iff the `power_iso` driver
  // was emitted for them (that is exactly when assessIso runs).
  eligibleEvaluated: number;
  tierCounts: Record<string, number>; // ELITE/STRONG/AVERAGE/WEAK/UNAVAILABLE over eligibleEvaluated
  eliteClassified: number; // Elite-labeled + displayEligible among eligibleEvaluated
  evaluatedElitePrevalence: number; // eliteClassified / eligibleEvaluated  ← the selectivity metric
  excluded: {
    invalidScaleOrMissing: number; // UNAVAILABLE ISO among evaluated candidates
    fallbackOrLowReliability: number; // valid but not display-eligible
  };
  // Denominator #2 — DISPLAYED Plate cards (the public set with ≥1 visible chip).
  displayedCards: number;
  eliteDisplayed: number; // Elite ISO chips actually rendered
  displayedElitePrevalence: number; // eliteDisplayed / displayedCards
  tagPrevalence: Record<string, number>; // displayed positive tag key → share of displayed cards
  elitePrevalenceExceeded: boolean; // evaluatedElitePrevalence > 25%
}

/**
 * Pure aggregator. Returns a structured report; performs no I/O.
 * @param evaluatedSignals EVERY evaluated signal (public + suppressed) — the ISO
 *   selectivity denominator. Every ISO-assessed hitter is counted here.
 * @param displayedSignals The public/displayed subset (defaults to evaluated) —
 *   the denominator for what users actually see on Plate cards.
 */
export function buildIsoDistributionReport(
  evaluatedSignals: readonly PregamePowerSignal[],
  displayedSignals: readonly PregamePowerSignal[] = evaluatedSignals,
): IsoDistributionReport {
  const tierCounts: Record<string, number> = {
    ELITE: 0, STRONG: 0, AVERAGE: 0, WEAK: 0, UNAVAILABLE: 0,
  };
  let eligibleEvaluated = 0;
  let eliteClassified = 0;
  let invalidScaleOrMissing = 0;
  let fallbackOrLowReliability = 0;

  // Denominator #1 — every ISO-assessed hitter in the full evaluated set.
  for (const s of evaluatedSignals) {
    const iso = s.drivers.find((d) => d.key === "power_iso");
    if (!iso) continue; // no ISO assessment ran for this hitter
    eligibleEvaluated++;
    const tier = (iso.tier ?? "UNAVAILABLE").toUpperCase();
    if (tierCounts[tier] == null) tierCounts[tier] = 0;
    tierCounts[tier]++;
    const displayEligible = iso.displayEligible !== false;
    if (displayEligible && iso.label === "Elite Isolated Power") eliteClassified++;
    if (tier === "UNAVAILABLE") invalidScaleOrMissing++;
    else if (!displayEligible) fallbackOrLowReliability++;
  }

  // Denominator #2 — displayed cards (public set with a visible chip).
  let displayedCards = 0;
  let eliteDisplayed = 0;
  const tagCounts: Record<string, number> = {};
  for (const s of displayedSignals) {
    const displayedPositives = s.drivers.filter(
      (d) => d.direction === "positive" && d.displayEligible !== false && d.key !== "power_pullair",
    );
    if (displayedPositives.length === 0) continue;
    displayedCards++;
    for (const d of displayedPositives) {
      tagCounts[d.key] = (tagCounts[d.key] ?? 0) + 1;
      if (d.key === "power_iso" && d.label === "Elite Isolated Power") eliteDisplayed++;
    }
  }
  const tagPrevalence: Record<string, number> = {};
  for (const [k, c] of Object.entries(tagCounts)) {
    tagPrevalence[k] = displayedCards > 0 ? c / displayedCards : 0;
  }

  const evaluatedElitePrevalence = eligibleEvaluated > 0 ? eliteClassified / eligibleEvaluated : 0;
  const displayedElitePrevalence = displayedCards > 0 ? eliteDisplayed / displayedCards : 0;

  return {
    version: ISO_ASSESSMENT_VERSION,
    eligibleEvaluated,
    tierCounts,
    eliteClassified,
    evaluatedElitePrevalence,
    excluded: { invalidScaleOrMissing, fallbackOrLowReliability },
    displayedCards,
    eliteDisplayed,
    displayedElitePrevalence,
    tagPrevalence,
    elitePrevalenceExceeded: evaluatedElitePrevalence > ISO_ELITE_PREVALENCE_WARN,
  };
}

// Small module-level history for the consecutive-slate tag-prevalence check. Keyed
// by slate date; keeps the newest few dates only. Best-effort observability, not a
// source of truth — never read by the engine.
interface SlateSnapshot { date: string; tagPrevalence: Record<string, number>; }
const slateHistory: SlateSnapshot[] = [];
const MAX_SLATE_HISTORY = 6;

/**
 * Records the slate's report and emits a single aggregate structured log line,
 * plus warnings if ELITE prevalence exceeds the cap OR any selective tag exceeds
 * 50% of displayed cards on two consecutive qualifying slates. Never throws.
 */
export function recordAndLogIsoDistribution(date: string, report: IsoDistributionReport): void {
  try {
    if (report.eligibleEvaluated === 0) return; // nothing evaluated — not a qualifying slate

    // Update history (dedupe by date, newest wins).
    const existingIdx = slateHistory.findIndex((s) => s.date === date);
    const snapshot: SlateSnapshot = { date, tagPrevalence: report.tagPrevalence };
    if (existingIdx >= 0) slateHistory[existingIdx] = snapshot;
    else slateHistory.push(snapshot);
    while (slateHistory.length > MAX_SLATE_HISTORY) slateHistory.shift();

    // eslint-disable-next-line no-console
    console.log(
      `[PLATE_ISO_DISTRIBUTION] v=${report.version} date=${date} evaluated=${report.eligibleEvaluated} ` +
        `tiers=${JSON.stringify(report.tierCounts)} ` +
        `evalElitePct=${(report.evaluatedElitePrevalence * 100).toFixed(1)}% ` +
        `displayed=${report.displayedCards} dispElitePct=${(report.displayedElitePrevalence * 100).toFixed(1)}% ` +
        `excluded=${JSON.stringify(report.excluded)}`,
    );

    if (report.elitePrevalenceExceeded) {
      console.warn(
        `[PLATE_ISO_DISTRIBUTION_WARN] ELITE prevalence ${(report.evaluatedElitePrevalence * 100).toFixed(1)}% ` +
          `> ${(ISO_ELITE_PREVALENCE_WARN * 100).toFixed(0)}% of ${report.eligibleEvaluated} evaluated hitters ` +
          `— classification may be regressing toward universality (date=${date}).`,
      );
    }

    // Consecutive-slate tag prevalence — compare this slate to the immediately
    // prior distinct slate date.
    const distinct = slateHistory.filter((s) => s.date !== date);
    const prior = distinct.length > 0 ? distinct[distinct.length - 1] : null;
    if (prior) {
      for (const [key, pct] of Object.entries(report.tagPrevalence)) {
        const priorPct = prior.tagPrevalence[key] ?? 0;
        if (pct > TAG_PREVALENCE_WARN && priorPct > TAG_PREVALENCE_WARN) {
          console.warn(
            `[PLATE_ISO_DISTRIBUTION_WARN] tag "${key}" on ${(pct * 100).toFixed(0)}% of displayed cards ` +
              `(prior slate ${(priorPct * 100).toFixed(0)}%) — supposedly selective tag is near-universal ` +
              `on consecutive slates (${prior.date} → ${date}).`,
          );
        }
      }
    }
  } catch {
    /* observability only — never break the response */
  }
}

/** Test hook: clear the consecutive-slate history so tests are deterministic. */
export function __resetIsoDistributionHistory(): void {
  slateHistory.length = 0;
}
