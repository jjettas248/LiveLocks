// HR Radar — shared visual language ("temperature ramp"). PRESENTATION-ONLY.
//
// Quick Decide (HrQuickDecide.tsx) and the Full Ladder (HrRadarLadder.tsx) used
// to each invent their own colors, badges, and bars — six competing accents
// that flattened the hierarchy so nothing popped. This module is the single
// source of the visual language both surfaces read, so the two can never drift
// and the eye can instantly rank a play by heat:
//
//   WATCHLIST (cool) → LEAN → PLAYABLE → ATTACK (hot) · CASHED (win) · MISSED (muted)
//
// Only Playable and Attack are official, graded HR calls — Watchlist/Lean are
// radar coverage, not official picks.
//
// It contains NO data logic. It never reads engine fields, never recomputes a
// score/probability/tier — callers pass already-derived, server-stamped values
// (via hrRadarDisplayState.ts / hrRadarScore.ts) and this module only styles
// them. All motion here is neutralized by the global prefers-reduced-motion
// reset in index.css.

import { Flame, Zap, TrendingUp, Eye, Trophy, CircleSlash, type LucideIcon } from "lucide-react";
import type { HrRadarBadgeTone } from "@shared/hrRadarStage";

// ── Canonical heat tier — the one scale both surfaces collapse onto. ─────────
export type HrHeatTier = "fire" | "ready" | "build" | "track" | "cashed" | "missed";

export interface HrTierTheme {
  tier: HrHeatTier;
  label: string;
  icon: LucideIcon;
  /** Hero / accent text color. */
  text: string;
  /** Left tier-rail fill. */
  rail: string;
  /** Contextual chip (bg + text + border in one). */
  chip: string;
  /** Soft card tint used behind a row/card of this tier. */
  cardTint: string;
  /** Border accent for a card of this tier. */
  border: string;
  /** Bar / meter fill hex (also used for the glowing tip spark). */
  hex: string;
  /** True for the hottest tiers — callers add glow + spark motion. */
  hot: boolean;
}

const THEME: Record<HrHeatTier, HrTierTheme> = {
  fire: {
    tier: "fire",
    label: "Attack",
    icon: Flame,
    text: "text-red-400",
    rail: "bg-red-500",
    chip: "bg-red-500/15 text-red-300 border-red-500/30",
    cardTint: "bg-red-500/[0.06]",
    border: "border-red-500/50",
    hex: "#ef4444",
    hot: true,
  },
  ready: {
    tier: "ready",
    label: "Playable",
    icon: Zap,
    text: "text-orange-400",
    rail: "bg-orange-500",
    chip: "bg-orange-500/15 text-orange-300 border-orange-500/30",
    cardTint: "bg-orange-500/[0.05]",
    border: "border-orange-500/40",
    hex: "#f97316",
    hot: true,
  },
  build: {
    // "Signal is heating up" — electric blue ownership (spec).
    tier: "build",
    label: "Lean",
    icon: TrendingUp,
    text: "text-blue-400",
    rail: "bg-blue-500",
    chip: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    cardTint: "bg-blue-500/[0.04]",
    border: "border-blue-500/30",
    hex: "#3b82f6",
    hot: false,
  },
  track: {
    // "Something is forming" — neutral blue-gray, recedes (spec).
    tier: "track",
    label: "Watchlist",
    icon: Eye,
    text: "text-slate-400",
    rail: "bg-slate-500",
    chip: "bg-slate-500/15 text-slate-300 border-slate-500/30",
    cardTint: "bg-slate-500/[0.03]",
    border: "border-slate-500/25",
    hex: "#64748b",
    hot: false,
  },
  cashed: {
    tier: "cashed",
    label: "Cashed",
    icon: Trophy,
    text: "text-emerald-400",
    rail: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    cardTint: "bg-emerald-500/[0.06]",
    border: "border-emerald-500/40",
    hex: "#10b981",
    hot: false,
  },
  missed: {
    tier: "missed",
    label: "Missed",
    icon: CircleSlash,
    text: "text-zinc-400",
    rail: "bg-zinc-600",
    chip: "bg-zinc-600/20 text-zinc-300 border-zinc-600/30",
    cardTint: "bg-zinc-500/[0.03]",
    border: "border-zinc-600/30",
    hex: "#71717a",
    hot: false,
  },
};

export function hrTierTheme(tier: HrHeatTier): HrTierTheme {
  return THEME[tier];
}

// ── Badge tone → chip classes. A driver chip's meaning (fire/warn/info/good,
// from HR_RADAR_BADGE_META) is a DIFFERENT axis than the row's stage — e.g.
// "PARK BOOST" (good) and "NEAR HR" (warn) should never render identically
// just because they both appear on a READY row. Single source so every
// chip renderer (Full Ladder, Hero Card, Decision Queue) agrees.
const BADGE_TONE_CLASS: Record<HrRadarBadgeTone, string> = {
  fire: "bg-red-500/15 text-red-400 border-red-500/30",
  warn: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  info: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

export function badgeToneClasses(tone: HrRadarBadgeTone): string {
  return BADGE_TONE_CLASS[tone];
}

// ── Map each surface's section vocabulary onto the shared heat tier. ─────────
// Quick Decide uses hrRadarDisplayState's HrRadarUserSection; the Full Ladder
// uses its own SectionKey. Both funnel through here so the ramp is identical.

export function tierFromUserSection(section: string): HrHeatTier {
  switch (section) {
    case "fire": return "fire";
    case "ready": return "ready";
    case "watching": return "build";
    case "developing": return "track";
    case "resolved": return "cashed"; // caller refines cashed vs missed by outcome
    default: return "track";
  }
}

// The analyze modal's alert row carries the server-stamped `playabilityStatus`
// (watchlist/lean/playable/attack/resolved) rather than a ladder SectionKey or
// HrRadarUserSection — same underlying vocabulary, different field name. This
// keeps the modal's color on the same shared ramp as the ladder/Quick Decide
// instead of a separately-derived score→tier lookup.
export function tierFromPlayabilityStatus(status: string | null | undefined, isHit: boolean): HrHeatTier {
  switch (status) {
    case "attack": return "fire";
    case "playable": return "ready";
    case "lean": return "build";
    case "watchlist": return "track";
    case "resolved": return isHit ? "cashed" : "missed";
    default: return "track";
  }
}

export function tierFromLadderSection(sectionKey: string): HrHeatTier {
  switch (sectionKey) {
    case "attackNow": return "fire";
    case "ready": return "ready";
    case "building": return "build";
    case "watch": return "track";
    case "noAbYet": return "track";
    case "cashed": return "cashed";
    case "dead": return "missed";
    case "modelReview": return "missed";
    default: return "track";
  }
}

// ── TierRail — thin colored accent down the leading edge of a card/row. ──────
// Replaces the big competing stage icons; a single calm cue for "how hot".
export function TierRail({ tier, className = "" }: { tier: HrHeatTier; className?: string }) {
  const t = THEME[tier];
  return (
    <span
      aria-hidden="true"
      className={`w-1 self-stretch rounded-full ${t.rail} ${t.hot ? "shadow-[0_0_8px_-1px] " + t.text : ""} ${className}`}
      style={t.hot ? { boxShadow: `0 0 8px -1px ${t.hex}` } : undefined}
      data-testid={`tier-rail-${tier}`}
    />
  );
}

// ── HeatMeter — the anticipation bar. A 0-10 strength fill with a glowing
// "spark" at the tip on hot tiers so a near-full meter creates almost-there
// pull. Pure formatting of an already-derived /10 value (no recompute).
export function HeatMeter({
  score10,
  tier,
  label = "Window strength",
  testId,
  valueTestId,
  compact = false,
  valueDisplay = "score10",
}: {
  score10: number | null;
  tier: HrHeatTier;
  label?: string;
  testId?: string;
  valueTestId?: string;
  compact?: boolean;
  /** "score10" → "7.8/10"; "percent" → "78%" (Distance-to-Fire framing). */
  valueDisplay?: "score10" | "percent";
}) {
  const t = THEME[tier];
  const v = score10 == null ? 0 : Math.max(0, Math.min(10, score10));
  const pct = (v / 10) * 100;
  const valueText = valueDisplay === "percent" ? `${Math.round(pct)}%` : `${v.toFixed(1)}/10`;
  return (
    <div className={compact ? "" : "mt-2"} data-testid={testId}>
      {!compact && (
        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
          <span>{label}</span>
          {score10 != null && (
            <span className={`font-semibold tabular-nums ${t.text}`} data-testid={valueTestId}>
              {valueText}
            </span>
          )}
        </div>
      )}
      <div className={`relative ${compact ? "h-1" : "h-1.5"} rounded-full bg-muted/60 overflow-visible`}>
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${t.hex}99, ${t.hex})`,
          }}
        />
        {/* Glowing tip spark — only on hot tiers, only when the meter has real
            fill, so a near-full READY/FIRE meter pulls the eye. */}
        {t.hot && pct > 6 && (
          <span
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full hr-heat-spark"
            style={{ left: `${pct}%`, background: t.hex, boxShadow: `0 0 8px 2px ${t.hex}` }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}

// ── CashCelebration — one-pass "win" sheen wrapper for resolved cashed rows.
// Rewards the dopamine loop without being noisy (single diagonal shine, then
// settles into a calm emerald-tinted card). Reduced-motion users get the tint
// only.
export function CashCelebration({
  children,
  className = "",
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={`relative overflow-hidden hr-cash-sheen ${className}`} data-testid={testId}>
      {children}
    </div>
  );
}

// ── MomentumArrow — compact heating/cooling glyph next to a hero number. ─────
export function momentumGlyph(
  momentum: string | null | undefined,
): { glyph: string; color: string; label: string } | null {
  switch (momentum) {
    case "heating_up": return { glyph: "↑", color: "text-emerald-400", label: "Heating up" };
    case "cooling_off": return { glyph: "↓", color: "text-orange-400", label: "Cooling off" };
    case "holding_strong": return { glyph: "→", color: "text-amber-400", label: "Holding strong" };
    default: return null;
  }
}
