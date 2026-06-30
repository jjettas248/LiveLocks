import { ReactNode } from "react";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";

export interface VerdictHeaderProps {
  /** Player / team — the subject of the bet. */
  subject: string;
  /** "OVER 0.5 Home Runs" style one-liner — the bet itself. */
  betLine: string;
  /** Server grade (A+/A/B+/B/B-/Watch) or stage label (FIRE/READY/...). Required — this IS the verdict. */
  grade: string;
  /** Tailwind classes for the grade chip (bg+text+border), chosen by the caller from a token helper. */
  gradeToneClass: string;
  /** Sport badge classes, e.g. sportAccentClasses("mlb"). Omit to hide. */
  sportBadge?: { label: string; className: string } | null;
  /** Live/urgency cue, e.g. "Live Call" or "URGENT". Renders with a pulse dot when isLive. */
  urgencyLabel?: string | null;
  isLive?: boolean;
  /** "12s ago" / "T6 · 1 out" freshness or context, right-aligned. */
  freshnessLabel?: string | null;
  /** "Counts in record" / "Flagship" style secondary chip. */
  secondaryBadge?: ReactNode;
}

/**
 * Leftmost anchor of the trader-argument card: what the bet is and how good the
 * server says it is. The grade/stage chip is the single most important pixel on
 * the card — it answers "how good" before anything else loads.
 */
export function VerdictHeader({
  subject,
  betLine,
  grade,
  gradeToneClass,
  sportBadge,
  urgencyLabel,
  isLive,
  freshnessLabel,
  secondaryBadge,
}: VerdictHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          <Pill tone="custom" size="md" className={cn("font-black", gradeToneClass)} data-testid="text-verdict-grade">
            {grade}
          </Pill>
          {sportBadge && (
            <Pill tone="custom" className={sportBadge.className}>
              {sportBadge.label}
            </Pill>
          )}
          {urgencyLabel && (
            <span className="inline-flex items-center gap-1 text-micro font-bold uppercase tracking-wide text-foreground/80">
              {isLive && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />}
              {urgencyLabel}
            </span>
          )}
          {secondaryBadge}
        </div>
        <div className="text-title-premium text-foreground truncate" data-testid="text-verdict-subject">
          {subject}
        </div>
        <div className="text-body-premium text-muted-foreground truncate">{betLine}</div>
      </div>
      {freshnessLabel && (
        <span className="text-micro text-muted-foreground/70 shrink-0 whitespace-nowrap mt-0.5">
          {freshnessLabel}
        </span>
      )}
    </div>
  );
}
