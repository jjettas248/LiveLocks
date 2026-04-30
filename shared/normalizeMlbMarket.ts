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
