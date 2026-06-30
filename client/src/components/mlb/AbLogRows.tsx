import { Target } from "lucide-react";

// Shared per-PA At-Bat Log row renderer. Used by both the inline HR Radar
// ladder card expand (HrRadarLadder.tsx) and the analyze modal (mlb-live.tsx)
// so the two surfaces stay visually identical. Pure presentation — no data
// fetching, no derivation beyond display formatting.
export interface AbRow {
  abNumber: number;
  exitVelocity: number | null;
  launchAngle: number | null;
  distance: number | null;
  outcome: string;
  isBarrel: boolean;
  isHardHit: boolean;
  perABxBA?: number | null;
  contactGrade?: string;
  hrProbability?: number;
}

// Drop placeholder/padded rows the server appends when the boxscore PA count
// exceeds tracked contact data. Those rows carry outcome "unknown" and no
// EV/LA/distance, and would render as bare "PA" lines with no detail.
function renderableAbRows(abs: AbRow[]): AbRow[] {
  return abs.filter(
    (ab) =>
      (ab.outcome && ab.outcome !== "unknown") ||
      ab.exitVelocity != null ||
      ab.launchAngle != null ||
      ab.distance != null,
  );
}

function outcomeLabelFor(outcome: string): string {
  return outcome === "hit"
    ? "Hit"
    : outcome === "strikeout"
    ? "K"
    : outcome === "walk"
    ? "BB"
    : outcome === "hbp"
    ? "HBP"
    : outcome === "out"
    ? "Out"
    : outcome === "error"
    ? "Error"
    : "PA";
}

function outcomeColorFor(outcome: string): string {
  return outcome === "hit"
    ? "text-green-400"
    : outcome === "strikeout"
    ? "text-red-400"
    : outcome === "walk" || outcome === "hbp"
    ? "text-blue-400"
    : "text-muted-foreground";
}

interface AbLogRowsProps {
  abs: AbRow[];
  /** Render the "At-Bat Log (N of M PAs)" header above the rows. */
  showHeader?: boolean;
}

export function AbLogRows({ abs, showHeader = true }: AbLogRowsProps) {
  const renderable = renderableAbRows(abs);
  if (renderable.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {showHeader && (
        <div className="text-[10px] font-semibold text-muted-foreground flex items-center gap-1.5">
          <Target className="w-3 h-3" />
          <span>
            At-Bat Log ({renderable.length} of {abs.length} PAs)
          </span>
        </div>
      )}
      <div className="space-y-1">
        {renderable.map((ab) => (
          <div
            key={ab.abNumber}
            className="flex items-center gap-2 text-[10px] p-1.5 rounded-lg bg-muted/10 border border-border/10"
            data-testid={`row-ab-${ab.abNumber}`}
          >
            <span className="w-5 text-center text-muted-foreground font-bold">#{ab.abNumber}</span>
            <span className={`font-semibold ${outcomeColorFor(ab.outcome)}`}>{outcomeLabelFor(ab.outcome)}</span>
            {ab.exitVelocity != null && (
              <span
                className={`font-bold tabular-nums ${ab.isBarrel ? "text-orange-400" : ab.isHardHit ? "text-yellow-400" : "text-muted-foreground"}`}
              >
                {ab.exitVelocity.toFixed(1)} mph
              </span>
            )}
            {ab.launchAngle != null && <span className="text-muted-foreground tabular-nums">{ab.launchAngle.toFixed(0)}°</span>}
            {ab.distance != null && <span className="text-muted-foreground tabular-nums">{ab.distance.toFixed(0)}ft</span>}
            {ab.isBarrel && <span className="text-[8px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 font-bold">BRL</span>}
            {ab.isHardHit && !ab.isBarrel && <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-bold">HH</span>}
            {ab.perABxBA != null && ab.perABxBA > 0 && (
              <span
                className={`text-[8px] px-1 py-0.5 rounded font-bold tabular-nums ${ab.perABxBA >= 0.7 ? "bg-emerald-500/15 text-emerald-400" : ab.perABxBA >= 0.4 ? "bg-sky-500/15 text-sky-400" : "text-muted-foreground bg-muted/20"}`}
                data-testid={`text-xba-ab-${ab.abNumber}`}
              >
                xBA .{(ab.perABxBA * 1000).toFixed(0).padStart(3, "0")}
              </span>
            )}
            {ab.contactGrade && ab.contactGrade !== "weak" && (
              <span
                className={`text-[8px] px-1 py-0.5 rounded font-medium ${ab.contactGrade === "barrel" ? "text-orange-400 bg-orange-500/10" : ab.contactGrade === "solid" ? "text-emerald-400 bg-emerald-500/10" : ab.contactGrade === "flare" ? "text-sky-400 bg-sky-500/10" : "text-muted-foreground bg-muted/10"}`}
              >
                {ab.contactGrade}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Build the compact collapsed-chip summary, e.g. "3 PAs · last 98.9 BRL".
// Falls back to just the PA count when no contact detail is available.
export function abChipSummary(abs: AbRow[] | null | undefined, fallbackCount?: number | null): string | null {
  const renderable = abs ? renderableAbRows(abs) : [];
  const count = renderable.length || fallbackCount || 0;
  if (count === 0) return null;
  const paLabel = `${count} PA${count === 1 ? "" : "s"}`;
  const last = renderable[renderable.length - 1];
  if (last && last.exitVelocity != null) {
    const tag = last.isBarrel ? " BRL" : last.isHardHit ? " HH" : "";
    return `${paLabel} · last ${last.exitVelocity.toFixed(1)}${tag}`;
  }
  return paLabel;
}
