// Pure helpers for requireMLBAccess's free-preview fallback (server/auth.ts).
// Deliberately dependency-free (no storage/db import) so they stay
// unit-testable without a live database, unlike auth.ts itself.
//
// Correction 5 (access-control audit): the original gameId-less fallback
// collapsed EVERY gameId-less route onto one single flat key ("mlb-general").
// tryConsumeGamePlayToday's daily limit (MLB_PREVIEW_LIMIT) is a real,
// atomic, per-user cap on DISTINCT unlocked keys — but a single shared key
// across N different endpoints means unlocking ANY ONE of them (e.g.
// visiting /api/mlb/alerts) makes isGameUnlockedToday(userId, "mlb-general")
// true for ALL the others too, for the rest of the day, with ZERO further
// budget consumed. That is "2 free previews" in name only — in practice it
// is "1 real preview, then unlimited free access to every other gameId-less
// route" (confirmed: /api/mlb/props accepts arbitrary player/market/line
// query-or-body values with no gameId requirement at all, so once
// "mlb-general" is unlocked by any other route, that becomes an unlimited
// free lookup tool too).
//
// Fix: gameId always wins (existing, correct per-game behavior, unchanged).
// Otherwise, the key is scoped to the SPECIFIC route (method + registered
// path pattern) plus a fingerprint of that route's own real path params,
// query params, AND body (playerId, sessionDate, batter/pitcher name, the
// pregame/mound "record" endpoints' ?date=, ...) when any are present — so
// visiting one route never unlocks a different one, and visiting player A's
// history (or day X's record) never unlocks player B's (or day Y's). A
// route with none of these at all (a true board/dashboard snapshot with
// nothing to distinguish by) keys on its route pattern alone — semantically
// "this one dashboard is your 1 of 2 previews today", matching the existing
// per-game semantic.
//
// A small, explicit set of routes are excluded from the free-preview
// fallback ENTIRELY (see MLB_PREVIEW_DENYLIST_ROUTES) — raw
// odds/calculation tools whose real "identity" is free-form query/body
// data (arbitrary player+market+line combinations), not a small number of
// stable resources. Fingerprinting those would either still be exploitable
// (a client can vary an irrelevant field to look "new" — bounded by the
// global 2/day cap, so not an access bypass, but see below) or would burn
// a free user's entire daily budget within seconds of ordinary polling
// (these are typically re-queried with live, ever-changing stats). Either
// way there is no coherent "free preview" of a calculator — real paid MLB
// access is required, full stop, regardless of whether a gameId happens to
// be present in the request (client-supplied and trivially omittable, so it
// is never treated as a security boundary).

import { createHash } from "node:crypto";

/**
 * Routes whose real "identity" is unbounded/free-form (arbitrary
 * player+market+line query/body combinations) rather than a small number of
 * genuine stable resources — the "raw odds/research" endpoints Correction 5
 * calls out. Denied for the free-preview fallback unconditionally; access
 * requires an actual paid MLB tier (or admin). Keyed as "METHOD path" using
 * the route's REGISTERED pattern (e.g. the literal string passed to
 * app.get/app.post), never a resolved/substituted path.
 */
export const MLB_PREVIEW_DENYLIST_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/mlb/props",
  "POST /api/mlb/calculate",
  "POST /api/mlb/calculate-manual",
  "GET /api/mlb/odds",
]);

export function isMlbPreviewDenylistedRoute(method: string, routePattern: string): boolean {
  return MLB_PREVIEW_DENYLIST_ROUTES.has(`${method.toUpperCase()} ${routePattern}`);
}

/**
 * Deterministic, order-independent fingerprint of a route's real request
 * inputs (path params like { playerId: "123" }, query params like
 * { date: "2026-07-01" }, or a POST body). Multiple sources are merged
 * (params, then query, then body — a real name collision across sources is
 * not expected in practice, and any consistent precedence is fine since the
 * goal is only "different real input -> different fingerprint", not a
 * canonical single source of truth). Empty/undefined-only input fingerprints
 * to "" (never a non-empty hash of nothing) so a genuinely input-less route
 * keys on its route pattern alone, with no meaningless suffix.
 */
export function fingerprintRouteParams(...sources: Array<Record<string, unknown> | null | undefined>): string {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      if (source[key] !== undefined && source[key] !== null) merged[key] = source[key];
    }
  }
  const keys = Object.keys(merged).sort();
  if (keys.length === 0) return "";
  const normalized = keys.map((k) => `${k}=${JSON.stringify(merged[k])}`).join("&");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export interface MlbPreviewRouteContext {
  method: string;
  /** The route's REGISTERED pattern (e.g. req.route.path — "/api/mlb/player-history/:playerId"), never a resolved path with real values substituted. */
  routePattern: string;
  params: Record<string, unknown> | null | undefined;
  query?: Record<string, unknown> | null | undefined;
  body?: Record<string, unknown> | null | undefined;
}

/**
 * Resolves the storage key requireMLBAccess's free-preview fallback
 * consumes/checks against. Never a single flat string shared across every
 * gameId-less route — see file header for why that was exploitable.
 */
export function resolveMlbPreviewConsumeKey(
  gameId: string | null | undefined,
  route: MlbPreviewRouteContext,
): string {
  if (gameId) return `mlb-${gameId}`;
  const routeKey = `${route.method.toUpperCase()} ${route.routePattern}`;
  const fingerprint = fingerprintRouteParams(route.params, route.query, route.body);
  return fingerprint ? `mlb-route:${routeKey}:${fingerprint}` : `mlb-route:${routeKey}`;
}
