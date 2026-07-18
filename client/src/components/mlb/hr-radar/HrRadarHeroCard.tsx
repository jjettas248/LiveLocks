// HR Radar — the single most important play right now (Quick Decide's
// primary card). PRESENTATION ONLY — every field comes from the canonical
// view model (engine truth). Quick Decide never shows a raw score,
// percentage, or progress meter (that's Full Ladder's job) — only stage,
// action, reason, next PA, and (for Ready) what's needed to promote.

import type { HrRadarCardViewModel } from "@/lib/mlb/hrRadarViewModel";
import { hrTierTheme, TierRail, badgeToneClasses } from "@/components/mlb/hrRadarVisuals";
import { getHrRadarCtaLabel } from "@/components/mlb/hrRadarConsumerCopy";

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
  const nextPa = vm.inningLabel ? `Next PA: ${vm.inningLabel}` : vm.nextPaLabel ?? null;
  const primaryLabel = isFire ? getHrRadarCtaLabel("fire", "hero") : getHrRadarCtaLabel("ready", "hero");

  return (
    <div
      className={`relative flex gap-3 rounded-2xl border ${t.border} ${t.cardTint} bg-card p-4 sm:p-5 ${isFire ? "hr-fire-pulse" : ""}`}
      data-testid="hr-hero-card"
      data-stage={vm.stage}
    >
      <TierRail tier={vm.stage} />
      <div className="min-w-0 flex-1 space-y-3">
        {/* Eyebrow — the entire decision in three words. */}
        <div className="flex items-center gap-1.5">
          <span className={`text-[11px] font-black uppercase tracking-[0.2em] ${t.text}`} data-testid="text-hero-eyebrow">
            {isFire ? "🔥 TAKE NOW" : "👁 WATCH NEXT AB"}
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

        {/* Player + next PA. No score, no percentage — see file header. */}
        <div>
          <div className="text-xl sm:text-2xl font-bold text-foreground leading-tight truncate" data-testid="text-hero-player">
            {vm.playerName}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{vm.team}</span>
            {nextPa && <span className="text-muted-foreground">· {nextPa}</span>}
          </div>
        </div>

        {/* Fire: this IS an official call. Ready: explicitly not a bet yet. */}
        {isFire ? (
          <p className="text-sm font-semibold text-foreground/90" data-testid="text-hero-official">
            Official HR call
          </p>
        ) : (
          <p className="text-sm font-semibold text-muted-foreground" data-testid="text-hero-no-bet-yet">
            No bet yet
          </p>
        )}

        {/* Why now / why watching. */}
        {vm.headline && (
          <p className="text-sm text-foreground/90 leading-snug" data-testid="text-hero-why">
            <span className="text-muted-foreground">{isFire ? "Why now: " : "Why watching: "}</span>
            {vm.headline}
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

        {/* Ready only: what the engine is waiting on to become a call. */}
        {!isFire && vm.promotionRequirement && (
          <p className="text-xs text-muted-foreground leading-snug" data-testid="text-hero-promotion-requirement">
            <span className="text-foreground/70 font-medium">Needs to become a call: </span>
            {vm.promotionRequirement}
          </p>
        )}

        {/* Fire without a valid slip payload: still an official call, but the
            app can't safely build the bet-slip entry. Say so instead of
            silently disabling the button. */}
        {isFire && !vm.canAddToSlip && (
          <p className="text-xs text-amber-400" data-testid="text-hero-slip-unavailable">
            Bet-slip data is temporarily unavailable.
          </p>
        )}

        {/* Actions — stage-matched primary CTA. */}
        <div className="grid grid-cols-2 gap-2 pt-0.5">
          <button
            data-testid="button-hero-primary"
            onClick={onPrimary}
            disabled={isFire && !vm.canAddToSlip}
            className={`flex items-center justify-center gap-1.5 py-3 rounded-xl text-sm font-bold active:scale-[0.97] transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
              isFire
                ? "bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30"
                : `bg-background/40 border ${t.border} ${t.text} hover:bg-background/70`
            }`}
          >
            {primaryLabel}
          </button>
          <button
            data-testid="button-hero-pass"
            onClick={onPass}
            className="flex items-center justify-center gap-1.5 py-3 rounded-xl bg-muted/30 border border-border text-muted-foreground text-sm font-semibold hover:text-foreground hover:bg-muted/50 active:scale-[0.97] transition-all"
          >
            Pass
          </button>
        </div>
      </div>
    </div>
  );
}
