import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X, Flame, ListFilter, Eye, Zap, Trophy, CircleSlash } from "lucide-react";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { type HrRadarLadderEntry, type HrRadarLadderResponse } from "@/components/mlb/HrRadarLadder";
import {
  mapHrRadarRowToDisplayState,
  isPregameOnlyRow,
  type HrRadarDisplayState,
  type HrRadarRowInput,
} from "@/components/mlb/hrRadarDisplayState";

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

// Quick Decide reads the SAME canonical mapper the Full Ladder uses
// (hrRadarDisplayState.ts) so the two surfaces can never disagree on stage,
// section, score, or whether a "%" is a real calibrated HR probability.
function toDisplay(entry: HrRadarLadderEntry): HrRadarDisplayState {
  return mapHrRadarRowToDisplayState(entry as unknown as HrRadarRowInput);
}

function formatPA(pa: number | null | undefined): string {
  if (pa == null || pa <= 0) return "";
  return `~${pa.toFixed(1)} PA left`;
}

// The hero metric for a card. FIRE live calls may lead with a TRUE calibrated
// HR chance % (mapper-gated — a raw 0-100 readiness can never reach here); all
// other stages lead with the /10 score so nothing renders a misleading "95%".
function HeroMetric({ d, allowPct, tone }: { d: HrRadarDisplayState; allowPct: boolean; tone: string }) {
  if (allowPct && d.hrChancePct != null) {
    return (
      <span className={`text-2xl font-bold tabular-nums ${tone}`} data-testid={`text-quick-hr-chance-${d.playerId}`}>
        {d.hrChancePct}%
        <span className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground"> HR chance</span>
      </span>
    );
  }
  if (d.scoreLabel != null) {
    return (
      <span className={`text-2xl font-bold tabular-nums ${tone}`} data-testid={`text-quick-score-${d.playerId}`}>
        {d.scoreLabel}
      </span>
    );
  }
  return null;
}

// ── LIVE CALL card — FIRE only. Official, actionable, Take/Pass. ────────────
function LiveCallCard({
  entry,
  onAccept,
  onDismiss,
}: {
  entry: HrRadarLadderEntry;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const d = toDisplay(entry);
  const inning = d.inningLabel ?? "";
  const pa = formatPA(entry.remainingPAExpectation);
  const timing = [pa, inning].filter(Boolean).join(" · ");

  return (
    <div
      className="rounded-xl border border-red-500/50 bg-card p-4 space-y-3"
      data-testid={`quick-decide-card-${d.playerId}`}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full bg-red-500/20 text-red-400 tracking-widest uppercase">
          <Flame className="w-4 h-4" /> Live Call
        </span>
        <HeroMetric d={d} allowPct tone="text-red-400" />
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-base font-bold text-foreground leading-tight" data-testid={`text-quick-player-${d.playerId}`}>
          {d.playerName}
        </span>
        <span className="text-xs text-muted-foreground uppercase tracking-wide shrink-0">{d.team}</span>
        {d.recordEligible && (
          <span
            className="text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30 shrink-0"
            data-testid={`badge-quick-record-eligible-${d.playerId}`}
            title="This signal counts toward the official HR Radar record"
          >
            Counts in record
          </span>
        )}
      </div>

      {/* Drivers — verbatim server evidence (CLAUDE.md §3.5). */}
      {d.drivers.length > 0 && (
        <div className="space-y-1" data-testid={`quick-drivers-${d.playerId}`}>
          {d.drivers.slice(0, 4).map((r, i) => (
            <p key={i} className="text-sm text-foreground/85 leading-snug" data-testid={`text-quick-driver-${d.playerId}-${i}`}>
              • {r}
            </p>
          ))}
        </div>
      )}

      {timing && <p className="text-xs text-muted-foreground/70">{timing}</p>}

      <div className="grid grid-cols-2 gap-2 pt-0.5">
        <button
          data-testid={`button-quick-take-${d.playerId}`}
          onClick={onAccept}
          className="flex items-center justify-center gap-1.5 py-3 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-sm font-semibold hover:bg-emerald-500/30 active:scale-[0.97] transition-all"
        >
          <Check className="w-4 h-4" /> Take It
        </button>
        <button
          data-testid={`button-quick-pass-${d.playerId}`}
          onClick={onDismiss}
          className="flex items-center justify-center gap-1.5 py-3 rounded-lg bg-muted/40 border border-border text-muted-foreground text-sm font-semibold hover:text-foreground hover:bg-muted/60 active:scale-[0.97] transition-all"
        >
          <X className="w-4 h-4" /> Pass
        </button>
      </div>
    </div>
  );
}

// ── Compact read-only row — Ready / Watching. Never an official call, never a
// "%": leads with the /10 score and the stage's action-strength label. ──────
function SetupRow({ entry, tone }: { entry: HrRadarLadderEntry; tone: string }) {
  const d = toDisplay(entry);
  const inning = d.inningLabel ?? "";
  const pa = formatPA(entry.remainingPAExpectation);
  const timing = [pa, inning].filter(Boolean).join(" · ");
  const driver = d.drivers[0] ?? null;
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-border/40 bg-card/60 px-3 py-2.5"
      data-testid={`watchlist-row-${d.playerId}`}
    >
      <Eye className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground truncate" data-testid={`text-watch-player-${d.playerId}`}>
            {d.playerName}
          </span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide shrink-0">{d.team}</span>
        </div>
        {driver && (
          <p className="text-xs text-muted-foreground leading-snug truncate" data-testid={`text-watch-reason-${d.playerId}`}>
            {driver}
          </p>
        )}
        {timing && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{timing}</p>}
      </div>
      {d.scoreLabel != null && (
        <span className={`text-sm font-bold tabular-nums shrink-0 ${tone}`} data-testid={`text-watch-metric-${d.playerId}`}>
          {d.scoreLabel}
        </span>
      )}
    </div>
  );
}

// ── RESULTS row — resolved official FIRE calls only (Cashed / Missed). ──────
function ResultRow({ entry, kind }: { entry: HrRadarLadderEntry; kind: "cashed" | "missed" }) {
  const cashed = kind === "cashed";
  const Icon = cashed ? Trophy : CircleSlash;
  const fmt = (inning: number | null, half: string | null): string => {
    if (inning == null) return "";
    const prefix = (half ?? "").toLowerCase().startsWith("b") ? "B" : "T";
    return `${prefix}${inning}`;
  };
  const detected = fmt(entry.detectedInning, entry.detectedHalf);
  const hit = fmt(entry.hitInning, entry.hitHalf);
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

// Official miss outcomes (FIRE-only record). Non-official resolutions
// (uncalled_hr / late_signal / expired / early-window) are NOT shown here.
function isOfficialMiss(entry: HrRadarLadderEntry): boolean {
  const o = String(entry.outcome ?? entry.outcomeStatus ?? "").toLowerCase();
  return o === "called_miss" || o === "miss" || o === "missed";
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

  const [dismissed, setDismissed] = useState<Set<string>>(() => readSet(dismissKey(sessionDate)));
  const [accepted, setAccepted] = useState<Set<string>>(() => readSet(acceptKey(sessionDate)));
  const [prevDate, setPrevDate] = useState(sessionDate);

  // Re-sync when the session date rolls over (day boundary).
  if (sessionDate !== prevDate && sessionDate !== "") {
    setPrevDate(sessionDate);
    setDismissed(readSet(dismissKey(sessionDate)));
    setAccepted(readSet(acceptKey(sessionDate)));
  }

  // ── Canonical user-facing sections, derived row-by-row via the shared mapper
  // (same source the Full Ladder uses). We flatten all server buckets and let
  // the mapper assign each row a section so Quick Decide and Full Ladder agree.
  //   LIVE CALLS = section "fire"            (official, actionable)
  //   READY NOW  = section "ready"           (high-conviction, not official)
  //   WATCHING   = section "watching"/"developing" (build + track)
  //   RESULTS    = resolved official FIRE calls only (cashed / official miss)
  const s = data?.sections;
  const liveRows: HrRadarLadderEntry[] = [
    ...(s?.attackNow ?? []),
    ...(s?.ready ?? []),
    ...(s?.building ?? []),
    ...(s?.watch ?? []),
  ];

  const fire: HrRadarLadderEntry[] = [];
  const readyNow: HrRadarLadderEntry[] = [];
  const watching: HrRadarLadderEntry[] = [];
  for (const e of liveRows) {
    const d = toDisplay(e);
    if (d.isAdminOnly) continue; // noAbYet / modelReview never shown to users here
    if (isPregameOnlyRow(e as unknown as HrRadarRowInput)) continue; // hide until live AB
    if (d.section === "fire") fire.push(e);
    else if (d.section === "ready") readyNow.push(e);
    else if (d.section === "watching" || d.section === "developing") watching.push(e);
  }

  const sortByScore = (a: HrRadarLadderEntry, b: HrRadarLadderEntry) =>
    (toDisplay(b).displayScore10 ?? -1) - (toDisplay(a).displayScore10 ?? -1);

  // LIVE CALLS — FIRE rows still awaiting the user's decision.
  const liveCalls = fire.filter((e) => {
    const k = entryKey(e.playerId, e.gameId);
    return !dismissed.has(k) && !accepted.has(k);
  });

  // READY NOW — top 5-10 by /10 score (high-conviction setups, not official).
  const readySorted = [...readyNow].sort(sortByScore).slice(0, 10);

  // WATCHING — developing setups; only meaningful rows (≥1 driver or a score).
  const watchingMeaningful = [...watching]
    .filter((e) => {
      const d = toDisplay(e);
      return d.drivers.length > 0 || (d.displayScore10 ?? 0) > 0;
    })
    .sort(sortByScore);

  // RESULTS — official FIRE outcomes only.
  const cashed = s?.cashed ?? [];
  const resultsMissed = (s?.dead ?? []).filter(isOfficialMiss);
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
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Quick Decide</span>
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

      {/* ── LIVE CALLS — FIRE only. Always shown (slim empty state). ── */}
      <section className="space-y-2" data-testid="section-live-calls">
        <SectionHeader icon={Flame} title="Live Calls" tone="text-red-400" />
        {liveCalls.length > 0 ? (
          liveCalls.map((entry) => (
            <LiveCallCard
              key={`${entry.playerId}|${entry.gameId}`}
              entry={entry}
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

      {/* ── READY NOW — userStage=ready. High conviction, not official yet. ── */}
      {readySorted.length > 0 && (
        <section className="space-y-2" data-testid="section-ready-now">
          <SectionHeader icon={Zap} title="Ready Now" subtitle="High-conviction setup — not official call yet" tone="text-orange-400" />
          {readySorted.map((entry) => (
            <SetupRow key={`${entry.playerId}|${entry.gameId}`} entry={entry} tone="text-orange-300" />
          ))}
        </section>
      )}

      {/* ── WATCHING — build + track. Hidden when empty. ── */}
      {watchingMeaningful.length > 0 && (
        <section className="space-y-2" data-testid="section-watching">
          <SectionHeader icon={Eye} title="Watching" subtitle="Developing setup" tone="text-amber-400" />
          {watchingMeaningful.map((entry) => (
            <SetupRow key={`${entry.playerId}|${entry.gameId}`} entry={entry} tone="text-muted-foreground" />
          ))}
        </section>
      )}

      {/* ── RECENTLY RESOLVED — resolved official FIRE calls. Hidden when empty. ── */}
      {hasResults && (
        <section className="space-y-2" data-testid="section-results">
          <SectionHeader icon={Trophy} title="Recently Resolved" tone="text-emerald-400" />
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
