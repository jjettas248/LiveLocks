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
