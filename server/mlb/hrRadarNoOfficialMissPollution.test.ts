/**
 * HR Radar — Watchlist/Lean misses must not pollute the official W/L record.
 *
 * Documents (does not re-implement) an invariant that was already true before
 * the 2026-07 playability-language pass: `resolveFinalNoHrGrading` only
 * produces a counted `called_miss` for a row that reached the HR-Max-Window
 * (Playable/Attack). A Watchlist/Lean-only row that never converts to an HR
 * resolves as `"expired"` — excluded from `CALLED_HIT_OUTCOME_STATUSES`, the
 * `called_miss` bucket, and (per storage.ts's `totalGraded = calledHits +
 * misses`) the official hit-rate denominator entirely.
 *
 * Run: npx tsx server/mlb/hrRadarNoOfficialMissPollution.test.ts
 */

import {
  resolveFinalNoHrGrading,
  reachedHrMaxWindow,
  CALLED_HIT_OUTCOME_STATUSES,
  isOfficialOutcomeBucket,
  deriveHrOutcomeBucket,
} from "./hrRadarSection";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${String(expected)} actual=${String(actual)}`);
}

console.log("\n=== HR Radar No-Official-Miss-Pollution — Invariant Suite ===\n");

// ── A. A Watchlist-only row (never reached Playable/Attack) resolves as
// "expired", never as a counted "called_miss" ────────────────────────────
const watchlistOnly = { alertTier: "watch", confidenceTier: "monitor", signalState: "watching" };
assert("A.1 Watchlist-only row did NOT reach the HR Max Window",
  !reachedHrMaxWindow(watchlistOnly));
eq("A.2 Watchlist-only, no HR → expired (not called_miss)",
  resolveFinalNoHrGrading(watchlistOnly), "expired");

// ── B. A Lean-only row (build/prepare, never promoted) also resolves expired ──
const leanOnly = { alertTier: "prepare", confidenceTier: "building", signalState: "live" };
assert("B.1 Lean-only row did NOT reach the HR Max Window", !reachedHrMaxWindow(leanOnly));
eq("B.2 Lean-only, no HR → expired (not called_miss)", resolveFinalNoHrGrading(leanOnly), "expired");

// ── C. Only a Playable/Attack row (HR Max Window) can become a counted miss ──
const playableRow = { alertTier: "officialAlert", confidenceTier: "strong", signalState: "actionable" };
assert("C.1 Playable/Attack row DID reach the HR Max Window", reachedHrMaxWindow(playableRow));
eq("C.2 Playable/Attack, no HR → called_miss (counted)",
  resolveFinalNoHrGrading(playableRow), "called_miss");

// ── D. "expired" is never a member of CALLED_HIT_OUTCOME_STATUSES or an
// official outcome bucket — cross-checked against both taxonomies ─────────
assert("D.1 'expired' is not a called-hit status",
  !CALLED_HIT_OUTCOME_STATUSES.has("expired" as any));
assert("D.2 'called_miss' is not a called-hit status (it's the counted-loss status)",
  !CALLED_HIT_OUTCOME_STATUSES.has("called_miss" as any));

// ── E. lean_before_hr / watchlist_before_hr outcome buckets are never
// official — the HR-hit-side mirror of the no-HR-side invariant above ─────
const leanBucket = deriveHrOutcomeBucket({
  firstLeanAtMs: 100, hrEndTimeMs: 200, reachedFireCommitment: false,
});
const watchlistBucket = deriveHrOutcomeBucket({
  firstWatchlistAtMs: 100, hrEndTimeMs: 200, reachedFireCommitment: false,
});
assert("E.1 lean_before_hr is not an official bucket", !isOfficialOutcomeBucket(leanBucket));
assert("E.2 watchlist_before_hr is not an official bucket", !isOfficialOutcomeBucket(watchlistBucket));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
