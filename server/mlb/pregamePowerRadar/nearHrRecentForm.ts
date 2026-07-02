// Component 6 — Near-HR Recent Form (weight 0.08).
//
// Pure scorer. Retroactively re-runs the engine's own near-HR contact
// classifier (../nearHrContact.ts) over a batter's last 3 ET calendar days of
// persisted per-AB contact events. Never touches the game currently being
// scored — `sessionDateEt` is the hard leakage boundary: only rows whose ET
// calendar day falls strictly 1-3 days before it are considered. Missing or
// insufficient data degrades to a neutral no-op (score10: 5, available:
// false) — never a penalty.
//
// Known limitation: `contactEvents` does not persist `hitType` or `xba`, so
// the POWER_DOUBLE / POWER_TRIPLE / XBA_MISMATCH_DANGER "almost HR" paths in
// nearHrContact.ts are structurally undetectable retroactively. This is an
// accepted degradation — the detector treats absent fields as "not
// applicable," it never fabricates them.

import { detectNearHrContactPeak, type NearHrContactEvent, type NearHrTier } from "../nearHrContact";
import type { ComponentScore, PowerDriver } from "./types";
import { clamp10, round1 } from "./scoreUtils";
import { toEtDateKey } from "../../utils/dateUtils";

export interface RecentContactEventRow {
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  isBarrel: boolean;
  result: string | null;
  timestamp: Date | string;
}

export interface NearHrRecentFormInputs {
  /** Unfiltered, unsorted contact-event rows for ONE batter. */
  events: RecentContactEventRow[];
  /** slateDateET() of the game being scored — the leakage boundary. */
  sessionDateEt: string;
}

/** Recency weight by ET-calendar-day offset from sessionDateEt (1 = yesterday). */
const OFFSET_WEIGHTS: Record<number, number> = { 1: 1.0, 2: 0.65, 3: 0.4 };
const TIER_POINTS: Record<NearHrTier, number> = { lean: 9.5, watch: 7.0 };
const QUIET_DAY_POINTS = 5.0; // real ABs, no near-HR signal — neutral, not penalized
const CONSECUTIVE_DAY_BONUS = 1.2;
const WINDOW_DAYS = 3;

function tierLabel(tier: NearHrTier): string {
  return tier === "lean" ? "Near-HR Contact (Strong)" : "Near-HR Contact";
}

/** Whole-calendar-day distance from `fromDayKey` to `toDayKey` (both "YYYY-MM-DD"). */
function daysBetween(fromDayKey: string, toDayKey: string): number {
  const [y1, m1, d1] = fromDayKey.split("-").map(Number);
  const [y2, m2, d2] = toDayKey.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86_400_000);
}

export function computeNearHrRecentForm(inputs: NearHrRecentFormInputs): ComponentScore {
  const drivers: PowerDriver[] = [];

  // Leakage guard + fixed 3-day window: only ET calendar days strictly
  // BEFORE sessionDateEt (offset >= 1, excludes the game being scored) and
  // no more than WINDOW_DAYS back (offset <= 3).
  const byDay = new Map<string, RecentContactEventRow[]>();
  for (const row of inputs.events) {
    const dayKey = toEtDateKey(row.timestamp);
    const offset = daysBetween(dayKey, inputs.sessionDateEt);
    if (offset < 1 || offset > WINDOW_DAYS) continue;
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(row);
  }

  if (byDay.size === 0) {
    return { score10: 5, available: false, drivers, warnings: ["No prior-day contact data"] };
  }

  // Score as a recency-weighted excess over the neutral quiet-day baseline —
  // NOT a weighted average — so a single strong day's contribution still
  // scales with how recent it was (a plain weighted average of one value
  // collapses to that value regardless of its weight).
  const qualifyingOffsets: number[] = [];
  let weightedExcess = 0;

  for (const dayKey of Array.from(byDay.keys()).sort()) {
    const rows = byDay.get(dayKey)!;
    const offset = daysBetween(dayKey, inputs.sessionDateEt);
    const weight = OFFSET_WEIGHTS[offset] ?? 0.25;
    // Oldest→newest within the day, as detectNearHrContactPeak requires.
    const sorted = [...rows].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const events: NearHrContactEvent[] = sorted.map((r) => ({
      ev: r.exitVelocity,
      la: r.launchAngle,
      distance: r.distance,
      isBarrel: r.isBarrel,
      outcome: r.result,
      // Not persisted in contactEvents — accepted degradation (see header).
      hitType: null,
      xba: null,
    }));

    const peak = detectNearHrContactPeak(events, events.length);
    const points = peak.tier ? TIER_POINTS[peak.tier] : QUIET_DAY_POINTS;
    weightedExcess += (points - QUIET_DAY_POINTS) * weight;

    if (peak.tier) {
      qualifyingOffsets.push(offset);
      drivers.push({
        key: `near_hr_form_${dayKey}`,
        label: tierLabel(peak.tier),
        direction: "positive",
        evidence: `${dayKey} — ${peak.drivers.join(", ") || peak.tier}`,
        weight: peak.tier === "lean" ? 90 : 65,
      });
    }
  }

  // Bonus requires two ADJACENT qualifying offsets (e.g. yesterday + the day
  // before) — not just "2+ qualifying days somewhere in the window". Offsets
  // 1 and 3 with nothing on offset 2 is a gap, not a streak.
  const sortedOffsets = [...qualifyingOffsets].sort((a, b) => a - b);
  const hasConsecutivePair = sortedOffsets.some(
    (offset, i) => i > 0 && offset - sortedOffsets[i - 1] === 1,
  );

  let score10 = QUIET_DAY_POINTS + weightedExcess;
  if (hasConsecutivePair) {
    score10 += CONSECUTIVE_DAY_BONUS;
    drivers.push({
      key: "near_hr_form_consecutive",
      label: "Consecutive-Day Near-HR Pattern",
      direction: "positive",
      evidence: `${qualifyingOffsets.length} of last ${WINDOW_DAYS} days, back-to-back`,
      weight: 80,
    });
  }

  return { score10: round1(clamp10(score10)), available: true, drivers, warnings: [] };
}
