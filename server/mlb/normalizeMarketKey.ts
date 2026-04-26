export function normalizeMlbMarketKey(market: string | null | undefined): string {
  if (!market) return "";
  const m = String(market).trim();
  if (m === "hr") return "home_runs";
  if (m === "pitcher_k") return "pitcher_strikeouts";
  if (m === "outs_recorded") return "pitcher_outs";
  return m;
}
