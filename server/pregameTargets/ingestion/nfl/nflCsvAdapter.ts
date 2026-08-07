// PR6 — NFL (nflverse) CSV adapter. Parses the verbatim provider CSV BY COLUMN NAME
// (order-independent), fail-closed: a missing header row, a missing OR duplicated
// required/consumed column, a wrong-width row, or conflicting duplicate keys are all
// rejected — never silently coerced. A blank key is dropped and surfaced in diagnostics;
// byte-identical duplicate rows collapse deterministically. A blank/omitted stat cell is
// `null` (missing), never a fabricated 0.

import {
  NFL_KNOWN_AT_POLICY_VERSION,
  buildNflSourceKey,
  type NflAdapterDiagnostics,
  type NflScheduleAdapterResult,
  type NflScheduleRecord,
  type NflWeeklyAdapterResult,
  type NflWeeklyStatRecord,
} from "./nflSourceContracts";

/** Minimal RFC4180-ish CSV parse: quoted fields, embedded commas, escaped "" quotes,
 *  CRLF/LF. Returns header row + data rows, or null when structurally unusable. */
export function parseCsv(text: unknown): { headers: string[]; rows: string[][] } | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") pushField();
    else if (c === "\n") pushRow();
    else if (c === "\r") { /* swallow; \n handles the row */ }
    else field += c;
  }
  // Trailing field/row (no final newline).
  if (field !== "" || row.length > 0) pushRow();
  if (rows.length === 0) return null;
  const headers = rows[0];
  return { headers, rows: rows.slice(1) };
}

const REQUIRED_WEEKLY = ["player_id", "season", "week"] as const;
// Team is resolved from recent_team OR team; both are consumed (either may be absent).
const CONSUMED_WEEKLY = ["player_id", "season", "week", "recent_team", "team", "position", "targets", "receptions", "receiving_yards", "carries", "rushing_yards"] as const;

const REQUIRED_SCHEDULE = ["game_id", "season", "week", "gameday"] as const;
const CONSUMED_SCHEDULE = ["game_id", "season", "week", "gameday", "home_team", "away_team"] as const;

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "" || t.toUpperCase() === "NA" || t.toUpperCase() === "NULL") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function str(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" || t.toUpperCase() === "NA" ? null : t;
}

/** Resolve column indices by name; detect duplicate consumed headers + missing required. */
function resolveHeaders(headers: string[], required: readonly string[], consumed: readonly string[]):
  | { ok: true; idx: Record<string, number> }
  | { ok: false } {
  const idx: Record<string, number> = {};
  const seen = new Set<string>();
  const dup = new Set<string>();
  headers.forEach((h, i) => {
    if (typeof h !== "string") return;
    const key = h.trim().toLowerCase();
    if (seen.has(key)) dup.add(key);
    seen.add(key);
    idx[key] = i;
  });
  if (consumed.some((k) => dup.has(k))) return { ok: false }; // ambiguous duplicate consumed header
  if (required.some((k) => idx[k] === undefined)) return { ok: false }; // missing required header
  return { ok: true, idx };
}

export interface ParseNflWeeklyArgs { season: number; sourceKey: string; rawPayload: unknown; fetchedAt: string; sourcePublishedAt?: string | null }

export function parseNflWeeklyStats(args: ParseNflWeeklyArgs): NflWeeklyAdapterResult {
  const fail = (reason: "empty_result" | "incomplete_response" | "conflicting_rows" | "malformed"): NflWeeklyAdapterResult =>
    ({ ok: false, kind: "nflverse_weekly_stats", sourceKey: args.sourceKey, season: args.season, reason, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt });

  const parsed = parseCsv(args.rawPayload);
  if (parsed === null) return fail("malformed");
  const hres = resolveHeaders(parsed.headers, REQUIRED_WEEKLY, CONSUMED_WEEKLY);
  if (!hres.ok) return fail("incomplete_response");
  const { idx } = hres;
  const width = parsed.headers.length;
  const get = (row: string[], key: string): string | undefined => (idx[key] === undefined ? undefined : row[idx[key]]);

  const byKey = new Map<string, { record: NflWeeklyStatRecord; sig: string }>();
  const diagnostics: NflAdapterDiagnostics = { blankKeyRows: 0, duplicateRowsCollapsed: 0 };
  for (const row of parsed.rows) {
    if (row.length !== width) return fail("incomplete_response"); // wrong-width row (truncated/garbage)
    const playerId = (get(row, "player_id") ?? "").trim();
    const seasonN = num(get(row, "season"));
    const weekN = num(get(row, "week"));
    if (playerId === "" || seasonN === null || weekN === null) { diagnostics.blankKeyRows++; continue; }
    const record: NflWeeklyStatRecord = {
      playerId,
      season: seasonN,
      week: weekN,
      teamTricode: str(get(row, "recent_team")) ?? str(get(row, "team")),
      position: str(get(row, "position")),
      targets: num(get(row, "targets")),
      receptions: num(get(row, "receptions")),
      receivingYards: num(get(row, "receiving_yards")),
      carries: num(get(row, "carries")),
      rushingYards: num(get(row, "rushing_yards")),
      gameDateIso: null, // resolved by the schedule join in the feature builder
      timestamps: {
        sourceEffectiveAt: "", // set once the game date is resolved
        sourcePublishedAt: args.sourcePublishedAt ?? null,
        fetchedAt: args.fetchedAt,
        knownAtPolicyVersion: NFL_KNOWN_AT_POLICY_VERSION,
      },
    };
    const sig = JSON.stringify(CONSUMED_WEEKLY.map((k) => get(row, k) ?? null));
    const key = `${playerId}|${seasonN}|${weekN}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.sig !== sig) return fail("conflicting_rows");
      diagnostics.duplicateRowsCollapsed++;
      continue;
    }
    byKey.set(key, { record, sig });
  }
  const records = Array.from(byKey.values()).map((v) => v.record);
  if (records.length === 0) return fail("empty_result");
  return { ok: true, kind: "nflverse_weekly_stats", sourceKey: args.sourceKey, season: args.season, records, diagnostics, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt };
}

export interface ParseNflScheduleArgs { season: number; sourceKey: string; rawPayload: unknown; fetchedAt: string }

export function parseNflSchedule(args: ParseNflScheduleArgs): NflScheduleAdapterResult {
  const fail = (reason: "empty_result" | "incomplete_response" | "conflicting_rows" | "malformed"): NflScheduleAdapterResult =>
    ({ ok: false, kind: "nflverse_schedule", sourceKey: args.sourceKey, season: args.season, reason, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt });

  const parsed = parseCsv(args.rawPayload);
  if (parsed === null) return fail("malformed");
  const hres = resolveHeaders(parsed.headers, REQUIRED_SCHEDULE, CONSUMED_SCHEDULE);
  if (!hres.ok) return fail("incomplete_response");
  const { idx } = hres;
  const width = parsed.headers.length;
  const get = (row: string[], key: string): string | undefined => (idx[key] === undefined ? undefined : row[idx[key]]);

  const byKey = new Map<string, { record: NflScheduleRecord; sig: string }>();
  const diagnostics: NflAdapterDiagnostics = { blankKeyRows: 0, duplicateRowsCollapsed: 0 };
  for (const row of parsed.rows) {
    if (row.length !== width) return fail("incomplete_response");
    const gameId = (get(row, "game_id") ?? "").trim();
    const seasonN = num(get(row, "season"));
    const weekN = num(get(row, "week"));
    const gameday = (get(row, "gameday") ?? "").trim();
    if (gameId === "" || seasonN === null || weekN === null || gameday === "") { diagnostics.blankKeyRows++; continue; }
    const record: NflScheduleRecord = { gameId, season: seasonN, week: weekN, gameDate: gameday, homeTeam: str(get(row, "home_team")), awayTeam: str(get(row, "away_team")) };
    const sig = JSON.stringify(CONSUMED_SCHEDULE.map((k) => get(row, k) ?? null));
    const existing = byKey.get(gameId);
    if (existing) {
      if (existing.sig !== sig) return fail("conflicting_rows");
      diagnostics.duplicateRowsCollapsed++;
      continue;
    }
    byKey.set(gameId, { record, sig });
  }
  const records = Array.from(byKey.values()).map((v) => v.record);
  if (records.length === 0) return fail("empty_result");
  return { ok: true, kind: "nflverse_schedule", sourceKey: args.sourceKey, season: args.season, records, diagnostics, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt };
}

/** nflverse gameday ("2024-09-08") → ISO instant anchor, or a stable invalid tag. */
export function gamedayToIso(gameday: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameday.trim());
  if (!m) return "invalid-game-date";
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
}
