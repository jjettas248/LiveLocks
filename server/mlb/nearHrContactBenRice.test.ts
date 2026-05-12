// Ben Rice regression harness — locks the Phase 2 STEP 4/5/6 detection
// improvements so a future refactor can't silently revert to "0.0/10
// MONITOR uncalled_hr" for HR-danger pre-HR patterns.
//
// Run: npx tsx server/mlb/nearHrContactBenRice.test.ts

import { detectNearHrContact, detectNearHrContactPeak } from "./nearHrContact";
import { deriveQualifyingSignals, deriveSuggestedUserStageFromSignals, enrichWithUserStage } from "./hrRadarUserStage";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`[NEAR_HR_BENRICE_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// ─── Ben Rice case (May 2026) ──────────────────────────────────────────────
// AB1: 97.9 EV / 18 LA / 292 ft / xBA .680 (solid contact, no barrel)
// AB2: 100.6 EV / 26 LA / 374 ft / barrel / xBA .750
// HR  occurs T3.

const benRiceAb1 = { ev: 97.9, la: 18, distance: 292, xba: 0.680, isBarrel: false };
const benRiceAb2 = { ev: 100.6, la: 26, distance: 374, xba: 0.750, isBarrel: true };

// AB1 alone: fails legacy WATCH (LA<20, dist<350); HIGH_XBA_DANGER catches
// it (xBA .680>=.65, EV 97.9>=96, LA 18 in [16,34]).
const ab1 = detectNearHrContact(benRiceAb1);
check("Ben Rice AB1 — HIGH_XBA_DANGER tier=watch", ab1.tier === "watch", `got tier=${ab1.tier} matchedPath=${ab1.matchedPath}`);
check("Ben Rice AB1 — matchedPath=HIGH_XBA_DANGER", ab1.matchedPath === "HIGH_XBA_DANGER", `got ${ab1.matchedPath}`);

// AB2 alone: meets WATCH (EV>=98, LA in [20,35], dist>=350) AND has barrel
// → BARREL_OVERRIDE_LEAN (watch promoted to lean by barrel).
const ab2 = detectNearHrContact(benRiceAb2);
check("Ben Rice AB2 — barrel-promoted to lean", ab2.tier === "lean", `got tier=${ab2.tier}`);
check("Ben Rice AB2 — matchedPath=BARREL_OVERRIDE_LEAN", ab2.matchedPath === "BARREL_OVERRIDE_LEAN", `got ${ab2.matchedPath}`);

// Window of [AB1, AB2]: lean wins (from AB2), and repeatedDanger flips on
// (2 hards + 1 elite).
const peak = detectNearHrContactPeak([benRiceAb1, benRiceAb2]);
check("Ben Rice window — peak.tier=lean", peak.tier === "lean", `got ${peak.tier}`);
check("Ben Rice window — repeatedDanger=true", peak.repeatedDanger === true);
check("Ben Rice window — sourceAbIndex points at AB2", peak.sourceAbIndex === 1, `got ${peak.sourceAbIndex}`);
check("Ben Rice window — diagnostics length=2", peak.diagnostics.length === 2);
check("Ben Rice window — AB1 missedPattern guard true (HIGH_XBA_DANGER catches it now, so missedPattern=false)",
  peak.diagnostics[0].missedPattern === false,
  `AB1 detectedTier=${peak.diagnostics[0].detectedTier} missedPattern=${peak.diagnostics[0].missedPattern}`);

// Drivers list should include either the high-xBA or barrel marker so
// downstream tagging can mark it as high_xba_danger.
const driversText = peak.drivers.join(" | ").toLowerCase();
check("Ben Rice window — drivers cite barrel/high-xBA/repeated pattern",
  driversText.includes("barrel") || driversText.includes("xba") || driversText.includes("repeated") || driversText.includes("pre-hr"),
  `drivers=[${peak.drivers.join(",")}]`);

// ─── Single-barrel-before-HR case (TEST B) ────────────────────────────────
const singleBarrel = { ev: 103, la: 28, distance: 410, xba: 0.55, isBarrel: true };
const sbResult = detectNearHrContact(singleBarrel);
check("Single barrel + EV>=100 + LA 20-35 → tier=lean", sbResult.tier === "lean", `got ${sbResult.tier}`);

// Bare-barrel with weaker context should at least produce WATCH.
const weakBarrel = { ev: 92, la: 12, distance: 220, xba: 0.45, isBarrel: true };
const wbResult = detectNearHrContact(weakBarrel);
check("Barrel tag with weak context → tier>=watch (override)", wbResult.tier === "watch", `got ${wbResult.tier}`);

// ─── No-evidence HR case (TEST C / TEST E — overflooding guard) ──────────
const weakGrounder1 = { ev: 84, la: 4, distance: 110, xba: 0.18, isBarrel: false };
const weakGrounder2 = { ev: 79, la: 2, distance: 95, xba: 0.12, isBarrel: false };
const noEvidencePeak = detectNearHrContactPeak([weakGrounder1, weakGrounder2]);
check("Weak grounders → tier=null", noEvidencePeak.tier === null, `got ${noEvidencePeak.tier}`);
check("Weak grounders → repeatedDanger=false", noEvidencePeak.repeatedDanger === false);

// ─── qualifyingSignals derivation picks up high_xba_danger ────────────────
const sigs = deriveQualifyingSignals({
  factors: { maxXBA: 0.75, maxEV: 100.6, avgEV: 99.2, maxLA: 26, barrels: 1, hardHits: 2 },
  triggerTags: ["Barrel + high-xBA danger"],
  inning: 3,
  positiveDrivers: [],
  conversionProbability: null,
});
check("deriveQualifyingSignals picks up high_xba_danger from factors", sigs.includes("high_xba_danger"));
check("deriveQualifyingSignals picks up high_xba_danger from tag", sigs.includes("high_xba_danger"));
check("deriveQualifyingSignals also picks up two_hard_hit_balls", sigs.includes("two_hard_hit_balls"));
check("deriveQualifyingSignals also picks up elite_barrel", sigs.includes("elite_barrel"));

const stageFromSigs = deriveSuggestedUserStageFromSignals({ qualifyingSignals: sigs });
check("Suggested user stage from Ben Rice signals >= ready", stageFromSigs === "ready" || stageFromSigs === "fire", `got ${stageFromSigs}`);

// high_xba_danger alone (no barrels, no two-hards, no near-barrel) → build floor.
const xbaOnlySigs = deriveQualifyingSignals({
  factors: { maxXBA: 0.68, maxEV: 97.9, avgEV: 97.9, maxLA: 18, barrels: 0, hardHits: 1 },
  triggerTags: [],
  inning: 1,
  positiveDrivers: [],
  conversionProbability: null,
});
check("high_xba_danger alone → at least 'build' suggested stage",
  deriveSuggestedUserStageFromSignals({ qualifyingSignals: xbaOnlySigs }) === "build",
  `got ${deriveSuggestedUserStageFromSignals({ qualifyingSignals: xbaOnlySigs })}`);

// ─── Phase 3 STEP 7 — score floor when qualifyingSignals exist ────────────
// Simulated Ben Rice row with currentReadinessScore=0 but qualifying
// signals present. Without the floor the modal showed 0.0/10 / MONITOR
// uncalled_hr. Floor is fallbackScoreForStage(userStage) — at "ready"
// that's 7.5; at "build" it's 5.5; at "track" 2.5.
const enrichedNoSignal = enrichWithUserStage({
  legacyTier: "monitor",
  legacyState: "live",
  dynamicState: "WATCH",
  canonicalStage: "watch",
  currentReadinessScore: 0,
  peakReadinessScore: 0,
  initialReadinessScore: 0,
  factors: { maxXBA: 0.75, maxEV: 100.6, avgEV: 99.2, maxLA: 26, barrels: 1, hardHits: 2 },
  triggerTags: ["Barrel + high-xBA danger"],
  inning: 3,
  alertPath: null,
});
check("Ben Rice enrichment — userStage promoted out of track", enrichedNoSignal.userStage !== "track" && enrichedNoSignal.userStage !== "resolved",
  `got userStage=${enrichedNoSignal.userStage}`);
check("Ben Rice enrichment — currentSignalScore10 > 0 (evidence floor)",
  (enrichedNoSignal.currentSignalScore10 ?? 0) > 0,
  `got ${enrichedNoSignal.currentSignalScore10}`);
check("Ben Rice enrichment — peakSignalScore10 > 0 (evidence floor)",
  (enrichedNoSignal.peakSignalScore10 ?? 0) > 0,
  `got ${enrichedNoSignal.peakSignalScore10}`);
check("Ben Rice enrichment — qualifyingSignals includes high_xba_danger",
  enrichedNoSignal.qualifyingSignals.includes("high_xba_danger"));
check("Ben Rice enrichment — qualifyingSignals includes elite_barrel",
  enrichedNoSignal.qualifyingSignals.includes("elite_barrel"));

// ─── No-evidence row stays at 0 (don't overflood) ─────────────────────────
const enrichedEmpty = enrichWithUserStage({
  legacyTier: "monitor",
  legacyState: "live",
  dynamicState: "WATCH",
  canonicalStage: "watch",
  currentReadinessScore: 0,
  peakReadinessScore: 0,
  initialReadinessScore: 0,
  factors: { maxXBA: 0.18, maxEV: 84, avgEV: 79, maxLA: 4, barrels: 0, hardHits: 0 },
  triggerTags: [],
  inning: 1,
  alertPath: null,
});
check("No-evidence enrichment — userStage stays track", enrichedEmpty.userStage === "track",
  `got ${enrichedEmpty.userStage}`);
check("No-evidence enrichment — currentSignalScore10 stays 0 (no overflood)",
  enrichedEmpty.currentSignalScore10 === 0,
  `got ${enrichedEmpty.currentSignalScore10}`);
check("No-evidence enrichment — qualifyingSignals empty", enrichedEmpty.qualifyingSignals.length === 0,
  `got [${enrichedEmpty.qualifyingSignals.join(",")}]`);

// ─── Window with one barrel surrounded by mediocre ABs ────────────────────
const barrelInMiddle = [
  { ev: 88, la: 5, distance: 180, xba: 0.22, isBarrel: false },
  { ev: 104.4, la: 24, distance: 382, xba: 0.83, isBarrel: true },
  { ev: 99.6, la: 6, distance: 195, xba: 0.31, isBarrel: false },
];
const peakMiddle = detectNearHrContactPeak(barrelInMiddle);
check("Window remembers prior barrel — tier=lean", peakMiddle.tier === "lean", `got ${peakMiddle.tier}`);
check("Window sourceAbIndex points at AB1 (the barrel)", peakMiddle.sourceAbIndex === 1, `got ${peakMiddle.sourceAbIndex}`);

// ─── Repeated-danger override (no per-AB lean, but window pattern) ───────
const twoHardOneElite = [
  { ev: 96, la: 22, distance: 340, xba: 0.61, isBarrel: false }, // hard (EV+LA in band)
  { ev: 95, la: 25, distance: 345, xba: 0.62, isBarrel: false }, // hard
  { ev: 100, la: 28, distance: 360, xba: 0.66, isBarrel: false }, // hard + elite
];
const repPeak = detectNearHrContactPeak(twoHardOneElite);
check("Repeated-danger override — repeatedDanger=true", repPeak.repeatedDanger === true);
check("Repeated-danger override — promoted to lean", repPeak.tier === "lean", `got ${repPeak.tier}`);

console.log(`[NEAR_HR_BENRICE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) {
  process.exit(1);
} else {
  console.log("[NEAR_HR_BENRICE_TEST] OK");
}
