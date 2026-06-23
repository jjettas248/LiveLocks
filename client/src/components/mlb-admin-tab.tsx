import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, CheckCircle, ChevronDown, ChevronRight } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { MLB_MARKET_LABELS } from "@/lib/mlbFormatters";

// ── Local type definitions (mirrors server/mlb/types.ts) ─────────────────────

type MLBMarket =
  | "hits"
  | "total_bases"
  | "pitcher_strikeouts"
  | "pitcher_outs"
  | "hits_allowed"
  | "home_runs"
  | "hrr"
  | "walks_allowed"
  | "batter_strikeouts"
  | "hr_allowed";

type MLBConfidenceTier = "ELITE" | "STRONG" | "LEAN" | "NO_EDGE";
type MLBRecommendedSide = "OVER" | "UNDER" | "NO_EDGE";

interface MLBPropOutput {
  market: MLBMarket;
  playerId: string;
  playerName: string;
  gameId: string;
  projection: number;
  bookLine: number;
  rawProbabilityOver: number;
  rawProbabilityUnder: number;
  calibratedProbabilityOver: number;
  calibratedProbabilityUnder: number;
  rawProbability: number;
  calibratedProbability: number;
  edge: number;
  recommendedSide: MLBRecommendedSide;
  confidenceTier: MLBConfidenceTier;
  mode: "standard" | "early_explosive";
  completedAB: number;
  twoABRuleSatisfied: boolean;
  isExperimental: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  explanationBullets: string[];
  warnings: string[];
  engineGeneratedAt: number;
}

// Full MLBPropInput as defined in server/mlb/types.ts
interface MLBPropInput {
  playerId: string;
  playerName: string;
  team: string;
  opponent: string;
  gameId: string;
  market: MLBMarket;
  bookLine: number;
  seasonAvg: number;
  plateAppearances: number;
  atBats: number;
  currentStatValue: number;
  remainingPA: number;
  remainingAB: number;
  completedAB: number;
  inning: number;
  isTopInning: boolean;
  batterHand: "L" | "R" | "S" | null;
  pitcherThrows?: "L" | "R" | null;
  parkHistoryFactor?: number | null;
  bvpPlateAppearances?: number | null;
  bvpOpsLikeFactor?: number | null;
  pitcherVsHandednessFactor?: number | null;
  lineupPocketWeakness?: number | null;
  contactQuality: {
    exitVelocity: number | null;
    launchAngle: number | null;
    hitDistance: number | null;
    hardHitRateSeason: number | null;
    barrelRateProxySeason: number | null;
    priorABResults: Array<{
      exitVelocity: number | null;
      launchAngle: number | null;
      distance: number | null;
      outcome: "hit" | "out" | "strikeout" | "walk" | "hbp" | "error" | "other";
    }>;
  };
  pitcher: {
    pitchCount: number;
    timesThrough: number;
    era: number | null;
    whip: number | null;
    kPer9: number | null;
    bbPer9: number | null;
    managerLeashShort: boolean;
    isPitcherCollapsing: boolean;
    pitchMix: Array<{ pitchType: string; percentage: number; avgVelocity: number | null }>;
    throws: "L" | "R" | null;
  };
  lineup: {
    battingOrderSlot: number;
    orderTurnoverProximity: number;
    lineupSectionStrength: "strong" | "neutral" | "weak";
    hittersAheadOnBase: number;
    pocketWeakness: number | null;
  };
  weatherPark: {
    parkFactor: number;
    temperature: number | null;
    windSpeed: number | null;
    windDirection: "in" | "out" | "cross" | "calm" | null;
    humidity: number | null;
    isIndoors: boolean;
    parkHistoryFactor: number | null;
  };
  bullpen: {
    bullpenEra: number | null;
    bullpenUsageLastThreeDays: number | null;
    isTopRelieverAvailable: boolean;
  };
}

// ── Market options ────────────────────────────────────────────────────────────

const MLB_MARKETS: MLBMarket[] = [
  "hits",
  "total_bases",
  "hrr",
  "pitcher_strikeouts",
  "pitcher_outs",
  "hits_allowed",
  "home_runs",
  "walks_allowed",
  "batter_strikeouts",
  "hr_allowed",
];

const MARKET_LABELS = MLB_MARKET_LABELS;

// ── Form type ─────────────────────────────────────────────────────────────────

interface TesterForm {
  playerName: string;
  playerId: string;
  team: string;
  opponent: string;
  market: MLBMarket;
  bookLine: number;
  seasonAvg: number;
  remainingAB: number;
  completedAB: number;
  inning: number;
  batterHand: "L" | "R" | "S" | null;
}

const DEFAULT_FORM: TesterForm = {
  playerName: "",
  playerId: "",
  team: "",
  opponent: "",
  market: "hits",
  bookLine: 0.5,
  seasonAvg: 0.95,
  remainingAB: 3,
  completedAB: 0,
  inning: 1,
  batterHand: null,
};

// ── Build a valid MLBPropInput with neutral defaults for non-form fields ───────

function buildNeutralInput(form: TesterForm): MLBPropInput {
  const totalAB = form.remainingAB + form.completedAB;
  return {
    playerId: form.playerId || "unknown",
    playerName: form.playerName,
    team: form.team,
    opponent: form.opponent || "",
    gameId: "admin-test",
    market: form.market,
    bookLine: form.bookLine,
    seasonAvg: form.seasonAvg,
    plateAppearances: totalAB,
    atBats: totalAB,
    currentStatValue: 0,
    remainingPA: form.remainingAB,
    remainingAB: form.remainingAB,
    completedAB: form.completedAB,
    inning: form.inning,
    isTopInning: true,
    batterHand: form.batterHand,
    contactQuality: {
      exitVelocity: null,
      launchAngle: null,
      hitDistance: null,
      hardHitRateSeason: null,
      barrelRateProxySeason: null,
      priorABResults: [],
    },
    pitcher: {
      pitchCount: 60,
      timesThrough: 2,
      era: 4.0,
      whip: 1.3,
      kPer9: 8.5,
      bbPer9: 3.0,
      managerLeashShort: false,
      isPitcherCollapsing: false,
      pitchMix: [],
      throws: null,
    },
    lineup: {
      battingOrderSlot: 5,
      orderTurnoverProximity: 0.5,
      lineupSectionStrength: "neutral",
      hittersAheadOnBase: 0,
      pocketWeakness: null,
    },
    weatherPark: {
      parkFactor: 1.0,
      temperature: 72,
      windSpeed: 5,
      windDirection: "cross",
      humidity: 50,
      isIndoors: false,
      parkHistoryFactor: null,
    },
    bullpen: {
      bullpenEra: 4.0,
      bullpenUsageLastThreeDays: 2,
      isTopRelieverAvailable: true,
    },
  };
}

// ── Confidence tier color ─────────────────────────────────────────────────────

function tierColor(tier: string): string {
  if (tier === "ELITE") return "text-emerald-400";
  if (tier === "STRONG") return "text-green-400";
  if (tier === "LEAN") return "text-yellow-400";
  return "text-muted-foreground";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MLBAdminTab() {
  const [syncResult, setSyncResult] = useState<{ playersLoaded: number; teamsLoaded: number } | null>(null);

  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/mlb/sync-rosters"),
    onSuccess: (data: any) => setSyncResult(data),
  });

  const [form, setForm] = useState<TesterForm>(DEFAULT_FORM);
  const [propResult, setPropResult] = useState<MLBPropOutput | null>(null);
  const [propError, setPropError] = useState<string | null>(null);

  const propMutation = useMutation({
    mutationFn: (payload: MLBPropInput) => apiRequest("POST", "/api/mlb/props", payload),
    onSuccess: (data: any) => {
      setPropResult(data as MLBPropOutput);
      setPropError(null);
    },
    onError: (err: any) => {
      setPropError(err?.message ?? "Engine error");
      setPropResult(null);
    },
  });

  function handleFormChange<K extends keyof TesterForm>(key: K, value: TesterForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.playerName || !form.team || form.bookLine <= 0 || form.seasonAvg <= 0) return;
    propMutation.mutate(buildNeutralInput(form));
  }

  const { data: diagData, isLoading: isDiagLoading } = useQuery<any>({
    queryKey: ["/api/mlb/diagnostics"],
    refetchInterval: 30000,
  });

  const [testerOpen, setTesterOpen] = useState(true);
  const [diagOpen, setDiagOpen] = useState(true);
  // Phase 5 — admin-only Uncalled HR Review collapsible. Defaults closed
  // since the underlying query only fires when expanded (saves a network
  // round-trip on every admin tab visit).
  const [uncalledOpen, setUncalledOpen] = useState(false);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <span role="img" aria-label="baseball">⚾</span> MLB Phase A — Admin Panel
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Internal tooling for MLB engine testing and roster management. Not visible to users.
        </p>
      </div>

      {/* ── Section 1: Roster Sync ── */}
      <div className="rounded-xl border border-border/60 bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground mb-2">Roster Sync</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Fetches the active 2026 MLB player pool and team rosters from the MLB Stats API.
          Run before using the prop tester to enable roster-based field hydration.
        </p>
        <button
          data-testid="button-sync-mlb-rosters"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          {syncMutation.isPending ? "Syncing…" : "Sync MLB Rosters"}
        </button>
        {syncMutation.isError && (
          <div className="mt-3 flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {(syncMutation.error as any)?.message ?? "Sync failed"}
          </div>
        )}
        {syncResult && !syncMutation.isError && (
          <div className="mt-3 flex items-center gap-2 text-xs text-green-400">
            <CheckCircle className="w-3.5 h-3.5 shrink-0" />
            Loaded {syncResult.playersLoaded} players across {syncResult.teamsLoaded} teams
          </div>
        )}
      </div>

      {/* ── Section 2: Prop Edge Tester ── */}
      <div className="rounded-xl border border-border/60 bg-card p-5">
        <button
          className="w-full flex items-center justify-between text-sm font-semibold text-foreground mb-1"
          onClick={() => setTesterOpen((v) => !v)}
        >
          <span>Prop Edge Tester</span>
          {testerOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <p className="text-xs text-muted-foreground mb-4">
          Calls POST /api/mlb/props with neutral context defaults. Contact quality is null (no live
          data Phase A). All nested contexts use neutral MLB averages.
        </p>

        {testerOpen && (
          <form onSubmit={handleSubmit} className="space-y-5">
            <fieldset className="space-y-3">
              <legend className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Player Identity</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Player Name <span className="text-destructive">*</span>
                  </label>
                  <input
                    data-testid="input-mlb-player-name"
                    type="text"
                    value={form.playerName}
                    onChange={(e) => handleFormChange("playerName", e.target.value)}
                    placeholder="e.g. Aaron Judge"
                    required
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Player ID <span className="text-muted-foreground text-xs">(optional — for roster lookup)</span>
                  </label>
                  <input
                    data-testid="input-mlb-player-id"
                    type="text"
                    value={form.playerId}
                    onChange={(e) => handleFormChange("playerId", e.target.value)}
                    placeholder="e.g. 592450"
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Team <span className="text-destructive">*</span>
                  </label>
                  <input
                    data-testid="input-mlb-team"
                    type="text"
                    value={form.team}
                    onChange={(e) => handleFormChange("team", e.target.value)}
                    placeholder="e.g. NYY"
                    required
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Opponent <span className="text-muted-foreground text-xs">(optional)</span>
                  </label>
                  <input
                    data-testid="input-mlb-opponent"
                    type="text"
                    value={form.opponent}
                    onChange={(e) => handleFormChange("opponent", e.target.value)}
                    placeholder="e.g. BOS"
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Batter Hand <span className="text-muted-foreground text-xs">(optional — auto-hydrated from roster)</span>
                  </label>
                  <select
                    data-testid="select-mlb-batter-hand"
                    value={form.batterHand ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      handleFormChange("batterHand", v === "" ? null : (v as "L" | "R" | "S"));
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="">Unknown / auto-hydrate</option>
                    <option value="L">Left (L)</option>
                    <option value="R">Right (R)</option>
                    <option value="S">Switch (S)</option>
                  </select>
                </div>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Market Settings</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Market <span className="text-destructive">*</span>
                  </label>
                  <select
                    data-testid="select-mlb-market"
                    value={form.market}
                    onChange={(e) => handleFormChange("market", e.target.value as MLBMarket)}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {MLB_MARKETS.map((m) => (
                      <option key={m} value={m}>{MARKET_LABELS[m]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Book Line <span className="text-destructive">*</span>
                  </label>
                  <input
                    data-testid="input-mlb-book-line"
                    type="number"
                    step="0.5"
                    min="0"
                    value={form.bookLine}
                    onChange={(e) => handleFormChange("bookLine", parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Season Avg (per game) <span className="text-destructive">*</span>
                  </label>
                  <input
                    data-testid="input-mlb-season-avg"
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.seasonAvg}
                    onChange={(e) => handleFormChange("seasonAvg", parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Line Context</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Remaining AB</label>
                  <input
                    data-testid="input-mlb-remaining-ab"
                    type="number"
                    min="0"
                    value={form.remainingAB}
                    onChange={(e) => handleFormChange("remainingAB", parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Completed AB</label>
                  <input
                    data-testid="input-mlb-completed-ab"
                    type="number"
                    min="0"
                    value={form.completedAB}
                    onChange={(e) => handleFormChange("completedAB", parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Inning</label>
                  <input
                    data-testid="input-mlb-inning"
                    type="number"
                    min="1"
                    max="9"
                    value={form.inning}
                    onChange={(e) => handleFormChange("inning", parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            </fieldset>

            <button
              data-testid="button-mlb-test-submit"
              type="submit"
              disabled={propMutation.isPending || !form.playerName || !form.team}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {propMutation.isPending ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Calculating…
                </>
              ) : (
                "Calculate Edge"
              )}
            </button>

            {propError && (
              <div className="flex items-center gap-2 text-xs text-destructive">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {propError}
              </div>
            )}

            {propResult && (
              <div className="rounded-lg border border-border/60 bg-secondary/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    {propResult.playerName} — {MARKET_LABELS[propResult.market]}
                  </span>
                  <span
                    data-testid="text-mlb-confidence-tier"
                    className={`text-xs font-bold uppercase ${tierColor(propResult.confidenceTier)}`}
                  >
                    {propResult.confidenceTier}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Projection</div>
                    <div data-testid="text-mlb-projection" className="font-semibold text-foreground">
                      {propResult.projection.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Book Line</div>
                    <div className="font-semibold text-foreground">{propResult.bookLine}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Calibrated % (Over)</div>
                    <div data-testid="text-mlb-calibrated-prob" className="font-semibold text-foreground">
                      {propResult.calibratedProbabilityOver.toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Edge</div>
                    <div data-testid="text-mlb-edge" className="font-semibold text-foreground">
                      {propResult.edge.toFixed(2)}%
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-muted-foreground">Recommended:</span>
                  <span
                    data-testid="text-mlb-side"
                    className={
                      propResult.recommendedSide === "OVER"
                        ? "font-semibold text-green-400"
                        : propResult.recommendedSide === "UNDER"
                        ? "font-semibold text-red-400"
                        : "text-muted-foreground"
                    }
                  >
                    {propResult.recommendedSide}
                  </span>
                  <span className="text-muted-foreground">Mode:</span>
                  <span className="text-foreground">{propResult.mode}</span>
                  {propResult.suppressed && (
                    <span className="text-yellow-500">
                      Suppressed: {propResult.suppressionReason}
                    </span>
                  )}
                </div>

                {propResult.warnings.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground font-medium">Warnings:</div>
                    {propResult.warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs text-yellow-500/90">
                        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                        {w}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </form>
        )}
      </div>

      {/* ── Section 3: Diagnostics ── */}
      <div className="rounded-xl border border-border/60 bg-card p-5">
        <button
          className="w-full flex items-center justify-between text-sm font-semibold text-foreground mb-1"
          onClick={() => setDiagOpen((v) => !v)}
        >
          <span>Diagnostics</span>
          {diagOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <p className="text-xs text-muted-foreground mb-3">
          Live feed from GET /api/mlb/diagnostics — auto-refreshes every 30s.
        </p>

        {diagOpen && (
          <>
            {isDiagLoading && (
              <div className="text-xs text-muted-foreground">Loading diagnostics…</div>
            )}
            {diagData && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div className="rounded-lg bg-secondary/50 p-3">
                    <div className="text-muted-foreground mb-1">Total Records</div>
                    <div className="font-semibold text-foreground text-base">
                      {diagData.totalRecords ?? 0}
                    </div>
                  </div>
                  <div className="rounded-lg bg-secondary/50 p-3">
                    <div className="text-muted-foreground mb-1">Early Explosive Mode Rate</div>
                    <div className="font-semibold text-foreground text-base">
                      {diagData.earlyExplosiveModeRate != null
                        ? `${(diagData.earlyExplosiveModeRate * 100).toFixed(1)}%`
                        : "—"}
                    </div>
                  </div>
                  {diagData.suppressed != null && (
                    <div className="rounded-lg bg-secondary/50 p-3">
                      <div className="text-muted-foreground mb-1">Suppressed</div>
                      <div className="font-semibold text-foreground text-base">
                        {diagData.suppressed}
                      </div>
                    </div>
                  )}
                </div>

                {diagData.byConfidenceTier && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-2">
                      By Confidence Tier
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {Object.entries(
                        diagData.byConfidenceTier as Record<string, { count: number }>
                      ).map(([tier, stat]) => (
                        <div key={tier} className="rounded-lg bg-secondary/50 p-2 text-xs">
                          <div className={`font-semibold ${tierColor(tier)}`}>{tier}</div>
                          <div className="text-foreground">{stat.count}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Phase 5 — Uncalled HR Review (admin only). Surfaces the most recent
          uncalled_hr / early_hr_insufficient_sample rows so admins can see
          what the engine missed and why. Calibration data, not product. */}
      <UncalledHrReviewPanel
        open={uncalledOpen}
        onToggle={() => setUncalledOpen((v) => !v)}
      />
    </div>
  );
}

// ─── Phase 5 — Uncalled HR Review panel ──────────────────────────────────────
// Standalone admin section. Query is gated on `open` so the network call
// never fires until expanded. Endpoint is requireAdmin server-side; if the
// viewer is not admin the request will 403 and we render an empty state.

interface UncalledHrRow {
  id: string;
  sessionDate: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team: string;
  gradingStatus: string;
  hitInning: number | null;
  hitHalf: string | null;
  detectedInning: number | null;
  pregameScore: number | null;
  maxPreHrScore: number | null;
  hadPreHrRadarRow: boolean;
  hadPreHrContact: boolean;
  matchMethod: string | null;
  gradingReason: string | null;
  suppressionReasons: string[] | null;
  hitterArchetype: string | null;
  pitcherFade: number | null;
  parkWeatherScore: number | null;
  atBatIndex: number | null;
  resolvedAt: string | null;
  // Review bucket taxonomy (diagnosticsSnapshot.hrReview) — additive, nullable.
  reviewBucket: string | null;
  reviewReason: string | null;
  reviewDataQuality: string | null;
  preHrPeakStage: string | null;
  preHrPeakScore10: number | null;
  currentStage: string | null;
  currentScore10: number | null;
}

const HR_REVIEW_BUCKET_META: Record<string, { label: string; cls: string }> = {
  called_hit: { label: "Called", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  late_signal: { label: "Late", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
  attribution_miss: { label: "Attribution", cls: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  same_pa_hr_no_prior_live_signal: { label: "Same-PA", cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
  early_window_hr: { label: "Early", cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
  live_promotion_miss: { label: "Promotion", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  context_miss: { label: "Context", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  true_uncalled_hr: { label: "True Miss", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
  insufficient_review_data: { label: "Data Gap", cls: "bg-purple-500/15 text-purple-300 border-purple-500/30" },
};

function HrReviewBucketBadge({ bucket, reason }: { bucket: string | null; reason: string | null }) {
  if (!bucket) return <span className="text-muted-foreground">—</span>;
  const meta = HR_REVIEW_BUCKET_META[bucket] ?? { label: bucket, cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" };
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}
      title={reason ?? bucket}
      data-testid={`badge-hrreview-${bucket}`}
    >
      {meta.label}
    </span>
  );
}

function UncalledHrReviewPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { data, isLoading, isError } = useQuery<{ rows: UncalledHrRow[] }>({
    queryKey: ["/api/admin/hr-radar/uncalled"],
    enabled: open,
    refetchInterval: open ? 60000 : false,
  });
  const rows = data?.rows ?? [];

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5" data-testid="panel-uncalled-hr-review">
      <button
        className="w-full flex items-center justify-between text-sm font-semibold text-foreground mb-1"
        onClick={onToggle}
        data-testid="button-toggle-uncalled-hr"
      >
        <span>Uncalled HR Review</span>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      <p className="text-xs text-muted-foreground mb-3">
        Last 50 HRs the engine did not call (uncalled_hr + early_hr_insufficient_sample). Calibration only — not user-visible.
      </p>

      {open && (
        <>
          {isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {isError && (
            <div className="text-xs text-red-400" data-testid="text-uncalled-error">
              Failed to load. Admin only — confirm you're signed in as admin.
            </div>
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <div className="text-xs text-muted-foreground" data-testid="text-uncalled-empty">
              No uncalled HRs in the last 7 days.
            </div>
          )}
          {!isLoading && !isError && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-uncalled-hr">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border/40">
                    <th className="text-left py-1.5 pr-2">Date</th>
                    <th className="text-left py-1.5 pr-2">Player</th>
                    <th className="text-left py-1.5 pr-2">Bucket</th>
                    <th className="text-left py-1.5 pr-2">Peak → Now</th>
                    <th className="text-center py-1.5 pr-2">Data</th>
                    <th className="text-left py-1.5 pr-2">Status</th>
                    <th className="text-right py-1.5 pr-2">Inn</th>
                    <th className="text-right py-1.5 pr-2">AB#</th>
                    <th className="text-center py-1.5 pr-2">Pre-HR Row</th>
                    <th className="text-center py-1.5 pr-2">Contact</th>
                    <th className="text-right py-1.5 pr-2">PreScore</th>
                    <th className="text-right py-1.5 pr-2">MaxScore</th>
                    <th className="text-left py-1.5 pr-2">Archetype</th>
                    <th className="text-right py-1.5 pr-2">PFade</th>
                    <th className="text-right py-1.5 pr-2">Park/Wx</th>
                    <th className="text-left py-1.5 pr-2">Suppress / Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/20 align-top"
                      data-testid={`row-uncalled-${r.id}`}
                    >
                      <td className="py-1.5 pr-2 font-mono">{r.sessionDate}</td>
                      <td className="py-1.5 pr-2">
                        <div className="font-medium text-foreground">{r.playerName}</div>
                        <div className="text-muted-foreground">{r.team}</div>
                      </td>
                      <td className="py-1.5 pr-2">
                        <HrReviewBucketBadge bucket={r.reviewBucket} reason={r.reviewReason} />
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-muted-foreground" data-testid={`cell-peaknow-${r.id}`}>
                        {r.preHrPeakStage || r.currentStage ? (
                          <>
                            {(r.preHrPeakStage ?? "—")}
                            {r.preHrPeakScore10 != null ? `@${r.preHrPeakScore10.toFixed(1)}` : ""}
                            {" → "}
                            {(r.currentStage ?? "—")}
                            {r.currentScore10 != null ? `@${r.currentScore10.toFixed(1)}` : ""}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-center text-muted-foreground">{r.reviewDataQuality ?? "—"}</td>
                      <td className="py-1.5 pr-2">
                        <span className={
                          r.gradingStatus === "uncalled_hr"
                            ? "text-zinc-300"
                            : "text-purple-300"
                        }>
                          {r.gradingStatus}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        {r.hitInning != null ? `${(r.hitHalf ?? "").charAt(0).toUpperCase()}${r.hitInning}` : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">{r.atBatIndex ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-center">{r.hadPreHrRadarRow ? "✓" : "—"}</td>
                      <td className="py-1.5 pr-2 text-center">{r.hadPreHrContact ? "✓" : "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        {r.pregameScore != null ? r.pregameScore.toFixed(1) : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        {r.maxPreHrScore != null ? r.maxPreHrScore.toFixed(1) : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-foreground/80">{r.hitterArchetype ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        {r.pitcherFade != null ? r.pitcherFade.toFixed(2) : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        {r.parkWeatherScore != null ? r.parkWeatherScore.toFixed(2) : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-muted-foreground max-w-[18rem]">
                        {r.suppressionReasons && r.suppressionReasons.length > 0
                          ? r.suppressionReasons.join(", ")
                          : (r.gradingReason ?? "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
