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
