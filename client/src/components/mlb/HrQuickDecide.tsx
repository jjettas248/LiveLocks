import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ListFilter, Radar } from "lucide-react";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import {
  type HrRadarLadderEntry,
  type HrRadarLadderResponse,
} from "@/components/mlb/HrRadarLadder";
import {
  mapHrRadarRowToDisplayState,
  isPregameOnlyRow,
  type HrRadarRowInput,
} from "@/components/mlb/hrRadarDisplayState";
import {
  buildHrRadarCardViewModel,
  compareByImportance,
  selectQuickDecide,
  type HrRadarCardViewModel,
} from "@/lib/mlb/hrRadarViewModel";
import { HrRadarHeroCard } from "@/components/mlb/hr-radar/HrRadarHeroCard";
import { HrRadarDecisionQueue } from "@/components/mlb/hr-radar/HrRadarDecisionQueue";
import { HrRadarRecentHitsStrip } from "@/components/mlb/hr-radar/HrRadarRecentHitsStrip";
import {
  HrRadarStageToastHost,
  detectStageMovements,
  type StageMovement,
} from "@/components/mlb/hr-radar/HrRadarStageToast";

// ── Per-session accept/dismiss, keyed by sessionDate. Shared key scheme with
// the Full Ladder so a Take/Pass in one surface is honored in the other. ──────
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

// Live (non-resolved) decision rows that survive the user-facing filters: drop
// admin-only and pregame-no-AB rows (engine truth, via the canonical mapper)
// before building the view model.
function buildLiveVMs(entries: HrRadarLadderEntry[]): HrRadarCardViewModel[] {
  const out: HrRadarCardViewModel[] = [];
  for (const e of entries) {
    const d = mapHrRadarRowToDisplayState(e as unknown as HrRadarRowInput);
    if (d.isAdminOnly) continue;
    if (isPregameOnlyRow(e as unknown as HrRadarRowInput)) continue;
    const vm = buildHrRadarCardViewModel(e);
    if (vm.isResolved) continue;
    out.push(vm);
  }
  return out.sort(compareByImportance);
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
  if (sessionDate !== prevDate && sessionDate !== "") {
    setPrevDate(sessionDate);
    setDismissed(readSet(dismissKey(sessionDate)));
    setAccepted(readSet(acceptKey(sessionDate)));
  }

  const s = data?.sections;
  const liveRaw: HrRadarLadderEntry[] = useMemo(() => [
    ...(s?.attackNow ?? []),
    ...(s?.ready ?? []),
    ...(s?.building ?? []),
    ...(s?.watch ?? []),
  ], [s]);

  // All live VMs (pre user accept/dismiss) — used for counts + movement detection.
  const allLiveVMs = useMemo(() => buildLiveVMs(liveRaw), [liveRaw]);

  // Active feed = live VMs the user hasn't already taken or passed on.
  const activeVMs = useMemo(
    () => allLiveVMs.filter((vm) => !dismissed.has(vm.id) && !accepted.has(vm.id)),
    [allLiveVMs, dismissed, accepted],
  );

  // Hero = single highest-importance live FIRE (else READY). Queue = the next
  // ≤5, TRACK hidden unless nothing higher exists. Pure selection (testable).
  const { hero, queue } = selectQuickDecide(activeVMs);

  // Cashed VMs (today) → recent-hits proof strip.
  const cashedVMs = useMemo(
    () => (s?.cashed ?? []).map((e) => buildHrRadarCardViewModel(e, { sectionHint: "cashed" })),
    [s],
  );

  // Counts for the slim status line.
  const counts = useMemo(() => {
    const c = { fire: 0, ready: 0, build: 0, track: 0 };
    for (const vm of allLiveVMs) {
      if (vm.stage === "fire") c.fire++;
      else if (vm.stage === "ready") c.ready++;
      else if (vm.stage === "build") c.build++;
      else if (vm.stage === "track") c.track++;
    }
    return c;
  }, [allLiveVMs]);
  const trackedCount = allLiveVMs.length;

  // ── Dopamine layer: stage-movement toasts + fresh-cashed celebration. ──────
  const stageSnapshotRef = useRef<Map<string, HrRadarCardViewModel["stage"]>>(new Map());
  const cashedSnapshotRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const [movements, setMovements] = useState<StageMovement[]>([]);
  const [freshCashed, setFreshCashed] = useState(0);

  useEffect(() => {
    if (!sessionDate) return;
    const nextStages = new Map(allLiveVMs.map((vm) => [vm.id, vm.stage] as const));
    const nextCashed = new Set(cashedVMs.map((vm) => vm.id));
    if (!initializedRef.current) {
      // Seed silently on first real payload — no toast/celebration on load.
      stageSnapshotRef.current = nextStages;
      cashedSnapshotRef.current = nextCashed;
      initializedRef.current = true;
      return;
    }
    const moves = detectStageMovements(
      stageSnapshotRef.current,
      allLiveVMs.map((vm) => ({ id: vm.id, playerName: vm.playerName, stage: vm.stage, reason: vm.headline })),
    );
    if (moves.length > 0) {
      setMovements((prev) => [...prev, ...moves].slice(-3));
    }
    let fresh = 0;
    for (const id of Array.from(nextCashed)) if (!cashedSnapshotRef.current.has(id)) fresh++;
    if (fresh > 0) {
      setFreshCashed(fresh);
      const t = window.setTimeout(() => setFreshCashed(0), 2400);
      stageSnapshotRef.current = nextStages;
      cashedSnapshotRef.current = nextCashed;
      return () => window.clearTimeout(t);
    }
    stageSnapshotRef.current = nextStages;
    cashedSnapshotRef.current = nextCashed;
  }, [sessionDate, allLiveVMs, cashedVMs]);

  const dismissMovement = (id: string) =>
    setMovements((prev) => prev.filter((m) => m.id !== id));

  // ── Actions. Only FIRE (official live call) adds a bet to the slip; every
  // softer stage CTA ("Watch Next AB", etc.) just clears the play from the feed
  // so we never imply an official call where there isn't one. ─────────────────
  const handlePrimary = (vm: HrRadarCardViewModel) => {
    const k = vm.id;
    const next = new Set(accepted).add(k);
    setAccepted(next);
    writeSet(acceptKey(sessionDate), next);
    if (vm.stage === "fire") {
      onAddToSlip?.({
        playerId: vm.playerId,
        playerName: vm.playerName,
        market: "home_runs",
        bookLine: 0.5,
        recommendedSide: "OVER",
        sportsbook: "draftkings",
        edge: null,
        enginePct: null,
        gameId: vm.gameId,
        overOdds: null,
        underOdds: null,
      } as unknown as MlbSignalData);
    }
  };
  const handlePass = (vm: HrRadarCardViewModel) => {
    const k = vm.id;
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
      <HrRadarStageToastHost movements={movements} onDismiss={dismissMovement} />

      {/* Header — title + live temperature line + Full Ladder link. */}
      <div className="space-y-1.5 px-1">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm font-black uppercase tracking-[0.18em] text-foreground">
            <Radar className="w-4 h-4 text-primary" /> HR Radar
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium" data-testid="hr-live-counts">
          <span className="text-muted-foreground/70">Live:</span>
          <span className="text-red-400">{counts.fire} Bet Now</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-orange-400">{counts.ready} High Conviction</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-blue-400">{counts.build} Building</span>
          {cashedVMs.length > 0 && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-emerald-400">{cashedVMs.length} Cashed today</span>
            </>
          )}
        </div>
      </div>

      {/* Hot Seat hero — the one play to look at right now. */}
      {hero ? (
        <HrRadarHeroCard vm={hero} onPrimary={() => handlePrimary(hero)} onPass={() => handlePass(hero)} />
      ) : (
        <div
          className="rounded-2xl border border-border/50 bg-card/60 p-5 text-center space-y-1.5"
          data-testid="hr-hero-empty"
        >
          <Radar className="w-6 h-6 text-muted-foreground/60 mx-auto" />
          <p className="text-sm font-semibold text-foreground">No Bet Now or High Conviction calls right now.</p>
          <p className="text-xs text-muted-foreground leading-snug">
            {trackedCount > 0
              ? `Radar is tracking ${trackedCount} power window${trackedCount === 1 ? "" : "s"}. Next trigger: live contact, barrel, or pitcher fatigue.`
              : "Radar is warming up — signals appear here as games go live."}
          </p>
        </div>
      )}

      {/* Decision Queue — next ≤5 (Track hidden unless nothing higher). */}
      <HrRadarDecisionQueue items={queue} onPrimary={handlePrimary} />

      {/* Recent Hits — proof strip. */}
      <HrRadarRecentHitsStrip cashed={cashedVMs} freshCount={freshCashed} />
    </div>
  );
}
