// Canonical MLB market normalization shared by client + server.
// All inbound market keys (from sportsbook feeds, frontend forms, engine
// outputs, calculator hydration) MUST pass through this function before
// being compared, looked up, or stored. The set of canonical values is
// the union of `ALL_MLB_MARKETS` from `server/mlb/types.ts` plus a few
// composite props the calculator/box score reference directly.

const ALIAS_MAP: Record<string, string> = {
  // Home runs
  hr: "home_runs",
  homer: "home_runs",
  homers: "home_runs",
  homerun: "home_runs",
  home_run: "home_runs",
  home_runs: "home_runs",

  // Pitcher Ks
  pitcher_k: "pitcher_strikeouts",
  pitcher_ks: "pitcher_strikeouts",
  pitcher_strikeout: "pitcher_strikeouts",
  pitcher_strikeouts: "pitcher_strikeouts",
  k: "pitcher_strikeouts",

  // Pitcher outs / IP
  outs_recorded: "pitcher_outs",
  pitching_outs: "pitcher_outs",
  pitcher_outs: "pitcher_outs",

  // Hits + Runs + RBI composite
  hrr: "hrr",
  "h+r+rbi": "hrr",
  "hits+runs+rbi": "hrr",
  "hits+runs+rbis": "hrr",
  hits_runs_rbi: "hrr",
  hits_runs_rbis: "hrr",
  hitsrunsrbi: "hrr",

  // Pass-through canonical values
  hits: "hits",
  total_bases: "total_bases",
  batter_strikeouts: "batter_strikeouts",
  hits_allowed: "hits_allowed",
  walks_allowed: "walks_allowed",
  hr_allowed: "hr_allowed",
  earned_runs: "earned_runs",
};

export function normalizeMlbMarket(input: string | null | undefined): string {
  if (!input) return "";
  const key = String(input).trim().toLowerCase().replace(/\s+/g, "_");
  if (ALIAS_MAP[key]) return ALIAS_MAP[key];
  // Strip leading "batter_" / "pitcher_" duplicates and retry
  const stripped = key.replace(/^batter_|^pitcher_/, "");
  if (ALIAS_MAP[stripped]) return ALIAS_MAP[stripped];
  return key;
}

export function marketsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeMlbMarket(a) === normalizeMlbMarket(b);
}

/**
 * Canonical line-key helper used by both server (resolver, canonicalSignals
 * payload) and client (tuple lookup map). Quantizes the line to a single
 * decimal place so floating-point representations like 1.4999999 and 1.5
 * map to the same bucket, then string-formats with a stable `.toFixed(1)`.
 * Returns the literal `"_"` sentinel when the line is null/undefined.
 */
export function mlbLineKey(line: number | null | undefined): string {
  if (line == null || !Number.isFinite(line)) return "_";
  // Quantize to 1 decimal — sportsbook MLB lines are always at .0 or .5.
  return (Math.round((line as number) * 10) / 10).toFixed(1);
}

/**
 * Build the canonical (player, market, line) tuple key shared by server
 * and client — both must construct lookup keys with this helper so the
 * box score badge and the calculator panel agree on the same tuple.
 */
export function mlbCanonicalTupleKey(
  playerId: string,
  market: string | null | undefined,
  line: number | null | undefined,
): string {
  return `${playerId}|${normalizeMlbMarket(market)}|${mlbLineKey(line)}`;
}
