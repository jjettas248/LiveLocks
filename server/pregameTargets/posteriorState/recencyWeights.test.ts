// Run: npx tsx server/pregameTargets/posteriorState/recencyWeights.test.ts
import { computeRecencyWeight, DEFAULT_RECENCY_CONFIG } from "./recencyWeights";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Season decay: current > prior-1 > prior-2, rollover drops the rest ────────
{
  const w0 = computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill" }).season;
  const w1 = computeRecencyWeight({ ageDays: 0, seasonOffset: 1, featureClass: "skill" }).season;
  const w2 = computeRecencyWeight({ ageDays: 0, seasonOffset: 2, featureClass: "skill" }).season;
  const w3 = computeRecencyWeight({ ageDays: 0, seasonOffset: 3, featureClass: "skill" }).season;
  ok(w0 === 1, "current season factor = 1");
  ok(w0 > w1 && w1 > w2, "current > prior-1 > prior-2");
  ok(approx(w1, 0.5) && approx(w2, 0.25), "season decay is 0.5^offset");
  ok(w3 === 0, "season beyond the rolling window (offset 3) drops to 0");
  ok(computeRecencyWeight({ ageDays: 0, seasonOffset: -1, featureClass: "skill" }).season === 0, "negative offset drops to 0");
}

// ── Role information decays FASTER than skill at the same age ─────────────────
{
  const age = 60;
  const role = computeRecencyWeight({ ageDays: age, seasonOffset: 0, featureClass: "role" }).recency;
  const context = computeRecencyWeight({ ageDays: age, seasonOffset: 0, featureClass: "context" }).recency;
  const skill = computeRecencyWeight({ ageDays: age, seasonOffset: 0, featureClass: "skill" }).recency;
  ok(role < context && context < skill, "role decays faster than context faster than skill");
  const hl = DEFAULT_RECENCY_CONFIG.halfLifeDaysByClass.skill;
  ok(approx(computeRecencyWeight({ ageDays: hl, seasonOffset: 0, featureClass: "skill" }).recency, 0.5), "recency = 0.5 at one skill half-life");
  ok(computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "role" }).recency === 1, "age 0 → recency 1");
}

// ── Continuity discounts, floored (skill partially carries) ──────────────────
{
  const full = computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill" }).continuity;
  const oneBroken = computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill", roleContinuity: 0 }).continuity;
  const allBroken = computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill", roleContinuity: 0, orgContinuity: 0, schemeContinuity: 0 }).continuity;
  ok(full === 1, "absent continuity → no discount (1)");
  ok(oneBroken < full, "a broken continuity dimension discounts");
  ok(approx(oneBroken, DEFAULT_RECENCY_CONFIG.continuityFloor), "one fully-broken dim floors at continuityFloor");
  ok(approx(allBroken, DEFAULT_RECENCY_CONFIG.continuityFloor ** 3), "three broken dims multiply the floor");
  ok(allBroken > 0, "continuity never zeroes out entirely (floored, not 0)");
}

// ── No-op safety + fail-safe clamping ────────────────────────────────────────
{
  const base = computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill" });
  ok(base.context === 1 && base.quality === 1 && base.weight === 1, "absent optionals → factors 1, weight 1");
  ok(computeRecencyWeight({ ageDays: NaN, seasonOffset: 0, featureClass: "skill" }).recency === 0, "NaN age → recency 0 (fail-safe, not NaN)");
  {
    const w = computeRecencyWeight({ ageDays: 0, seasonOffset: NaN, featureClass: "skill" });
    ok(w.season === 0 && w.weight === 0, "NaN seasonOffset → season 0, weight 0 (fail-safe, not NaN)");
    ok(Number.isFinite(w.weight), "weight stays finite under a NaN seasonOffset");
  }
  ok(computeRecencyWeight({ ageDays: 0, seasonOffset: Infinity, featureClass: "skill" }).season === 0, "Infinity seasonOffset → season 0");
  // A custom config with an out-of-range continuityFloor must not break [0,1].
  {
    const allBroken = { ageDays: 0, seasonOffset: 0, featureClass: "skill" as const, roleContinuity: 0, orgContinuity: 0, schemeContinuity: 0 };
    const hi = computeRecencyWeight(allBroken, { ...DEFAULT_RECENCY_CONFIG, continuityFloor: 2 });
    ok(hi.continuity <= 1 && hi.weight <= 1, "continuityFloor > 1 is clamped → weight stays <= 1");
    const nan = computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill" }, { ...DEFAULT_RECENCY_CONFIG, continuityFloor: NaN });
    ok(Number.isFinite(nan.weight), "NaN continuityFloor → finite weight");
  }
  // A custom seasonDecay outside [0,1] must not break the invariant either.
  {
    const hi = computeRecencyWeight({ ageDays: 0, seasonOffset: 1, featureClass: "skill" }, { ...DEFAULT_RECENCY_CONFIG, seasonDecay: 2 });
    ok(hi.season <= 1 && hi.weight <= 1, "seasonDecay > 1 is clamped → season/weight stay <= 1");
    const nan = computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill" }, { ...DEFAULT_RECENCY_CONFIG, seasonDecay: NaN });
    ok(Number.isFinite(nan.weight), "NaN seasonDecay → finite weight");
  }
  // A non-finite maxSeasonOffset must not disable the rollover (fail-safe: keep
  // only the current season).
  {
    const nanW = { ...DEFAULT_RECENCY_CONFIG, maxSeasonOffset: NaN };
    ok(computeRecencyWeight({ ageDays: 0, seasonOffset: 2, featureClass: "skill" }, nanW).season === 0, "NaN maxSeasonOffset → out-of-window offset drops to 0");
    ok(computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill" }, nanW).season === 1, "current season (offset 0) still survives a bad window config");
    const infW = { ...DEFAULT_RECENCY_CONFIG, maxSeasonOffset: Infinity };
    ok(computeRecencyWeight({ ageDays: 0, seasonOffset: 5, featureClass: "skill" }, infW).season === 0, "Infinity maxSeasonOffset → still drops beyond the window");
  }
  ok(computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill", dataQuality: 2 }).quality === 1, "quality clamped to 1");
  ok(computeRecencyWeight({ ageDays: 0, seasonOffset: 0, featureClass: "skill", contextSimilarity: -1 }).context === 0, "negative context clamped to 0");
  ok(computeRecencyWeight({ ageDays: -10, seasonOffset: 0, featureClass: "skill" }).recency === 1, "negative age clamped to 0 → recency 1");
}

// ── Full product composes all factors ────────────────────────────────────────
{
  const w = computeRecencyWeight({
    ageDays: DEFAULT_RECENCY_CONFIG.halfLifeDaysByClass.skill,
    seasonOffset: 1,
    featureClass: "skill",
    roleContinuity: 0,
    contextSimilarity: 0.5,
    dataQuality: 0.8,
  });
  const expected = 0.5 /*season*/ * 0.5 /*recency*/ * DEFAULT_RECENCY_CONFIG.continuityFloor /*role*/ * 0.5 /*context*/ * 0.8 /*quality*/;
  ok(approx(w.weight, expected), "weight = product of all five factors");
}

console.log(`\nrecencyWeights.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
