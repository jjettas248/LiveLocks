/**
 * HR Radar Live — "live-event only" + Ready/Fire official-semantics invariants.
 *
 * Locks two product rules for the live in-game HR Radar engine:
 *   1. HR Radar Live is a LIVE event-based engine — it contains NO Monte Carlo /
 *      simulation logic, and the no-AB pregame seed (a pregame prior that is not
 *      live evidence) is GATED OFF by default.
 *   2. FIRE-only official record — only userStage="fire" stamps
 *      officialSignalStage. Track / Build / Ready are NEVER official calls, so a
 *      Ready row can never silently grade as a called_hit / called_miss.
 *
 * Run: npx tsx server/mlb/hrRadarLiveOnly.test.ts
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { isHrRadarPregameSeedEnabled } from "./hrRadarLiveContract";
import { enrichWithUserStage } from "./hrRadarUserStage";
import { computePregameHrFormBreakdown } from "./hrConversionModel";

const HERE = dirname(fileURLToPath(import.meta.url));

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

console.log("\n=== HR Radar Live — Live-Only + FIRE-Only Invariant Suite ===\n");

// ── 1. No Monte Carlo / simulation in the live HR Radar engine ─────────────
// The live HR Radar engine must remain deterministic / event-driven. These are
// the files that compute live HR Radar stage / scoring. None of them may import
// or reference Monte Carlo / simulation machinery. (We scan source text rather
// than mock the engine so a future `import { monteCarlo } from ...` trips here.)
console.log("1. HR Radar Live engine contains no Monte Carlo / simulation");
const LIVE_ENGINE_FILES = [
  "hrAlertEngine.ts",
  "hrRadarUserStage.ts",
  "nearHrContact.ts",
  "evaluateHRAlert.ts",
  "HRSignalBuilder.ts",
  "hrRadarStateMachine.ts",
  "hrRadarSection.ts",
];
// Match real simulation tokens; allow innocuous substrings (e.g. "accumulate")
// by requiring a word-ish boundary around the simulation root.
const MONTE_CARLO_RE = /monte[\s_-]*carlo|montecarlo|\bsimulat(e|ed|es|ing|ion)\b|randomSample|\bMath\.random\b/i;
for (const f of LIVE_ENGINE_FILES) {
  let src = "";
  try {
    src = readFileSync(join(HERE, f), "utf8");
  } catch (e) {
    assert(`1.x ${f} readable`, false, String((e as any)?.message ?? e));
    continue;
  }
  const hit = src.match(MONTE_CARLO_RE);
  assert(`1.x ${f} has no Monte Carlo / simulation`, hit == null,
    hit ? `matched "${hit[0]}"` : undefined);
}

// ── 2. No-AB pregame seed is gated OFF by default (live-evidence only) ──────
console.log("\n2. Pregame no-AB seed gate");
eq("2.1 default (no env) → disabled", isHrRadarPregameSeedEnabled({} as NodeJS.ProcessEnv), false);
eq("2.2 explicit off → disabled", isHrRadarPregameSeedEnabled({ HR_RADAR_PREGAME_SEED: "false" } as any), false);
eq("2.3 explicit on → enabled (reversible)", isHrRadarPregameSeedEnabled({ HR_RADAR_PREGAME_SEED: "on" } as any), true);
eq("2.4 '1' → enabled", isHrRadarPregameSeedEnabled({ HR_RADAR_PREGAME_SEED: "1" } as any), true);
eq("2.5 garbage → disabled (fail-safe live-only)", isHrRadarPregameSeedEnabled({ HR_RADAR_PREGAME_SEED: "maybe" } as any), false);

// ── 3. FIRE-only official record — Ready/Track/Build are NOT official ───────
console.log("\n3. enrichWithUserStage — FIRE-only officialSignalStage");

// A genuine FIRE row (engine declared via actionable officialAlert +
// FAST_PROMOTE_ELITE) stamps officialSignalStage="fire".
const fire = enrichWithUserStage({
  legacyState: "actionable",
  alertPath: "FAST_PROMOTE_ELITE",
  currentReadinessScore: 90,
  peakReadinessScore: 100,
});
eq("3.1 fire userStage", fire.userStage, "fire");
eq("3.1 fire → officialSignalStage=fire", fire.officialSignalStage, "fire");

// A READY row (engine promotion path at live, but not a FIRE path) is
// high-conviction WATCH context — never official.
const ready = enrichWithUserStage({
  legacyState: "live",
  alertPath: "PATH_A",
  currentReadinessScore: 70,
  peakReadinessScore: 70,
});
eq("3.2 ready userStage", ready.userStage, "ready");
eq("3.2 ready → officialSignalStage=null (READY not official)", ready.officialSignalStage, null);

// BUILD is never official.
const build = enrichWithUserStage({
  dynamicState: "PREPARE",
  legacyTier: "building",
});
eq("3.3 build → officialSignalStage=null", build.officialSignalStage, null);

// TRACK is never official.
const track = enrichWithUserStage({ legacyTier: "monitor" });
eq("3.4 track → officialSignalStage=null", track.officialSignalStage, null);

// ── 4. Engine-internal pregame HR-form prior is a no-op without profile ─────
// The remaining pregame influence in the live engine (hrConversionModel) is a
// season-power-profile prior that DECAYS to zero as live contact accumulates.
// It must never fabricate a non-neutral prior from missing data — with no
// profile fields it returns the neutral 50 and reports hasProfile=false, so a
// batter with no profile data gets no pregame nudge at all.
console.log("\n4. Pregame HR-form prior is neutral / no-op without profile data");
const neutral = computePregameHrFormBreakdown({} as any);
eq("4.1 empty profile → neutral score 50", neutral.score, 50);
eq("4.2 empty profile → hasProfile=false", neutral.hasProfile, false);
eq("4.3 empty profile → no fabricated drivers", neutral.drivers.length, 0);

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
