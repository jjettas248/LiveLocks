// PR6 — NFL ingestion: fail-closed execution flag (scaffolding).
//
// ADDITIONALLY guards ingestion; NOT a substitute for explicit invocation. Normal server
// startup NEVER triggers ingestion regardless of this flag — ingestion runs only from the
// explicit CLI/manual runner. Default OFF. (Distinct from NFL_ENTITLEMENT_ENABLED, which
// gates the hasNFL access mapping — see server/utils/access.ts.)

export const NFL_PREGAME_INGEST_ENV = "NFL_PREGAME_INGEST_ENABLED" as const;
const AFFIRMATIVE = new Set(["true", "1", "on", "yes"]);

export function parseNflIngestFlag(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return AFFIRMATIVE.has(raw.trim().toLowerCase());
}

export function isNflIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseNflIngestFlag(env[NFL_PREGAME_INGEST_ENV]);
}
