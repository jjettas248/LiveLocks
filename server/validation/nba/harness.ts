import { computeProbability, isComboMarket, getEngineConstants } from "../../nba/probabilityEngine";
import {
  classifyArchetype,
  VARIANCE_MULTIPLIERS,
  MINUTES_FRAGILITY_MULTIPLIERS,
  CORRELATION_DEFAULTS,
  COMBO_VARIANCE_EXTRA,
  SAFETY_CEILINGS,
  isVolatileArchetype,
  isImpactedArchetype,
  getSafetyCeiling,
} from "../../nba/archetypes";
import type { NBAArchetype } from "../../nba/archetypes";
import { NBA_FIXTURES, type NBAFixture } from "./fixtures";

type DriftType =
  | "ARCHETYPE_DRIFT"
  | "BLENDED_RATE_DRIFT"
  | "CALIBRATION_DRIFT"
  | "FRAGILITY_DRIFT"
  | "SAFETY_CEILING_DRIFT"
  | "DIRECTIONAL_INTEGRITY_FAILURE"
  | "PROBABILITY_BOUNDS_FAILURE"
  | "OUTPUT_CONTRACT_FAILURE"
  | "COVARIANCE_DRIFT"
  | "HALFTIME_PIPELINE_DRIFT"
  | "CONSTANT_DRIFT";

interface DriftReport {
  type: DriftType;
  severity: "critical" | "warning" | "info";
  expected: string;
  actual: string;
  location: string;
}

interface ValidationResult {
  passed: boolean;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  driftReports: DriftReport[];
  fixtureResults: FixtureResult[];
  constantChecks: ConstantCheck[];
  timestamp: string;
}

interface FixtureResult {
  name: string;
  description: string;
  passed: boolean;
  details: string[];
  output?: any;
}

interface ConstantCheck {
  name: string;
  expected: any;
  actual: any;
  passed: boolean;
}

const EXPECTED_ARCHETYPES: NBAArchetype[] = [
  "stable_star", "stable_starter", "volatile_starter",
  "bench_microwave", "low_minute_big", "lineup_impacted", "role_uncertain",
];

const EXPECTED_VARIANCE_MULTIPLIERS: Record<string, number> = {
  stable_star: 1.00, stable_starter: 1.05, volatile_starter: 1.20,
  bench_microwave: 1.30, low_minute_big: 1.25, lineup_impacted: 1.35,
  role_uncertain: 1.40,
};

const EXPECTED_FRAGILITY_MULTIPLIERS: Record<string, number> = {
  stable_star: 1.00, stable_starter: 1.05, volatile_starter: 1.20,
  bench_microwave: 1.30, low_minute_big: 1.35, lineup_impacted: 1.40,
  role_uncertain: 1.50,
};

const EXPECTED_SAFETY_CEILINGS: Record<string, number> = {
  stable_single: 0.80, stable_combo: 0.74,
  volatile_single: 0.70, volatile_combo: 0.66,
  impacted_any: 0.64,
};

const EXPECTED_CORRELATIONS: Record<string, { rho_PR: number; rho_PA: number; rho_RA: number }> = {
  stable_star:      { rho_PR: 0.20, rho_PA: 0.28, rho_RA: 0.12 },
  stable_starter:   { rho_PR: 0.18, rho_PA: 0.22, rho_RA: 0.10 },
  volatile_starter: { rho_PR: 0.14, rho_PA: 0.18, rho_RA: 0.08 },
  bench_microwave:  { rho_PR: 0.08, rho_PA: 0.12, rho_RA: 0.05 },
  low_minute_big:   { rho_PR: 0.22, rho_PA: 0.05, rho_RA: 0.10 },
  lineup_impacted:  { rho_PR: 0.14, rho_PA: 0.18, rho_RA: 0.08 },
  role_uncertain:   { rho_PR: 0.14, rho_PA: 0.18, rho_RA: 0.08 },
};

const EXPECTED_COMBO_EXTRA: Record<string, number> = {
  stable_star: 1.0, stable_starter: 1.0, volatile_starter: 1.0,
  bench_microwave: 1.0, low_minute_big: 1.0,
  lineup_impacted: 1.12, role_uncertain: 1.12,
};

const EXPECTED_ENGINE_CONSTANTS: Record<string, { value: number; location: string }> = {
  SINGLE_EPSILON: { value: 0.35, location: "probabilityEngine.ts SINGLE_EPSILON" },
  COMBO_EPSILON: { value: 0.60, location: "probabilityEngine.ts COMBO_EPSILON" },
  SIGMA_FLOOR_points: { value: 3.0, location: "probabilityEngine.ts STAT_SIGMA_FLOORS.points" },
  SIGMA_FLOOR_rebounds: { value: 2.0, location: "probabilityEngine.ts STAT_SIGMA_FLOORS.rebounds" },
  SIGMA_FLOOR_assists: { value: 1.8, location: "probabilityEngine.ts STAT_SIGMA_FLOORS.assists" },
  SIGMA_FLOOR_steals: { value: 0.8, location: "probabilityEngine.ts STAT_SIGMA_FLOORS.steals" },
  SIGMA_FLOOR_blocks: { value: 0.8, location: "probabilityEngine.ts STAT_SIGMA_FLOORS.blocks" },
  SIGMA_FLOOR_threes: { value: 1.2, location: "probabilityEngine.ts STAT_SIGMA_FLOORS.threes" },
  COMBO_INFLATION_pts_reb: { value: 1.05, location: "probabilityEngine.ts COMBO_INFLATION.pts_reb" },
  COMBO_INFLATION_pts_ast: { value: 1.08, location: "probabilityEngine.ts COMBO_INFLATION.pts_ast" },
  COMBO_INFLATION_reb_ast: { value: 1.08, location: "probabilityEngine.ts COMBO_INFLATION.reb_ast" },
  COMBO_INFLATION_pts_reb_ast: { value: 1.12, location: "probabilityEngine.ts COMBO_INFLATION.pts_reb_ast" },
};

function validateConstants(): { checks: ConstantCheck[]; drifts: DriftReport[] } {
  const checks: ConstantCheck[] = [];
  const drifts: DriftReport[] = [];

  for (const arch of EXPECTED_ARCHETYPES) {
    const vmExpected = EXPECTED_VARIANCE_MULTIPLIERS[arch];
    const vmActual = VARIANCE_MULTIPLIERS[arch];
    const vmPassed = vmActual === vmExpected;
    checks.push({ name: `VARIANCE_MULT_${arch}`, expected: vmExpected, actual: vmActual, passed: vmPassed });
    if (!vmPassed) drifts.push({ type: "CONSTANT_DRIFT", severity: "critical", expected: `${vmExpected}`, actual: `${vmActual}`, location: `archetypes.ts VARIANCE_MULTIPLIERS[${arch}]` });

    const fmExpected = EXPECTED_FRAGILITY_MULTIPLIERS[arch];
    const fmActual = MINUTES_FRAGILITY_MULTIPLIERS[arch];
    const fmPassed = fmActual === fmExpected;
    checks.push({ name: `FRAGILITY_MULT_${arch}`, expected: fmExpected, actual: fmActual, passed: fmPassed });
    if (!fmPassed) drifts.push({ type: "CONSTANT_DRIFT", severity: "critical", expected: `${fmExpected}`, actual: `${fmActual}`, location: `archetypes.ts MINUTES_FRAGILITY_MULTIPLIERS[${arch}]` });

    const ceExpected = EXPECTED_COMBO_EXTRA[arch];
    const ceActual = COMBO_VARIANCE_EXTRA[arch];
    const cePassed = ceActual === ceExpected;
    checks.push({ name: `COMBO_EXTRA_${arch}`, expected: ceExpected, actual: ceActual, passed: cePassed });
    if (!cePassed) drifts.push({ type: "COVARIANCE_DRIFT", severity: "critical", expected: `${ceExpected}`, actual: `${ceActual}`, location: `archetypes.ts COMBO_VARIANCE_EXTRA[${arch}]` });

    const corrExpected = EXPECTED_CORRELATIONS[arch];
    const corrActual = CORRELATION_DEFAULTS[arch];
    for (const key of ["rho_PR", "rho_PA", "rho_RA"] as const) {
      const kExpected = corrExpected[key];
      const kActual = corrActual[key];
      const kPassed = kActual === kExpected;
      checks.push({ name: `CORR_${arch}_${key}`, expected: kExpected, actual: kActual, passed: kPassed });
      if (!kPassed) drifts.push({ type: "COVARIANCE_DRIFT", severity: "critical", expected: `${kExpected}`, actual: `${kActual}`, location: `archetypes.ts CORRELATION_DEFAULTS[${arch}].${key}` });
    }
  }

  for (const [key, expected] of Object.entries(EXPECTED_SAFETY_CEILINGS)) {
    const actual = SAFETY_CEILINGS[key];
    const passed = actual === expected;
    checks.push({ name: `CEILING_${key}`, expected, actual, passed });
    if (!passed) drifts.push({ type: "SAFETY_CEILING_DRIFT", severity: "critical", expected: `${expected}`, actual: `${actual}`, location: `archetypes.ts SAFETY_CEILINGS[${key}]` });
  }

  const ec = getEngineConstants();
  const engineChecks: [string, number, any, string][] = [
    ["SINGLE_EPSILON", 0.35, ec.SINGLE_EPSILON, "probabilityEngine.ts"],
    ["COMBO_EPSILON", 0.60, ec.COMBO_EPSILON, "probabilityEngine.ts"],
    ["CALIBRATION_SINGLE", 0.88, ec.CALIBRATION_SINGLE, "probabilityEngine.ts calibrate()"],
    ["CALIBRATION_COMBO", 0.78, ec.CALIBRATION_COMBO, "probabilityEngine.ts calibrate()"],
    ["VOLATILE_SHRINKAGE", 0.90, ec.VOLATILE_SHRINKAGE, "probabilityEngine.ts calibrate()"],
    ["UNDER_BIAS_PRE_CAL", 0.92, ec.UNDER_BIAS_PRE_CAL, "probabilityEngine.ts computeProbability()"],
    ["UNDER_BIAS_IN_CAL", 0.95, ec.UNDER_BIAS_IN_CAL, "probabilityEngine.ts calibrate()"],
    ["FRAGILITY_MAX_PENALTY", 0.45, ec.FRAGILITY_MAX_PENALTY, "probabilityEngine.ts computeProbability()"],
    ["MIN_DISPLAY_CONFIDENCE", 0.58, ec.MIN_DISPLAY_CONFIDENCE, "probabilityEngine.ts computeProbability()"],
    ["MIN_MODEL_EDGE", 0.04, ec.MIN_MODEL_EDGE, "probabilityEngine.ts computeProbability()"],
    ["FRAG_W_minutesVar", 0.25, ec.FRAGILITY_WEIGHTS.normalizedMinutesVariance, "probabilityEngine.ts computeFragilityScore()"],
    ["FRAG_W_roleUncertainty", 0.20, ec.FRAGILITY_WEIGHTS.roleUncertainty, "probabilityEngine.ts computeFragilityScore()"],
    ["FRAG_W_lineupInstability", 0.20, ec.FRAGILITY_WEIGHTS.lineupInstability, "probabilityEngine.ts computeFragilityScore()"],
    ["FRAG_W_blowoutRisk", 0.15, ec.FRAGILITY_WEIGHTS.blowoutRisk, "probabilityEngine.ts computeFragilityScore()"],
    ["FRAG_W_usageShock", 0.10, ec.FRAGILITY_WEIGHTS.usageShock, "probabilityEngine.ts computeFragilityScore()"],
    ["FRAG_W_lateSeasonChaos", 0.10, ec.FRAGILITY_WEIGHTS.lateSeasonChaos, "probabilityEngine.ts computeFragilityScore()"],
  ];
  for (const sf of Object.entries(EXPECTED_ENGINE_CONSTANTS)) {
    const [name, spec] = sf;
    const actual = name.startsWith("SIGMA_FLOOR_")
      ? ec.STAT_SIGMA_FLOORS[name.replace("SIGMA_FLOOR_", "") as keyof typeof ec.STAT_SIGMA_FLOORS]
      : name.startsWith("COMBO_INFLATION_")
      ? ec.COMBO_INFLATION[name.replace("COMBO_INFLATION_", "") as keyof typeof ec.COMBO_INFLATION]
      : undefined;
    if (actual !== undefined) {
      engineChecks.push([name, spec.value, actual, spec.location]);
    }
  }
  for (const [name, expected, actual, location] of engineChecks) {
    const passed = actual === expected;
    checks.push({ name: `ENGINE_${name}`, expected, actual, passed });
    if (!passed) drifts.push({ type: "CONSTANT_DRIFT", severity: "critical", expected: `${expected}`, actual: `${actual}`, location });
  }

  return { checks, drifts };
}

function validateArchetypeClassification(): { checks: ConstantCheck[]; drifts: DriftReport[] } {
  const checks: ConstantCheck[] = [];
  const drifts: DriftReport[] = [];

  const cases: { input: any; expected: NBAArchetype }[] = [
    { input: { avgMinutes: 34, starterConsistency: 0.9, recentMinutesVariance: 10, gamesPlayed: 70 }, expected: "stable_star" },
    { input: { avgMinutes: 28, isStarter: true, recentMinutesVariance: 15, gamesPlayed: 60 }, expected: "stable_starter" },
    { input: { avgMinutes: 26, isStarter: true, recentMinutesVariance: 40, gamesPlayed: 60 }, expected: "volatile_starter" },
    { input: { avgMinutes: 18, usageRate: 0.25, position: "SG", gamesPlayed: 60, starterConsistency: 0.55 }, expected: "bench_microwave" },
    { input: { avgMinutes: 18, usageRate: 0.12, position: "C", gamesPlayed: 60, starterConsistency: 0.55 }, expected: "low_minute_big" },
    { input: { avgMinutes: 25, lineupDisrupted: true, gamesPlayed: 60 }, expected: "lineup_impacted" },
    { input: { avgMinutes: 20, gamesPlayed: 10 }, expected: "lineup_impacted" },
    { input: { avgMinutes: 18, starterConsistency: 0.3, usageRate: 0.15, position: "SG", gamesPlayed: 60 }, expected: "role_uncertain" },
  ];

  for (const c of cases) {
    const actual = classifyArchetype(c.input);
    const passed = actual === c.expected;
    checks.push({ name: `ARCHETYPE_${c.expected}`, expected: c.expected, actual, passed });
    if (!passed) drifts.push({ type: "ARCHETYPE_DRIFT", severity: "critical", expected: c.expected, actual, location: `archetypes.ts classifyArchetype()` });
  }

  return { checks, drifts };
}

function validateFixture(fixture: NBAFixture): FixtureResult {
  const details: string[] = [];
  let passed = true;

  const output = computeProbability(fixture.input, fixture.options);

  if (output.archetype !== fixture.expectations.expectedArchetype) {
    passed = false;
    details.push(`ARCHETYPE: expected=${fixture.expectations.expectedArchetype} actual=${output.archetype}`);
  }

  if (fixture.expectations.noSignal === true) {
    if (output.direction !== "NO_SIGNAL") {
      passed = false;
      details.push(`EXPECTED_NO_SIGNAL: got direction=${output.direction} confidence=${output.displayConfidence}`);
    }
  } else if (fixture.expectations.expectedDirection && output.direction !== fixture.expectations.expectedDirection) {
    if (fixture.expectations.noSignal === false && output.direction === "NO_SIGNAL") {
      passed = false;
      details.push(`DIRECTION: expected=${fixture.expectations.expectedDirection} got NO_SIGNAL reasons=[${output.noSignalReasons.join(",")}]`);
    } else if (output.direction !== fixture.expectations.expectedDirection) {
      passed = false;
      details.push(`DIRECTION: expected=${fixture.expectations.expectedDirection} actual=${output.direction}`);
    }
  }

  if (output.direction !== "NO_SIGNAL" && output.displayConfidence != null) {
    if (fixture.expectations.probMin != null && output.displayConfidence < fixture.expectations.probMin) {
      passed = false;
      details.push(`PROB_LOW: expected>=${fixture.expectations.probMin} actual=${output.displayConfidence}`);
    }
    if (fixture.expectations.probMax != null && output.displayConfidence > fixture.expectations.probMax) {
      passed = false;
      details.push(`PROB_HIGH: expected<=${fixture.expectations.probMax} actual=${output.displayConfidence}`);
    }
  }

  if (output.direction !== "NO_SIGNAL") {
    if (output.direction === "OVER" && output.projection <= output.line) {
      passed = false;
      details.push(`DIRECTIONAL_INTEGRITY: OVER but projection=${output.projection} <= line=${output.line}`);
    }
    if (output.direction === "UNDER" && output.projection >= output.line) {
      passed = false;
      details.push(`DIRECTIONAL_INTEGRITY: UNDER but projection=${output.projection} >= line=${output.line}`);
    }
  }

  if (!Number.isFinite(output.finalProbabilityOver) || !Number.isFinite(output.finalProbabilityUnder)) {
    passed = false;
    details.push(`NON_FINITE: probOver=${output.finalProbabilityOver} probUnder=${output.finalProbabilityUnder}`);
  }
  if (output.finalProbabilityOver < 0 || output.finalProbabilityOver > 1) {
    passed = false;
    details.push(`BOUNDS: probOver=${output.finalProbabilityOver} outside [0,1]`);
  }
  if (output.finalProbabilityUnder < 0 || output.finalProbabilityUnder > 1) {
    passed = false;
    details.push(`BOUNDS: probUnder=${output.finalProbabilityUnder} outside [0,1]`);
  }

  if (!Number.isFinite(output.projection)) {
    passed = false;
    details.push(`CONTRACT: projection is not finite: ${output.projection}`);
  }
  if (!Number.isFinite(output.modelEdge)) {
    passed = false;
    details.push(`CONTRACT: modelEdge is not finite: ${output.modelEdge}`);
  }
  if (output.direction !== "NO_SIGNAL" && output.displayConfidence == null) {
    passed = false;
    details.push(`CONTRACT: direction=${output.direction} but displayConfidence is null`);
  }

  if (fixture.expectations.isCombo) {
    const ceiling = getSafetyCeiling(fixture.input.archetype, true);
    if (output.displayConfidence != null && output.displayConfidence > ceiling + 0.001) {
      passed = false;
      details.push(`CEILING: combo confidence ${output.displayConfidence} exceeds ceiling ${ceiling}`);
    }
  }

  if (fixture.expectations.shouldHaveFragilityReasons) {
    for (const reason of fixture.expectations.shouldHaveFragilityReasons) {
      if (!output.fragilityReasons.includes(reason)) {
        passed = false;
        details.push(`FRAGILITY: expected reason "${reason}" not present in [${output.fragilityReasons.join(",")}]`);
      }
    }
  }

  if (passed) {
    details.push(`OK: direction=${output.direction} confidence=${output.displayConfidence} projection=${output.projection} edge=${output.modelEdge.toFixed(4)}`);
  }

  return {
    name: fixture.name,
    description: fixture.description,
    passed,
    details,
    output: {
      direction: output.direction,
      displayConfidence: output.displayConfidence,
      projection: output.projection,
      modelEdge: output.modelEdge,
      archetype: output.archetype,
      fragilityScore: output.fragilityScore,
      calibrationTrack: output.calibrationTrack,
      noSignal: output.noSignal,
      noSignalReasons: output.noSignalReasons,
    },
  };
}

function validateCalibrationStability(results: FixtureResult[]): DriftReport[] {
  const drifts: DriftReport[] = [];
  const signalResults = results.filter(r => r.output && r.output.direction !== "NO_SIGNAL" && r.output.displayConfidence != null);

  if (signalResults.length === 0) {
    drifts.push({
      type: "CALIBRATION_DRIFT",
      severity: "critical",
      expected: "At least some fixtures should produce signals",
      actual: "All fixtures returned NO_SIGNAL",
      location: "probabilityEngine.ts computeProbability()",
    });
    return drifts;
  }

  const confidences = signalResults.map(r => r.output.displayConfidence).filter(Boolean) as number[];
  const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;

  if (avg > 0.80) {
    drifts.push({
      type: "CALIBRATION_DRIFT",
      severity: "warning",
      expected: "Average confidence typically 55-75%",
      actual: `Average confidence ${(avg * 100).toFixed(1)}% (inflated)`,
      location: "probabilityEngine.ts calibrate()",
    });
  }

  if (avg < 0.50) {
    drifts.push({
      type: "CALIBRATION_DRIFT",
      severity: "warning",
      expected: "Average confidence typically 55-75%",
      actual: `Average confidence ${(avg * 100).toFixed(1)}% (suppressed)`,
      location: "probabilityEngine.ts calibrate()",
    });
  }

  const overCount = signalResults.filter(r => r.output.direction === "OVER").length;
  const underCount = signalResults.filter(r => r.output.direction === "UNDER").length;
  const total = overCount + underCount;
  if (total > 0) {
    const overRatio = overCount / total;
    if (overRatio > 0.85 || overRatio < 0.15) {
      drifts.push({
        type: "CALIBRATION_DRIFT",
        severity: "warning",
        expected: "Balanced over/under distribution (15-85%)",
        actual: `Over ratio: ${(overRatio * 100).toFixed(1)}% (${overCount}/${total})`,
        location: "probabilityEngine.ts direction logic",
      });
    }
  }

  return drifts;
}

export function runNBAValidation(): ValidationResult {
  const allDrifts: DriftReport[] = [];
  const allChecks: ConstantCheck[] = [];
  let totalAssertions = 0;
  let passedAssertions = 0;

  const { checks: constChecks, drifts: constDrifts } = validateConstants();
  allChecks.push(...constChecks);
  allDrifts.push(...constDrifts);
  totalAssertions += constChecks.length;
  passedAssertions += constChecks.filter(c => c.passed).length;

  const { checks: archChecks, drifts: archDrifts } = validateArchetypeClassification();
  allChecks.push(...archChecks);
  allDrifts.push(...archDrifts);
  totalAssertions += archChecks.length;
  passedAssertions += archChecks.filter(c => c.passed).length;

  const fixtureResults: FixtureResult[] = [];
  for (const fixture of NBA_FIXTURES) {
    const result = validateFixture(fixture);
    fixtureResults.push(result);
    totalAssertions++;
    if (result.passed) passedAssertions++;
    if (!result.passed) {
      for (const detail of result.details) {
        if (detail.startsWith("DIRECTIONAL_INTEGRITY")) {
          allDrifts.push({ type: "DIRECTIONAL_INTEGRITY_FAILURE", severity: "critical", expected: "Projection aligns with direction", actual: detail, location: `fixture: ${fixture.name}` });
        } else if (detail.startsWith("PROB_") || detail.startsWith("BOUNDS")) {
          allDrifts.push({ type: "PROBABILITY_BOUNDS_FAILURE", severity: "critical", expected: "Probability within expected range", actual: detail, location: `fixture: ${fixture.name}` });
        } else if (detail.startsWith("CONTRACT")) {
          allDrifts.push({ type: "OUTPUT_CONTRACT_FAILURE", severity: "critical", expected: "Valid output contract", actual: detail, location: `fixture: ${fixture.name}` });
        } else if (detail.startsWith("FRAGILITY")) {
          allDrifts.push({ type: "FRAGILITY_DRIFT", severity: "warning", expected: "Expected fragility reasons present", actual: detail, location: `fixture: ${fixture.name}` });
        } else if (detail.startsWith("CEILING")) {
          allDrifts.push({ type: "SAFETY_CEILING_DRIFT", severity: "critical", expected: "Confidence within ceiling", actual: detail, location: `fixture: ${fixture.name}` });
        }
      }
    }
  }

  const calDrifts = validateCalibrationStability(fixtureResults);
  allDrifts.push(...calDrifts);

  const failedAssertionCount = totalAssertions - passedAssertions;
  const criticalDriftCount = allDrifts.filter(d => d.severity === "critical").length;

  return {
    passed: failedAssertionCount === 0 && criticalDriftCount === 0,
    totalAssertions,
    passedAssertions,
    failedAssertions: totalAssertions - passedAssertions,
    driftReports: allDrifts,
    fixtureResults,
    constantChecks: allChecks,
    timestamp: new Date().toISOString(),
  };
}

export function formatValidationReport(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push("  NBA ENGINE VALIDATION REPORT");
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`  Status: ${result.passed ? "✓ PASS" : "✗ FAIL"}`);
  lines.push(`  Assertions: ${result.passedAssertions}/${result.totalAssertions} passed`);
  lines.push(`  Drift Reports: ${result.driftReports.length}`);
  lines.push(`  Timestamp: ${result.timestamp}`);
  lines.push("───────────────────────────────────────────────────────────");

  if (result.driftReports.length > 0) {
    lines.push("\n  DRIFT DETECTED:");
    for (const drift of result.driftReports) {
      lines.push(`  [${drift.severity.toUpperCase()}] ${drift.type}`);
      lines.push(`    Expected: ${drift.expected}`);
      lines.push(`    Actual:   ${drift.actual}`);
      lines.push(`    Location: ${drift.location}`);
    }
  }

  lines.push("\n  FIXTURE RESULTS:");
  for (const fr of result.fixtureResults) {
    const icon = fr.passed ? "✓" : "✗";
    lines.push(`  ${icon} ${fr.name}: ${fr.details[0]}`);
    if (!fr.passed) {
      for (let i = 1; i < fr.details.length; i++) {
        lines.push(`    → ${fr.details[i]}`);
      }
    }
  }

  const failedConst = result.constantChecks.filter(c => !c.passed);
  if (failedConst.length > 0) {
    lines.push("\n  FAILED CONSTANT CHECKS:");
    for (const c of failedConst) {
      lines.push(`  ✗ ${c.name}: expected=${c.expected} actual=${c.actual}`);
    }
  } else {
    lines.push(`\n  CONSTANT CHECKS: All ${result.constantChecks.length} passed`);
  }

  lines.push("\n═══════════════════════════════════════════════════════════");
  return lines.join("\n");
}
