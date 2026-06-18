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

// Inline-style values for components that still build style objects. Each
// references the CSS var so theme changes propagate automatically.
export function tierColors(tier: string | null | undefined): {
  color: string;
  background: string;
  border: string;
} {
  const t = normalizeTier(tier);
  return {
    color: `hsl(var(--tier-${t}))`,
    background: `hsl(var(--tier-${t}) / 0.13)`,
    border: `hsl(var(--tier-${t}) / 0.45)`,
  };
}

// Per-sport text-accent class. One map, imported everywhere a sport is tagged.
const SPORT_ACCENT_TEXT: Record<Sport, string> = {
  mlb: "text-sport-mlb",
  nba: "text-sport-nba",
  ncaab: "text-sport-ncaab",
};

export function sportAccentText(sport: string | null | undefined): string {
  const s = (sport ?? "").toLowerCase() as Sport;
  return SPORT_ACCENT_TEXT[s] ?? "text-muted-foreground";
}
