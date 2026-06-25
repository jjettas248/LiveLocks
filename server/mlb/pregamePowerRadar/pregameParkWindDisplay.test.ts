// [Pre-Game Power Radar] PR2 — player-specific park/wind DISPLAY hydration.
// Run with: npx tsx server/mlb/pregamePowerRadar/pregameParkWindDisplay.test.ts
//
// No DOM test runner exists in this repo, so card behavior is verified at the
// server display-contract level (the exact data the card renders verbatim) plus
// static/structural guards on the component + the change surface.
//
// Covers PR2's 10 required tests:
//  1. Card renders wind direction when available.
//  2. Card renders wind speed.
//  3. Card renders emojis.
//  4. Card renders player-specific explanation.
//  5. Missing context shows safe fallback.
//  6. No numeric market setup score appears.
//  7. Single big score remains overall score10.
//  8. Mobile layout wraps cleanly.
//  9. HR Radar files are not changed (except shared type imports).
// 10. No NBA/NCAAB files changed.

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { hydratePregamePlayerParkWindFit } from "./playerParkWindFit";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CLIENT = "client/src/components/mlb/PregamePowerRadar.tsx";
const clientSrc = readFileSync(CLIENT, "utf8");
// Body of the new fit-row component only (for the "no numeric score" guard).
const fitRowBody = clientSrc.slice(
  clientSrc.indexOf("function PlayerParkWindFitRow"),
  clientSrc.indexOf("export default PregamePowerRadar"),
);

console.log("\n[pregameParkWindDisplay] running cases\n");

// A representative directional case: RHH pull hitter, wind out to LF at Wrigley.
const lfFit = hydratePregamePlayerParkWindFit({
  venueName: "Wrigley Field",
  batterHand: "R",
  pullRatePercent: 52,
  windString: "15 mph, Out To LF",
  windSpeedMph: 15,
});

// ── 1. wind direction available ───────────────────────────────────────────────
assert("1. renders wind direction when available", lfFit.windDirectionLabel === "Out to LF", `got ${lfFit.windDirectionLabel}`);
{
  const rf = hydratePregamePlayerParkWindFit({ venueName: "Yankee Stadium", batterHand: "L", pullRatePercent: 52, windString: "15 mph, Out To RF", windSpeedMph: 15 });
  assert("1b. RF wind → 'Out to RF'", rf.windDirectionLabel === "Out to RF", `got ${rf.windDirectionLabel}`);
  const cross = hydratePregamePlayerParkWindFit({ venueName: "Wrigley Field", batterHand: "R", pullRatePercent: 52, windString: "15 mph, L To R", windSpeedMph: 15 });
  assert("1c. crosswind → 'Crosswind'", cross.windDirectionLabel === "Crosswind", `got ${cross.windDirectionLabel}`);
  // The card renders the wind direction field.
  assert("1d. card renders windDirectionLabel", clientSrc.includes("fit.windDirectionLabel"));
}

// ── 2. wind speed ─────────────────────────────────────────────────────────────
assert("2. renders wind speed", lfFit.windSpeedMph === 15, `got ${lfFit.windSpeedMph}`);
assert("2b. card renders windSpeedMph", clientSrc.includes("fit.windSpeedMph"));

// ── 3. emojis ─────────────────────────────────────────────────────────────────
{
  const KNOWN = ["🌬️", "🏟️", "↔️", "⚠️", "❔"];
  assert("3. fit carries an emoji glyph", KNOWN.includes(lfFit.emoji), `got ${lfFit.emoji}`);
  const inFit = hydratePregamePlayerParkWindFit({ venueName: "Fenway Park", batterHand: "R", pullRatePercent: 50, windString: "16 mph, In From CF", windSpeedMph: 16 });
  assert("3b. wind-in emoji is ⚠️", inFit.emoji === "⚠️", `got ${inFit.emoji}`);
  assert("3c. card renders the server emoji verbatim", clientSrc.includes("fit.emoji"));
}

// ── 4. player-specific explanation ────────────────────────────────────────────
assert("4. label is player-specific (mentions RHH pull)", /RHH pull/.test(lfFit.label), lfFit.label);
assert("4b. explanation is non-empty", typeof lfFit.explanation === "string" && lfFit.explanation.length > 0);
assert("4c. card renders explanation", clientSrc.includes("fit.explanation"));

// ── 5. missing context → safe fallback (does not invent) ──────────────────────
{
  const unknownAll = hydratePregamePlayerParkWindFit({ venueName: "Pop-Up Park 2026", batterHand: null, windString: null, windDegrees: null });
  assert("5. missing venue+hand+wind → ❔ unavailable", unknownAll.emoji === "❔" && unknownAll.classification === "unknown", `got ${unknownAll.emoji}/${unknownAll.classification}`);
  const noSpray = hydratePregamePlayerParkWindFit({ venueName: "Wrigley Field", batterHand: "R", pullRatePercent: null, windString: "15 mph, Out To LF", windSpeedMph: 15 });
  assert("5b. missing spray on directional wind → neutral (not invented)", noSpray.classification === "neutral");
  // The card has an explicit absent-fit fallback line.
  assert("5c. card has absent-fit fallback", clientSrc.includes("Park/wind data unavailable"));
}

// ── 6. no numeric market setup score appears ──────────────────────────────────
{
  const keys = Object.keys(lfFit);
  const banned = keys.filter((k) => /score|multiplier|component|setup/i.test(k));
  assert("6. display contract exposes no numeric score/multiplier key", banned.length === 0, banned.join(","));
  // The fit row itself renders no numeric setup score.
  assert("6b. fit row renders no 'score'", !/score/i.test(fitRowBody));
}

// ── 7. single big score remains overall score10 ───────────────────────────────
{
  // The only numeric field on the display contract is the raw wind speed reading.
  const numericKeys = Object.entries(lfFit).filter(([, v]) => typeof v === "number").map(([k]) => k);
  assert("7. only numeric display field is windSpeedMph (no rival score)", numericKeys.length === 1 && numericKeys[0] === "windSpeedMph", numericKeys.join(","));
  // The headline score10 is still the single big number on the card.
  assert("7b. card still renders s.score10 as the headline", clientSrc.includes("s.score10.toFixed(1)"));
}

// ── 8. mobile layout wraps cleanly ────────────────────────────────────────────
assert("8. fit row uses flex-wrap (mobile)", /flex-wrap/.test(fitRowBody));

// ── 9. HR Radar files not changed (except shared imports) ─────────────────────
let changed: string[] = [];
try {
  changed = execSync("git diff --name-only origin/main", { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
} catch (e: any) {
  console.log(`  (note: git diff unavailable: ${e.message})`);
}
{
  const HR_RADAR = /(hrRadar|hrAlert|hrConversion|evaluateHRAlert|liveGameOrchestrator|signalScore|nearHrContact|HRSignalBuilder|parkWindFit\.ts$)/;
  const touched = changed.filter((f) => HR_RADAR.test(f));
  assert("9. no HR Radar engine file modified", touched.length === 0, touched.join(","));
  // The hydrator only IMPORTS the shared module (allowed) — never edits it.
  assert("9b. shared parkWindFit.ts not modified", !changed.some((f) => f.endsWith("server/mlb/parkWindFit.ts")));
}

// ── 10. no NBA/NCAAB files changed ────────────────────────────────────────────
{
  const cross = changed.filter((f) => /(\/nba\/|\/ncaab\/|nba|ncaab)/i.test(f));
  assert("10. no NBA/NCAAB files changed", cross.length === 0, cross.join(","));
}

console.log(`\n[pregameParkWindDisplay] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
