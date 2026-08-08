// PR6 — NFL (nflverse) CSV adapter. Parses the verbatim provider CSV BY COLUMN NAME
// (order-independent), fail-closed. Provider-native `game_id` is the canonical game
// identity. Season/dataset identity is ENFORCED: every accepted weekly row must belong to
// the requested season; a multi-season schedule file is deterministically filtered to the
// requested season. Malformed integer identifiers fail closed (never silently normalized);
// a blank/omitted STAT cell is `null` (missing), never a fabricated 0.

import {
  NFL_KNOWN_AT_POLICY_VERSION, NFL_MIN_WEEK, NFL_MAX_WEEK,
  type NflAdapterDiagnostics, type NflScheduleAdapterResult, type NflScheduleRecord,
  type NflWeeklyAdapterResult, type NflWeeklyStatRecord,
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
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") pushField();
    else if (c === "\n") pushRow();
    else if (c === "\r") { /* swallow */ }
    else field += c;
  }
  if (field !== "" || row.length > 0) pushRow();
  if (rows.length === 0) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

// Weekly (nflverse-data stats_player / stats_player_week_{season}.csv).
const REQUIRED_WEEKLY = ["player_id", "game_id", "season", "week", "season_type", "team"] as const;
const CONSUMED_WEEKLY = ["player_id", "game_id", "season", "week", "season_type", "team", "opponent_team", "position", "targets", "receptions", "receiving_yards", "carries", "rushing_yards"] as const;

// Schedule (nfldata data/games.csv, multi-season).
const REQUIRED_SCHEDULE = ["game_id", "season", "week", "gameday"] as const;
const CONSUMED_SCHEDULE = ["game_id", "season", "week", "gameday", "home_team", "away_team", "game_type"] as const;

/** Strict integer parse — returns null on any non-integer (never silently normalizes). */
function intOrNull(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "" || !/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}
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

function resolveHeaders(headers: string[], required: readonly string[], consumed: readonly string[]): { ok: true; idx: Record<string, number> } | { ok: false } {
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
  if (consumed.some((k) => dup.has(k))) return { ok: false };
  if (required.some((k) => idx[k] === undefined)) return { ok: false };
  return { ok: true, idx };
}

export interface ParseNflWeeklyArgs { requestedSeason: number; sourceKey: string; rawPayload: unknown; fetchedAt: string; sourcePublishedAt?: string | null }

export function parseNflWeeklyStats(args: ParseNflWeeklyArgs): NflWeeklyAdapterResult {
  const fail = (reason: "empty_result" | "incomplete_response" | "conflicting_rows" | "season_mismatch" | "invalid_identifier" | "malformed"): NflWeeklyAdapterResult =>
    ({ ok: false, kind: "nflverse_weekly_stats", sourceKey: args.sourceKey, season: args.requestedSeason, reason, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt });

  const parsed = parseCsv(args.rawPayload);
  if (parsed === null) return fail("malformed");
  const hres = resolveHeaders(parsed.headers, REQUIRED_WEEKLY, CONSUMED_WEEKLY);
  if (!hres.ok) return fail("incomplete_response");
  const { idx } = hres;
  const width = parsed.headers.length;
  const get = (row: string[], key: string): string | undefined => (idx[key] === undefined ? undefined : row[idx[key]]);

  const diagnostics: NflAdapterDiagnostics = { rawRows: parsed.rows.length, blankKeyRows: 0, duplicateRowsCollapsed: 0, seasonFilteredRows: 0 };
  const byKey = new Map<string, { record: NflWeeklyStatRecord; sig: string }>();
  for (const row of parsed.rows) {
    if (row.length !== width) return fail("incomplete_response");
    const playerId = (get(row, "player_id") ?? "").trim();
    const gameId = (get(row, "game_id") ?? "").trim();
    if (playerId === "" || gameId === "") { diagnostics.blankKeyRows++; continue; }
    // Identity integers must be valid — never silently normalized.
    const seasonN = intOrNull(get(row, "season"));
    const weekN = intOrNull(get(row, "week"));
    if (seasonN === null || weekN === null) return fail("invalid_identifier");
    if (weekN < NFL_MIN_WEEK || weekN > NFL_MAX_WEEK) return fail("invalid_identifier");
    // Dataset identity: every accepted row belongs to the requested season.
    if (seasonN !== args.requestedSeason) return fail("season_mismatch");
    const seasonType = (get(row, "season_type") ?? "").trim();
    if (seasonType === "") { diagnostics.blankKeyRows++; continue; }

    const record: NflWeeklyStatRecord = {
      playerId, gameId, season: seasonN, week: weekN, seasonType,
      teamTricode: str(get(row, "team")), opponentTricode: str(get(row, "opponent_team")), position: str(get(row, "position")),
      targets: num(get(row, "targets")), receptions: num(get(row, "receptions")), receivingYards: num(get(row, "receiving_yards")),
      carries: num(get(row, "carries")), rushingYards: num(get(row, "rushing_yards")),
      timestamps: { sourceEffectiveAt: "", sourcePublishedAt: args.sourcePublishedAt ?? null, fetchedAt: args.fetchedAt, knownAtPolicyVersion: NFL_KNOWN_AT_POLICY_VERSION },
    };
    const sig = JSON.stringify(CONSUMED_WEEKLY.map((k) => get(row, k) ?? null));
    const key = `${playerId}|${gameId}`; // a player has one stat row per game
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
  return { ok: true, kind: "nflverse_weekly_stats", sourceKey: args.sourceKey, season: args.requestedSeason, records, diagnostics, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt };
}

export interface ParseNflScheduleArgs { requestedSeason: number; sourceKey: string; rawPayload: unknown; fetchedAt: string }

/** Parse the MULTI-SEASON schedule CSV and deterministically FILTER to the requested season. */
export function parseNflSchedule(args: ParseNflScheduleArgs): NflScheduleAdapterResult {
  const fail = (reason: "empty_result" | "incomplete_response" | "conflicting_rows" | "invalid_identifier" | "malformed"): NflScheduleAdapterResult =>
    ({ ok: false, kind: "nflverse_schedule", sourceKey: args.sourceKey, season: args.requestedSeason, reason, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt });

  const parsed = parseCsv(args.rawPayload);
  if (parsed === null) return fail("malformed");
  const hres = resolveHeaders(parsed.headers, REQUIRED_SCHEDULE, CONSUMED_SCHEDULE);
  if (!hres.ok) return fail("incomplete_response");
  const { idx } = hres;
  const width = parsed.headers.length;
  const get = (row: string[], key: string): string | undefined => (idx[key] === undefined ? undefined : row[idx[key]]);

  const diagnostics: NflAdapterDiagnostics = { rawRows: parsed.rows.length, blankKeyRows: 0, duplicateRowsCollapsed: 0, seasonFilteredRows: 0 };
  const byKey = new Map<string, { record: NflScheduleRecord; sig: string }>();
  for (const row of parsed.rows) {
    if (row.length !== width) return fail("incomplete_response");
    const gameId = (get(row, "game_id") ?? "").trim();
    const gameday = (get(row, "gameday") ?? "").trim();
    if (gameId === "") { diagnostics.blankKeyRows++; continue; }
    const seasonN = intOrNull(get(row, "season"));
    const weekN = intOrNull(get(row, "week"));
    if (seasonN === null || weekN === null) return fail("invalid_identifier");
    if (seasonN !== args.requestedSeason) { diagnostics.seasonFilteredRows++; continue; } // deterministic season filter
    if (gameday === "") { diagnostics.blankKeyRows++; continue; }
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
  if (records.length === 0) return fail("empty_result"); // requested season has no schedule rows
  return { ok: true, kind: "nflverse_schedule", sourceKey: args.sourceKey, season: args.requestedSeason, records, diagnostics, rawPayload: args.rawPayload, fetchedAt: args.fetchedAt };
}

/** nflverse gameday ("2024-09-08") → ISO instant anchor, or a stable invalid tag. */
export function gamedayToIso(gameday: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameday.trim());
  if (!m) return "invalid-game-date";
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
}
