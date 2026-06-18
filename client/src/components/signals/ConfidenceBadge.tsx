import { tierBadgeClasses } from "@/lib/uiTokens";

export type ConfidenceTier = "ELITE" | "STRONG" | "VALUE" | "NO_EDGE";

// Tier colors come from the shared token helper (canonical: elite=gold,
// strong=green, value=teal). NO_EDGE stays neutral/muted.
const TIER_STYLES: Record<ConfidenceTier, string> = {
  ELITE: tierBadgeClasses("elite"),
  STRONG: tierBadgeClasses("strong"),
  VALUE: tierBadgeClasses("value"),
  NO_EDGE: "bg-muted/50 text-muted-foreground border-border/30",
};

export function classifyTier(probability: number): ConfidenceTier {
  if (probability >= 75) return "ELITE";
  if (probability >= 65) return "STRONG";
  if (probability >= 58) return "VALUE";
  return "NO_EDGE";
}

export function ConfidenceBadge({ tier, className }: { tier: ConfidenceTier; className?: string }) {
  return (
    <span
      data-testid={`badge-confidence-${tier.toLowerCase()}`}
      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${TIER_STYLES[tier]} ${className ?? ""}`}
    >
      {tier === "NO_EDGE" ? "NO EDGE" : tier}
    </span>
  );
}
