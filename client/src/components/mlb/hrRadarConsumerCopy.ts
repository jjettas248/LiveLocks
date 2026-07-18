// HR Radar — the ONE consumer-facing vocabulary module. PRESENTATION-ONLY.
//
// Every user-visible HR Radar noun (stage names, section headers,
// descriptions, CTA labels, result labels) lives here and nowhere else.
// `hrRadarVisuals.tsx` owns color/icon/border/glow only — it must never own
// copy. This module exists specifically to prevent the pre-rebuild drift
// where "Attack"/"Playable"/"Lean"/"Watchlist"/"Hot Seat"/"Take It"/
// "Decision Queue" were each spelled out independently in 5+ different
// files. Internal engine/admin vocabularies (shared/hrRadarStage.ts's
// PlayabilityStatus + PLAYABILITY_LABEL, the admin conversion-funnel labels
// in mlb-signal-intelligence.tsx) are UNCHANGED and out of scope — they are
// not consumer-facing.

import type { HrRadarLiveStage, HrRadarResultType } from "@shared/hrRadarDecisionView";

export const HR_RADAR_STAGE_COPY: Record<
  "fire" | "ready" | "build" | "watch",
  { short: string; section: string; description: string }
> = {
  fire: {
    short: "Fire",
    section: "FIRE",
    description: "Official HR calls available now.",
  },
  ready: {
    short: "Ready",
    section: "READY",
    description: "Watch the next plate appearance. No bet yet.",
  },
  build: {
    short: "Build",
    section: "BUILD",
    description: "The signal is developing but is not actionable.",
  },
  watch: {
    short: "Watch",
    section: "WATCH",
    description: "Early monitoring only.",
  },
};

export const HR_RADAR_RESULT_COPY: Record<"signal_hit" | "official_miss" | "model_review", {
  short: string;
  section: string;
  description: string;
}> = {
  signal_hit: {
    short: "Signal Hit",
    section: "SIGNAL HITS",
    description: "Home runs that occurred after an official Fire call.",
  },
  official_miss: {
    short: "Missed",
    section: "MISSED",
    description: "Official Fire calls that resolved without a home run.",
  },
  model_review: {
    short: "Model Review",
    section: "MODEL REVIEW",
    description: "Admin-only — uncalled HRs and calibration-only outcomes.",
  },
};

export const HR_RADAR_WAITING_FOR_FIRST_AB_COPY = {
  section: "WAITING FOR FIRST AB",
  description: "The game is live, but no plate appearance has been tracked yet.",
};

export const HR_RADAR_FORMING_SIGNALS_COPY = {
  section: "FORMING SIGNALS",
  description: "Background monitoring — not actionable.",
};

/** Stage-safe fallback "why watching" / "needs to become a call" copy. Used
 *  ONLY when the server didn't supply a specific `promotionRequirement` for
 *  the row — these are UI explanations, not engine claims. */
export const HR_RADAR_PROMOTION_FALLBACK: Record<"ready" | "build" | "watch", string> = {
  ready: "Waiting for the next qualifying contact event.",
  build: "Needs stronger or repeated contact evidence.",
  watch: "Monitoring early conditions.",
};

export function hrRadarLiveStageLabel(stage: Exclude<HrRadarLiveStage, null>): string {
  return HR_RADAR_STAGE_COPY[stage].short;
}

export function hrRadarResultLabel(resultType: Exclude<HrRadarResultType, null>): string {
  return HR_RADAR_RESULT_COPY[resultType].short;
}

/**
 * Consumer-safe label for a server-stamped `PlayabilityStatus`
 * (shared/hrRadarStage.ts: watchlist|lean|playable|attack|resolved). Used by
 * surfaces (e.g. the HR Radar detail modal) that only have the internal
 * playability vocabulary available and must still render the ONE consumer
 * vocabulary — never "Watchlist"/"Lean"/"Playable"/"Attack" verbatim.
 */
export function hrRadarConsumerLabelForPlayability(
  status: "watchlist" | "lean" | "playable" | "attack" | "resolved" | null | undefined,
): string {
  switch (status) {
    case "watchlist": return HR_RADAR_STAGE_COPY.watch.short;
    case "lean": return HR_RADAR_STAGE_COPY.build.short;
    case "playable": return HR_RADAR_STAGE_COPY.ready.short;
    case "attack": return HR_RADAR_STAGE_COPY.fire.short;
    case "resolved": return "Resolved";
    default: return "Watch";
  }
}

/**
 * CTA copy, by stage + rendering context. Only Fire and Ready ever have a
 * primary label — Build/Watch have no CTA per the consumer action matrix
 * (callers should not render a button at all for those stages).
 */
export function getHrRadarCtaLabel(stage: "fire" | "ready", context: "hero" | "row"): string {
  if (stage === "fire") return context === "hero" ? "Add HR 0.5" : "Take Now";
  return "Watch Next AB";
}
