// Single source of truth for signal-tier and per-sport visual styling.
//
// Before this, "elite" rendered as gold, green, purple, AND teal across
// different files, and MLB's accent was variously green/blue/emerald. Route all
// tier/sport color decisions through the helpers here so the design tokens in
// index.css (`--tier-*`, `--sport-*`) stay the only place colors are defined.
//
// Two consumption styles are supported:
//   - Tailwind classes (preferred for JSX className)
//   - inline CSS values that reference the same CSS vars (for components that
//     build `style={{}}` objects from raw hex today)

export type SignalTier = "elite" | "strong" | "value" | "watch";
export type Sport = "mlb" | "nba" | "ncaab";

function normalizeTier(tier: string | null | undefined): SignalTier {
  switch ((tier ?? "").toLowerCase()) {
    case "elite":
      return "elite";
    case "strong":
      return "strong";
    case "value":
    case "lean":
      return "value";
    default:
      return "watch";
  }
}

// Tailwind badge/pill classes per tier (bg + text + border via tokens).
const TIER_BADGE_CLASSES: Record<SignalTier, string> = {
  elite: "bg-tier-elite/15 text-tier-elite border-tier-elite/40",
  strong: "bg-tier-strong/15 text-tier-strong border-tier-strong/40",
  value: "bg-tier-value/15 text-tier-value border-tier-value/40",
  watch: "bg-tier-watch/15 text-tier-watch border-tier-watch/30",
};

export function tierBadgeClasses(tier: string | null | undefined): string {
  return TIER_BADGE_CLASSES[normalizeTier(tier)];
}

// Confidence pill text/glow per tier — used where a tier needs a stronger,
// solid-ish accent (hero numbers, confidence chips) rather than the soft badge.
const TIER_PILL_CLASSES: Record<SignalTier, string> = {
  elite: "bg-tier-elite/20 text-tier-elite border-tier-elite/50",
  strong: "bg-tier-strong/20 text-tier-strong border-tier-strong/50",
  value: "bg-tier-value/20 text-tier-value border-tier-value/50",
  watch: "bg-tier-watch/15 text-tier-watch border-tier-watch/30",
};

export function confidencePillClasses(tier: string | null | undefined): string {
  return TIER_PILL_CLASSES[normalizeTier(tier)];
}

// Per-sport accent — soft badge treatment (bg + text + border via tokens).
const SPORT_ACCENT_CLASSES: Record<Sport, string> = {
  mlb: "bg-sport-mlb/15 text-sport-mlb border-sport-mlb/40",
  nba: "bg-sport-nba/15 text-sport-nba border-sport-nba/40",
  ncaab: "bg-sport-ncaab/15 text-sport-ncaab border-sport-ncaab/40",
};

function normalizeSport(sport: string | null | undefined): Sport {
  switch ((sport ?? "").toLowerCase()) {
    case "nba":
      return "nba";
    case "ncaab":
      return "ncaab";
    default:
      return "mlb";
  }
}

export function sportAccentClasses(sport: string | null | undefined): string {
  return SPORT_ACCENT_CLASSES[normalizeSport(sport)];
}

// SurfaceCard variant → token-driven classes. Kept here (not in the component)
// so the surface treatment is part of the single styling source of truth.
export type SurfaceVariant =
  | "default"
  | "elevated"
  | "glass"
  | "gradient"
  | "danger"
  | "success";

const SURFACE_VARIANT_CLASSES: Record<SurfaceVariant, string> = {
  default: "bg-surface-1 border-surface-border shadow-surface-sm",
  elevated: "bg-surface-2 border-surface-border shadow-surface-md",
  glass: "bg-surface-2/70 border-white/10 backdrop-blur-xl shadow-surface-md",
  gradient:
    "border-surface-border shadow-surface-md bg-gradient-to-b from-surface-3 to-surface-1",
  danger: "bg-destructive/5 border-destructive/30 shadow-surface-sm",
  success: "bg-tier-strong/5 border-tier-strong/30 shadow-surface-sm",
};

export function surfaceVariantClasses(variant: SurfaceVariant): string {
  return SURFACE_VARIANT_CLASSES[variant];
}
