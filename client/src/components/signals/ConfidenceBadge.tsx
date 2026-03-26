export type ConfidenceTier = "ELITE" | "STRONG" | "VALUE" | "NO_EDGE";

const TIER_STYLES: Record<ConfidenceTier, string> = {
  ELITE: "bg-green-500/15 text-green-400 border-green-500/30",
  STRONG: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  VALUE: "bg-teal-500/15 text-teal-400 border-teal-500/30",
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
