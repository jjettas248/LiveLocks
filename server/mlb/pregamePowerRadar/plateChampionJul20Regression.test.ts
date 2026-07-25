// The Plate — champion (July-20 restored) policy lock.
//
// Guards the restoration against silent re-drift:
//   1. Champion component weights equal the July-20 values.
//   2. Contact-allowed pitcher metrics cannot change champion Pitcher Vulnerability.
//   3. Last-3-start ERA cannot change champion Pitcher Vulnerability.
//   4. Rest days cannot change champion Pitcher Vulnerability.
//   5. Batted-ball-event count cannot change champion Batter Power.
//   6. Attack Environment cannot change champion score10.
//   7. Attack Environment cannot change champion tier.
//   8. Attack Environment cannot suppress the champion.
//   9. Evidence-family count cannot independently suppress the champion.
//  10. Positive-driver count < 2 still suppresses the champion.
//  11. Research driver keys cannot satisfy the champion's driver minimum,
//      regardless of the order in which they are appended.
//  12. The challenger reproduces HEAD's pre-freeze driver count exactly.
//  13. Driver-key set hygiene — every emitted key is deliberately classified.
//  14. Publication is explicit and is NOT `!suppressed`.
//  15. The build-time decision and the read-time diagnostics adapter agree.
//  16. Champion and challenger share identical BvP behavior.
//
// Run: npx tsx server/mlb/pregamePowerRadar/plateChampionJul20Regression.test.ts

import {
  composePregameScore,
  classifyTier,
  COMPONENT_WEIGHTS,
  type ScoringComponents,
  type ScoringFlags,
} from "./scoring";
import { computeBatterPowerProfile, type BatterPowerInputs } from "./batterPowerProfile";
import { computePitcherVulnerability, type PitcherVulnerabilityInputs } from "./pitcherVulnerability";
import { computeMatchupFit } from "./matchupFit";
import { PLATE_CHAMPION_POLICY } from "./modelVersions/plateChampionJul20";
import { PLATE_CHALLENGER_POLICY } from "./modelVersions/plateChallengerCurrent";
import {
  countPositiveDrivers,
  classifyDriverKey,
  driverKeysForUniverse,
  JUL20_POSITIVE_DRIVER_KEYS,
  CURRENT_HEAD_POSITIVE_DRIVER_KEYS,
  RESEARCH_ONLY_DRIVER_KEYS,
} from "./modelVersions/plateDriverUniverse";
import { decidePlatePublication } from "./modelVersions/platePublicationDecision";
import { wasPubliclyFlaggedPregame, buildChampionPublicationInput } from "./diagnostics";
import type { PowerDriver, PregamePowerSignal } from "./types";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const CHAMP = PLATE_CHAMPION_POLICY;
const CHAL = PLATE_CHALLENGER_POLICY;

// ── 1. Component weights ──────────────────────────────────────────────────────
ok(COMPONENT_WEIGHTS.batterPower === 0.28, `batterPower weight 0.28 (got ${COMPONENT_WEIGHTS.batterPower})`);
ok(COMPONENT_WEIGHTS.pitcherVulnerability === 0.23, `pitcherVulnerability weight 0.23 (got ${COMPONENT_WEIGHTS.pitcherVulnerability})`);
ok(COMPONENT_WEIGHTS.matchupFit === 0.18, `matchupFit weight 0.18 (got ${COMPONENT_WEIGHTS.matchupFit})`);
ok(COMPONENT_WEIGHTS.parkWeather === 0.14, `parkWeather weight 0.14 (got ${COMPONENT_WEIGHTS.parkWeather})`);
ok(COMPONENT_WEIGHTS.lineupOpportunity === 0.09, `lineupOpportunity weight 0.09 (got ${COMPONENT_WEIGHTS.lineupOpportunity})`);
ok(COMPONENT_WEIGHTS.nearHrRecentForm === 0.08, `nearHrRecentForm weight 0.08 (got ${COMPONENT_WEIGHTS.nearHrRecentForm})`);
ok(
  Math.abs(Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9,
  "component weights sum to 1.00",
);

// ── 2-4. Pitcher research legs cannot move the champion ───────────────────────
const pvBase: PitcherVulnerabilityInputs = {
  pitcherKnown: true, batterHand: "R", pitcherThrows: "R",
  hrPer9VsLHB: 1.2, hrPer9VsRHB: 1.6, eraVsLHB: 3.9, eraVsRHB: 4.6,
};
const pvChampionBare = computePitcherVulnerability(pvBase, CHAMP.pitcher);

{
  const withContact = computePitcherVulnerability(
    { ...pvBase, barrelAllowedPct: 14, hardHitAllowedPct: 50, flyBallAllowedPct: 48 },
    CHAMP.pitcher,
  );
  ok(withContact.score10 === pvChampionBare.score10, `[2] contact-allowed metrics do not move champion PV (${withContact.score10} vs ${pvChampionBare.score10})`);
  ok(!withContact.drivers.some((d) => d.key === "pv_barrel"), "[2] champion emits no pv_barrel driver");
  // …but they MUST move the challenger, or the shadow track measures nothing.
  const challengerBare = computePitcherVulnerability(pvBase, CHAL.pitcher);
  const challengerContact = computePitcherVulnerability(
    { ...pvBase, barrelAllowedPct: 14, hardHitAllowedPct: 50, flyBallAllowedPct: 48 },
    CHAL.pitcher,
  );
  ok(challengerContact.score10 !== challengerBare.score10, `[2] contact-allowed metrics DO move challenger PV (${challengerContact.score10} vs ${challengerBare.score10})`);
}
{
  const rough = computePitcherVulnerability({ ...pvBase, last3StartERA: 7.2 }, CHAMP.pitcher);
  const dominant = computePitcherVulnerability({ ...pvBase, last3StartERA: 1.4 }, CHAMP.pitcher);
  ok(rough.score10 === pvChampionBare.score10 && dominant.score10 === pvChampionBare.score10, `[3] last-3-start ERA does not move champion PV (${rough.score10}/${dominant.score10} vs ${pvChampionBare.score10})`);
  ok(!rough.drivers.some((d) => d.key === "pv_recent_era"), "[3] champion emits no pv_recent_era driver");
  ok(!dominant.drivers.some((d) => d.key === "pv_recent_era_good"), "[3] champion emits no pv_recent_era_good driver");
}
{
  const shortRest = computePitcherVulnerability({ ...pvBase, daysSinceLastStart: 2 }, CHAMP.pitcher);
  const longRest = computePitcherVulnerability({ ...pvBase, daysSinceLastStart: 12 }, CHAMP.pitcher);
  ok(shortRest.score10 === pvChampionBare.score10 && longRest.score10 === pvChampionBare.score10, `[4] rest days do not move champion PV (${shortRest.score10}/${longRest.score10} vs ${pvChampionBare.score10})`);
  ok(!shortRest.drivers.some((d) => d.key === "pv_short_rest"), "[4] champion emits no pv_short_rest driver");
}
{
  // Everything at once — the combined case, not just one leg at a time.
  const loaded = computePitcherVulnerability({
    ...pvBase, barrelAllowedPct: 14, hardHitAllowedPct: 50, flyBallAllowedPct: 48,
    last3StartERA: 7.2, daysSinceLastStart: 2,
  }, CHAMP.pitcher);
  ok(loaded.score10 === pvChampionBare.score10, `[2-4] every research leg together does not move champion PV (${loaded.score10} vs ${pvChampionBare.score10})`);
}

// ── 5. BBE cannot move champion Batter Power ──────────────────────────────────
const bpBase: Omit<BatterPowerInputs, "battedBallEvents"> = {
  xISO: 0.24, xSLG: 0.54, barrelRatePct: 14, hardHitRatePct: 49, exitVelocity: 92,
  maxEV: 114, flyBallPct: 42, hrFBRatioPct: 22, pullRatePct: 48, sweetSpotPct: 38, xwOBA: 0.40,
};
{
  const at10 = computeBatterPowerProfile({ ...bpBase, battedBallEvents: 10 }, CHAMP.batter);
  const at30 = computeBatterPowerProfile({ ...bpBase, battedBallEvents: 30 }, CHAMP.batter);
  const at100 = computeBatterPowerProfile({ ...bpBase, battedBallEvents: 100 }, CHAMP.batter);
  const atNull = computeBatterPowerProfile({ ...bpBase, battedBallEvents: null }, CHAMP.batter);
  ok(
    at10.score10 === at30.score10 && at30.score10 === at100.score10 && at100.score10 === atNull.score10,
    `[5] champion Batter Power identical at BBE 10/30/100/null (${at10.score10}/${at30.score10}/${at100.score10}/${atNull.score10})`,
  );
  // The challenger must still vary, else the shrinkage hypothesis is untestable.
  const cAt10 = computeBatterPowerProfile({ ...bpBase, battedBallEvents: 10 }, CHAL.batter);
  const cAt100 = computeBatterPowerProfile({ ...bpBase, battedBallEvents: 100 }, CHAL.batter);
  ok(cAt10.score10 !== cAt100.score10, `[5] challenger Batter Power DOES vary with BBE (${cAt10.score10} vs ${cAt100.score10})`);
}

// ── 6-8. Attack Environment is inert for the champion ─────────────────────────
const baseFlags: ScoringFlags = {
  batterPowerAvailable: true, pitcherProfileAvailable: true, confirmedLineup: true,
  parkAvailable: true, weatherAvailable: true, bvpAvailable: false,
  parkIsOnlyPositiveDriver: false, positiveDriverCount: 3,
  attackEnvironmentTier: "NEUTRAL", attackEnvironmentEliminationEligible: false,
};
const eliteComps: ScoringComponents = {
  batterPowerScore: 8, pitcherVulnerabilityScore: 8, matchupFitScore: 8,
  parkWeatherScore: 8, lineupOpportunityScore: 8, nearHrRecentFormScore: 8, bvpModifier: 0,
};
{
  const tiers = ["ELITE", "FAVORABLE", "NEUTRAL", "HOSTILE"] as const;
  const results = tiers.map((t) =>
    composePregameScore(eliteComps, { ...baseFlags, attackEnvironmentTier: t }, CHAMP.gates),
  );
  ok(new Set(results.map((r) => r.score10)).size === 1, `[6] champion score10 identical across all AE tiers (${results.map((r) => r.score10).join("/")})`);
  ok(new Set(results.map((r) => r.tier)).size === 1, `[7] champion tier identical across all AE tiers (${results.map((r) => r.tier).join("/")})`);
  ok(results.every((r) => r.tier === "elite"), `[7] champion reaches elite without an AE blessing (got ${results[2].tier})`);
  // Challenger must differ, or the AE gate is measuring nothing.
  const cNeutral = composePregameScore(eliteComps, baseFlags, CHAL.gates);
  ok(cNeutral.tier === "strong", `[7] challenger NEUTRAL AE still caps at strong (got ${cNeutral.tier})`);
}
{
  // Borderline band [6.0, 6.5) with HOSTILE + eliminationEligible — the only
  // situation where AE suppresses anything at all.
  const borderline: ScoringComponents = {
    batterPowerScore: 6.2, pitcherVulnerabilityScore: 6.2, matchupFitScore: 6.2,
    parkWeatherScore: 6.2, lineupOpportunityScore: 6.2, nearHrRecentFormScore: 6.2, bvpModifier: 0,
  };
  const hostileFlags: ScoringFlags = {
    ...baseFlags, attackEnvironmentTier: "HOSTILE", attackEnvironmentEliminationEligible: true,
  };
  const champ = composePregameScore(borderline, hostileFlags, CHAMP.gates);
  const chal = composePregameScore(borderline, hostileFlags, CHAL.gates);
  ok(champ.score10 >= 6.0 && champ.score10 < 6.5, `[8] fixture lands in the borderline band (got ${champ.score10})`);
  ok(!champ.suppressedReasons.includes("attack_environment_hostile_borderline"), "[8] champion never pushes attack_environment_hostile_borderline");
  ok(!champ.suppressed, "[8] champion not suppressed by a HOSTILE attack environment");
  ok(!champ.attackEnvironmentSuppressionApplied, "[8] champion reports no AE suppression applied");
  ok(chal.suppressedReasons.includes("attack_environment_hostile_borderline"), "[8] challenger DOES apply the AE borderline suppression");
}
{
  // classifyTier unit: AE argument is ignored entirely under the champion.
  const tiers = ["ELITE", "FAVORABLE", "NEUTRAL", "HOSTILE"] as const;
  const labels = tiers.map((t) => classifyTier(7.6, 8.0, 7.0, false, t, CHAMP.gates));
  ok(new Set(labels).size === 1 && labels[0] === "elite", `[7] classifyTier champion → elite for every AE tier (${labels.join("/")})`);
}

// ── 9-10. Qualification is driver count, not evidence families ────────────────
{
  // Three positive drivers, all from ONE evidence family (batter power).
  // Champion: qualifies. Challenger: rejects (needs 2 independent families).
  const oneFamilyComps: ScoringComponents = {
    batterPowerScore: 9.0, pitcherVulnerabilityScore: 5.6, matchupFitScore: 5.0,
    parkWeatherScore: 5.0, lineupOpportunityScore: 5.0, nearHrRecentFormScore: 5.0, bvpModifier: 0,
  };
  const flags: ScoringFlags = { ...baseFlags, positiveDriverCount: 3 };
  const champ = composePregameScore(oneFamilyComps, flags, CHAMP.gates);
  const chal = composePregameScore(oneFamilyComps, flags, CHAL.gates);
  ok(champ.evidenceFamilyCount < 2, `[9] fixture genuinely has <2 evidence families (got ${champ.evidenceFamilyCount})`);
  ok(!champ.suppressedReasons.includes("insufficient_drivers"), "[9] champion not suppressed by a low evidence-family count");
  ok(chal.suppressedReasons.includes("insufficient_drivers"), "[9] challenger IS suppressed by a low evidence-family count");
  ok(champ.evidenceFamilyCount === chal.evidenceFamilyCount, "[9] evidence families are still computed under both policies");
}
{
  // One driver → both models reject.
  const flags: ScoringFlags = { ...baseFlags, positiveDriverCount: 1 };
  const champ = composePregameScore(eliteComps, flags, CHAMP.gates);
  const chal = composePregameScore(eliteComps, flags, CHAL.gates);
  ok(champ.suppressedReasons.includes("insufficient_drivers"), "[10] champion suppresses a one-driver candidate");
  ok(chal.suppressedReasons.includes("insufficient_drivers"), "[10] challenger suppresses a one-driver candidate");
}

// ── 11. Research drivers cannot satisfy the champion minimum ──────────────────
const CHAMP_KEYS = driverKeysForUniverse(CHAMP.drivers.universe);
const CHAL_KEYS = driverKeysForUniverse(CHAL.drivers.universe);
{
  const oneReal: PowerDriver[] = [{ key: "power_iso", label: "Elite Isolated Power", direction: "positive" }];
  const aeTags: PowerDriver[] = [
    { key: "atkenv_power_env", label: "Power Environment", direction: "positive", weight: 0 },
    { key: "atkenv_extra_base_env", label: "Extra-Base Environment", direction: "positive", weight: 0 },
    { key: "atkenv_weak_pitcher_park", label: "Weak Pitcher • Hitter's Park", direction: "positive", weight: 0 },
  ];
  ok(countPositiveDrivers([...oneReal, ...aeTags], CHAMP_KEYS) === 1, "[11] AE tags appended AFTER a real driver do not raise the champion count");
  // The whole point: order must not matter.
  ok(countPositiveDrivers([...aeTags, ...oneReal], CHAMP_KEYS) === 1, "[11] AE tags appended BEFORE a real driver do not raise the champion count either");
  ok(countPositiveDrivers([...aeTags], CHAMP_KEYS) === 0, "[11] AE tags alone count zero for the champion");
  ok(countPositiveDrivers([...aeTags], CHAL_KEYS) === 0, "[11] AE tags alone count zero for the challenger too (HEAD freezes before they are appended)");

  // …and that one-driver candidate must still be suppressed end to end.
  const flags: ScoringFlags = {
    ...baseFlags,
    positiveDriverCount: countPositiveDrivers([...oneReal, ...aeTags], CHAMP_KEYS),
  };
  const champ = composePregameScore(eliteComps, flags, CHAMP.gates);
  ok(champ.suppressedReasons.includes("insufficient_drivers"), "[11] one real driver + three AE tags is still insufficient_drivers");
}

// ── 12. Challenger reproduces HEAD's pre-freeze driver universe ───────────────
{
  const headEmitted: PowerDriver[] = [
    { key: "power_iso", label: "Elite Isolated Power", direction: "positive" },
    { key: "fit_pitch_family", label: "Strong vs Primary Pitch Shape", direction: "positive" },
    { key: "pv_recent_era", label: "Rough Last 3 Starts", direction: "positive" },
    { key: "pv_short_rest", label: "Short Rest", direction: "positive" },
    { key: "atkenv_power_env", label: "Power Environment", direction: "positive", weight: 0 },
  ];
  ok(countPositiveDrivers(headEmitted, CHAL_KEYS) === 4, `[12] challenger counts the 4 pre-freeze keys, not the AE tag (got ${countPositiveDrivers(headEmitted, CHAL_KEYS)})`);
  ok(countPositiveDrivers(headEmitted, CHAMP_KEYS) === 1, `[12] champion counts only the July-20 key (got ${countPositiveDrivers(headEmitted, CHAMP_KEYS)})`);
  // Negative drivers never count, even when their key is enumerated.
  ok(
    countPositiveDrivers([{ key: "power_iso", label: "x", direction: "negative" }], CHAMP_KEYS) === 0,
    "[12] a negative-direction driver never counts, listed key or not",
  );
  // near_hr_form_* is a dynamic key family and must count via its prefix.
  ok(
    countPositiveDrivers([{ key: "near_hr_form_2026-07-24", label: "x", direction: "positive" }], CHAMP_KEYS) === 1,
    "[12] dynamic near_hr_form_* keys count via prefix",
  );
}

// ── 13. Driver-key set hygiene ────────────────────────────────────────────────
{
  for (const k of Array.from(RESEARCH_ONLY_DRIVER_KEYS)) {
    ok(!JUL20_POSITIVE_DRIVER_KEYS.has(k), `[13] research key ${k} is not in the July-20 set`);
    ok(!CURRENT_HEAD_POSITIVE_DRIVER_KEYS.has(k), `[13] research key ${k} is not in the current-HEAD set`);
  }
  ok(
    Array.from(JUL20_POSITIVE_DRIVER_KEYS).every((k) => CURRENT_HEAD_POSITIVE_DRIVER_KEYS.has(k)),
    "[13] the current-HEAD set is a superset of the July-20 set",
  );

  // Every driver key emitted anywhere in the non-test build source must be
  // classified. `_`-prefixed files are spawned test halves, not build source;
  // the `direction:` requirement keeps non-driver `key:` fields (e.g.
  // gradeFactorSummary entries) out of the scan.
  const dir = join(process.cwd(), "server/mlb/pregamePowerRadar");
  const emitted = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.includes(".test.") || f.startsWith("_")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of Array.from(src.matchAll(/key:\s*"([a-z0-9_]+)"[^}]*?direction:/g))) emitted.add(m[1]);
    // Ternary form: `key: cond ? "a" : "b"` (appendAttackEnvironmentDrivers).
    for (const m of Array.from(src.matchAll(/key:\s*[^,\n]*\?\s*"([a-z0-9_]+)"\s*:\s*"([a-z0-9_]+)"/g))) {
      emitted.add(m[1]);
      emitted.add(m[2]);
    }
  }
  const unclassified = Array.from(emitted).filter((k) => classifyDriverKey(k) === "unclassified");
  ok(
    unclassified.length === 0,
    `[13] every emitted driver key is classified (unclassified: ${unclassified.join(", ") || "none"})`,
  );
  ok(emitted.size > 20, `[13] the key scan actually found keys (found ${emitted.size})`);
  // Self-validation: if the scan silently stopped matching, "everything is
  // classified" would pass vacuously. Prove it reaches both a plain-key file
  // and the ternary-key form in appendAttackEnvironmentDrivers.
  ok(emitted.has("power_iso"), "[13] scan reaches plain driver keys");
  ok(emitted.has("atkenv_power_env") && emitted.has("atkenv_hostile"), "[13] scan reaches the ternary-form AE keys");
  ok(emitted.has("fit_pitch_family") && emitted.has("pv_short_rest"), "[13] scan reaches the post-July-20 keys");
}

// ── 14. Publication is explicit, and is not `!suppressed` ─────────────────────
{
  const base = {
    tier: "strong" as const, score10: 7.0, suppressed: false,
    positiveDriverCount: 3, evidenceFamilyCount: 3, dataCoverageScore: 0.9,
    batterPowerAvailable: true, lineupStatus: "posted", isOfficialPlay: false, isPregameTarget: true,
  };
  ok(decidePlatePublication(base, CHAMP).publicEligible, "[14] a clean candidate is publicly eligible");

  // Unsuppressed but tier-ineligible → NOT public. This is the case that proves
  // publicEligible and !suppressed are genuinely different predicates.
  const watchTier = { ...base, tier: "watch" as const };
  const d = decidePlatePublication(watchTier, CHAMP);
  ok(!watchTier.suppressed && !d.publicEligible, "[14] unsuppressed + tier-ineligible → not public (publicEligible !== !suppressed)");
  ok(d.ineligibleReasons.includes("tier_not_eligible"), "[14] the reason is reported, not just the boolean");

  // Same for thin coverage.
  const thin = { ...base, dataCoverageScore: 0.4 };
  ok(!decidePlatePublication(thin, CHAMP).publicEligible, "[14] unsuppressed + thin coverage → not public");

  // Evidence clause is the policy-forked one.
  const oneFamily = { ...base, evidenceFamilyCount: 1 };
  ok(decidePlatePublication(oneFamily, CHAMP).publicEligible, "[14] champion publishes on driver count with 1 evidence family");
  ok(!decidePlatePublication(oneFamily, CHAL).publicEligible, "[14] challenger refuses the same candidate");
  const oneDriver = { ...base, positiveDriverCount: 1 };
  ok(!decidePlatePublication(oneDriver, CHAMP).publicEligible, "[14] champion refuses a one-driver candidate");
  ok(!decidePlatePublication(oneDriver, CHAL).publicEligible, "[14] challenger refuses a one-driver candidate (legacy veto)");
}

// ── 15. Build-time decision and read-time adapter agree ───────────────────────
{
  function sig(over: Partial<PregamePowerSignal>): PregamePowerSignal {
    return {
      signalId: "mlb-pregame:2026-07-24:g1:b1", sport: "mlb", engine: "pregame_power_radar",
      sessionDate: "2026-07-24", gameId: "g1", gameDate: "2026-07-24", startsAt: null,
      generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
      pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
      primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
      score10: 7, tier: "strong",
      drivers: [
        { key: "power_iso", label: "Elite Isolated Power", direction: "positive" },
        { key: "pv_hr9", label: "Pitcher Yields HR vs RHB", direction: "positive" },
      ],
      warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
      gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
      hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
      status: "active", suppressed: false, suppressedReasons: [],
      outcomes: null, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
      diagnostics: {
        batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
        lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
        suppressedReasons: [], sourceFreshness: {},
        rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
      } as any,
      ...over,
    } as PregamePowerSignal;
  }

  const clean = sig({});
  ok(
    wasPubliclyFlaggedPregame(clean) ===
      decidePlatePublication(buildChampionPublicationInput(clean), CHAMP).publicEligible,
    "[15] adapter and decision agree on a clean candidate",
  );

  // The adapter reads the POST-append drivers array, so this is the case that
  // would silently pass if the count were not universe-restricted.
  const aeInflated = sig({
    drivers: [
      { key: "power_iso", label: "Elite Isolated Power", direction: "positive" },
      { key: "atkenv_power_env", label: "Power Environment", direction: "positive", weight: 0 },
      { key: "atkenv_extra_base_env", label: "Extra-Base Environment", direction: "positive", weight: 0 },
    ],
  });
  ok(!wasPubliclyFlaggedPregame(aeInflated), "[15] AE tags in the persisted drivers array cannot make a one-driver signal public");
  ok(buildChampionPublicationInput(aeInflated).positiveDriverCount === 1, `[15] adapter counts 1, not 3 (got ${buildChampionPublicationInput(aeInflated).positiveDriverCount})`);

  const suppressedSig = sig({ suppressed: true, suppressedReasons: ["insufficient_drivers"] });
  ok(!wasPubliclyFlaggedPregame(suppressedSig), "[15] a suppressed signal is never public");

  const watchSig = sig({ tier: "watch" });
  ok(!wasPubliclyFlaggedPregame(watchSig), "[15] a `watch` tier signal is never public even when unsuppressed");
}

// ── 16. BvP is shared, so it can never explain a champion/challenger delta ────
{
  const fit = {
    batterHand: "L" as const, pitcherThrows: "R" as const, batterOpsVsHand: 0.9,
    batterXslgVsDominantFamily: null, pullRatePct: 50, parkFavorsPull: true,
  };
  for (const [pa, hr, hits] of [[8, 1, 3], [20, 2, 6], [40, 5, 14], [60, 6, 20]] as const) {
    const a = computeMatchupFit({ ...fit, bvpPlateAppearances: pa, bvpHr: hr, bvpHits: hits });
    const b = computeMatchupFit({ ...fit, bvpPlateAppearances: pa, bvpHr: hr, bvpHits: hits });
    ok(
      a.bvpModifier === b.bvpModifier && a.bvpDirection === b.bvpDirection && a.bvpZeroProduction === b.bvpZeroProduction,
      `[16] BvP behavior is policy-independent at ${pa} PA`,
    );
  }
  // Sample discipline itself is retained (it is NOT reverted to July 20).
  const tiny = computeMatchupFit({ ...fit, bvpPlateAppearances: 8, bvpHr: 3, bvpHits: 5 });
  ok(tiny.bvpModifier === 0, `[16] <10 AB still yields a zero BvP modifier (got ${tiny.bvpModifier})`);
  ok(tiny.bvpDirection === "neutral", "[16] <25 AB still yields no BvP direction");
}

console.log(`\nplateChampionJul20Regression.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
