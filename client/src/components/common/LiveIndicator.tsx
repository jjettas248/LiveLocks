import { cn } from "@/lib/utils";

/**
 * Pulsing "live" status dot.
 *
 * Replaces the `<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />`
 * pattern that was copy-pasted ~15 times across dashboard/mlb-live/ncaab and the
 * feed components. Keep all live-dot styling here so a tweak lands once.
 */
export type LiveIndicatorColor = "green" | "red" | "orange" | "amber" | "blue";

const COLOR_CLASS: Record<LiveIndicatorColor, string> = {
  green: "bg-green-500",
  red: "bg-red-500",
  orange: "bg-orange-400",
  amber: "bg-amber-400",
  blue: "bg-blue-500",
};

export function LiveIndicator({
  color = "green",
  className,
  "data-testid": testId,
}: {
  color?: LiveIndicatorColor;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={cn("inline-block w-1.5 h-1.5 rounded-full animate-pulse", COLOR_CLASS[color], className)}
    />
  );
}
