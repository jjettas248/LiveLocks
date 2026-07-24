// HR Live Edge unified-lane qualification/propagation contract.
//
// Locks the regression repair: after PR #134/#135 wired the HR occurrence model
// into calculateHREdge, home_runs must flow through its own Live Edge lane —
// the unified HR engine's canonical state decides EXISTENCE and lifecycle,
// sportsbook odds decide BETTABILITY only, and non-executable HR conviction can
// never look like FIRE in the view model, canonical lifecycle, persistence, or
// alerts.
//
// Run: npx tsx server/mlb/hrLiveEdgeQualification.test.ts

import { deriveMlbLifecycleState, toCanonicalFromMlb } from "../services/canonicalMapper";
import { IMMUTABLE_FIELDS } from "../../shared/canonicalSignal";
import type { CanonicalSignal } from "../../shared/canonicalSignal";
import type { MLBSignal } from "../../shared/mlbSignal";
import {
  deriveMarketActionability,
  deriveHrMarketActionability,
  actionabilityToDisplayGroup,
} from "../services/mlbMarketSignalViewModel";
import { isEligibleForAlert } from "../services/alertSubscriber";
import { applyDisplayContract, normalizeMLBSignal } from "./normalizeSignal";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[HR_LIVE_EDGE_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// ── Factories ────────────────────────────────────────────────────────────
function hrSig(o: {
  currentState?: "WATCH" | "PREPARE" | "BET_NOW" | "COOLED_OFF" | "CLOSED";
  canonicalStage?: "watch" | "building" | "attack" | "cooling" | "closed";
  isBettable?: boolean;
  hasRealSportsbookLine?: boolean;
  alreadyHit?: boolean;
  signalTier?: "watch" | "lean" | "strong" | "elite";
}): MLBSignal {
  return {
    playerId: "p1",
    playerName: "Test Slugger",
    gameId: "G1",
    market: "home_runs",
    recommendedSide: "OVER",
    displaySide: "OVER",
    enginePct: 24,
    calibratedProbabilityOver: 24,
    calibratedProbabilityUnder: 76,
    displayProbability: 24,
    signalScore: 70,
    signalTier: o.signalTier ?? "elite",
    confidenceTier: "STRONG",
    isBettable: o.isBettable,
    hasRealSportsbookLine: o.hasRealSportsbookLine,
    alreadyHit: o.alreadyHit ?? false,
    hrAlert: {
      currentState: o.currentState ?? "WATCH",
      canonicalStage: o.canonicalStage,
    } as any,
  } as any;
}

function hrCanonical(o: {
  signalTier?: "watch" | "lean" | "strong" | "elite";
  isBettable?: boolean;
  lifecycleState?: any;
}): CanonicalSignal {
  return {
    signalId: "mlb:G1:p1:home_runs:OVER",
    sport: "mlb",
    gameId: "G1",
    actorId: "p1",
    actorName: "Test Slugger",
    market: "home_runs",
    side: "OVER",
    displayProbability: 24,
    overProbability: 24,
    underProbability: 76,
    edge: null,
    projection: 0.28,
    bookLine: null,
    signalTier: o.signalTier ?? "elite",
    signalScore: 70,
    isBettable: o.isBettable,
    drivers: [],
    triggerSummary: null,
    lifecycleState: o.lifecycleState ?? "build",
    lifecycleHistory: [],
    engineGeneratedAt: 1,
    surfacedAt: 1,
    updatedAt: 1,
    expiresAt: null,
  } as any;
}

// ── 1. Lifecycle mapping — official-FIRE gate (C / C6) ─────────────────────
check("attack + BET_NOW + isBettable → elite (official FIRE)",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "attack", currentState: "BET_NOW", isBettable: true })) === "elite");
check("attack + BET_NOW + NOT bettable (no odds) → build",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "attack", currentState: "BET_NOW", isBettable: false })) === "build");
check("PATH attack + FSM PREPARE (not bettable) → build (never elite)",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "attack", currentState: "PREPARE", isBettable: false })) === "build");
check("building → build",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "building", currentState: "PREPARE", isBettable: false })) === "build");
check("watch → watch",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "watch", currentState: "WATCH" })) === "watch");
check("cooling → watch",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "cooling", currentState: "COOLED_OFF" })) === "watch");
check("closed → expired",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "closed", currentState: "CLOSED" })) === "expired");
check("alreadyHit → cashed (terminal wins)",
  deriveMlbLifecycleState(hrSig({ canonicalStage: "attack", currentState: "BET_NOW", isBettable: true, alreadyHit: true })) === "cashed");
// Fallback when a legacy snapshot lacks canonicalStage: PREPARE must map to
// build (NOT the old strong→ACTION_NOW).
check("legacy PREPARE (no canonicalStage) → build, never strong",
  deriveMlbLifecycleState(hrSig({ currentState: "PREPARE", isBettable: false })) === "build");

// ── 2. canonicalStage survives into the canonical signal; isBettable carried ─
const canonFire = toCanonicalFromMlb(hrSig({ canonicalStage: "attack", currentState: "BET_NOW", isBettable: true }));
check("toCanonicalFromMlb: official FIRE → lifecycle elite", canonFire.lifecycleState === "elite");
check("toCanonicalFromMlb copies isBettable=true", canonFire.isBettable === true);
const canonNoFire = toCanonicalFromMlb(hrSig({ canonicalStage: "attack", currentState: "PREPARE", isBettable: false }));
check("toCanonicalFromMlb: PATH-only attack → lifecycle build", canonNoFire.lifecycleState === "build");
check("toCanonicalFromMlb: isBettable stamped false (not undefined)", canonNoFire.isBettable === false);
check("IMMUTABLE_FIELDS includes isBettable", IMMUTABLE_FIELDS.includes("isBettable" as any));

// ── 3. View-model ACTION_NOW firewall (C5) ─────────────────────────────────
function hrGroup(tier: any, lifecycle: any, isBettable: boolean): string {
  const raw = deriveMarketActionability(tier, lifecycle);
  const gated = deriveHrMarketActionability("home_runs", raw, isBettable);
  return actionabilityToDisplayGroup(gated);
}
check("HR official FIRE (elite lifecycle + bettable) → ACTION_NOW",
  hrGroup("elite", "elite", true) === "ACTION_NOW");
check("HR non-bettable elite-tier/attack conviction → BUILDING (firewalled)",
  hrGroup("elite", "build", false) === "BUILDING");
check("HR PREPARE→build, not bettable → BUILDING (never ACTION_NOW)",
  hrGroup("lean", "build", false) === "BUILDING");
check("HR watch → MONITOR",
  hrGroup("watch", "watch", false) === "MONITOR");
// Non-HR markets are untouched by the firewall.
check("non-HR strong lifecycle still ACTION_NOW",
  actionabilityToDisplayGroup(deriveHrMarketActionability("hits", deriveMarketActionability("strong", "strong"), false)) === "ACTION_NOW");

// ── 4. Alert firewall (C6) ─────────────────────────────────────────────────
check("HR tier_upgraded suppressed when NOT bettable",
  isEligibleForAlert("all_sports", hrCanonical({ signalTier: "elite", isBettable: false }), "tier_upgraded") === false);
check("HR lifecycle_upgraded suppressed when NOT bettable",
  isEligibleForAlert("all_sports", hrCanonical({ signalTier: "elite", isBettable: false }), "lifecycle_upgraded") === false);
check("HR tier_upgraded eligible when bettable (official FIRE)",
  isEligibleForAlert("all_sports", hrCanonical({ signalTier: "elite", isBettable: true }), "tier_upgraded") === true);
check("HR hr_watch_detected still eligible regardless of bettability",
  isEligibleForAlert("all_sports", hrCanonical({ signalTier: "watch", isBettable: false }), "hr_watch_detected") === true);

// ── 5. Display contract — HR bettability + diagnostics (C3 / C4) ────────────
const logs: string[] = [];
const origLog = console.log;
console.log = (...a: any[]) => { logs.push(a.map(String).join(" ")); };
try {
  const fire = applyDisplayContract(
    hrSig({ currentState: "BET_NOW", canonicalStage: "attack", hasRealSportsbookLine: true }), {});
  check("HR bettable at ~24% when real line + BET_NOW", fire.isBettable === true);
  const noOdds = applyDisplayContract(
    hrSig({ currentState: "BET_NOW", canonicalStage: "attack", hasRealSportsbookLine: false }), {});
  check("HR NOT bettable when no real sportsbook line", noOdds.isBettable === false);
  const prepare = applyDisplayContract(
    hrSig({ currentState: "PREPARE", canonicalStage: "building", hasRealSportsbookLine: true }), {});
  check("HR NOT bettable pre-BET_NOW even with a real line", prepare.isBettable === false);
} finally {
  console.log = origLog;
}
check("no [MLB_DISPLAY_CONTRACT_MISMATCH] for a legit sub-50% HR FIRE",
  !logs.some((l) => l.includes("[MLB_DISPLAY_CONTRACT_MISMATCH]")),
  logs.filter((l) => l.includes("MISMATCH")).join(" | "));

// ── 6. Provenance — synthetic 0.5 threshold never surfaces publicly (B2) ────
const occOnly = normalizeMLBSignal(
  {
    playerId: "p9",
    playerName: "No-Line Slugger",
    market: "home_runs",
    side: "OVER",
    line: 0.5,                    // internal HR-occurrence threshold
    hasRealSportsbookLine: false, // occurrence-only
    sportsbook: null,
    projection: 0.28,
    signalScore: 60,
    calibratedProbabilityOver: 22,
    calibratedProbabilityUnder: 78,
    confidenceTier: "STRONG",
    signalTier: "lean",
  },
  { gameId: "G1", rawOutput: { edge: 7.5, evPct: 3.1, overOdds: -120, underOdds: 100 }, gameState: null, game: null, pitchMixFallback: null },
);
check("occurrence-only HR: public bookLine nulled (no 0.5 leak)", occOnly.bookLine === null,
  `bookLine=${occOnly.bookLine}`);
check("occurrence-only HR: sportsbook nulled", occOnly.sportsbook === null);
check("occurrence-only HR: edge nulled", occOnly.edge === null, `edge=${occOnly.edge}`);
check("occurrence-only HR: overOdds/underOdds nulled",
  occOnly.overOdds === null && occOnly.underOdds === null);

// A HR WITH a real line keeps its public pricing.
const realLine = normalizeMLBSignal(
  {
    playerId: "p8", playerName: "Real-Line Slugger", market: "home_runs", side: "OVER",
    line: 0.5, hasRealSportsbookLine: true, sportsbook: "draftkings", projection: 0.31,
    signalScore: 72, calibratedProbabilityOver: 27, calibratedProbabilityUnder: 73,
    confidenceTier: "STRONG", signalTier: "elite",
  },
  { gameId: "G1", rawOutput: { edge: 6.2, evPct: 2.4, overOdds: 250, underOdds: -320 }, gameState: null, game: null, pitchMixFallback: null },
);
check("real-line HR: public bookLine preserved", realLine.bookLine === 0.5);
check("real-line HR: sportsbook preserved", realLine.sportsbook === "draftkings");
check("real-line HR: edge preserved", realLine.edge === 6.2, `edge=${realLine.edge}`);

// A non-HR market is never affected by the provenance null-out.
const nonHr = normalizeMLBSignal(
  {
    playerId: "p7", playerName: "Hitter", market: "hits", side: "OVER",
    line: 1.5, sportsbook: "fanduel", projection: 1.7, signalScore: 65,
    calibratedProbabilityOver: 58, calibratedProbabilityUnder: 42, confidenceTier: "STRONG", signalTier: "strong",
  },
  { gameId: "G1", rawOutput: { edge: 4.0, evPct: 2.0, overOdds: -110, underOdds: -110 }, gameState: null, game: null, pitchMixFallback: null },
);
check("non-HR market: pricing untouched by provenance rule",
  nonHr.bookLine === 1.5 && nonHr.sportsbook === "fanduel" && nonHr.edge === 4.0);

console.log(`[HR_LIVE_EDGE_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[HR_LIVE_EDGE_TEST] OK");
