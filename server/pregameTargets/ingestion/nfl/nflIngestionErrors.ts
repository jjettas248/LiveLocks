// PR6 — NFL ingestion: bounded, sanitized failure records. The runner must NEVER log a
// raw error object, a raw DB driver message, a stack, a connection string, or the raw
// provider payload. These pure helpers turn an arbitrary thrown value into a bounded,
// redacted record safe to print. (Self-contained — no cross-sport import.)

export type NflIngestErrorStage = "fetch_schedule" | "fetch_weekly" | "parse" | "persist" | "unknown";

export interface NflIngestErrorRecord {
  stage: NflIngestErrorStage;
  season: string;
  errorKind: string;
  message: string;
}

const MAX_MESSAGE = 200;
const SENSITIVE_MARKERS = ["://", "player_id", "rowset", "resultset", "bearer ", "password", "pgpassword", "database_url", "connectionstring", "authorization", "secret", "apikey", "api_key", "token="];

export function classifyNflIngestError(err: unknown): string {
  if (err instanceof Error && typeof err.name === "string" && err.name.length > 0) return err.name.slice(0, 40);
  return typeof err;
}

export function sanitizeNflIngestErrorMessage(raw: unknown): string {
  const s = typeof raw === "string" ? raw : raw instanceof Error ? String(raw.message ?? "") : "";
  if (s === "") return "(no message)";
  const lower = s.toLowerCase();
  if (SENSITIVE_MARKERS.some((m) => lower.includes(m))) return "(redacted: message may contain sensitive content)";
  return s.slice(0, MAX_MESSAGE);
}

export function buildNflIngestErrorRecord(args: { stage: NflIngestErrorStage; season: string; err: unknown }): NflIngestErrorRecord {
  return { stage: args.stage, season: args.season, errorKind: classifyNflIngestError(args.err), message: sanitizeNflIngestErrorMessage(args.err) };
}
