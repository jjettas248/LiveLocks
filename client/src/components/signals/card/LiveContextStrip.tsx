import { type LiveContextItem } from "./types";
import { cn } from "@/lib/utils";

export interface LiveContextStripProps {
  items: LiveContextItem[];
  /** "~2 PA left" / "T6 · 1 out" — time-to-decision, shown right-aligned. */
  timingLabel?: string | null;
}

const TONE_CLASS: Record<NonNullable<LiveContextItem["tone"]>, string> = {
  default: "text-foreground",
  good: "text-green-400",
  bad: "text-red-400",
};

/**
 * The live moment — recent contact, today's line, pitcher state. Renders
 * nothing when there's nothing real to show (no fabricated "no data" filler).
 */
export function LiveContextStrip({ items, timingLabel }: LiveContextStripProps) {
  if (items.length === 0 && !timingLabel) return null;

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 px-2.5 rounded-lg bg-secondary/40 border border-border/30">
      <div className="flex items-center gap-3 flex-wrap text-micro min-w-0" data-testid="strip-live-context">
        {items.map((item, i) => (
          <span key={`${item.label}-${i}`} className="whitespace-nowrap">
            <span className="text-muted-foreground">{item.label} </span>
            <span className={cn("font-semibold", TONE_CLASS[item.tone ?? "default"])}>{item.value}</span>
          </span>
        ))}
      </div>
      {timingLabel && (
        <span className="text-micro font-semibold text-foreground/70 shrink-0 whitespace-nowrap" data-testid="text-live-timing">
          {timingLabel}
        </span>
      )}
    </div>
  );
}
