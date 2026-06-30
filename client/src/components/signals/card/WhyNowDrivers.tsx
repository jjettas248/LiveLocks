import { type DriverItem } from "./types";

export interface WhyNowDriversProps {
  /** Server-built one-line "why this signal" summary, shown above the list. */
  headline?: string | null;
  /** Ranked driver lines. Rendered in the order given (server already ranks). */
  drivers?: DriverItem[];
  /** Flat chip fallback for surfaces without structured drivers (e.g. HR Radar chips). */
  chips?: string[];
}

/**
 * The evidence. Renders nothing if there's no real server-built explanation —
 * never fabricates a reason. Drivers render as compact weighted bars when a
 * weight is present, otherwise as plain bullet lines.
 */
export function WhyNowDrivers({ headline, drivers, chips }: WhyNowDriversProps) {
  const hasDrivers = drivers && drivers.length > 0;
  const hasChips = chips && chips.length > 0;
  if (!headline && !hasDrivers && !hasChips) return null;

  return (
    <div className="space-y-1.5">
      {headline && (
        <p className="text-body-premium text-foreground/90 leading-snug" data-testid="text-why-now-headline">
          {headline}
        </p>
      )}
      {hasDrivers && (
        <ul className="space-y-1" data-testid="list-why-now-drivers">
          {drivers!.slice(0, 5).map((d, i) => (
            <li key={`${d.label}-${i}`} className="flex items-center gap-2">
              <span className="text-micro text-foreground/80 flex-1 min-w-0 truncate" title={d.detail ?? undefined}>
                {d.label}
              </span>
              {d.weight != null && (
                <span className="w-14 h-1 rounded-full bg-muted/50 overflow-hidden shrink-0" aria-hidden="true">
                  <span
                    className="block h-full rounded-full bg-primary/70"
                    style={{ width: `${Math.max(4, Math.min(100, d.weight))}%` }}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {hasChips && (
        <div className="flex flex-wrap gap-1.5" data-testid="list-why-now-chips">
          {chips!.slice(0, 4).map((c) => (
            <span
              key={c}
              className="text-micro font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-secondary/60 border border-border/50 text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
