// PR5 — NBA ingestion: fail-closed execution flag (scaffolding).
//
// This flag ADDITIONALLY guards ingestion; it is NOT a substitute for explicit
// invocation. Normal server startup never triggers ingestion regardless of this
// flag — ingestion runs only from the explicit CLI/manual runner. Default OFF.

export const NBA_PREGAME_INGEST_ENV = "NBA_PREGAME_INGEST_ENABLED" as const;

const AFFIRMATIVE = new Set(["true", "1", "on", "yes"]);

export function parseNbaIngestFlag(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return AFFIRMATIVE.has(raw.trim().toLowerCase());
}

export function isNbaIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseNbaIngestFlag(env[NBA_PREGAME_INGEST_ENV]);
}
