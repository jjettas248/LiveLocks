// HR Radar — "Hot Seat" hero card. The single most important play right now.
// One big number, one why, one "what's needed next", one action. PRESENTATION
// ONLY — every field comes from the canonical view model (engine truth).

import { useEffect, useRef, useState } from "react";
import { Check, X, Flame } from "lucide-react";
import type { HrRadarCardViewModel } from "@/lib/mlb/hrRadarViewModel";
import { HR_PUBLIC_STAGE_LABEL } from "@/lib/mlb/hrRadarViewModel";
import { hrTierTheme, HeatMeter, TierRail, momentumGlyph, badgeToneClasses } from "@/components/mlb/hrRadarVisuals";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Count-up to the score on first mount (and on score change). Settles in ~0.5s.
// Reduced-motion users jump straight to the value.
function useCountUp(target: number, deps: unknown[]): number {
  const [val, setVal] = useState(target);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (prefersReducedMotion()) { setVal(target); return; }
    const from = 0;
    const dur = 480;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start == null) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(from + (target - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return val;
}

export function HrRadarHeroCard({
  vm,
  onPrimary,
  onPass,
}: {
  vm: HrRadarCardViewModel;
  onPrimary: () => void;
  onPass: () => void;
}) {
  const t = hrTierTheme(vm.stage);
  const isFire = vm.stage === "fire";
  const score = useCountUp(vm.score10, [vm.id, vm.score10]);
  const mom = momentumGlyph(vm.entry.momentumLabel);

  const nextPa = vm.inningLabel ? `Next PA: ${vm.inningLabel}` : vm.nextPaLabel ?? null;

  return (
    <div
      className={`relative flex gap-3 rounded-2xl border ${t.border} ${t.cardTint} bg-card p-4 sm:p-5 ${isFire ? "hr-fire-pulse" : ""}`}
      data-testid="hr-hero-card"
      data-stage={vm.stage}
    >
      <TierRail tier={vm.stage} />
      <div className="min-w-0 flex-1 space-y-3">
        {/* Eyebrow */}
        <div className="flex items-center gap-1.5">
          <Flame className={`w-4 h-4 ${isFire ? "text-red-400" : t.text}`} />
          <span className={`text-[11px] font-black uppercase tracking-[0.2em] ${t.text}`}>
            {isFire ? "Live Call" : "Hot Seat"}
          </span>
          {vm.recordEligible && (
            <span
              className="ml-1 text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30"
              title="Counts toward the official HR Radar record"
            >
              Counts in record
            </span>
          )}
        </div>

        {/* Player + headline number */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xl sm:text-2xl font-bold text-foreground leading-tight truncate" data-testid="text-hero-player">
              {vm.playerName}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs">
              <span className={`font-black uppercase tracking-wide ${t.text}`}>
                {HR_PUBLIC_STAGE_LABEL[vm.stage]}
              </span>
              {nextPa && <span className="text-muted-foreground">· {nextPa}</span>}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="flex items-baseline gap-1 justify-end">
              <span
                className={`hr-score-settle text-4xl sm:text-5xl font-black tabular-nums leading-none ${t.text}`}
                data-testid="text-hero-score"
              >
                {score.toFixed(1)}
              </span>
              {mom && (
                <span className={`text-lg font-bold ${mom.color}`} title={mom.label}>{mom.glyph}</span>
              )}
            </div>
            <div className="text-[9px] uppercase tracking-widest text-muted-foreground mt-1">/ 10 strength</div>
            {/* Calibrated HR chance — the closest thing HR Radar has to "the
                edge": only populated on official FIRE calls (gated upstream),
                pure renderer of vm.hrChancePct. */}
            {vm.hrChancePct != null && (
              <div className={`text-xs font-bold tabular-nums mt-0.5 ${t.text}`} data-testid="text-hero-hr-chance">
                {Math.round(vm.hrChancePct)}% HR chance
              </div>
            )}
          </div>
        </div>

        {/* Why now */}
        {vm.headline && (
          <p className="text-sm text-foreground/90 leading-snug" data-testid="text-hero-why">
            <span className="text-muted-foreground">Why now: </span>{vm.headline}
          </p>
        )}

        {/* Trigger chips — each carries its own tone (fire/warn/info/good) so
            two different badge types never look identical just because they
            share a stage. */}
        {vm.driverChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="hero-chips">
            {vm.driverChips.map((c, i) => (
              <span
                key={c.label}
                className={`text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${badgeToneClasses(c.tone)}`}
                data-testid={`chip-hero-${i}`}
              >
                {c.label}
              </span>
            ))}
          </div>
        )}

        {/* Distance to Fire */}
        {!isFire && (
          <div>
            <HeatMeter
              score10={vm.score10}
              tier={vm.stage}
              label="Distance to Fire"
              valueDisplay="percent"
              testId="hero-distance-to-fire"
              valueTestId="text-hero-distance"
            />
            {vm.nextEventLabel && (
              <p className="mt-1.5 text-xs text-muted-foreground leading-snug" data-testid="text-hero-needs">
                <span className="text-foreground/70 font-medium">Needs: </span>{vm.nextEventLabel}
              </p>
            )}
          </div>
        )}

        {/* Actions — stage-matched primary CTA. */}
        <div className="grid grid-cols-2 gap-2 pt-0.5">
          <button
            data-testid="button-hero-primary"
            onClick={onPrimary}
            className={`flex items-center justify-center gap-1.5 py-3 rounded-xl text-sm font-bold active:scale-[0.97] transition-all ${
              isFire
                ? "bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30"
                : `bg-background/40 border ${t.border} ${t.text} hover:bg-background/70`
            }`}
          >
            <Check className="w-4 h-4" /> {vm.primaryCtaLabel}
          </button>
          <button
            data-testid="button-hero-pass"
            onClick={onPass}
            className="flex items-center justify-center gap-1.5 py-3 rounded-xl bg-muted/30 border border-border text-muted-foreground text-sm font-semibold hover:text-foreground hover:bg-muted/50 active:scale-[0.97] transition-all"
          >
            <X className="w-4 h-4" /> Pass
          </button>
        </div>
      </div>
    </div>
  );
}
