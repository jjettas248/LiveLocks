// Golden-fixture canonicalization + tiny assert harness (PR0 baseline).
//
// PR0 is a NON-PRODUCTION-CHANGE baseline phase: this module and the fixtures
// beside it exist ONLY to freeze the current observable behavior of pure
// engine/scoring/grading functions before the NBA/NFL pregame-targets work
// begins. Nothing here is imported by production code.
//
// Determinism rules enforced here (per PR0 corrections #2 and #6):
//   • Object keys are sorted recursively, so serialization is byte-stable
//     regardless of property insertion order.
//   • Numbers are recorded EXACTLY (no rounding) — the fixtures are meant to
//     detect floating-point precision drift, so masking it would defeat them.
//   • Named volatile fields (wall-clock timestamps that the current code
//     stamps with Date.now()) are replaced by the sentinel "<volatile>" so the
//     baseline is credential-, network-, and clock-independent. Every such
//     field is named explicitly — nothing is guessed.
//
// SCOPE OF MASKING (narrow on purpose): only fields that the covered code paths
// stamp from the WALL CLOCK are masked. A timestamp the fixture supplies
// deterministically — a pinned candidate `createdAt`, the fixed `generatedAt`
// argument threaded into buildResponse/buildMoundResponse, or a `generatedAt`
// derived from a frozen row `updatedAt` — is NOT masked, so a regression that
// drops, ignores, or corrupts that caller-provided timestamp still trips the
// guard. Masking by key name is only safe because, in every boundary covered
// here, these two keys are ALWAYS wall-clock and never deterministic:
//   - `timestamp`     → processNBAEngine top-level stamp (Date.now())
//   - `dataFreshness` → processNBAEngine top-level stamp (Date.now())
// If a future fixture introduces a key that is wall-clock in one place and
// deterministic in another, switch to path-aware masking rather than widening
// this set (which would silently weaken coverage — the very defect this scoping
// prevents).

/** Fields the covered code paths stamp from Date.now(); normalized to a sentinel. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "timestamp",
  "dataFreshness",
]);

export const VOLATILE_SENTINEL = "<volatile>";

/**
 * Recursively canonicalize a value: sort object keys, replace volatile fields
 * with a sentinel, preserve numbers/null/undefined distinctions exactly.
 * `undefined` object properties are dropped (JSON semantics); `null` is kept
 * (so "missing" vs "observed null" stays observable).
 */
export function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  // Date instances (e.g. a row's lockedAt/convertedLiveAt) have no own
  // enumerable keys — serialize to a deterministic ISO string, never `{}`.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = VOLATILE_KEYS.has(k) ? VOLATILE_SENTINEL : canonicalize(v);
    }
    return out;
  }
  // number (incl. -0 normalized to 0), string, boolean
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}

/** Stable JSON serialization of a canonicalized value. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}

// ── Tiny assert harness (matches the repo's hand-rolled *.test.ts convention) ──

let passed = 0;
let failed = 0;

export function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${msg}`);
  }
}

export function eqStable(actual: unknown, expected: unknown, msg: string): void {
  const a = stableStringify(actual);
  const b = stableStringify(expected);
  if (a === b) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${msg}\n  --- expected\n${indent(b)}\n  --- actual\n${indent(a)}`);
  }
}

function indent(s: string): string {
  return s.split("\n").map((l) => `    ${l}`).join("\n");
}

export function summary(): { passed: number; failed: number } {
  return { passed, failed };
}
