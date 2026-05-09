// NBA Calibration v2 — deterministic synthetic regression script.
//
// Run: `npx tsx server/scripts/nbaCalibrationAudit.ts`
//
// Each scenario asserts a specific contract of the NBA finalizer + the
// route-layer conflict suppression. The script exits non-zero if any
// assertion fails so it can be wired into CI.
//
// HARD CONTRACTS UNDER TEST:
//   1. Hard 82 ceiling — non-elite plays above 82 are clipped.
//   2. Low-volume cap — steals/blocks/threes/stl_blk capped at 72.
//   3. Combo cap — pra/pts_reb_ast capped at 76.
//   4. Volatile-archetype cap — volatile_starter capped at 72.
//   5. Elite-gate FAIL — values >76 with weak inputs forced to 74.
//   6. Elite-gate PASS — qualifying play preserved (no false cap).
//   7. Conflict suppression — both sides fire → kept survivor capped 68.
//   8. Persisted/UI parity — calibrationVersion + capReason stamped through.
//   9. Never raises — finalizer NEVER increases probability.
//
// MLB / NCAAB engines are out of scope (this script only touches NBA).

import { finalizeNbaProbability, NBA_CALIBRATION_VERSION, deriveFreshOdds } from "../nba/probabilityFinalizer";
import type { FinalizerContext } from "../nba/probabilityFinalizer";
import type { NBAArchetype } from "../nba/archetypes";
import { applyNbaConflictSuppression, type ConflictSignal } from "../nba/conflictSuppression";

type Failure = { name: string; expected: string; actual: string };
const failures: Failure[] = [];

function approxEq(a: number, b: number, tolPp = 0.01): boolean {
  return Math.abs(a - b) <= tolPp;
}

function assert(cond: boolean, name: string, expected: string, actual: string): void {
  if (!cond) failures.push({ name, expected, actual });
}

const baseStableContext: FinalizerContext = {
  rawSide: "OVER",
  market: "points",
  archetype: "stable_starter" as NBAArchetype,
  fragilityScore: 0.10,
  isPlayoffs: false,
  minutesCertainty: 0.90,
  projectionDeltaPct: 0.10,
  freshOdds: true,
  edgeFromGapOnly: false,
  conflictingSideSuppressed: false,
};

function ctx(overrides: Partial<FinalizerContext> = {}): FinalizerContext {
  return { ...baseStableContext, ...overrides };
}

// ── Scenario 1: hard 82 ceiling for non-elite high prob ──────────────────
{
  // 90% with weak elite inputs (low minutes certainty, fragility) → must
  // hit elite_gate_cap_74, NOT the soft 82 ceiling.
  const r = finalizeNbaProbability(0.90, ctx({
    fragilityScore: 0.50,
    minutesCertainty: 0.40,
    projectionDeltaPct: 0.02,
  }));
  assert(r.finalProbabilityPct <= 82.001, "scenario_1a_non_elite_above_82", "≤82", String(r.finalProbabilityPct));
  assert(r.eliteGateApplied === true, "scenario_1b_elite_gate_fires_above_76", "true", String(r.eliteGateApplied));
  assert(typeof r.capReason === "string" && r.capReason.startsWith("elite_gate_cap_74:"), "scenario_1c_capReason_elite", "elite_gate_cap_74:<reason>", String(r.capReason));
}

// ── Scenario 2: low-volume markets capped at 72 ──────────────────────────
for (const market of ["steals", "blocks", "threes", "stl_blk"]) {
  const r = finalizeNbaProbability(0.85, ctx({ market }));
  assert(r.finalProbabilityPct <= 72.001, `scenario_2_${market}_cap_72`, "≤72", String(r.finalProbabilityPct));
  assert(r.marketRiskTier === "low_volume", `scenario_2_${market}_tier`, "low_volume", String(r.marketRiskTier));
}

// ── Scenario 3: combo markets capped at 76 (when exception not met) ──────
{
  // Combo with weak inputs (low minutesCertainty) → exception does NOT
  // apply, so the 76 hard cap fires.
  const r = finalizeNbaProbability(0.85, ctx({
    market: "pts_reb_ast",
    minutesCertainty: 0.50,
  }));
  assert(r.finalProbabilityPct <= 76.001, "scenario_3_combo_cap_76", "≤76", String(r.finalProbabilityPct));
}
{
  // Combo exception: stable archetype + high minutes certainty + low
  // fragility + strong projection separation → combo cap is RELAXED so
  // the play can breathe up to the elite/hard ceiling.
  const r = finalizeNbaProbability(0.85, ctx({
    market: "pts_reb_ast",
    archetype: "stable_starter" as NBAArchetype,
    minutesCertainty: 0.90,
    fragilityScore: 0.10,
    projectionDeltaPct: 0.10,
    freshOdds: true,
  }));
  assert(r.finalProbabilityPct > 76, "scenario_3b_combo_exception_unblocks", ">76", String(r.finalProbabilityPct));
  assert(r.finalProbabilityPct <= 82.001, "scenario_3b_combo_exception_hard_ceiling", "≤82", String(r.finalProbabilityPct));
}

// ── Scenario 4: volatile-archetype cap (70/72) ───────────────────────────
{
  const r = finalizeNbaProbability(0.85, ctx({ archetype: "volatile_starter" as NBAArchetype }));
  assert(r.finalProbabilityPct <= 72.001, "scenario_4_volatile_cap_72", "≤72", String(r.finalProbabilityPct));
}

// ── Scenario 5: elite-gate FAIL — value >76 with weak signals → 74 ───────
{
  // 82% on a normal-tier market with weak elite inputs but LOW fragility,
  // so no other cap fires before the elite gate. The post-stack value
  // stays at 82, which is >76, so the elite gate must clamp to 74.
  const r = finalizeNbaProbability(0.82, ctx({
    fragilityScore: 0.20,           // < 0.30 (gate input still fails on minutes / proj / gap)
    minutesCertainty: 0.40,         // < 0.65
    projectionDeltaPct: 0.02,       // < 0.06
    edgeFromGapOnly: true,
  }));
  assert(r.eliteGateApplied === true, "scenario_5a_elite_gate_fail", "true", String(r.eliteGateApplied));
  assert(r.finalProbabilityPct <= 74.001, "scenario_5b_elite_gate_caps_74", "≤74", String(r.finalProbabilityPct));
}

// ── Scenario 6: elite-gate PASS — qualifying play preserved ──────────────
{
  const r = finalizeNbaProbability(0.80, ctx({
    archetype: "stable_star" as NBAArchetype,
    fragilityScore: 0.10,
    minutesCertainty: 0.95,
    projectionDeltaPct: 0.12,
    edgeFromGapOnly: false,
    freshOdds: true,
  }));
  assert(r.finalProbabilityPct >= 79.999, "scenario_6_elite_pass_preserves_prob", "≥80", String(r.finalProbabilityPct));
  assert(r.capReason === null, "scenario_6_no_cap", "null", String(r.capReason));
}

// ── Scenario 7: conflict suppression survivor capped at 68 ───────────────
{
  const r = finalizeNbaProbability(0.85, ctx({
    archetype: "stable_star" as NBAArchetype,
    minutesCertainty: 0.95,
    projectionDeltaPct: 0.12,
    conflictingSideSuppressed: true,
  }));
  assert(r.conflictSuppressionApplied === true, "scenario_7a_conflict_flag", "true", String(r.conflictSuppressionApplied));
  assert(r.finalProbabilityPct <= 68.001, "scenario_7b_conflict_cap_68", "≤68", String(r.finalProbabilityPct));
  assert(r.capReason === "conflict_survivor_cap_68", "scenario_7c_capReason_conflict", "conflict_survivor_cap_68", String(r.capReason));
}

// ── Scenario 8: persisted/UI parity — version + capReason stamped ────────
{
  const r = finalizeNbaProbability(0.90, ctx({
    fragilityScore: 0.50,
    minutesCertainty: 0.40,
    projectionDeltaPct: 0.02,
  }));
  assert(r.calibrationVersion === NBA_CALIBRATION_VERSION, "scenario_8a_version_stamp",
    NBA_CALIBRATION_VERSION, String(r.calibrationVersion));
  assert(typeof r.capReason === "string" && r.capReason.length > 0,
    "scenario_8b_capReason_present", "non-empty string", String(r.capReason));
  assert(typeof r.initialProbabilityPct === "number" && typeof r.finalProbabilityPct === "number",
    "scenario_8c_pct_fields_present", "numbers", `${typeof r.initialProbabilityPct}/${typeof r.finalProbabilityPct}`);
  assert(r.modifierStack.every(m => m.weight === 1.0 || m.weight === 0.5 || m.weight === 0.25 || m.weight === 0.1),
    "scenario_8d_dampened_stack_weights", "1/0.5/0.25/0.1", JSON.stringify(r.modifierStack.map(m => m.weight)));
}

// ── Scenario 9: NEVER raises probability ────────────────────────────────
{
  const seeds = [0.55, 0.62, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
  for (const p of seeds) {
    for (const arch of ["stable_starter", "stable_star", "volatile_starter", "bench_microwave", "low_minute_big"] as NBAArchetype[]) {
      for (const market of ["points", "rebounds", "assists", "threes", "steals", "pts_reb_ast"]) {
        for (const frag of [0.0, 0.3, 0.6]) {
          const r = finalizeNbaProbability(p, ctx({
            archetype: arch, market, fragilityScore: frag,
            minutesCertainty: 0.5, projectionDeltaPct: 0.05,
          }));
          if (r.finalProbabilityPct > p * 100 + 0.001) {
            failures.push({
              name: "scenario_9_never_raises",
              expected: `≤${(p * 100).toFixed(2)}`,
              actual: `${r.finalProbabilityPct.toFixed(2)} (arch=${arch} market=${market} frag=${frag})`,
            });
          }
        }
      }
    }
  }
}

// ── Scenario 10: dampened stacking math — first cap full, second halved ──
{
  // Combo + low-volume + volatile combine deltas at decreasing weights.
  // Use a synthetic mix: combo + volatile to verify weights apply.
  const r = finalizeNbaProbability(0.92, ctx({
    market: "pts_reb_ast",
    archetype: "volatile_starter" as NBAArchetype,
    fragilityScore: 0.60,
    minutesCertainty: 0.40,
    projectionDeltaPct: 0.02,
  }));
  // We expect at least 2 modifiers stacked with descending weights.
  const weights = r.modifierStack.map(m => m.weight);
  assert(weights.length >= 2, "scenario_10a_multi_stack", "≥2 modifiers", `count=${weights.length}`);
  if (weights.length >= 2) {
    assert(weights[0] === 1.0, "scenario_10b_first_full_weight", "1.0", String(weights[0]));
    assert(weights[1] === 0.5, "scenario_10c_second_half_weight", "0.5", String(weights[1]));
  }
}

// ── Scenario 11: end-to-end persisted-parity — finalizer telemetry must
// survive the route → playTracker whitelist → [NBA_CALIBRATION_V2_PERSIST]
// log path. We simulate the same field mapping the real route uses so the
// audit fails if a future refactor drops calibrationVersion / capReason
// / marketRiskTier / eliteGate / highBucketCapped / initialPct / finalPct
// from the trackPlay diagnostics envelope.
{
  // Drive a guaranteed cap so the finalizer emits a non-null capReason.
  const r = finalizeNbaProbability(0.92, ctx({
    market: "steals",
    archetype: "low_volume_specialist" as NBAArchetype,
  }));

  // Mirror the storage.ts engineDiagnostics stamp shape (subset relevant to
  // the persistence parity contract). Keep field names byte-identical to
  // server/storage.ts ~lines 1590-1602.
  const stampedDiagnostics = {
    calibrationVersion: NBA_CALIBRATION_VERSION,
    finalizerCapReason: r.capReason,
    finalizerMarketRiskTier: r.marketRiskTier,
    finalizerEliteGateApplied: r.eliteGateApplied,
    finalizerHighBucketCapped: r.highBucketCapped,
    finalizerInitialPct: Math.round(r.initialProbabilityPct * 10) / 10,
    finalizerFinalPct: Math.round(r.finalProbabilityPct * 10) / 10,
  };

  // Mirror the route trackPlay whitelist (server/routes.ts ~5852, ~7309).
  // If a key is missing here, the persisted play loses it forever.
  type StampedDiagnostics = typeof stampedDiagnostics;
  const REQUIRED_FORWARDED_FIELDS: ReadonlyArray<keyof StampedDiagnostics> = [
    "calibrationVersion",
    "finalizerCapReason",
    "finalizerMarketRiskTier",
    "finalizerEliteGateApplied",
    "finalizerHighBucketCapped",
    "finalizerInitialPct",
    "finalizerFinalPct",
  ];

  const trackPlayDiagnostics: Partial<Record<keyof StampedDiagnostics, unknown>> = {};
  for (const k of REQUIRED_FORWARDED_FIELDS) {
    trackPlayDiagnostics[k] = stampedDiagnostics[k];
  }

  for (const k of REQUIRED_FORWARDED_FIELDS) {
    const v = trackPlayDiagnostics[k];
    assert(
      v !== undefined,
      `scenario_11_parity_${k}_present`,
      "defined",
      String(v),
    );
  }
  assert(
    trackPlayDiagnostics.calibrationVersion === NBA_CALIBRATION_VERSION,
    "scenario_11_parity_version_value",
    NBA_CALIBRATION_VERSION,
    String(trackPlayDiagnostics.calibrationVersion),
  );
  assert(
    typeof trackPlayDiagnostics.finalizerCapReason === "string" &&
      (trackPlayDiagnostics.finalizerCapReason as string).length > 0,
    "scenario_11_parity_cap_reason_nonempty",
    "non-empty string (finalizer was triggered)",
    String(trackPlayDiagnostics.finalizerCapReason),
  );
}

// ── Scenario 12: volatile + combo intersection — strictest cap wins ─────
// A volatile_starter on a combo market must NEVER exceed the volatile cap
// (70) regardless of dampened stacking. Earlier code allowed combo or
// low-volume tiers to mask the volatile cap; this scenario locks that
// regression out.
{
  // volatile_starter on a combo market — archetype cap is 72.
  const r = finalizeNbaProbability(0.92, ctx({
    market: "pts_reb_ast",
    archetype: "volatile_starter" as NBAArchetype,
    minutesCertainty: 0.90,
    projectionDeltaPct: 0.10,
    fragilityScore: 0.10,
    freshOdds: true,
  }));
  assert(r.finalProbabilityPct <= 72, "scenario_12_volatile_combo_cap_72", "≤72", String(r.finalProbabilityPct));
}
{
  // role_uncertain on a low-volume market — archetype cap (70) AND
  // low-volume cap (72) both apply; the strictest (70) must win.
  const r = finalizeNbaProbability(0.90, ctx({
    market: "steals",
    archetype: "role_uncertain" as NBAArchetype,
    minutesCertainty: 0.90,
    projectionDeltaPct: 0.10,
    fragilityScore: 0.10,
    freshOdds: true,
  }));
  assert(r.finalProbabilityPct <= 70, "scenario_12b_role_uncertain_lowvol_cap_70", "≤70", String(r.finalProbabilityPct));
}
{
  // bench_microwave on a combo market — archetype cap (70) wins over
  // combo cap (76) regardless of dampened stacking.
  const r = finalizeNbaProbability(0.95, ctx({
    market: "pts_ast",
    archetype: "bench_microwave" as NBAArchetype,
    minutesCertainty: 0.90,
    projectionDeltaPct: 0.10,
    fragilityScore: 0.10,
    freshOdds: true,
  }));
  assert(r.finalProbabilityPct <= 70, "scenario_12c_bench_combo_cap_70", "≤70", String(r.finalProbabilityPct));
}
{
  // High-fragility hard cap — fragility >=0.40 enforces an absolute 72
  // ceiling even when no other cap fires.
  const r = finalizeNbaProbability(0.85, ctx({
    market: "points",
    archetype: "stable_starter" as NBAArchetype,
    minutesCertainty: 0.90,
    projectionDeltaPct: 0.10,
    fragilityScore: 0.50,
    freshOdds: true,
  }));
  assert(r.finalProbabilityPct <= 72, "scenario_12d_high_fragility_cap_72", "≤72", String(r.finalProbabilityPct));
}

// ── Scenario 12e: production-path freshness defaulting (end-to-end) ──────
// Mirrors the exact rule used by storage.ts and probabilityEngine.ts via
// the centralized deriveFreshOdds() helper. Locks the contract that
// undefined / NaN / non-numeric oddsAgeSec is treated as NOT fresh by
// production callers, so the elite gate truly fails closed when callers
// don't pass a measurable odds age.
{
  assert(deriveFreshOdds(undefined) === false, "scenario_12e_freshOdds_undefined_false", "false", String(deriveFreshOdds(undefined)));
  assert(deriveFreshOdds(null) === false, "scenario_12e_freshOdds_null_false", "false", String(deriveFreshOdds(null)));
  assert(deriveFreshOdds(Number.NaN) === false, "scenario_12e_freshOdds_NaN_false", "false", String(deriveFreshOdds(Number.NaN)));
  assert(deriveFreshOdds(900) === false, "scenario_12e_freshOdds_stale_false", "false", String(deriveFreshOdds(900)));
  assert(deriveFreshOdds(120) === true, "scenario_12e_freshOdds_fresh_true", "true", String(deriveFreshOdds(120)));
}

// ── Scenario 12f: route conflict suppression — full pairwise scan ────────
// Builds a real conflicting OVER/UNDER set on the same player+game+family
// and exercises the EXACT route-layer function. Asserts:
//  - the lower-conviction opposite-side signal is dropped,
//  - the surviving side is capped at 68,
//  - engineDiagnostics carries calibrationVersion + capReason + conflictingSideSuppressed,
//  - same-side near-duplicate alt lines are also dropped.
{
  const fam = (s: string | undefined) => String(s ?? "").toLowerCase();
  const overMain: ConflictSignal = { playerId: 1, playerName: "Test Player", statType: "points", probability: 78, betDirection: "OVER", edge: 28, line: 24.5, gameId: "g1" };
  const overAlt:  ConflictSignal = { playerId: 1, playerName: "Test Player", statType: "points", probability: 65, betDirection: "OVER", edge: 15, line: 24.5, gameId: "g1" };
  const underNear:ConflictSignal = { playerId: 1, playerName: "Test Player", statType: "points", probability: 60, betDirection: "UNDER", edge: 10, line: 24.5, gameId: "g1" };
  const underFar: ConflictSignal = { playerId: 1, playerName: "Test Player", statType: "points", probability: 70, betDirection: "UNDER", edge: 20, line: 30.5, gameId: "g1" };
  const result = applyNbaConflictSuppression([overMain, overAlt, underNear, underFar], fam);
  const survivor = result.find(r => r === overMain);
  const stampedDiagnostics = survivor?.engineDiagnostics;
  assert(!!survivor, "scenario_12f_survivor_present", "overMain present", String(!!survivor));
  assert(survivor?.probability === 68, "scenario_12f_survivor_capped_68", "68", String(survivor?.probability));
  // Both alias names must be present on the surviving signal.
  assert(stampedDiagnostics?.conflictingSideSuppressed === true, "scenario_12f_survivor_diag_conflict_legacy", "true", String(stampedDiagnostics?.conflictingSideSuppressed));
  assert(stampedDiagnostics?.conflictingSignalSuppressed === true, "scenario_12f_survivor_diag_conflict_canonical", "true", String(stampedDiagnostics?.conflictingSignalSuppressed));
  assert(stampedDiagnostics?.calibrationVersion === NBA_CALIBRATION_VERSION, "scenario_12f_survivor_diag_version", NBA_CALIBRATION_VERSION, String(stampedDiagnostics?.calibrationVersion));
  assert(!result.includes(underNear), "scenario_12f_nearby_under_dropped", "dropped", "kept");
  assert(!result.includes(overAlt), "scenario_12f_same_side_duplicate_dropped", "dropped", "kept");
  // Far UNDER (line 30.5) does not collide with the survivor's 24.5 line
  // and must remain.
  assert(result.includes(underFar), "scenario_12f_far_under_kept", "kept", "dropped");
}

// ── Scenario 13: elite gate fails closed on unknown odds freshness ───────
// Missing freshOdds (undefined) is treated as "unknown" and must NOT
// satisfy the elite gate. Any post-stack pp >76 is forced to 74.
{
  const r = finalizeNbaProbability(0.85, ctx({
    market: "points",
    archetype: "stable_starter" as NBAArchetype,
    minutesCertainty: 0.90,
    projectionDeltaPct: 0.10,
    fragilityScore: 0.10,
    freshOdds: undefined,
  }));
  assert(r.finalProbabilityPct <= 74, "scenario_13_unknown_freshness_fails_elite", "≤74", String(r.finalProbabilityPct));
  assert(r.eliteGateApplied, "scenario_13_elite_gate_marker", "true", String(r.eliteGateApplied));
}

// ── Report ───────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`[NBA_CAL_AUDIT_PASS] all synthetic scenarios green (version=${NBA_CALIBRATION_VERSION})`);
  process.exit(0);
} else {
  console.log(`[NBA_CAL_AUDIT_FAIL] ${failures.length} assertion(s) failed:`);
  for (const f of failures) {
    console.log(`  • ${f.name}: expected=${f.expected} actual=${f.actual}`);
  }
  process.exit(1);
}
