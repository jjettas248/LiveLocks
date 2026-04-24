import { storage } from "../../storage";
import {
  getSafetyCeiling,
  getPlayoffSafetyCeiling,
  getPlayoffFragilityMultiplier,
  type NBAArchetype,
} from "../../nba/archetypes";
import {
  getSeasonTypeForGame,
  type NBASeasonType,
} from "../../services/nbaStatsService";

type Check = { name: string; passed: boolean; expected: string; actual: string };

function check(name: string, expected: string, actual: string, passed: boolean): Check {
  return { name, passed, expected, actual };
}

function eq(a: unknown, b: unknown): boolean { return a === b; }

export function runPlayoffSmoke(): { passed: boolean; checks: Check[] } {
  const checks: Check[] = [];

  // ── PHASE 1: season-phase resolution ──
  const apr15_2026 = storage.getNbaSeasonContext("2026-04-15");
  checks.push(check(
    "Apr 15 2026 → playoffs",
    "isPlayoffs=true,seasonPhase=playoffs",
    `isPlayoffs=${apr15_2026.isPlayoffs},seasonPhase=${apr15_2026.seasonPhase}`,
    apr15_2026.isPlayoffs === true && apr15_2026.seasonPhase === "playoffs",
  ));

  const mar20_2026 = storage.getNbaSeasonContext("2026-03-20");
  checks.push(check(
    "Mar 20 2026 → late regular season",
    "isPlayoffs=false,seasonPhase=late",
    `isPlayoffs=${mar20_2026.isPlayoffs},seasonPhase=${mar20_2026.seasonPhase}`,
    mar20_2026.isPlayoffs === false && mar20_2026.seasonPhase === "late",
  ));

  const jan10_2026 = storage.getNbaSeasonContext("2026-01-10");
  checks.push(check(
    "Jan 10 2026 → mid regular season",
    "isPlayoffs=false,seasonPhase=mid",
    `isPlayoffs=${jan10_2026.isPlayoffs},seasonPhase=${jan10_2026.seasonPhase}`,
    jan10_2026.isPlayoffs === false && jan10_2026.seasonPhase === "mid",
  ));

  const apr05_2026 = storage.getNbaSeasonContext("2026-04-05");
  checks.push(check(
    "Apr 5 2026 (pre-cutover) → still regular season",
    "isPlayoffs=false",
    `isPlayoffs=${apr05_2026.isPlayoffs}`,
    apr05_2026.isPlayoffs === false,
  ));

  // ── PHASE 4: playoff ceilings ≤ regular-season ceilings ──
  const archetypes: NBAArchetype[] = [
    "stable_star", "stable_starter", "volatile_starter",
    "bench_microwave", "low_minute_big", "lineup_impacted", "role_uncertain",
  ];
  for (const a of archetypes) {
    const reg = getSafetyCeiling(a, false);
    const po = getPlayoffSafetyCeiling(a, false);
    checks.push(check(
      `Playoff ceiling ≤ regular for ${a}`,
      `playoff(${po}) ≤ regular(${reg})`,
      `playoff=${po},regular=${reg}`,
      po <= reg,
    ));
  }

  // ── PHASE 4: playoff fragility multiplier semantics ──
  const starMult = getPlayoffFragilityMultiplier("stable_star");
  const uncertainMult = getPlayoffFragilityMultiplier("role_uncertain");
  checks.push(check(
    "Playoff fragility: stars dampened (<1)",
    "<1",
    String(starMult),
    starMult < 1,
  ));
  checks.push(check(
    "Playoff fragility: role_uncertain amplified (>1)",
    ">1",
    String(uncertainMult),
    uncertainMult > 1,
  ));

  // ── PHASE 5: seasonType routing ──
  const stPlayoff: NBASeasonType = getSeasonTypeForGame("2026-04-22");
  const stRegular: NBASeasonType = getSeasonTypeForGame("2026-02-15");
  checks.push(check(
    "getSeasonTypeForGame(Apr 22 2026)",
    "Playoffs",
    stPlayoff,
    eq(stPlayoff, "Playoffs"),
  ));
  checks.push(check(
    "getSeasonTypeForGame(Feb 15 2026)",
    "Regular Season",
    stRegular,
    eq(stRegular, "Regular Season"),
  ));

  const passed = checks.every(c => c.passed);
  return { passed, checks };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const result = runPlayoffSmoke();
  console.log("\n═══ NBA PLAYOFF CALIBRATION SMOKE TEST ═══\n");
  for (const c of result.checks) {
    const mark = c.passed ? "✓" : "✗";
    console.log(`  ${mark} ${c.name}`);
    if (!c.passed) {
      console.log(`      expected: ${c.expected}`);
      console.log(`      actual:   ${c.actual}`);
    }
  }
  const pass = result.checks.filter(c => c.passed).length;
  const fail = result.checks.length - pass;
  console.log(`\n  Total: ${result.checks.length}  Pass: ${pass}  Fail: ${fail}`);
  console.log(result.passed ? "  RESULT: PASS\n" : "  RESULT: FAIL\n");
  process.exit(result.passed ? 0 : 1);
}
