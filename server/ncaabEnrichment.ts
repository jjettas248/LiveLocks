// ── NCAAB Data Enrichment Layer ───────────────────────────────────────────────
// All sources are free/public. Each fetch is wrapped in try/catch and fails
// silently so one broken source never blocks the card from rendering.

const ESPN_NCAAB = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball";
const ENRICH_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
const INJURY_CACHE_TTL = 30 * 60 * 1000;      // 30 min — injuries change more

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TorvikStats {
  adjO: number;
  adjD: number;
  tempo: number;
  efgPct: number;
  tovPct: number;
  orbPct: number;
  ftRate: number;
  barthag: number;
  rank: number;
  source: string;
}

export interface ActionNetworkData {
  overPct: number | null;
  underPct: number | null;
  overMoney: number | null;
  underMoney: number | null;
  total: number | null;
  openTotal: number | null;
  spread: number | null;
  openSpread: number | null;
  homeSpreadPct: number | null;
  awaySpreadPct: number | null;
  source: string;
}

export interface VegasInsiderData {
  openTotal: number | null;
  currentTotal: number | null;
  movement: number | null;
  source: string;
}

export interface InjuredPlayer {
  name: string;
  team: string;
  position: string;
  injury: string;
  status: string;
}

export interface InjuryImpact {
  injuries: InjuredPlayer[];
  out: number;
  hasKeyPlayerOut: boolean;
  summary: string;
}

export interface CompositeSignal {
  name: string;
  projTotal: number | null;
  weight: number;
  diff: number;
}

export interface CompositeEngineResult {
  overProb: number;
  underProb: number;
  projTotal: number | null;
  signals: CompositeSignal[];
  sourceCount: number;
  sourceSummary: string;
}

export interface EnrichedGameData {
  homeTeam: string;
  awayTeam: string;
  torvik: {
    home: TorvikStats | null;
    away: TorvikStats | null;
  };
  actionNetwork: ActionNetworkData | null;
  vegasInsider: VegasInsiderData | null;
  injuries: {
    home: InjuryImpact | null;
    away: InjuryImpact | null;
    all: InjuredPlayer[];
  };
  composite: CompositeEngineResult | null;
  sources: string[];
  fetchedAt: number;
}

// ── Module-level caches ────────────────────────────────────────────────────────

const enrichmentCache = new Map<string, { data: EnrichedGameData; fetchedAt: number }>();
let torvikData: any[] | null = null;
let torvikFetchedAt = 0;
let injuryData: InjuredPlayer[] | null = null;
let injuryFetchedAt = 0;

export function clearEnrichmentCache(): void {
  enrichmentCache.clear();
  torvikData = null;
  torvikFetchedAt = 0;
  injuryData = null;
  injuryFetchedAt = 0;
  console.log("[ENRICH] Cache cleared by admin");
}

export function getEnrichmentCacheStats(): { games: number; torvikLoaded: boolean; injuriesLoaded: boolean } {
  return {
    games: enrichmentCache.size,
    torvikLoaded: torvikData !== null,
    injuriesLoaded: injuryData !== null,
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function normStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function teamsPartialMatch(a: string, b: string): boolean {
  const na = normStr(a);
  const nb = normStr(b);
  if (na === nb) return true;
  const aLast = na.split(" ").filter(w => w.length > 3).pop() ?? na;
  const bLast = nb.split(" ").filter(w => w.length > 3).pop() ?? nb;
  return aLast === bLast || na.includes(bLast) || nb.includes(aLast);
}

// ── STEP 1: BartTorvik / T-Rank ───────────────────────────────────────────────

async function ensureTorvikData(): Promise<any[] | null> {
  if (torvikData && Date.now() - torvikFetchedAt < ENRICH_CACHE_TTL) return torvikData;
  try {
    const year = new Date().getFullYear();
    const res = await fetch(`https://barttorvik.com/trank.php?json=1&year=${year}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { console.warn("[TORVIK] Fetch failed:", res.status); return torvikData; }
    const raw = await res.json() as any;
    const arr: any[] = Array.isArray(raw) ? raw : (raw.teams ?? raw.data ?? []);
    console.log(`[TORVIK] Loaded ${arr.length} teams`);
    torvikData = arr;
    torvikFetchedAt = Date.now();
    return arr;
  } catch (err: any) {
    console.warn("[TORVIK] Error:", err.message);
    return torvikData;
  }
}

export async function fetchBartTorvik(teamName: string): Promise<TorvikStats | null> {
  const data = await ensureTorvikData();
  if (!data?.length) return null;
  const norm = normStr(teamName);
  const nameKeys = ["team", "teamname", "TeamName", "name", "Team"];
  const match = data.find(t => {
    return nameKeys.some(k => {
      const v = normStr(String(t[k] ?? ""));
      return v === norm || (v.length > 3 && norm.includes(v)) || (norm.length > 3 && v.includes(norm));
    });
  }) ?? data.find(t => {
    const normLast = norm.split(" ").filter(w => w.length > 3).pop() ?? norm;
    return nameKeys.some(k => {
      const v = normStr(String(t[k] ?? ""));
      const vLast = v.split(" ").filter(w => w.length > 3).pop() ?? v;
      return vLast === normLast && normLast.length > 3;
    });
  });
  if (!match) { console.warn("[TORVIK] No match for:", teamName); return null; }
  const p = (v: any) => parseFloat(String(v ?? 0)) || 0;
  return {
    adjO:    p(match.adjoe    ?? match.adjO    ?? match.AdjOE ?? match["adj. o"]),
    adjD:    p(match.adjde    ?? match.adjD    ?? match.AdjDE ?? match["adj. d"]),
    tempo:   p(match.tempo    ?? match.Tempo   ?? match["tempo"]),
    efgPct:  p(match.efg      ?? match.EFG     ?? match["efg%"]),
    tovPct:  p(match.tov      ?? match.TOV     ?? match["tov%"]),
    orbPct:  p(match.orb      ?? match.ORB     ?? match["orb%"]),
    ftRate:  p(match.ftr      ?? match.FTR     ?? match["ftr"]),
    barthag: p(match.barthag  ?? match.Barthag),
    rank:    parseInt(String(match.rk ?? match.rank ?? match.Rank ?? 999), 10),
    source:  "barttorvik",
  };
}

// ── STEP 3: ActionNetwork Public API ──────────────────────────────────────────

export async function fetchActionNetwork(homeTeam: string, awayTeam: string): Promise<ActionNetworkData | null> {
  try {
    const res = await fetch(
      "https://api.actionnetwork.com/web/v1/scoreboard/ncaab?period=game&bookIds=15,30,76,123,69,68",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://www.actionnetwork.com",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) { console.warn("[AN] Status:", res.status); return null; }
    const data = await res.json() as any;
    const games: any[] = data.games ?? [];
    const match = games.find((g: any) => {
      const names: string[] = (g.teams ?? []).map((t: any) => String(t.display_name ?? t.name ?? "").toLowerCase());
      return names.some(n => teamsPartialMatch(n, homeTeam)) && names.some(n => teamsPartialMatch(n, awayTeam));
    });
    if (!match) { console.warn("[AN] No match for:", homeTeam, "vs", awayTeam); return null; }
    const odds: any[] = match.odds ?? [];
    const consensus = odds.find((o: any) => o.book_id === 0) ?? odds[0] ?? {};
    console.log("[AN] Found:", homeTeam, "vs", awayTeam);
    const n = (v: any) => (v != null ? parseFloat(String(v)) : null);
    return {
      overPct:      n(consensus.over_bets_pct),
      underPct:     n(consensus.under_bets_pct),
      overMoney:    n(consensus.over_money_pct),
      underMoney:   n(consensus.under_money_pct),
      total:        n(consensus.total),
      openTotal:    n(consensus.open_total),
      spread:       n(consensus.spread),
      openSpread:   n(consensus.open_spread),
      homeSpreadPct: n(consensus.home_spread_bets_pct),
      awaySpreadPct: n(consensus.away_spread_bets_pct),
      source: "action_network",
    };
  } catch (err: any) {
    console.warn("[AN] Error:", err.message);
    return null;
  }
}

// ── STEP 4: VegasInsider Opening Line Scrape ──────────────────────────────────

export async function fetchVegasInsider(homeTeam: string, awayTeam: string): Promise<VegasInsiderData | null> {
  try {
    const res = await fetch("https://www.vegasinsider.com/college-basketball/odds/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const homeLast = homeTeam.split(" ").filter(w => w.length > 3).pop() ?? homeTeam;
    const awayLast = awayTeam.split(" ").filter(w => w.length > 3).pop() ?? awayTeam;
    const homeIdx = html.toLowerCase().indexOf(homeLast.toLowerCase());
    const awayIdx = html.toLowerCase().indexOf(awayLast.toLowerCase());
    if (homeIdx < 0 || awayIdx < 0) return null;
    const section = html.slice(Math.min(homeIdx, awayIdx) - 100, Math.max(homeIdx, awayIdx) + 500);
    const totalMatches = Array.from(section.matchAll(/(\d{2,3}(?:\.\d)?)/g)).map(m => parseFloat(m[1]));
    const viTotals = totalMatches.filter(n => n >= 100 && n <= 180);
    if (viTotals.length < 1) return null;
    const openTotal = viTotals[0] ?? null;
    const currentTotal = viTotals[1] ?? openTotal;
    return {
      openTotal,
      currentTotal,
      movement: openTotal && currentTotal ? parseFloat((currentTotal - openTotal).toFixed(1)) : null,
      source: "vegasinsider",
    };
  } catch (err: any) {
    console.warn("[VI] Error:", err.message);
    return null;
  }
}

// ── STEP 8: Rotowire Injury Table Parse ───────────────────────────────────────

async function ensureInjuryData(): Promise<InjuredPlayer[] | null> {
  if (injuryData && Date.now() - injuryFetchedAt < INJURY_CACHE_TTL) return injuryData;
  try {
    const res = await fetch("https://www.rotowire.com/basketball/college-basketball-injury-report.php", {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { console.warn("[ROTOWIRE] Status:", res.status); return injuryData; }
    const html = await res.text();
    const injuries: InjuredPlayer[] = [];
    const rowRe = /<tr[^>]*class="[^"]*injured-report[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const row = rowMatch[1];
      const cells: string[] = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(row)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim());
      }
      if (cells.length >= 5) {
        injuries.push({ name: cells[0], team: cells[1], position: cells[2] ?? "", injury: cells[3] ?? "", status: cells[4] ?? "" });
      }
    }
    if (injuries.length === 0) {
      const altRowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let altMatch: RegExpExecArray | null;
      while ((altMatch = altRowRe.exec(html)) !== null && injuries.length < 200) {
        const row = altMatch[1];
        if (!row.includes("player-name") && !row.includes("injury")) continue;
        const cells: string[] = [];
        const cellRe2 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cm: RegExpExecArray | null;
        while ((cm = cellRe2.exec(row)) !== null) {
          cells.push(cm[1].replace(/<[^>]+>/g, "").trim());
        }
        if (cells.length >= 4 && cells[0].length > 2) {
          injuries.push({ name: cells[0], team: cells[1] ?? "", position: cells[2] ?? "", injury: cells[3] ?? "", status: cells[4] ?? "Questionable" });
        }
      }
    }
    console.log("[ROTOWIRE] Parsed", injuries.length, "injuries");
    injuryData = injuries;
    injuryFetchedAt = Date.now();
    return injuries;
  } catch (err: any) {
    console.warn("[ROTOWIRE] Error:", err.message);
    return injuryData;
  }
}

export function getTeamInjuryImpact(teamName: string, allInjuries: InjuredPlayer[] | null): InjuryImpact | null {
  if (!allInjuries?.length) return null;
  const teamInjuries = allInjuries.filter(p => teamsPartialMatch(p.team, teamName));
  if (!teamInjuries.length) return null;
  const out = teamInjuries.filter(p => p.status === "Out" || p.status === "Doubtful");
  return {
    injuries: teamInjuries,
    out: out.length,
    hasKeyPlayerOut: out.length > 0,
    summary: out.length > 0 ? `${out.length} player(s) out/doubtful` : "Healthy",
  };
}

// ── STEP 9: Enrichment Orchestrator ───────────────────────────────────────────

export async function enrichNCAABGameFull(
  gameId: string,
  homeTeam: string,
  awayTeam: string,
  liveLine: number | null,
  espnStats: { home: { ppg: number; oppPpg: number } | null; away: { ppg: number; oppPpg: number } | null } | null
): Promise<EnrichedGameData> {
  const cached = enrichmentCache.get(gameId);
  if (cached && Date.now() - cached.fetchedAt < ENRICH_CACHE_TTL) {
    console.log("[ENRICH] Cache hit:", gameId);
    return cached.data;
  }

  console.log("[ENRICH] Full enrichment:", homeTeam, "vs", awayTeam);

  const [homeTorvik, awayTorvik, anData, viData, injuries] = await Promise.allSettled([
    fetchBartTorvik(homeTeam),
    fetchBartTorvik(awayTeam),
    fetchActionNetwork(homeTeam, awayTeam),
    fetchVegasInsider(homeTeam, awayTeam),
    ensureInjuryData(),
  ]);

  const val = <T>(r: PromiseSettledResult<T>): T | null => r.status === "fulfilled" ? r.value : null;

  const torvik = { home: val(homeTorvik), away: val(awayTorvik) };
  const an = val(anData);
  const vi = val(viData);
  const allInjuries = val(injuries) ?? [];

  const homeInjury = getTeamInjuryImpact(homeTeam, allInjuries);
  const awayInjury = getTeamInjuryImpact(awayTeam, allInjuries);

  const sources: string[] = [];
  if (torvik.home || torvik.away) sources.push("BartTorvik");
  if (an) sources.push("ActionNetwork");
  if (vi) sources.push("VegasInsider");
  if (allInjuries.length > 0) sources.push("Rotowire");

  console.log("[ENRICH] Sources loaded:", {
    tolvikHome: !!torvik.home,
    tolvikAway: !!torvik.away,
    actionNetwork: !!an,
    vegasInsider: !!vi,
    injuries: allInjuries.length,
  });

  const composite = buildCompositeEngine({ torvik, actionNetwork: an, espnStats, injuries: { home: homeInjury, away: awayInjury } }, liveLine);

  const result: EnrichedGameData = {
    homeTeam,
    awayTeam,
    torvik,
    actionNetwork: an,
    vegasInsider: vi,
    injuries: { home: homeInjury, away: awayInjury, all: allInjuries },
    composite,
    sources,
    fetchedAt: Date.now(),
  };

  enrichmentCache.set(gameId, { data: result, fetchedAt: Date.now() });
  return result;
}

// ── STEP 10: Composite Engine ──────────────────────────────────────────────────

function buildCompositeEngine(
  enriched: {
    torvik: { home: TorvikStats | null; away: TorvikStats | null };
    actionNetwork: ActionNetworkData | null;
    espnStats: { home: { ppg: number; oppPpg: number } | null; away: { ppg: number; oppPpg: number } | null } | null;
    injuries: { home: InjuryImpact | null; away: InjuryImpact | null };
  },
  liveLine: number | null
): CompositeEngineResult | null {
  if (!liveLine) return null;

  const signals: CompositeSignal[] = [];
  let projTotal: number | null = null;

  const ht = enriched.torvik.home;
  const at = enriched.torvik.away;

  if (ht?.tempo && at?.tempo && ht?.adjO && at?.adjD && at?.adjO && ht?.adjD) {
    const possessions = (ht.tempo + at.tempo) / 2;
    const homeExpPts = ((ht.adjO + at.adjD) / 2 / 100) * possessions;
    const awayExpPts = ((at.adjO + ht.adjD) / 2 / 100) * possessions;
    const torvikTotal = homeExpPts + awayExpPts;
    console.log("[COMPOSITE] Torvik:", homeExpPts.toFixed(1), "+", awayExpPts.toFixed(1), "=", torvikTotal.toFixed(1));
    signals.push({ name: "BartTorvik Efficiency", projTotal: torvikTotal, weight: 4.0, diff: torvikTotal - liveLine });
    projTotal = torvikTotal;
  }

  const hs = enriched.espnStats?.home;
  const as_ = enriched.espnStats?.away;
  if (hs?.ppg && as_?.ppg && hs?.oppPpg && as_?.oppPpg) {
    const espnTotal = ((hs.ppg + as_.oppPpg) / 2) + ((as_.ppg + hs.oppPpg) / 2);
    signals.push({ name: "ESPN Pace Model", projTotal: espnTotal, weight: 2.0, diff: espnTotal - liveLine });
    if (!projTotal) projTotal = espnTotal;
  }

  const an = enriched.actionNetwork;
  if (an?.openTotal != null && an?.total != null) {
    const move = an.total - an.openTotal;
    signals.push({ name: "Line Movement", projTotal: null, weight: 1.5, diff: move * 0.5 });
  }

  if (an?.overPct != null && an?.underPct != null) {
    const publicBias = an.overPct - 50;
    signals.push({ name: "Public Fade", projTotal: null, weight: 0.5, diff: -publicBias * 0.1 });
  }

  let injuryAdj = 0;
  if ((enriched.injuries.home?.out ?? 0) > 0) injuryAdj -= 2.5;
  if ((enriched.injuries.away?.out ?? 0) > 0) injuryAdj -= 2.5;
  if (injuryAdj !== 0) {
    signals.push({ name: "Injury Reduction", projTotal: null, weight: 2.0, diff: injuryAdj });
  }

  if (signals.length === 0) return null;

  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
  const weightedDiff = signals.reduce((s, sig) => s + sig.diff * sig.weight, 0) / totalWeight;
  const finalProj = projTotal ? projTotal + weightedDiff * 0.3 : liveLine + weightedDiff;
  const certaintyMult = Math.min(2.5 + signals.length * 0.5, 5.0);
  const rawProb = 50 + weightedDiff * certaintyMult;
  const maxEdge = Math.min(30 + signals.length * 5, 70);
  const overProb = parseFloat(Math.min(Math.max(rawProb, 100 - maxEdge), maxEdge).toFixed(1));

  console.log("[COMPOSITE] Final:", { signals: signals.length, weightedDiff: weightedDiff.toFixed(2), finalProj: finalProj.toFixed(1), overProb });

  return {
    overProb,
    underProb: parseFloat((100 - overProb).toFixed(1)),
    projTotal: parseFloat(finalProj.toFixed(1)),
    signals,
    sourceCount: signals.length,
    sourceSummary: signals.map(s => s.name).join(", "),
  };
}
