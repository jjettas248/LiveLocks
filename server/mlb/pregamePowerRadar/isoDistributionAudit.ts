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
  eligibleEvaluated: number; // hitters with an ISO tag candidate (emission fired)
  tierCounts: Record<string, number>; // ELITE/STRONG/AVERAGE/WEAK/UNAVAILABLE
  elitePrevalence: number; // eliteDisplayed / eligibleEvaluated
  excluded: {
    invalidScaleOrMissing: number; // UNAVAILABLE ISO among candidates
    fallbackOrLowReliability: number; // valid but not display-eligible
  };
  displayedCards: number;
  tagPrevalence: Record<string, number>; // displayed positive tag key → share of displayed cards
  elitePrevalenceExceeded: boolean;
}

/** Pure aggregator. Returns a structured report; performs no I/O. */
export function buildIsoDistributionReport(signals: readonly PregamePowerSignal[]): IsoDistributionReport {
  const tierCounts: Record<string, number> = {
    ELITE: 0, STRONG: 0, AVERAGE: 0, WEAK: 0, UNAVAILABLE: 0,
  };
  let eligibleEvaluated = 0;
  let eliteDisplayed = 0;
  let invalidScaleOrMissing = 0;
  let fallbackOrLowReliability = 0;

  for (const s of signals) {
    const iso = s.drivers.find((d) => d.key === "power_iso");
    if (!iso) continue; // no ISO candidate emitted for this hitter
    eligibleEvaluated++;
    const tier = (iso.tier ?? "UNAVAILABLE").toUpperCase();
    if (tierCounts[tier] == null) tierCounts[tier] = 0;
    tierCounts[tier]++;
    const displayEligible = iso.displayEligible !== false;
    if (displayEligible && iso.label === "Elite Isolated Power") eliteDisplayed++;
    if (tier === "UNAVAILABLE") invalidScaleOrMissing++;
    else if (!displayEligible) fallbackOrLowReliability++;
  }

  // Displayed-tag prevalence over the cards that actually surface a chip.
  let displayedCards = 0;
  const tagCounts: Record<string, number> = {};
  for (const s of signals) {
    const displayedPositives = s.drivers.filter(
      (d) => d.direction === "positive" && d.displayEligible !== false && d.key !== "power_pullair",
    );
    if (displayedPositives.length === 0) continue;
    displayedCards++;
    for (const d of displayedPositives) tagCounts[d.key] = (tagCounts[d.key] ?? 0) + 1;
  }
  const tagPrevalence: Record<string, number> = {};
  for (const [k, c] of Object.entries(tagCounts)) {
    tagPrevalence[k] = displayedCards > 0 ? c / displayedCards : 0;
  }

  const elitePrevalence = eligibleEvaluated > 0 ? eliteDisplayed / eligibleEvaluated : 0;

  return {
    version: ISO_ASSESSMENT_VERSION,
    eligibleEvaluated,
    tierCounts,
    elitePrevalence,
    excluded: { invalidScaleOrMissing, fallbackOrLowReliability },
    displayedCards,
    tagPrevalence,
    elitePrevalenceExceeded: elitePrevalence > ISO_ELITE_PREVALENCE_WARN,
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
      `[PLATE_ISO_DISTRIBUTION] v=${report.version} date=${date} eligible=${report.eligibleEvaluated} ` +
        `tiers=${JSON.stringify(report.tierCounts)} elitePct=${(report.elitePrevalence * 100).toFixed(1)}% ` +
        `displayed=${report.displayedCards} excluded=${JSON.stringify(report.excluded)}`,
    );

    if (report.elitePrevalenceExceeded) {
      console.warn(
        `[PLATE_ISO_DISTRIBUTION_WARN] ELITE prevalence ${(report.elitePrevalence * 100).toFixed(1)}% ` +
          `> ${(ISO_ELITE_PREVALENCE_WARN * 100).toFixed(0)}% of ${report.eligibleEvaluated} eligible hitters ` +
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
