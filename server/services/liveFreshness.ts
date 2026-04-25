export type LiveFreshness = {
  generatedAt: number;
  updatedAt: number;
  source: "engine" | "cache" | "fallback" | "empty";
  stale: boolean;
  ageMs: number;
};

export function buildFreshness(
  updatedAt: number | null | undefined,
  maxFreshMs: number,
): LiveFreshness {
  const now = Date.now();
  const ts = updatedAt ?? 0;
  const ageMs = ts > 0 ? now - ts : Infinity;

  return {
    generatedAt: now,
    updatedAt: ts,
    source: ts > 0 ? "engine" : "empty",
    stale: ts <= 0 || ageMs > maxFreshMs,
    ageMs,
  };
}
