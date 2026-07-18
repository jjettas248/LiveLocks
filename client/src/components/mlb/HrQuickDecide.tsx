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
  buildConsumerViewModels,
  compareByImportance,
  selectQuickDecide,
  type HrRadarCardViewModel,
} from "@/lib/mlb/hrRadarViewModel";
import type { HrRadarDecisionView, HrRadarDecisionViewCounts } from "@shared/hrRadarDecisionView";
import { HrRadarHeroCard } from "@/components/mlb/hr-radar/HrRadarHeroCard";
import { HrRadarDecisionQueue, QueueRow } from "@/components/mlb/hr-radar/HrRadarDecisionQueue";
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

// ── LEGACY FALLBACK ONLY — used when a ladder response has no `decisionView`
// at all (a service-worker-cached response captured before this rollout).
// Reproduces the classification decisionView now owns, so behavior matches
// even without the authoritative contract. Live (non-resolved) decision rows
// that survive the user-facing filters: drop admin-only and pregame-no-AB
// rows (engine truth, via the canonical mapper) before building the VM.
function legacyBuildLiveVMs(entries: HrRadarLadderEntry[]): HrRadarCardViewModel[] {
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

function emptyCounts(): HrRadarDecisionViewCounts {
  return {
    takeNow: 0, watchNextAb: 0, build: 0, watch: 0, forming: 0,
    waitingForFirstAb: 0, liveTracked: 0, fireHitsToday: 0, fireMissesToday: 0, modelReview: 0,
  };
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

  // ── Decision-view sourcing. The server owns stage/action/count truth; this
  // component only lays it out. Three states:
  //   - normal:    decisionView.status === "ok" → use it directly.
  //   - degraded:  decisionView.status === "degraded" → keep rendering the
  //     last-good decisionView (retained via ref, same spirit as
  //     placeholderData) with a "temporarily refreshing" banner, so a
  //     transient server hiccup never flashes a false "0 · 0 · 0".
  //   - legacy fallback: `decisionView` entirely absent (a stale cached
  //     response from before this rollout) → the old client-side adapter.
  const rawDecisionView = data?.decisionView;
  const hasDecisionViewField = rawDecisionView !== undefined;
  const lastGoodRef = useRef<HrRadarDecisionView<HrRadarLadderEntry> | null>(null);
  if (rawDecisionView && rawDecisionView.status === "ok") {
    lastGoodRef.current = rawDecisionView;
  }
  const decisionView = hasDecisionViewField
    ? (rawDecisionView!.status === "ok" ? rawDecisionView! : lastGoodRef.current)
    : null;
  const isDegraded = hasDecisionViewField && rawDecisionView!.status === "degraded";
  const isDegradedWithNoData = isDegraded && decisionView == null;

  const s = data?.sections;
  const legacyLiveRaw: HrRadarLadderEntry[] = useMemo(() => [
    ...(s?.attackNow ?? []),
    ...(s?.ready ?? []),
    ...(s?.building ?? []),
    ...(s?.watch ?? []),
  ], [s]);
  const legacyAllLiveVMs = useMemo(
    () => (hasDecisionViewField ? [] : legacyBuildLiveVMs(legacyLiveRaw)),
    [hasDecisionViewField, legacyLiveRaw],
  );
  const legacyCashedVMs = useMemo(
    () => (hasDecisionViewField ? [] : (s?.cashed ?? []).map((e) => buildHrRadarCardViewModel(e, { sectionHint: "cashed" }))),
    [hasDecisionViewField, s],
  );

  // ── Build the per-bucket VM lists — decisionView path (normal), or the
  // legacy client-side adapter (fallback only). Never both.
  const takeNowVMs = useMemo(
    () => decisionView
      ? buildConsumerViewModels(decisionView, decisionView.groups.takeNow)
      : legacyAllLiveVMs.filter((v) => v.stage === "fire"),
    [decisionView, legacyAllLiveVMs],
  );
  const watchNextAbVMs = useMemo(
    () => decisionView
      ? buildConsumerViewModels(decisionView, decisionView.groups.watchNextAb)
      : legacyAllLiveVMs.filter((v) => v.stage === "ready"),
    [decisionView, legacyAllLiveVMs],
  );
  const formingVMs = useMemo(() => {
    if (decisionView) {
      const build = buildConsumerViewModels(decisionView, decisionView.groups.build);
      const watch = buildConsumerViewModels(decisionView, decisionView.groups.watch);
      return [...build, ...watch];
    }
    return legacyAllLiveVMs.filter((v) => v.stage === "build" || v.stage === "track");
  }, [decisionView, legacyAllLiveVMs]);
  const signalHitVMs = useMemo(
    () => decisionView
      ? buildConsumerViewModels(decisionView, decisionView.groups.signalHits)
      : legacyCashedVMs,
    [decisionView, legacyCashedVMs],
  );

  // Active = hasn't already been taken/passed this session.
  const activeTakeNow = useMemo(
    () => takeNowVMs.filter((vm) => !dismissed.has(vm.id) && !accepted.has(vm.id)).sort(compareByImportance),
    [takeNowVMs, dismissed, accepted],
  );
  const activeWatchNextAb = useMemo(
    () => watchNextAbVMs.filter((vm) => !dismissed.has(vm.id) && !accepted.has(vm.id)).sort(compareByImportance),
    [watchNextAbVMs, dismissed, accepted],
  );
  const activeForming = useMemo(
    () => formingVMs.filter((vm) => !dismissed.has(vm.id) && !accepted.has(vm.id)).sort(compareByImportance).slice(0, 5),
    [formingVMs, dismissed, accepted],
  );

  // Hero = top Fire if any, else top Ready if no Fire at all. Build/Watch
  // NEVER get hero treatment (a large non-actionable card recreates exactly
  // the urgency-around-nothing problem this rebuild removes).
  const { hero, hasFire, hasReady } = useMemo(() => {
    if (activeTakeNow.length > 0) return { hero: activeTakeNow[0], hasFire: true, hasReady: activeWatchNextAb.length > 0 };
    if (activeWatchNextAb.length > 0) return { hero: activeWatchNextAb[0], hasFire: false, hasReady: true };
    return { hero: null, hasFire: false, hasReady: activeWatchNextAb.length > 0 };
  }, [activeTakeNow, activeWatchNextAb]);
  const takeNowCompact = hero && hero.stage === "fire" ? activeTakeNow.slice(1) : activeTakeNow;
  const watchNextAbCompact = hero && hero.stage === "ready" ? activeWatchNextAb.slice(1) : activeWatchNextAb;

  // Counts — server-derived (decisionView.counts) or the legacy equivalent
  // computed the same way the server would (fallback path only). Never
  // recomputed from a locally-filtered VM list in the normal path. `useMemo`
  // is always called (Rules of Hooks) — the decisionView branch just ignores
  // its result.
  const legacyCounts = useMemo(() => {
    if (hasDecisionViewField) return emptyCounts();
    const c = emptyCounts();
    for (const vm of legacyAllLiveVMs) {
      if (vm.stage === "fire") c.takeNow++;
      else if (vm.stage === "ready") c.watchNextAb++;
      else if (vm.stage === "build") c.build++;
      else if (vm.stage === "track") c.watch++;
    }
    c.forming = c.build + c.watch;
    c.liveTracked = c.takeNow + c.watchNextAb + c.forming;
    c.fireHitsToday = legacyCashedVMs.length;
    return c;
  }, [hasDecisionViewField, legacyAllLiveVMs, legacyCashedVMs]);
  const counts = decisionView?.counts ?? legacyCounts;

  // ── Dopamine layer: stage-movement toasts + fresh-signal-hit celebration. ──
  const stageSnapshotRef = useRef<Map<string, HrRadarCardViewModel["stage"]>>(new Map());
  const hitSnapshotRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const [movements, setMovements] = useState<StageMovement[]>([]);
  const [freshHits, setFreshHits] = useState(0);

  const allLiveForMovement = useMemo(
    () => [...activeTakeNow, ...activeWatchNextAb, ...activeForming],
    [activeTakeNow, activeWatchNextAb, activeForming],
  );

  useEffect(() => {
    if (!sessionDate) return;
    const nextStages = new Map(allLiveForMovement.map((vm) => [vm.id, vm.stage] as const));
    const nextHits = new Set(signalHitVMs.map((vm) => vm.id));
    if (!initializedRef.current) {
      // Seed silently on first real payload — no toast/celebration on load.
      stageSnapshotRef.current = nextStages;
      hitSnapshotRef.current = nextHits;
      initializedRef.current = true;
      return;
    }
    const moves = detectStageMovements(
      stageSnapshotRef.current,
      allLiveForMovement.map((vm) => ({ id: vm.id, playerName: vm.playerName, stage: vm.stage, reason: vm.headline })),
    );
    if (moves.length > 0) {
      setMovements((prev) => [...prev, ...moves].slice(-3));
    }
    let fresh = 0;
    for (const id of Array.from(nextHits)) if (!hitSnapshotRef.current.has(id)) fresh++;
    if (fresh > 0) {
      setFreshHits(fresh);
      const t = window.setTimeout(() => setFreshHits(0), 2400);
      stageSnapshotRef.current = nextStages;
      hitSnapshotRef.current = nextHits;
      return () => window.clearTimeout(t);
    }
    stageSnapshotRef.current = nextStages;
    hitSnapshotRef.current = nextHits;
  }, [sessionDate, allLiveForMovement, signalHitVMs]);

  const dismissMovement = (id: string) =>
    setMovements((prev) => prev.filter((m) => m.id !== id));

  // ── Actions. Only Fire (official live call) adds a bet to the slip; every
  // softer stage CTA ("Watch Next AB", etc.) just clears the play from the
  // feed so we never imply an official call where there isn't one. Guarded
  // on `vm.canAddToSlip` (server-derived: Fire AND a valid bet payload), not
  // just `vm.stage === "fire"` — a Fire row can lack slip-safe data. ─────────
  const handlePrimary = (vm: HrRadarCardViewModel) => {
    const k = vm.id;
    const next = new Set(accepted).add(k);
    setAccepted(next);
    writeSet(acceptKey(sessionDate), next);
    if (vm.canAddToSlip) {
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

  if (isDegradedWithNoData) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card/60 p-5 text-center space-y-1.5" data-testid="hr-quick-decide-unavailable">
        <Radar className="w-6 h-6 text-muted-foreground/60 mx-auto" />
        <p className="text-sm font-semibold text-foreground">HR Radar is temporarily unavailable.</p>
      </div>
    );
  }

  const noFireNoReadyNoForming = activeTakeNow.length === 0 && activeWatchNextAb.length === 0 && activeForming.length === 0;
  const noFireNoReady = activeTakeNow.length === 0 && activeWatchNextAb.length === 0;
  const noFire = activeTakeNow.length === 0;

  return (
    <div className="space-y-5" data-testid="hr-quick-decide">
      <HrRadarStageToastHost movements={movements} onDismiss={dismissMovement} />

      {/* Header — single compact line, all counts server-derived. */}
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
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium" data-testid="hr-live-counts">
          <span className="text-red-400">Take Now {counts.takeNow}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-orange-400">Watch Next AB {counts.watchNextAb}</span>
          {counts.fireHitsToday > 0 && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-emerald-400">{counts.fireHitsToday} Signal Hit{counts.fireHitsToday === 1 ? "" : "s"} Today</span>
            </>
          )}
        </div>
        {isDegraded && (
          <p className="text-[10px] text-amber-400" data-testid="text-hr-degraded-banner">
            HR Radar is temporarily refreshing — showing the latest available signal state.
          </p>
        )}
      </div>

      {/* Fully quiet slate — nothing live, nothing forming. */}
      {noFireNoReadyNoForming && (
        <div className="rounded-2xl border border-border/50 bg-card/60 p-5 text-center space-y-1.5" data-testid="hr-empty-no-activity">
          <Radar className="w-6 h-6 text-muted-foreground/60 mx-auto" />
          <p className="text-sm font-semibold text-foreground">No live HR Radar activity right now.</p>
          <p className="text-xs text-muted-foreground leading-snug">Signals will appear as games progress.</p>
        </div>
      )}

      {/* No Fire, no Ready, but something is forming. */}
      {!noFireNoReadyNoForming && noFireNoReady && (
        <div className="rounded-2xl border border-border/50 bg-card/60 p-5 text-center space-y-1.5" data-testid="hr-empty-nothing-actionable">
          <Radar className="w-6 h-6 text-muted-foreground/60 mx-auto" />
          <p className="text-sm font-semibold text-foreground">Nothing is actionable yet.</p>
          <p className="text-xs text-muted-foreground leading-snug">The radar is monitoring live contact as signals develop.</p>
        </div>
      )}

      {/* No Fire (Ready may exist) — the explicit "don't bet from here" block. */}
      {noFire && !noFireNoReady && (
        <div className="rounded-2xl border border-border/50 bg-card/60 p-5 text-center space-y-1.5" data-testid="hr-empty-no-fire">
          <p className="text-sm font-bold uppercase tracking-wide text-foreground">No Official HR Calls Right Now</p>
          <p className="text-xs text-muted-foreground leading-snug">
            The radar is still monitoring live contact.<br />Do not place an HR bet from this screen yet.
          </p>
        </div>
      )}

      {/* TAKE NOW — Fire hero + compact remaining Fire calls. */}
      {activeTakeNow.length > 0 && (
        <section className="space-y-2" data-testid="hr-section-take-now">
          {hero && hero.stage === "fire" && (
            <HrRadarHeroCard vm={hero} onPrimary={() => handlePrimary(hero)} onPass={() => handlePass(hero)} />
          )}
          {takeNowCompact.map((vm, i) => (
            <QueueRow key={vm.id} vm={vm} rank={i + 1} onPrimary={() => handlePrimary(vm)} />
          ))}
        </section>
      )}

      {/* WATCH NEXT AB — Ready hero (only when there's no Fire) + compact
          remaining Ready players. Always its own section — Ready is never
          lumped into Forming Signals. */}
      {activeWatchNextAb.length > 0 && (
        <section className="space-y-2" data-testid="hr-section-watch-next-ab">
          {hero && hero.stage === "ready" && (
            <HrRadarHeroCard vm={hero} onPrimary={() => handlePrimary(hero)} onPass={() => handlePass(hero)} />
          )}
          {watchNextAbCompact.map((vm, i) => (
            <QueueRow key={vm.id} vm={vm} rank={i + 1} onPrimary={() => handlePrimary(vm)} />
          ))}
        </section>
      )}

      {/* FORMING SIGNALS — Build then Watch, capped at 5, no CTA. */}
      <HrRadarDecisionQueue items={activeForming} onPrimary={handlePrimary} />

      {/* Today's Official Results — Fire-only counts. */}
      <HrRadarRecentHitsStrip
        signalHits={counts.fireHitsToday}
        officialMisses={counts.fireMissesToday}
        freshCount={freshHits}
      />
    </div>
  );
}
