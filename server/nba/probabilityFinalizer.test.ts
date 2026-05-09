// NBA Probability Finalizer — end-to-end regression harness
//
// Locks the calibration contract so engine refactors can't silently regress
// the 80–100 bucket. Covers every cap reason, dampened stacking weights,
// elite-gate pass/fail paths, and the never-raises invariant.
//
// Run: npx tsx server/nba/probabilityFinalizer.test.ts

import {
  finalizeNbaProbability,
  deriveFreshOdds,
  NBA_CALIBRATION_VERSION,
  NBA_FRESH_ODDS_MAX_AGE_SEC,
  type FinalizerContext,
} from "./probabilityFinalizer";

let failed = 0;
let passed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✓ ${name}`);
      passed++;
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${name}\n  ${msg}`);
      failed++;
    });
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

function lte(a: number, b: number, msg: string): void {
  if (a > b) throw new Error(`${msg} (expected ${a} <= ${b})`);
}

function near(a: number, b: number, eps: number, msg: string): void {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} (expected ~${b}, got ${a}, eps=${eps})`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A fully elite-eligible context for stable_star on points */
function eliteCtx(overrides: Partial<FinalizerContext> = {}): FinalizerContext {
  return {
    rawSide: "OVER",
    market: "points",
    archetype: "stable_star",
    fragilityScore: 0,
    isPlayoffs: false,
    minutesCertainty: 0.90,
    projectionDeltaPct: 0.10,
    edgeFromGapOnly: false,
    freshOdds: true,
    ...overrides,
  };
}

async function main(): Promise<void> {

  // ── 1. deriveFreshOdds helper ────────────────────────────────────────────

  await test("deriveFreshOdds: null → false (fail-closed)", () => {
    eq(deriveFreshOdds(null), false, "null");
  });

  await test("deriveFreshOdds: undefined → false (fail-closed)", () => {
    eq(deriveFreshOdds(undefined), false, "undefined");
  });

  await test("deriveFreshOdds: NaN → false (fail-closed)", () => {
    eq(deriveFreshOdds(NaN), false, "NaN");
  });

  await test("deriveFreshOdds: age < 600 → true", () => {
    eq(deriveFreshOdds(NBA_FRESH_ODDS_MAX_AGE_SEC - 1), true, "599");
  });

  await test("deriveFreshOdds: age = 600 → false (boundary exclusive)", () => {
    eq(deriveFreshOdds(NBA_FRESH_ODDS_MAX_AGE_SEC), false, "600");
  });

  await test("deriveFreshOdds: age > 600 → false", () => {
    eq(deriveFreshOdds(601), false, "601");
  });

  // ── 2. Low-volume cap (72 pp) ────────────────────────────────────────────

  await test("low_volume_cap_72: steals market above 72 is capped", () => {
    const r = finalizeNbaProbability(0.85, eliteCtx({ market: "steals" }));
    lte(r.finalProbabilityPct, 72, "finalProbabilityPct");
    assert(r.capApplied, "capApplied should be true");
    assert(
      r.modifierStack.some((m) => m.name === "low_volume_cap_72"),
      "stack should include low_volume_cap_72",
    );
  });

  await test("low_volume_cap_72: blocks market above 72 is capped", () => {
    const r = finalizeNbaProbability(0.80, eliteCtx({ market: "blocks" }));
    lte(r.finalProbabilityPct, 72, "finalProbabilityPct");
  });

  await test("low_volume_cap_72: threes market above 72 is capped", () => {
    const r = finalizeNbaProbability(0.80, eliteCtx({ market: "threes" }));
    lte(r.finalProbabilityPct, 72, "finalProbabilityPct");
  });

  await test("low_volume_cap_72: absolute hard cap enforced even when stack dampens below cap", () => {
    // Even if stacking dampens the cap-modifier, the absolute 72 hard cap must hold.
    const r = finalizeNbaProbability(0.90, eliteCtx({ market: "steals", archetype: "bench_microwave" }));
    lte(r.finalProbabilityPct, 72, "absolute low-volume cap at 72");
  });

  await test("low_volume_cap_72: normal market is NOT capped by low-volume rule", () => {
    const r = finalizeNbaProbability(0.74, eliteCtx({ market: "points" }));
    // Should not have low_volume_cap_72 in stack
    assert(
      !r.modifierStack.some((m) => m.name === "low_volume_cap_72"),
      "points market should not trigger low_volume_cap",
    );
  });

  // ── 3. Combo cap (76 pp) ─────────────────────────────────────────────────

  await test("combo_cap_76: combo market above 76 is capped when not exempt", () => {
    const r = finalizeNbaProbability(
      0.85,
      eliteCtx({
        market: "pts_reb",
        fragilityScore: 0.35,  // blocks combo-exempt (_comboLowVolatility needs <0.30)
      }),
    );
    lte(r.finalProbabilityPct, 76, "combo cap 76");
    assert(
      r.modifierStack.some((m) => m.name === "combo_cap_76"),
      "stack should include combo_cap_76",
    );
  });

  await test("combo_cap_76: combo exempt when high certainty + stable + low fragility + proj separation", () => {
    // Exempt: minutesCertainty>=0.80, not volatile/impacted, fragilityScore<0.30, projDelta>=0.06
    const r = finalizeNbaProbability(
      0.78,
      eliteCtx({
        market: "pts_reb",
        fragilityScore: 0.10,
        minutesCertainty: 0.90,
        projectionDeltaPct: 0.10,
      }),
    );
    assert(
      !r.modifierStack.some((m) => m.name === "combo_cap_76"),
      "exempt combo should NOT have combo_cap_76 in stack",
    );
  });

  await test("combo_cap_76: volatile archetype blocks combo cap exemption", () => {
    const r = finalizeNbaProbability(
      0.85,
      eliteCtx({
        market: "pts_reb",
        archetype: "volatile_starter",
        fragilityScore: 0.10,
        minutesCertainty: 0.90,
        projectionDeltaPct: 0.10,
      }),
    );
    // volatile_starter triggers !_comboLowVolatility → combo cap fires
    assert(
      r.modifierStack.some((m) => m.name === "combo_cap_76"),
      "volatile archetype combo should have combo_cap_76",
    );
    lte(r.finalProbabilityPct, 72, "volatile_starter hard cap at 72");
  });

  // ── 4. Volatile / archetype caps ────────────────────────────────────────

  await test("volatile_cap_70: bench_microwave capped at 70", () => {
    const r = finalizeNbaProbability(
      0.80,
      eliteCtx({ archetype: "bench_microwave", market: "points" }),
    );
    lte(r.finalProbabilityPct, 70, "bench_microwave cap 70");
    assert(
      r.modifierStack.some((m) => m.name === "volatile_cap_70"),
      "stack should include volatile_cap_70",
    );
  });

  await test("volatile_cap_70: low_minute_big capped at 70", () => {
    const r = finalizeNbaProbability(0.80, eliteCtx({ archetype: "low_minute_big" }));
    lte(r.finalProbabilityPct, 70, "low_minute_big cap 70");
  });

  await test("volatile_cap_70: role_uncertain capped at 70", () => {
    const r = finalizeNbaProbability(0.80, eliteCtx({ archetype: "role_uncertain" }));
    lte(r.finalProbabilityPct, 70, "role_uncertain cap 70");
  });

  await test("volatile_cap_72: volatile_starter capped at 72", () => {
    const r = finalizeNbaProbability(0.80, eliteCtx({ archetype: "volatile_starter" }));
    lte(r.finalProbabilityPct, 72, "volatile_starter cap 72");
  });

  await test("volatile_cap_72: lineup_impacted capped at 72", () => {
    const r = finalizeNbaProbability(0.80, eliteCtx({ archetype: "lineup_impacted" }));
    lte(r.finalProbabilityPct, 72, "lineup_impacted cap 72");
  });

  await test("archetype cap: stable_star and stable_starter have no archetype cap", () => {
    const r1 = finalizeNbaProbability(0.78, eliteCtx({ archetype: "stable_star" }));
    const r2 = finalizeNbaProbability(0.78, eliteCtx({ archetype: "stable_starter" }));
    assert(!r1.modifierStack.some((m) => m.name.startsWith("volatile_cap_")), "stable_star no volatile_cap");
    assert(!r2.modifierStack.some((m) => m.name.startsWith("volatile_cap_")), "stable_starter no volatile_cap");
  });

  // ── 5. Elite gate fail paths ─────────────────────────────────────────────

  await test("elite_gate fail: stale_or_unknown_odds caps >76 to 74", () => {
    const r = finalizeNbaProbability(0.85, eliteCtx({ freshOdds: false }));
    lte(r.finalProbabilityPct, 74, "stale odds → 74");
    eq(r.eliteGateApplied, true, "eliteGateApplied");
    assert(r.capReason?.startsWith("elite_gate_cap_74"), "capReason prefix");
    assert(r.capReason?.includes("stale_or_unknown_odds"), "capReason includes reason");
  });

  await test("elite_gate fail: freshOdds undefined treated as stale", () => {
    const { freshOdds: _unused, ...restCtx } = eliteCtx();
    const ctx: FinalizerContext = { ...restCtx, freshOdds: undefined };
    const r = finalizeNbaProbability(0.85, ctx);
    lte(r.finalProbabilityPct, 74, "undefined freshOdds → gate fires");
    eq(r.eliteGateApplied, true, "eliteGateApplied");
  });

  await test("elite_gate fail: fragility_too_high (fragilityScore >= 0.30) caps to 74", () => {
    const r = finalizeNbaProbability(0.85, eliteCtx({ fragilityScore: 0.30 }));
    lte(r.finalProbabilityPct, 74, "fragility 0.30 → 74");
    eq(r.eliteGateApplied, true, "eliteGateApplied");
    assert(r.capReason?.includes("fragility_too_high"), "reason: fragility_too_high");
  });

  await test("elite_gate fail: minutes_certainty_too_low (<0.65) caps to 74", () => {
    const r = finalizeNbaProbability(0.85, eliteCtx({ minutesCertainty: 0.60 }));
    lte(r.finalProbabilityPct, 74, "low minutes certainty → 74");
    eq(r.eliteGateApplied, true, "eliteGateApplied");
    assert(r.capReason?.includes("minutes_certainty_too_low"), "reason: minutes_certainty_too_low");
  });

  await test("elite_gate fail: projection_separation_too_thin (projDelta < 0.06) caps to 74", () => {
    const r = finalizeNbaProbability(0.85, eliteCtx({ projectionDeltaPct: 0.05 }));
    lte(r.finalProbabilityPct, 74, "thin projection → 74");
    eq(r.eliteGateApplied, true, "eliteGateApplied");
    assert(r.capReason?.includes("projection_separation_too_thin"), "reason: projection_separation_too_thin");
  });

  await test("elite_gate fail: edge_from_gap_only caps to 74", () => {
    const r = finalizeNbaProbability(0.85, eliteCtx({ edgeFromGapOnly: true }));
    lte(r.finalProbabilityPct, 74, "gap-only edge → 74");
    eq(r.eliteGateApplied, true, "eliteGateApplied");
    assert(r.capReason?.includes("edge_from_gap_only"), "reason: edge_from_gap_only");
  });

  await test("elite_gate fail: conflicting_side takes priority over other failure reasons", () => {
    const r = finalizeNbaProbability(
      0.85,
      eliteCtx({ conflictingSideSuppressed: true, freshOdds: false }),
    );
    assert(r.capReason?.includes("conflicting_side") || r.conflictSuppressionApplied, "conflict wins");
    lte(r.finalProbabilityPct, 68, "conflict survivor cap 68");
  });

  await test("elite_gate fail: low_volume market blocks elite (via eliteFailureReason)", () => {
    // steals → classifyMarketRisk = low_volume → eliteFailureReason = "low_volume_market"
    const r = finalizeNbaProbability(
      0.85,
      eliteCtx({
        market: "steals",
        // ensure low_volume soft modifier already pulls workingPp to <=72, so
        // elite gate floor (76) won't trigger here; but absolute cap enforces 72
      }),
    );
    lte(r.finalProbabilityPct, 72, "steals never above 72");
  });

  // ── 6. Elite gate PASS ───────────────────────────────────────────────────

  await test("elite_gate PASS: eligible play above 76 is NOT capped by gate", () => {
    const r = finalizeNbaProbability(0.80, eliteCtx());
    // 80pp passes all criteria — gate should not fire
    eq(r.eliteGateApplied, false, "eliteGateApplied should be false");
    // Not hard-capped since 80 < 82
    eq(r.highBucketCapped, false, "highBucketCapped should be false");
    // Final should be 80 (no reductions for stable_star/points/no-fragility)
    eq(r.finalProbabilityPct, 80, "finalProbabilityPct should be 80");
  });

  await test("elite_gate PASS: play at exactly 76.1 pp passes gate if eligible", () => {
    const r = finalizeNbaProbability(0.761, eliteCtx());
    eq(r.eliteGateApplied, false, "eliteGateApplied");
    lte(r.finalProbabilityPct, 82, "within hard ceiling");
  });

  // ── 7. Hard 82 ceiling ───────────────────────────────────────────────────

  await test("hard_ceiling_82: eligible play at 95pp is clipped to 82", () => {
    const r = finalizeNbaProbability(0.95, eliteCtx());
    eq(r.finalProbabilityPct, 82, "hard ceiling clips to 82");
    eq(r.highBucketCapped, true, "highBucketCapped should be true");
    eq(r.capReason, "hard_ceiling_82", "capReason");
  });

  await test("hard_ceiling_82: play at exactly 82pp is NOT clipped", () => {
    const r = finalizeNbaProbability(0.82, eliteCtx());
    eq(r.highBucketCapped, false, "82pp exactly should not trigger high-bucket cap");
    eq(r.finalProbabilityPct, 82, "82pp preserved");
  });

  await test("hard_ceiling_82: play at 81pp is not clipped by hard ceiling", () => {
    const r = finalizeNbaProbability(0.81, eliteCtx());
    eq(r.highBucketCapped, false, "81pp no clip");
    eq(r.finalProbabilityPct, 81, "81pp preserved");
  });

  // ── 8. Conflict survivor cap (68 pp) ─────────────────────────────────────

  await test("conflict_survivor_cap_68: conflicting side reduces to 68", () => {
    const r = finalizeNbaProbability(0.75, eliteCtx({ conflictingSideSuppressed: true }));
    // 75pp → conflict survivor cap fires (75 > 68)
    eq(r.conflictSuppressionApplied, true, "conflictSuppressionApplied");
    eq(r.finalProbabilityPct, 68, "capped to 68");
    eq(r.capReason, "conflict_survivor_cap_68", "capReason");
  });

  await test("conflict_survivor_cap_68: play at 60pp is NOT lifted (cap-only, no raise)", () => {
    const r = finalizeNbaProbability(0.60, eliteCtx({ conflictingSideSuppressed: true }));
    eq(r.conflictSuppressionApplied, false, "60pp is already below 68, no suppression needed");
    eq(r.finalProbabilityPct, 60, "60pp unchanged");
  });

  await test("conflict_survivor_cap_68: conflict cap applied after elite gate when both fire", () => {
    // 80pp → elite gate fires (conflicting_side reason) → 74 → conflict cap → 68
    const r = finalizeNbaProbability(0.80, eliteCtx({ conflictingSideSuppressed: true }));
    eq(r.conflictSuppressionApplied, true, "conflict suppression applied");
    eq(r.finalProbabilityPct, 68, "final capped to 68");
    eq(r.capReason, "conflict_survivor_cap_68", "conflict cap takes priority in capReason");
  });

  // ── 9. Dampened stacking weights (1.0 / 0.5 / 0.25 / 0.1) ───────────────

  await test("stacking: single modifier fires at full weight 1.0", () => {
    // bench_microwave + points → volatile_cap_70 only
    const r = finalizeNbaProbability(0.80, eliteCtx({ archetype: "bench_microwave" }));
    const capMod = r.modifierStack.find((m) => m.name === "volatile_cap_70");
    assert(capMod !== undefined, "volatile_cap_70 should be in stack");
    eq(capMod!.weight, 1.0, "first modifier weight");
    near(capMod!.appliedDeltaPp, capMod!.rawDeltaPp, 0.001, "applied = raw * 1.0");
  });

  await test("stacking: two modifiers get weights 1.0 and 0.5", () => {
    // bench_microwave (volatile_cap_70) + steals (low_volume_cap_72)
    // Raw deltas from 90pp: volatile_cap_70 → 20, low_volume_cap_72 → 18
    // Sorted: [volatile_cap_70 @1.0, low_volume_cap_72 @0.5]
    const r = finalizeNbaProbability(
      0.90,
      eliteCtx({ archetype: "bench_microwave", market: "steals" }),
    );
    const volMod = r.modifierStack.find((m) => m.name === "volatile_cap_70");
    const lvMod  = r.modifierStack.find((m) => m.name === "low_volume_cap_72");
    assert(volMod !== undefined, "volatile_cap_70 present");
    assert(lvMod !== undefined, "low_volume_cap_72 present");
    eq(volMod!.weight, 1.0, "largest modifier weight = 1.0");
    eq(lvMod!.weight, 0.5, "second modifier weight = 0.5");
  });

  await test("stacking: four modifiers assign weights 1.0 / 0.5 / 0.25 / 0.1", () => {
    // stl_blk: both low_volume AND combo market.
    // bench_microwave: volatile archetype → volatile_cap_70.
    // fragilityScore=0.50: fragility_subtraction.
    // Four candidates: volatile_cap_70, low_volume_cap_72, combo_cap_76, fragility_subtraction.
    const r = finalizeNbaProbability(
      0.90,
      eliteCtx({
        market: "stl_blk",
        archetype: "bench_microwave",
        fragilityScore: 0.50,
        minutesCertainty: 0.90,
        projectionDeltaPct: 0.10,
      }),
    );
    eq(r.modifierStack.length, 4, "should have 4 modifiers in stack");
    const weights = r.modifierStack.map((m) => m.weight);
    eq(weights[0], 1.0,  "1st modifier weight = 1.0");
    eq(weights[1], 0.5,  "2nd modifier weight = 0.5");
    eq(weights[2], 0.25, "3rd modifier weight = 0.25");
    eq(weights[3], 0.1,  "4th modifier weight = 0.1");
  });

  await test("stacking: modifiers sorted largest-rawDeltaPp first", () => {
    // volatile_cap_70 rawDelta=20 > low_volume_cap_72 rawDelta=18 at 90pp
    const r = finalizeNbaProbability(
      0.90,
      eliteCtx({ archetype: "bench_microwave", market: "steals" }),
    );
    const firstMod = r.modifierStack[0];
    eq(firstMod.name, "volatile_cap_70", "largest delta modifier is first");
  });

  await test("stacking: appliedDeltaPp = rawDeltaPp * weight for each modifier", () => {
    const r = finalizeNbaProbability(
      0.90,
      eliteCtx({
        market: "stl_blk",
        archetype: "bench_microwave",
        fragilityScore: 0.50,
        minutesCertainty: 0.90,
        projectionDeltaPct: 0.10,
      }),
    );
    for (const mod of r.modifierStack) {
      near(mod.appliedDeltaPp, mod.rawDeltaPp * mod.weight, 0.001,
        `${mod.name} appliedDeltaPp = rawDeltaPp * weight`);
    }
  });

  // ── 10. Fragility subtraction ─────────────────────────────────────────────

  await test("fragility_subtraction: fires only at fragilityScore >= 0.40", () => {
    const below = finalizeNbaProbability(0.70, eliteCtx({ fragilityScore: 0.39 }));
    const above = finalizeNbaProbability(0.70, eliteCtx({ fragilityScore: 0.40 }));
    assert(
      !below.modifierStack.some((m) => m.name === "fragility_subtraction"),
      "no fragility modifier at 0.39",
    );
    assert(
      above.modifierStack.some((m) => m.name === "fragility_subtraction"),
      "fragility modifier present at 0.40",
    );
    eq(above.fragilityDeltaPp, 4 + 4 * Math.min(1, 0.40), "fragilityDeltaPp formula");
  });

  await test("fragility hard cap: fragilityScore>=0.40 enforces absolute 72 ceiling", () => {
    // Even with a single-modifier play that's dampened, the 72 hard cap must hold
    const r = finalizeNbaProbability(0.78, eliteCtx({ fragilityScore: 0.45 }));
    lte(r.finalProbabilityPct, 72, "fragility hard cap at 72");
  });

  // ── 11. Stale-odds hard cap ───────────────────────────────────────────────

  await test("stale_odds_cap: non-fresh odds enforce absolute 76 ceiling", () => {
    // freshOdds false → oddsCap = 76. If post-stack workingPp < 76 already
    // via elite gate (→74), the absolute cap at 76 doesn't tighten further.
    // Verify final never exceeds 76 when freshOdds is false.
    const r = finalizeNbaProbability(0.85, eliteCtx({ freshOdds: false }));
    lte(r.finalProbabilityPct, 76, "stale odds hard cap at 76");
  });

  // ── 12. Never-raises invariant ────────────────────────────────────────────

  await test("never-raises: finalProbabilityPct <= initialProbabilityPct across wide range", () => {
    const archetypes = [
      "stable_star", "stable_starter", "volatile_starter",
      "bench_microwave", "low_minute_big", "lineup_impacted", "role_uncertain",
    ] as const;
    const markets = ["points", "rebounds", "assists", "steals", "blocks", "pts_reb", "pts_ast"];
    const probabilities = [0.50, 0.60, 0.65, 0.70, 0.75, 0.78, 0.80, 0.82, 0.85, 0.90, 0.95, 0.98];

    let cases = 0;
    for (const arch of archetypes) {
      for (const market of markets) {
        for (const p of probabilities) {
          const ctx = eliteCtx({ archetype: arch, market, fragilityScore: 0.10 });
          const r = finalizeNbaProbability(p, ctx);
          if (r.finalProbabilityPct > r.initialProbabilityPct + 0.001) {
            throw new Error(
              `RAISE DETECTED: arch=${arch} market=${market} p=${p} ` +
              `initial=${r.initialProbabilityPct} final=${r.finalProbabilityPct}`,
            );
          }
          cases++;
        }
      }
    }
    assert(cases > 0, "at least one case was evaluated");
  });

  await test("never-raises: no raise with conflicting side suppressed", () => {
    const probabilities = [0.55, 0.65, 0.70, 0.75, 0.80, 0.85];
    for (const p of probabilities) {
      const r = finalizeNbaProbability(p, eliteCtx({ conflictingSideSuppressed: true }));
      assert(
        r.finalProbabilityPct <= r.initialProbabilityPct + 0.001,
        `raise detected at p=${p}: initial=${r.initialProbabilityPct} final=${r.finalProbabilityPct}`,
      );
    }
  });

  await test("never-raises: no raise with fragility across threshold range", () => {
    for (const f of [0.0, 0.29, 0.30, 0.39, 0.40, 0.60, 0.80, 1.0]) {
      const r = finalizeNbaProbability(0.80, eliteCtx({ fragilityScore: f }));
      assert(
        r.finalProbabilityPct <= r.initialProbabilityPct + 0.001,
        `raise at fragilityScore=${f}: initial=${r.initialProbabilityPct} final=${r.finalProbabilityPct}`,
      );
    }
  });

  // ── 13. Return shape and calibrationVersion ───────────────────────────────

  await test("result: pSideFinal = finalProbabilityPct / 100", () => {
    const r = finalizeNbaProbability(0.78, eliteCtx());
    near(r.pSideFinal, r.finalProbabilityPct / 100, 0.0001, "pSideFinal");
  });

  await test("result: calibrationVersion is stamped correctly", () => {
    const r = finalizeNbaProbability(0.70, eliteCtx());
    eq(r.calibrationVersion, NBA_CALIBRATION_VERSION, "calibrationVersion");
    eq(NBA_CALIBRATION_VERSION, "nba-calibration-v2", "constant value");
  });

  await test("result: initialProbabilityPct reflects clamped input (2..98)", () => {
    const r = finalizeNbaProbability(0.01, eliteCtx()); // raw 1pp → clamped to 2
    eq(r.initialProbabilityPct, 2, "1pp clamped to 2");
    const r2 = finalizeNbaProbability(0.99, eliteCtx()); // raw 99pp → clamped to 98 then hard 82
    eq(r2.initialProbabilityPct, 98, "99pp clamped to 98 for initial");
  });

  await test("result: capApplied is false when no cap fires", () => {
    // A 60pp elite-eligible play should have no cap
    const r = finalizeNbaProbability(0.60, eliteCtx());
    eq(r.capApplied, false, "capApplied");
    eq(r.capReason, null, "capReason");
    eq(r.modifierStack.length, 0, "modifierStack empty");
  });

  await test("result: marketRiskTier reflects classification correctly", () => {
    const normal = finalizeNbaProbability(0.60, eliteCtx({ market: "points" }));
    const lowVol = finalizeNbaProbability(0.60, eliteCtx({ market: "steals" }));
    const combo  = finalizeNbaProbability(0.60, eliteCtx({ market: "pts_reb" }));
    const vol    = finalizeNbaProbability(0.60, eliteCtx({ archetype: "volatile_starter" }));
    eq(normal.marketRiskTier, "normal",     "points → normal");
    eq(lowVol.marketRiskTier, "low_volume", "steals → low_volume");
    eq(combo.marketRiskTier,  "combo",      "pts_reb → combo");
    eq(vol.marketRiskTier,    "volatile",   "volatile_starter → volatile");
  });

  // ── 14. isCombo override ─────────────────────────────────────────────────

  await test("isCombo override: explicit isCombo=true on non-combo market applies combo cap", () => {
    const r = finalizeNbaProbability(
      0.85,
      eliteCtx({ market: "points", isCombo: true, fragilityScore: 0.35 }),
    );
    assert(
      r.modifierStack.some((m) => m.name === "combo_cap_76"),
      "explicit isCombo=true should trigger combo_cap_76",
    );
    lte(r.finalProbabilityPct, 76, "combo cap applied");
  });

  await test("isCombo override: explicit isCombo=false on combo market skips combo cap", () => {
    const r = finalizeNbaProbability(
      0.78,
      eliteCtx({ market: "pts_reb", isCombo: false }),
    );
    assert(
      !r.modifierStack.some((m) => m.name === "combo_cap_76"),
      "isCombo=false disables combo_cap_76",
    );
  });

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
