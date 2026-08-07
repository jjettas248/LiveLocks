// PR5 — NBA ingestion: raw playergamelog/teamgamelog → normalized records.
//
// Pure transform. Detects incomplete/failed responses and NEVER fabricates a row
// or a zero: a missing resultSet/header/rowSet → `incomplete_response`; zero rows
// → `empty_result`; a provider field that is absent/null → the stat is `null`
// (→ `missing` downstream), distinct from a genuine 0 (→ `observed_zero`). No
// line/price/EV/outcome field is ever read or produced.

import {
  NBA_KNOWN_AT_POLICY_VERSION,
  type NbaAdapterResult,
  type NbaNormalizedGameRecord,
  type NbaSourceKind,
} from "./nbaSourceContracts";

/** NBA season string ("2025-26") → integer season (2026 = the end year). */
export function nbaSeasonIntFromString(s: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const start = Number(m[1]);
  return start + 1;
}

/** Integer season (2026) → NBA season string ("2025-26"). */
export function nbaSeasonStringFromInt(seasonInt: number): string | null {
  if (!Number.isInteger(seasonInt) || seasonInt < 1947) return null;
  const start = seasonInt - 1;
  return `${start}-${String(seasonInt % 100).padStart(2, "0")}`;
}

function teamTricodeFromMatchup(matchup: string): string | null {
  // "LAL vs. BOS" / "LAL @ BOS" → the player's/team's own tricode is the first token.
  const m = /^([A-Z]{2,4})\b/.exec(String(matchup ?? "").trim());
  return m ? m[1] : null;
}

/** Finite number from a raw cell, or null when absent/blank/non-finite (never coerced to 0). */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface ParseNbaGameLogArgs {
  kind: NbaSourceKind;
  season: number; // integer season (e.g. 2026)
  sourceKey: string;
  entityNativeId: string;
  rawPayload: unknown;
  fetchedAt: string; // ISO instant of the real fetch
}

/** Parse a raw NBA Stats game-log response into normalized records (or a typed failure). */
export function parseNbaGameLog(args: ParseNbaGameLogArgs): NbaAdapterResult {
  const fail = (reason: "empty_result" | "incomplete_response" | "malformed"): NbaAdapterResult =>
    ({
      ok: false as const,
      kind: args.kind,
      sourceKey: args.sourceKey,
      season: args.season,
      entityNativeId: args.entityNativeId,
      reason,
      rawPayload: args.rawPayload,
      fetchedAt: args.fetchedAt,
    });

  const payload = args.rawPayload as { resultSets?: Array<{ headers?: unknown; rowSet?: unknown }> } | null | undefined;
  if (payload === null || payload === undefined || typeof payload !== "object") return fail("malformed");
  const rs = Array.isArray(payload.resultSets) ? payload.resultSets[0] : undefined;
  if (rs === undefined) return fail("incomplete_response");
  const headers = rs.headers;
  const rowSet = rs.rowSet;
  if (!Array.isArray(headers) || !Array.isArray(rowSet)) return fail("incomplete_response");
  if (rowSet.length === 0) return fail("empty_result");

  // Resolve columns BY NAME (order-independent). Detect DUPLICATE required
  // headers — an ambiguous schema is a fail-closed break, not a silent
  // last-wins. Unknown extra headers are ignored (we only read named columns,
  // per the source manifest). A missing REQUIRED header also fails closed.
  const idx: Record<string, number> = {};
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  headers.forEach((h, i) => {
    if (typeof h !== "string") return;
    const key = h.toUpperCase();
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    idx[key] = i;
  });
  // Structural anchors that MUST exist to identify a record and place it in time.
  // MIN/PTS/etc. are optional per-row (absence → a missing reading, not a failure).
  const REQUIRED = ["GAME_ID", "GAME_DATE"];
  if (REQUIRED.some((k) => duplicates.has(k))) return fail("incomplete_response"); // ambiguous duplicate required header
  if (REQUIRED.some((k) => idx[k] === undefined)) return fail("incomplete_response"); // missing required header
  const get = (row: unknown[], key: string): unknown => {
    const i = idx[key];
    return i === undefined ? undefined : row[i];
  };

  const records: NbaNormalizedGameRecord[] = [];
  for (const raw of rowSet) {
    if (!Array.isArray(raw)) return fail("malformed");
    const gameId = String(get(raw, "GAME_ID") ?? "").trim();
    if (gameId === "") continue; // a row with no game id cannot be an observation
    records.push({
      gameId,
      gameDate: String(get(raw, "GAME_DATE") ?? "").trim(),
      teamTricode: teamTricodeFromMatchup(String(get(raw, "MATCHUP") ?? "")),
      minutes: num(get(raw, "MIN")),
      points: num(get(raw, "PTS")),
      rebounds: num(get(raw, "REB")),
      assists: num(get(raw, "AST")),
      threePointersMade: num(get(raw, "FG3M")),
      timestamps: {
        sourceEffectiveAt: gameDateToIso(String(get(raw, "GAME_DATE") ?? "")),
        sourcePublishedAt: null, // endpoint exposes none
        fetchedAt: args.fetchedAt,
        knownAtPolicyVersion: NBA_KNOWN_AT_POLICY_VERSION,
      },
    });
  }
  if (records.length === 0) return fail("empty_result");

  return {
    ok: true,
    kind: args.kind,
    sourceKey: args.sourceKey,
    season: args.season,
    entityNativeId: args.entityNativeId,
    records,
    rawPayload: args.rawPayload,
    fetchedAt: args.fetchedAt,
  };
}

/**
 * NBA Stats GAME_DATE ("2024-01-15" or "JAN 15, 2024") → an ISO instant at UTC
 * midnight of that calendar date. This is the SOURCE-EFFECTIVE anchor (validAt),
 * explicitly NOT a knownAt. Returns the raw string tagged invalid if unparseable
 * (the feature builder treats an unparseable effective date as missing).
 */
export function gameDateToIso(gameDate: string): string {
  const s = String(gameDate ?? "").trim();
  // ISO date form.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`;
  // "MON DD, YYYY" form used by some endpoints.
  const months: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const m = /^([A-Z]{3})\s+(\d{1,2}),\s+(\d{4})$/.exec(s.toUpperCase());
  if (m && months[m[1]]) return `${m[3]}-${months[m[1]]}-${String(Number(m[2])).padStart(2, "0")}T00:00:00Z`;
  return "invalid-game-date";
}
