// LiveLocks — HR Radar canonical stage + badge vocabulary (single source).
//
// Step 5 of the HR Radar audit consolidation: there is exactly ONE user-facing
// stage ladder and ONE badge taxonomy. Internal engine taxonomies
// (DynamicHRState BET_NOW/PREPARE, PATH signalState PEAK/BUILDING, legacy
// confidenceTier, canonicalStage attack/building) still exist as engine inputs,
// but they collapse into the single CanonicalHrRadarStage below before anything
// user-facing reads them. UI never re-derives a stage and never invents a badge
// — both come from this module.
//
// Pure types + pure derivation. No I/O, no engine math.

// ── The one user-facing stage ─────────────────────────────────────────────
export type CanonicalHrRadarStage = "track" | "build" | "ready" | "fire" | "resolved";

export const HR_RADAR_STAGE_RANK: Record<CanonicalHrRadarStage, number> = {
  resolved: -1,
  track: 0,
  build: 1,
  ready: 2,
  fire: 3,
};

export const HR_RADAR_STAGE_LABEL: Record<CanonicalHrRadarStage, string> = {
  track: "Track",
  build: "Build",
  ready: "Ready",
  fire: "Fire",
  resolved: "Resolved",
};

/** The graded, actionable tier — the "HR Max Window". */
export function isHrMaxWindowStage(stage: CanonicalHrRadarStage): boolean {
  return stage === "fire" || stage === "ready";
}

// ── Playability language (user-facing) ──────────────────────────────────────
// The internal stage ladder above (track|build|ready|fire|resolved) stays as
// the engine's canonical vocabulary. Everything user-facing renders the
// betting-actionable playability language below instead — the server stamps
// it, the UI renders it verbatim, and it never re-derives from the internal
// stage name on its own. Only "playable" and "attack" are official calls.
export type PlayabilityStatus = "watchlist" | "lean" | "playable" | "attack" | "resolved";

export const STAGE_TO_PLAYABILITY: Record<CanonicalHrRadarStage, PlayabilityStatus> = {
  track: "watchlist",
  build: "lean",
  ready: "playable",
  fire: "attack",
  resolved: "resolved",
};

export const PLAYABILITY_LABEL: Record<PlayabilityStatus, string> = {
  watchlist: "Watchlist",
  lean: "Lean",
  playable: "Playable",
  attack: "Attack",
  resolved: "Resolved",
};

export const PLAYABILITY_DESCRIPTION: Record<PlayabilityStatus, string> = {
  watchlist: "Worth monitoring · not official",
  lean: "Signal forming · not official",
  playable: "Official HR signal active",
  attack: "Max-conviction HR window",
  resolved: "Result finalized",
};

/**
 * Display/order-only score floor per playability tier. Never used for
 * grading. Mirrors `fallbackScoreForStage()` (server/mlb/hrRadarUserStage.ts)
 * and `STAGE_SCORE_FLOOR` (server/mlb/hrRadarStateMachine.ts) — keep all
 * three in lock-step. `playable` is held at 7.5 (exceeds the requested 7.0
 * floor) so it doesn't regress the existing calibration.
 */
export const PLAYABILITY_SCORE_FLOOR: Record<PlayabilityStatus, number> = {
  watchlist: 2.5,
  lean: 5.5,
  playable: 7.5,
  attack: 9.0,
  resolved: 0,
};

export function getPlayabilityStatus(stage: CanonicalHrRadarStage): PlayabilityStatus {
  return STAGE_TO_PLAYABILITY[stage];
}

export function getPlayabilityLabel(status: PlayabilityStatus): string {
  return PLAYABILITY_LABEL[status];
}

export function getPlayabilityDescription(status: PlayabilityStatus): string {
  return PLAYABILITY_DESCRIPTION[status];
}

/** Only Playable (ready) and Attack (fire) are official, graded HR calls. */
export function isOfficialPlayability(status: PlayabilityStatus): boolean {
  return status === "playable" || status === "attack";
}

// ── The one display-grade vocabulary ────────────────────────────────────────
// Mirrors MLB props' `displayGrade` letter scale (server/mlb/normalizeSignal.ts
// deriveDisplayGrade) so both sports speak the same grade language. Combines
// the categorical stage with the numeric /10 score — never the stage alone —
// so two READY rows with different conviction actually grade differently.
export type HrRadarDisplayGrade = "A+" | "A" | "B+" | "B" | "B-" | "Watch";

/**
 * Derive the letter grade from the canonical stage + the row's conviction-
 * capped /10 display score. Pure lookup, no I/O. Resolved rows carry no grade
 * — the call is already decided, there is nothing left to grade.
 *
 * Thresholds are calibrated against `fallbackScoreForStage()`
 * (server/mlb/hrRadarUserStage.ts: track=2.5, build=5.5, ready=7.5, fire=9.0)
 * so the boundary floors line up with each stage's typical score, and a
 * higher score within a stage always earns a grade at least as good as a
 * lower one in the same stage.
 */
export function deriveHrRadarDisplayGrade(
  stage: CanonicalHrRadarStage,
  score10: number | null,
): HrRadarDisplayGrade | null {
  if (stage === "resolved") return null;
  const s = score10 ?? 0;
  switch (stage) {
    case "fire":
      return s >= 9.5 ? "A+" : "A";
    case "ready":
      if (s >= 9.0) return "A";
      if (s >= 8.0) return "B+";
      return "B";
    case "build":
      return s >= 6.5 ? "B-" : "Watch";
    case "track":
    default:
      return "Watch";
  }
}

// ── The one badge taxonomy ─────────────────────────────────────────────────
// Badges are contextual tags layered ON a stage — never stages themselves.
export type HrRadarBadge =
  | "hr_max_window"
  | "near_hr_contact"
  | "pitcher_fatigue"
  | "park_boost"
  | "barrel_trend"
  | "bridge_path";

export type HrRadarBadgeTone = "fire" | "warn" | "info" | "good";

export interface HrRadarBadgeMeta {
  label: string;
  tone: HrRadarBadgeTone;
  title: string;
}

export const HR_RADAR_BADGE_META: Record<HrRadarBadge, HrRadarBadgeMeta> = {
  hr_max_window: {
    label: "HR MAX WINDOW",
    tone: "fire",
    title: "Graded actionable tier — counts toward the record",
  },
  near_hr_contact: {
    label: "NEAR HR",
    tone: "warn",
    title: "Recent contact was a near-miss home run (barrel / high-xBA / pre-HR pattern)",
  },
  pitcher_fatigue: {
    label: "PITCHER FATIGUE",
    tone: "warn",
    title: "Pitcher is fading / fatigued — HR vulnerability rising",
  },
  park_boost: {
    label: "PARK BOOST",
    tone: "good",
    title: "Ballpark / wind environment favors home runs",
  },
  barrel_trend: {
    label: "BARREL TREND",
    tone: "good",
    title: "Repeated barrel-grade contact this game",
  },
  bridge_path: {
    label: "BRIDGE",
    tone: "info",
    title: "Surfaced via a lower-floor bridge path — context, not a max-window call",
  },
};

// HrQualifyingSignalType string literals this derivation keys off. Kept loose
// (string[]) so the server's HrQualifyingSignalType union and this module never
// drift into a hard compile coupling — unknown signals are simply ignored.
const NEAR_HR_SIGNALS = new Set(["near_barrel", "high_xba_danger", "pre_hr_danger"]);
const BARREL_SIGNALS = new Set(["elite_barrel", "two_hard_hit_balls", "massive_single_contact"]);
const FATIGUE_SIGNALS = new Set(["pitcher_collapse_power"]);

const BRIDGE_PATHS = new Set(["PATH_F_BLOCKED_BRIDGE"]);

/**
 * Derive the canonical badge set from already-computed evidence. Pure &
 * additive: every input is optional and contributes a badge only when present,
 * so partial data never fabricates a badge. Resolved rows carry no badges.
 */
export function deriveHrRadarBadges(input: {
  stage: CanonicalHrRadarStage;
  qualifyingSignals?: readonly string[] | null;
  alertPath?: string | null;
  /** True when the engine flagged a HR-favorable park/wind environment. */
  parkBoost?: boolean | null;
}): HrRadarBadge[] {
  if (input.stage === "resolved") return [];
  const out: HrRadarBadge[] = [];
  const signals = new Set((input.qualifyingSignals ?? []).map((s) => String(s).toLowerCase()));
  const path = (input.alertPath ?? "").toUpperCase();

  if (isHrMaxWindowStage(input.stage)) out.push("hr_max_window");
  if (Array.from(NEAR_HR_SIGNALS).some((s) => signals.has(s))) out.push("near_hr_contact");
  if (Array.from(FATIGUE_SIGNALS).some((s) => signals.has(s))) out.push("pitcher_fatigue");
  if (input.parkBoost === true) out.push("park_boost");
  if (Array.from(BARREL_SIGNALS).some((s) => signals.has(s))) out.push("barrel_trend");
  if (path && BRIDGE_PATHS.has(path)) out.push("bridge_path");

  return out;
}
