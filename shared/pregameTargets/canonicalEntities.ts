// PR1 — Canonical entity identity + fail-closed resolution (temporal foundation).
//
// The Pregame Targets program must be able to say, deterministically and for any
// historical decision instant, *exactly which entity a feature refers to*. Native
// provider ids (NBA Stats playerId, team tricode, gameId) are not safe to use
// raw: players are traded, tricodes are reused, and dupes/ambiguity appear in
// historical pulls. This module defines a canonical id scheme and a resolver that
// FAILS CLOSED — an id that cannot be resolved to exactly one entity is rejected,
// never guessed.
//
// PR1 scope: contract + pure resolution logic only. No provider wiring, no NFL
// (the sport union is intentionally single-membered until a later PR adds it).

export const PREGAME_SPORTS = ["nba"] as const;
export type PregameSport = (typeof PREGAME_SPORTS)[number];

export const PREGAME_ENTITY_KINDS = ["player", "team", "game", "market"] as const;
export type PregameEntityKind = (typeof PREGAME_ENTITY_KINDS)[number];

/** A fully-resolved, canonical entity reference. */
export interface CanonicalEntity {
  sport: PregameSport;
  kind: PregameEntityKind;
  /** Provider-native stable id (e.g. NBA Stats playerId), as a string. */
  nativeId: string;
  /** Canonical id string: `${sport}:${kind}:${nativeId}`. */
  canonicalId: string;
  /** Optional human label — display/analytics only, never an identity key. */
  displayName?: string;
}

export const ENTITY_RESOLUTION_FAILURES = [
  "malformed_id", // input didn't parse into sport/kind/nativeId
  "unknown_sport", // sport not in PREGAME_SPORTS
  "unknown_kind", // kind not in PREGAME_ENTITY_KINDS
  "unknown_id", // no candidate matched the native id
  "ambiguous", // more than one candidate matched (trade dupes, reused tricode)
] as const;
export type EntityResolutionFailure = (typeof ENTITY_RESOLUTION_FAILURES)[number];

/** Fail-closed result: either a single resolved entity, or a typed reason. */
export type EntityResolution =
  | { ok: true; entity: CanonicalEntity }
  | { ok: false; reason: EntityResolutionFailure; detail?: string };

const CANONICAL_ID_SEP = ":";

/**
 * Build the canonical id string. The native id is TRIMMED so a provider id with
 * incidental leading/trailing whitespace ("  123 ") cannot split into a separate
 * canonical identity from "123" and break directory joins.
 */
export function buildCanonicalId(
  sport: PregameSport,
  kind: PregameEntityKind,
  nativeId: string,
): string {
  return `${sport}${CANONICAL_ID_SEP}${kind}${CANONICAL_ID_SEP}${nativeId.trim()}`;
}

/**
 * Parse a canonical id string back into parts. Fail-closed: returns null on any
 * structural problem (wrong segment count, empty native id, unknown sport/kind).
 * Native ids themselves may legally contain the separator only if the caller
 * built them that way — we split on the FIRST two separators so the native id
 * keeps any remaining ones.
 */
export function parseCanonicalId(
  canonicalId: string,
): { sport: PregameSport; kind: PregameEntityKind; nativeId: string } | null {
  if (typeof canonicalId !== "string" || canonicalId.length === 0) return null;
  const firstSep = canonicalId.indexOf(CANONICAL_ID_SEP);
  if (firstSep <= 0) return null;
  const secondSep = canonicalId.indexOf(CANONICAL_ID_SEP, firstSep + 1);
  if (secondSep <= firstSep + 1) return null;
  const sport = canonicalId.slice(0, firstSep);
  const kind = canonicalId.slice(firstSep + 1, secondSep);
  const nativeId = canonicalId.slice(secondSep + 1);
  if (nativeId.length === 0) return null;
  if (!isPregameSport(sport)) return null;
  if (!isPregameEntityKind(kind)) return null;
  return { sport, kind, nativeId };
}

export function isPregameSport(v: unknown): v is PregameSport {
  return typeof v === "string" && (PREGAME_SPORTS as readonly string[]).includes(v);
}

export function isPregameEntityKind(v: unknown): v is PregameEntityKind {
  return typeof v === "string" && (PREGAME_ENTITY_KINDS as readonly string[]).includes(v);
}

// An instant must carry an EXPLICIT timezone designator (Z or ±HH:MM / ±HHMM).
// `Date.parse` silently interprets an offsetless datetime in the process-local
// timezone, which would make the foundational `knownAt <= predictionAt` cutoff
// depend on where the process runs. We reject offsetless strings up front.
const ISO_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an ISO-8601 instant to epoch ms, REQUIRING an explicit offset. Returns
 * NaN for a non-string, an offsetless datetime, or an unparseable value — so
 * every temporal comparison in the foundation is timezone-independent.
 */
export function isoInstantMs(iso: unknown): number {
  if (typeof iso !== "string" || !ISO_OFFSET_RE.test(iso)) return NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * A directory candidate. `activeFrom`/`activeTo` bound when this native id maps
 * to this canonical entity (ISO instants). A player traded mid-season yields two
 * candidates with the same nativeId but disjoint windows — resolution must pick
 * the one whose window contains the as-of instant, and reject if zero or many do.
 */
export interface EntityDirectoryEntry {
  sport: PregameSport;
  kind: PregameEntityKind;
  nativeId: string;
  canonicalId: string;
  displayName?: string;
  /** Inclusive lower bound (ISO instant) or null for "unbounded past". */
  activeFrom?: string | null;
  /** Exclusive upper bound (ISO instant) or null for "unbounded future". */
  activeTo?: string | null;
}

/**
 * Fail-closed resolution of a canonical id against a directory, as of an instant.
 *
 * Rules:
 *  - the id must parse (else `malformed_id`),
 *  - sport/kind must be known (`unknown_sport` / `unknown_kind`),
 *  - exactly one directory entry must match nativeId+sport+kind AND contain the
 *    as-of instant in its [activeFrom, activeTo) window; zero → `unknown_id`,
 *    more than one → `ambiguous`.
 *
 * `asOfIso` is the decision instant (predictionAt). Windows are half-open so a
 * trade at instant T cleanly hands off (old entry activeTo=T, new activeFrom=T).
 */
export function resolveCanonicalEntity(
  canonicalId: string,
  directory: readonly EntityDirectoryEntry[],
  asOfIso: string,
): EntityResolution {
  const parsed = parseCanonicalId(canonicalId);
  if (!parsed) {
    // Distinguish an unknown sport/kind (still structurally three-part) from a
    // truly malformed string, for clearer diagnostics.
    const rawParts = typeof canonicalId === "string" ? canonicalId.split(CANONICAL_ID_SEP) : [];
    if (rawParts.length >= 3 && rawParts[0] && !isPregameSport(rawParts[0])) {
      return { ok: false, reason: "unknown_sport", detail: rawParts[0] };
    }
    if (rawParts.length >= 3 && rawParts[1] && !isPregameEntityKind(rawParts[1])) {
      return { ok: false, reason: "unknown_kind", detail: rawParts[1] };
    }
    return { ok: false, reason: "malformed_id", detail: canonicalId };
  }

  const asOfMs = isoInstantMs(asOfIso);
  if (!Number.isFinite(asOfMs)) {
    return { ok: false, reason: "malformed_id", detail: `bad asOf: ${asOfIso}` };
  }

  const matches = directory.filter(
    (e) =>
      e.sport === parsed.sport &&
      e.kind === parsed.kind &&
      // Compare native ids in their NORMALIZED (trimmed) form — the same
      // normalization `buildCanonicalId` applies. A directory row built from a
      // provider id with incidental whitespace (`nativeId: " 123 "`, canonicalId
      // `nba:player:123`) is self-consistent yet would be rejected by a raw
      // `===` against the trimmed request id, dropping the only candidate as
      // `unknown_id`. Trimming both sides lets the normalized id join.
      e.nativeId.trim() === parsed.nativeId.trim() &&
      // Reject a self-inconsistent directory row whose redundant canonicalId does
      // not equal its own (sport, kind, nativeId) — never return a mismatched
      // identity (fail-closed). This guarantees the resolved canonicalId equals
      // the requested one. (buildCanonicalId trims, so a whitespace nativeId with
      // a canonical canonicalId still passes this check.)
      e.canonicalId === buildCanonicalId(e.sport, e.kind, e.nativeId) &&
      instantInWindow(asOfMs, e.activeFrom, e.activeTo),
  );

  if (matches.length === 0) return { ok: false, reason: "unknown_id", detail: canonicalId };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", detail: `${matches.length} candidates` };

  const m = matches[0];
  return {
    ok: true,
    entity: {
      sport: m.sport,
      kind: m.kind,
      nativeId: m.nativeId,
      canonicalId: m.canonicalId,
      displayName: m.displayName,
    },
  };
}

/** Half-open window test: [activeFrom, activeTo). null bounds are unbounded. */
function instantInWindow(
  asOfMs: number,
  activeFrom: string | null | undefined,
  activeTo: string | null | undefined,
): boolean {
  if (activeFrom != null) {
    const fromMs = isoInstantMs(activeFrom);
    if (!Number.isFinite(fromMs) || asOfMs < fromMs) return false;
  }
  if (activeTo != null) {
    const toMs = isoInstantMs(activeTo);
    if (!Number.isFinite(toMs) || asOfMs >= toMs) return false;
  }
  return true;
}
