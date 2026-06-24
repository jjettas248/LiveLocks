import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X, Zap, Flame, ListFilter, Eye, Trophy, CircleSlash } from "lucide-react";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { type HrRadarLadderEntry, type HrRadarLadderResponse } from "@/components/mlb/HrRadarLadder";
import { hrEntryCurrentScore10, hrEntryHrChancePct, hrEntryActionPct, hrEntryActionScore10 } from "@/components/mlb/hrRadarScore";

// Session key format mirrors HrRadarLadder.tsx exactly so Quick Decide and
// Full Ladder share the same accept/dismiss state across view toggles.
function dismissKey(date: string) { return `hr-radar-pass:${date}`; }
function acceptKey(date: string) { return `hr-radar-accept:${date}`; }
function entryKey(playerId: string, gameId: string) { return `${playerId}|${gameId}`; }
function readSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
}
function writeSet(key: string, set: Set<string>): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch {}
}

interface HrQuickDecideProps {
  onAddToSlip?: (sig: MlbSignalData) => void;
  onSwitchToLadder?: () => void;
}

// Both actionable Quick Decide stages live in the TOP WINDOW tier; the icon
// distinguishes urgency (fire = committed now, ready = top window). The headline
// uses the true HR chance %, identical to the Full Ladder.
const STAGE_CONFIG = {
  fire: {
    label: "TOP WINDOW",
    icon: Flame,
    border: "border-red-500/50",
    badgeBg: "bg-red-500/20",
    badgeText: "text-red-400",
  },
  ready: {
    label: "TOP WINDOW",
    icon: Zap,
    border: "border-orange-500/50",
    badgeBg: "bg-orange-500/20",
    badgeText: "text-orange-400",
  },
} as const;

type ActionableStage = "fire" | "ready";

// True HR chance % (preferred), falling back to the tier-banded action score
// then the legacy /10 — all server-stamped, formatted only.
function getHrChancePct(entry: HrRadarLadderEntry): number | null {
  return hrEntryHrChancePct(entry);
}
function getFallbackScore10(entry: HrRadarLadderEntry): number | null {
  return hrEntryActionScore10(entry) ?? hrEntryCurrentScore10(entry);
}

function getReasons(entry: HrRadarLadderEntry): string[] {
  // Prefer the jargon-stripped cleanReasons; fall back to supportingReasons,
  // then a single headline/stage line. Rendered verbatim (CLAUDE.md §3.5).
  const source = entry.cleanReasons?.length
    ? entry.cleanReasons
    : (entry.supportingReasons?.length ? entry.supportingReasons : []);
  const reasons = source.length
    ? source
    : [entry.headlineReason ?? entry.stageDescription ?? ""].filter(Boolean);
  return reasons.slice(0, 2);
}

// Compact decision metrics — reuse the exact field formulas the Full Ladder's
// HR Breakdown panel uses (HrRadarLadder.tsx HR Breakdown), shown as chips so
// the quick decision has a visible, quantified basis. All server-stamped values
// (formatted only, never re-derived).
type WhyChip = { label: string; tone: "neutral" | "success" | "warning" };

function getWhyChips(entry: HrRadarLadderEntry): WhyChip[] {
  const chips: WhyChip[] = [];
  if (entry.conversionProbability != null) {
    chips.push({ label: `HR ${Math.min(100, Math.round(entry.conversionProbability * 100))}%`, tone: "success" });
  }
  if (entry.pitcherHrVulnerability != null) {
    chips.push({ label: `Vuln ${Math.min(100, Math.round(entry.pitcherHrVulnerability))}`, tone: "neutral" });
  }
  if (entry.currentReadinessScore != null) {
    chips.push({ label: `Conviction ${Math.min(100, Math.round(entry.currentReadinessScore))}`, tone: "neutral" });
  }
  switch (entry.momentumLabel) {
    case "heating_up":
      chips.push({ label: "Heating up", tone: "success" });
      break;
    case "cooling_off":
      chips.push({ label: "Cooling", tone: "warning" });
      break;
    case "holding_strong":
      chips.push({ label: "Holding", tone: "neutral" });
      break;
    // "flat" / undefined → no momentum chip
  }
  return chips;
}

const CHIP_TONE: Record<WhyChip["tone"], string> = {
  neutral: "bg-muted/50 text-muted-foreground border-border/40",
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
};

function formatPA(pa: number | null | undefined): string {
  if (pa == null || pa <= 0) return "";
  return `~${pa.toFixed(1)} PA left`;
}

function formatInning(inning: number | null | undefined, half?: string | null): string {
  if (inning == null) return "";
  const prefix = half === "bottom" ? "B" : "T";
  return `${prefix}${inning}`;
}

function QuickCard({
  entry,
  stage,
  onAccept,
  onDismiss,
}: {
  entry: HrRadarLadderEntry;
  stage: ActionableStage;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const cfg = STAGE_CONFIG[stage];
  const StageIcon = cfg.icon;
  const hrChancePct = getHrChancePct(entry);
  const fallbackScore10 = getFallbackScore10(entry);
  const actionPct = hrEntryActionPct(entry);
  const primaryReason = entry.displayPrimaryReason ?? entry.headlineReason ?? null;
  const recordEligible = entry.displayRecordEligible === true;
  const reasons = getReasons(entry);
  const whyChips = getWhyChips(entry);
  const pa = formatPA(entry.remainingPAExpectation);
  const inning = formatInning(
    entry.currentInning ?? entry.detectedInning,
    entry.detectedHalf,
  );
  const timing = [pa, inning].filter(Boolean).join(" · ");

  return (
    <div
      className={`rounded-xl border ${cfg.border} bg-card p-4 space-y-3`}
      data-testid={`quick-decide-card-${entry.playerId}`}
    >
      {/* Stage badge (big icon) + HR chance hero */}
      <div className="flex items-center justify-between">
        <span
          className={`flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full ${cfg.badgeBg} ${cfg.badgeText} tracking-widest uppercase`}
        >
          <StageIcon className="w-4 h-4" />
          {cfg.label}
        </span>
        {hrChancePct != null ? (
          <span className={`text-2xl font-bold tabular-nums ${cfg.badgeText}`} data-testid={`text-quick-hr-chance-${entry.playerId}`}>
            {hrChancePct}%
            <span className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground"> HR chance</span>
          </span>
        ) : fallbackScore10 != null ? (
          <span className={`text-2xl font-bold tabular-nums ${cfg.badgeText}`} data-testid={`text-quick-strength-${entry.playerId}`}>
            {fallbackScore10.toFixed(1)}
            <span className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground"> strength</span>
          </span>
        ) : null}
      </div>

      {/* Player + team */}
      <div className="flex items-baseline gap-2">
        <span
          className="text-base font-bold text-foreground leading-tight"
          data-testid={`text-quick-player-${entry.playerId}`}
        >
          {entry.playerName}
        </span>
        <span className="text-xs text-muted-foreground uppercase tracking-wide shrink-0">
          {entry.team}
        </span>
        {recordEligible && (
          <span
            className="text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30 shrink-0"
            data-testid={`badge-quick-record-eligible-${entry.playerId}`}
            title="This signal counts toward the official HR Radar record"
          >
            Counts in record
          </span>
        )}
      </div>

      {/* Plain-English reason */}
      {primaryReason && (
        <p className="text-sm font-medium text-foreground/90 leading-snug" data-testid={`text-quick-primary-reason-${entry.playerId}`}>
          {primaryReason}
        </p>
      )}

      {/* Window strength — tier-banded actionability bar (not HR chance). */}
      {actionPct != null && (
        <div data-testid={`quick-window-strength-${entry.playerId}`}>
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>Window strength</span>
            <span>{actionPct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full ${cfg.badgeText.replace("text-", "bg-")}`} style={{ width: `${actionPct}%` }} />
          </div>
        </div>
      )}

      {/* Why — top reasons (verbatim server evidence) */}
      {reasons.length > 0 && (
        <div className="space-y-1">
          {reasons.map((r, i) => (
            <p
              key={i}
              className="text-sm text-muted-foreground leading-snug"
              data-testid={`text-quick-reason-${entry.playerId}-${i}`}
            >
              {reasons.length > 1 ? "• " : '"'}{r}{reasons.length > 1 ? "" : '"'}
            </p>
          ))}
        </div>
      )}

      {/* Why — quantified decision metrics (server-stamped, formatted only) */}
      {whyChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={`chips-quick-why-${entry.playerId}`}>
          {whyChips.map((chip, i) => (
            <span
              key={i}
              className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border tabular-nums ${CHIP_TONE[chip.tone]}`}
            >
              {chip.label}
            </span>
          ))}
        </div>
      )}

      {/* Timing */}
      {timing && (
        <p className="text-xs text-muted-foreground/70">{timing}</p>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-2 pt-0.5">
        <button
          data-testid={`button-quick-take-${entry.playerId}`}
          onClick={onAccept}
          className="flex items-center justify-center gap-1.5 py-3 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-sm font-semibold hover:bg-emerald-500/30 active:scale-[0.97] transition-all"
        >
          <Check className="w-4 h-4" /> Take It
        </button>
        <button
          data-testid={`button-quick-pass-${entry.playerId}`}
          onClick={onDismiss}
          className="flex items-center justify-center gap-1.5 py-3 rounded-lg bg-muted/40 border border-border text-muted-foreground text-sm font-semibold hover:text-foreground hover:bg-muted/60 active:scale-[0.97] transition-all"
        >
          <X className="w-4 h-4" /> Pass
        </button>
      </div>
    </div>
  );
}

// ── WATCHLIST row — compact, read-only, explicitly "not an official call" ──
// Combines the old Track / Almost / Ready stages. Never shows Take/Pass; these
// are forming conditions to monitor, not actionable picks.
function WatchRow({ entry }: { entry: HrRadarLadderEntry }) {
  const hrChancePct = getHrChancePct(entry);
  const fallback = getFallbackScore10(entry);
  const primaryReason =
    entry.displayPrimaryReason ?? entry.headlineReason ?? entry.stageDescription ?? null;
  const inning = formatInning(entry.currentInning ?? entry.detectedInning, entry.detectedHalf);
  const pa = formatPA(entry.remainingPAExpectation);
  const timing = [pa, inning].filter(Boolean).join(" · ");
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-border/40 bg-card/60 px-3 py-2.5"
      data-testid={`watchlist-row-${entry.playerId}`}
    >
      <Eye className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground truncate" data-testid={`text-watch-player-${entry.playerId}`}>
            {entry.playerName}
          </span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide shrink-0">{entry.team}</span>
        </div>
        {primaryReason && (
          <p className="text-xs text-muted-foreground leading-snug truncate" data-testid={`text-watch-reason-${entry.playerId}`}>
            {primaryReason}
          </p>
        )}
        {timing && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{timing}</p>}
      </div>
      {(hrChancePct != null || fallback != null) && (
        <span className="text-sm font-bold tabular-nums text-muted-foreground shrink-0" data-testid={`text-watch-metric-${entry.playerId}`}>
          {hrChancePct != null ? `${hrChancePct}%` : fallback!.toFixed(1)}
        </span>
      )}
    </div>
  );
}

// Official miss outcomes (FIRE-only record). Non-official resolutions
// (uncalled_hr / late_signal / expired / early-window) are NOT shown here.
function isOfficialMiss(entry: HrRadarLadderEntry): boolean {
  const o = String(entry.outcome ?? entry.outcomeStatus ?? "").toLowerCase();
  return o === "called_miss" || o === "miss" || o === "missed";
}

// ── RESULTS row — resolved official FIRE calls only (Cashed / Missed) ──────
function ResultRow({ entry, kind }: { entry: HrRadarLadderEntry; kind: "cashed" | "missed" }) {
  const cashed = kind === "cashed";
  const Icon = cashed ? Trophy : CircleSlash;
  const detected = formatInning(entry.detectedInning, entry.detectedHalf);
  const hit = formatInning(entry.hitInning, entry.hitHalf);
  const arc = cashed && detected && hit ? `Called ${detected} → Hit ${hit}` : detected ? `Called ${detected}` : "";
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${cashed ? "border-emerald-500/30 bg-emerald-500/5" : "border-zinc-600/30 bg-zinc-500/5"}`}
      data-testid={`result-row-${entry.playerId}`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${cashed ? "text-emerald-400" : "text-zinc-400"}`} />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-semibold text-foreground truncate">{entry.playerName}</span>
        {arc && <p className="text-[10px] text-muted-foreground/80 leading-snug">{arc}</p>}
      </div>
      <span
        className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${cashed ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-600/20 text-zinc-300"}`}
        data-testid={`badge-result-${kind}-${entry.playerId}`}
      >
        {cashed ? "Cashed" : "Missed"}
      </span>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle, tone }: { icon: any; title: string; subtitle?: string; tone: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <Icon className={`w-3.5 h-3.5 ${tone}`} />
      <span className={`text-xs font-bold uppercase tracking-wide ${tone}`}>{title}</span>
      {subtitle && <span className="text-[10px] text-muted-foreground normal-case font-normal">· {subtitle}</span>}
    </div>
  );
}

export function HrQuickDecide({ onAddToSlip, onSwitchToLadder }: HrQuickDecideProps) {
  const { data, isLoading } = useQuery<HrRadarLadderResponse>({
    queryKey: ["/api/mlb/hr-radar/ladder"],
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (prev) => prev,
  });

  const sessionDate = data?.sessionDate ?? "";

  const [dismissed, setDismissed] = useState<Set<string>>(
    () => readSet(dismissKey(sessionDate)),
  );
  const [accepted, setAccepted] = useState<Set<string>>(
    () => readSet(acceptKey(sessionDate)),
  );
  const [prevDate, setPrevDate] = useState(sessionDate);

  // Re-sync when the session date rolls over (day boundary).
  if (sessionDate !== prevDate && sessionDate !== "") {
    setPrevDate(sessionDate);
    setDismissed(readSet(dismissKey(sessionDate)));
    setAccepted(readSet(acceptKey(sessionDate)));
  }

  // ── Three user-facing buckets (Quick Decide simplification, 2026-06) ──────
  //  LIVE CALLS = FIRE only (old attackNow). Official, actionable, rare.
  //  WATCHLIST  = old Ready + Building + Watch combined. NOT an official call.
  //  RESULTS    = resolved official FIRE calls only (Cashed / official Missed).
  const attackNow = data?.sections?.attackNow ?? [];
  const ready = data?.sections?.ready ?? [];
  const building = data?.sections?.building ?? [];
  const watch = data?.sections?.watch ?? [];
  const cashed = data?.sections?.cashed ?? [];
  const dead = data?.sections?.dead ?? [];

  // LIVE CALLS — FIRE rows still awaiting the user's decision.
  const liveCalls = attackNow.filter((e) => {
    const k = entryKey(e.playerId, e.gameId);
    return !dismissed.has(k) && !accepted.has(k);
  });

  // WATCHLIST — Ready + Building + Watch, sorted by HR chance, then conviction,
  // then expected remaining PA. All server-stamped values; formatted only.
  const watchlist = [...ready, ...building, ...watch].sort((a, b) => {
    const hc = (getHrChancePct(b) ?? -1) - (getHrChancePct(a) ?? -1);
    if (hc !== 0) return hc;
    const conv = (b.currentReadinessScore ?? -1) - (a.currentReadinessScore ?? -1);
    if (conv !== 0) return conv;
    return (b.remainingPAExpectation ?? -1) - (a.remainingPAExpectation ?? -1);
  });

  // RESULTS — official FIRE outcomes only. cashed = called_hit (FIRE-only by
  // the server contract); missed = official called_miss. Non-official
  // resolutions (uncalled_hr / late_signal / expired / early-window) excluded.
  const resultsMissed = dead.filter(isOfficialMiss);
  const hasResults = cashed.length > 0 || resultsMissed.length > 0;

  const handleAccept = (entry: HrRadarLadderEntry) => {
    const k = entryKey(entry.playerId, entry.gameId);
    const next = new Set(accepted).add(k);
    setAccepted(next);
    writeSet(acceptKey(sessionDate), next);
    onAddToSlip?.({
      playerId: entry.playerId,
      playerName: entry.playerName,
      market: "home_runs",
      bookLine: 0.5,
      recommendedSide: "OVER",
      sportsbook: "draftkings",
      edge: null,
      enginePct: null,
      gameId: entry.gameId,
      overOdds: null,
      underOdds: null,
    } as unknown as MlbSignalData);
  };

  const handleDismiss = (entry: HrRadarLadderEntry) => {
    const k = entryKey(entry.playerId, entry.gameId);
    const next = new Set(dismissed).add(k);
    setDismissed(next);
    writeSet(dismissKey(sessionDate), next);
  };

  if (isLoading && !data) {
    return (
      <div className="flex justify-center p-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="hr-quick-decide">
      {/* Header — Full Ladder toggle always available */}
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Quick Decide
        </span>
        {onSwitchToLadder && (
          <button
            data-testid="button-view-full-ladder"
            onClick={onSwitchToLadder}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ListFilter className="w-3 h-3" /> Full Ladder
          </button>
        )}
      </div>

      {/* ── LIVE CALLS — FIRE only. Always shown (with a calm empty state). ── */}
      <section className="space-y-2" data-testid="section-live-calls">
        <SectionHeader icon={Flame} title="Live Calls" tone="text-red-400" />
        {liveCalls.length > 0 ? (
          liveCalls.map((entry) => (
            <QuickCard
              key={`${entry.playerId}|${entry.gameId}`}
              entry={entry}
              stage="fire"
              onAccept={() => handleAccept(entry)}
              onDismiss={() => handleDismiss(entry)}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground px-1 py-2" data-testid="empty-live-calls">
            No live HR calls right now.
          </p>
        )}
      </section>

      {/* ── WATCHLIST — Ready/Building/Watch. Hidden when empty. ── */}
      {watchlist.length > 0 && (
        <section className="space-y-2" data-testid="section-watchlist">
          <SectionHeader icon={Eye} title="Watchlist" subtitle="Not an official call yet" tone="text-amber-400" />
          {watchlist.map((entry) => (
            <WatchRow key={`${entry.playerId}|${entry.gameId}`} entry={entry} />
          ))}
        </section>
      )}

      {/* ── RESULTS — resolved official FIRE calls. Hidden when empty. ── */}
      {hasResults && (
        <section className="space-y-2" data-testid="section-results">
          <SectionHeader icon={Trophy} title="Results" tone="text-emerald-400" />
          {cashed.map((entry) => (
            <ResultRow key={`${entry.playerId}|${entry.gameId}`} entry={entry} kind="cashed" />
          ))}
          {resultsMissed.map((entry) => (
            <ResultRow key={`${entry.playerId}|${entry.gameId}`} entry={entry} kind="missed" />
          ))}
        </section>
      )}
    </div>
  );
}
