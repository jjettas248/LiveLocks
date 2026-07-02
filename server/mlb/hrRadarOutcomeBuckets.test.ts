/**
 * HR Radar playability outcome buckets — invariant test.
 *
 * Locks the 2026-07 §7 outcome-bucket taxonomy: attack_before_hr /
 * playable_before_hr (official) vs lean_before_hr / watchlist_before_hr
 * (radar-coverage-only) vs late_signal / uncalled_hr.
 *
 * Run: npx tsx server/mlb/hrRadarOutcomeBuckets.test.ts
 */

import { deriveHrOutcomeBucket, isOfficialOutcomeBucket, type HrOutcomeBucket } from "./hrRadarSection";

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

console.log("\n=== HR Radar Outcome Buckets — Invariant Suite ===\n");

const HR_AT = 1_000_000;

// ── A. attack_before_hr — reached FIRE + fire-committed before the HR ──────
eq("A.1 firstAttackAt before HR + fireCommitted=true → attack_before_hr",
  deriveHrOutcomeBucket({ firstAttackAtMs: HR_AT - 5000, hrEndTimeMs: HR_AT, reachedFireCommitment: true }),
  "attack_before_hr");

// ── B. playable_before_hr — reached READY (or FIRE without commitment) ─────
eq("B.1 firstPlayableAt before HR (no fire) → playable_before_hr",
  deriveHrOutcomeBucket({ firstPlayableAtMs: HR_AT - 5000, hrEndTimeMs: HR_AT, reachedFireCommitment: false }),
  "playable_before_hr");
eq("B.2 firstAttackAt before HR but fireCommitted=false → playable_before_hr (Ready-only, not Attack)",
  deriveHrOutcomeBucket({ firstAttackAtMs: HR_AT - 5000, hrEndTimeMs: HR_AT, reachedFireCommitment: false }),
  "playable_before_hr");

// ── C. lean_before_hr / watchlist_before_hr — coverage only ────────────────
eq("C.1 firstLeanAt before HR (no ready/attack) → lean_before_hr",
  deriveHrOutcomeBucket({ firstLeanAtMs: HR_AT - 5000, hrEndTimeMs: HR_AT, reachedFireCommitment: false }),
  "lean_before_hr");
eq("C.2 firstWatchlistAt before HR only → watchlist_before_hr",
  deriveHrOutcomeBucket({ firstWatchlistAtMs: HR_AT - 5000, hrEndTimeMs: HR_AT, reachedFireCommitment: false }),
  "watchlist_before_hr");

// ── D. late_signal / uncalled_hr ────────────────────────────────────────────
eq("D.1 gradingStatus=late_signal short-circuits", deriveHrOutcomeBucket({
  gradingStatus: "late_signal", hrEndTimeMs: HR_AT, reachedFireCommitment: false,
}), "late_signal");
eq("D.2 no pre-HR playability at all → uncalled_hr", deriveHrOutcomeBucket({
  hrEndTimeMs: HR_AT, reachedFireCommitment: false,
}), "uncalled_hr");
eq("D.3 timestamps AFTER the HR do not count as pre-HR", deriveHrOutcomeBucket({
  firstAttackAtMs: HR_AT + 5000, hrEndTimeMs: HR_AT, reachedFireCommitment: true,
}), "uncalled_hr");

// ── E. isOfficialOutcomeBucket — official rules (spec §9) ──────────────────
eq("E.1 attack_before_hr is official", isOfficialOutcomeBucket("attack_before_hr"), true);
eq("E.2 playable_before_hr is official", isOfficialOutcomeBucket("playable_before_hr"), true);
eq("E.3 lean_before_hr is NOT official", isOfficialOutcomeBucket("lean_before_hr"), false);
eq("E.4 watchlist_before_hr is NOT official", isOfficialOutcomeBucket("watchlist_before_hr"), false);
eq("E.5 late_signal is NOT official", isOfficialOutcomeBucket("late_signal"), false);
eq("E.6 uncalled_hr is NOT official", isOfficialOutcomeBucket("uncalled_hr"), false);

// ── F. Fixtures — Amed Rosario / Tyler O'Neill land at playable/attack ──────
// Both fixtures reach Playable (ready) before the HR (Phase 2 §2.1/§2.2);
// neither is fire-committed in these examples, so both bucket as
// playable_before_hr, which IS an official call per spec §9.
const rosarioBucket: HrOutcomeBucket = deriveHrOutcomeBucket({
  firstPlayableAtMs: HR_AT - 60_000, // T8 barrel well before the B9 HR
  hrEndTimeMs: HR_AT,
  reachedFireCommitment: false,
});
eq("F.1 Rosario fixture → playable_before_hr", rosarioBucket, "playable_before_hr");
assert("F.2 Rosario fixture bucket is official", isOfficialOutcomeBucket(rosarioBucket));

const oneillBucket: HrOutcomeBucket = deriveHrOutcomeBucket({
  firstPlayableAtMs: HR_AT - 10_000,
  hrEndTimeMs: HR_AT,
  reachedFireCommitment: false,
});
assert("F.3 O'Neill fixture → playable_before_hr or attack_before_hr",
  oneillBucket === "playable_before_hr" || oneillBucket === "attack_before_hr", oneillBucket);
assert("F.4 O'Neill fixture bucket is official", isOfficialOutcomeBucket(oneillBucket));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
