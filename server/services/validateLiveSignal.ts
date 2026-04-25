export function validateLiveSignalForDisplay(
  signal: any,
): { valid: boolean; reason?: string } {
  if (!signal) return { valid: false, reason: "missing_signal" };
  if (!signal.playerName) return { valid: false, reason: "missing_player" };
  if (!signal.market) return { valid: false, reason: "missing_market" };

  const lineN = Number(signal.line);
  if (!Number.isFinite(lineN)) return { valid: false, reason: "bad_line" };
  if (lineN < 0) return { valid: false, reason: "negative_line" };

  const projN = Number(signal.projection);
  if (!Number.isFinite(projN)) return { valid: false, reason: "bad_projection" };
  if (projN < 0) return { valid: false, reason: "negative_projection" };

  const probRaw = signal.probability ?? signal.engineProbability;
  const probN = Number(probRaw);
  if (!Number.isFinite(probN)) return { valid: false, reason: "bad_probability" };
  if (probN < 0 || probN > 100) return { valid: false, reason: "out_of_range_probability" };

  if (!signal.sportsbook && !signal.book && !signal.source) return { valid: false, reason: "missing_sportsbook" };
  return { valid: true };
}
