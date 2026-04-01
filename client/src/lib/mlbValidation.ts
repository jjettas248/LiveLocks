export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidMlbSignal(sig: Record<string, any>): boolean {
  if (!sig) return false;
  if (!sig.playerId || !sig.playerName || !sig.market) return false;
  if (!isFiniteNumber(sig.enginePct)) return false;
  if (sig.enginePct < 0 || sig.enginePct > 100) return false;
  if (!sig.recommendedSide || sig.recommendedSide === "NO_EDGE") return false;
  return true;
}

export function filterValidMlbSignals<T extends Record<string, any>>(signals: T[]): T[] {
  return (signals ?? []).filter(isValidMlbSignal);
}
