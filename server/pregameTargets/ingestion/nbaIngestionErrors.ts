// PR5 — NBA ingestion: bounded, sanitized failure records.
//
// The runner must NEVER log a raw error object, a raw database driver message, a
// stack, a connection string, or the raw provider payload — any of which can carry
// SQL parameters (the immutable snapshot payload is an insert parameter), credentials,
// or internal hostnames. These pure helpers turn an arbitrary thrown value into a
// bounded, redacted record safe to print.

export type IngestErrorStage = "fetch" | "parse" | "persist" | "unknown";

export interface IngestErrorRecord {
  stage: IngestErrorStage;
  playerId: string;
  season: string;
  seasonType: string;
  errorKind: string;
  message: string;
}

const MAX_MESSAGE = 200;

// Markers whose presence means the message may embed a payload / credential /
// connection string / SQL context. If ANY appears we drop the message entirely
// (keeping only the errorKind), rather than trying to surgically excise it.
const SENSITIVE_MARKERS = [
  "://", // any URI incl. postgres://, postgresql://, redis://
  "resultset", // provider payload marker (resultSets)
  "rowset", // provider payload marker (rowSet)
  "bearer ", // auth header
  "password",
  "pgpassword",
  "database_url",
  "connectionstring",
  "authorization",
  "secret",
  "apikey",
  "api_key",
  "token=",
];

/** A stable, non-sensitive error kind (the constructor name), bounded. */
export function classifyIngestError(err: unknown): string {
  if (err instanceof Error && typeof err.name === "string" && err.name.length > 0) {
    return err.name.slice(0, 40);
  }
  return typeof err;
}

/**
 * Redact + bound an error message. If it contains any sensitive marker (URI,
 * payload marker, credential token) the whole message is replaced with a generic
 * notice — a connection string or payload marker can therefore never survive.
 */
export function sanitizeIngestErrorMessage(raw: unknown): string {
  const s = typeof raw === "string" ? raw : raw instanceof Error ? String(raw.message ?? "") : "";
  if (s === "") return "(no message)";
  const lower = s.toLowerCase();
  if (SENSITIVE_MARKERS.some((m) => lower.includes(m))) {
    return "(redacted: message may contain sensitive content)";
  }
  return s.slice(0, MAX_MESSAGE);
}

/** Build the bounded record the runner prints for a failed (player, season). */
export function buildIngestErrorRecord(args: {
  stage: IngestErrorStage;
  playerId: string;
  season: string;
  seasonType: string;
  err: unknown;
}): IngestErrorRecord {
  return {
    stage: args.stage,
    playerId: args.playerId,
    season: args.season,
    seasonType: args.seasonType,
    errorKind: classifyIngestError(args.err),
    message: sanitizeIngestErrorMessage(args.err),
  };
}
