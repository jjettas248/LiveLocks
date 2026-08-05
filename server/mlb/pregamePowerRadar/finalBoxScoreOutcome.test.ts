// Pre-Game Power Radar — restart-proof grading fallback invariants.
//
// resolveOutcomeFromFinalBoxScore is the fallback the 5-minute grader uses when
// the in-memory box-score cache (mlbGameCache.gameBoxScore) has NO line for a
// batter — a game the live orchestrator never synced, or a cold cache after a
// redeploy. Without it, a real HR sits unmarked for the rest of the day (the
// bug this test guards). It reads a FINAL box score fetched on demand and must
// grade the HR exactly like the in-memory path, reusing the same win
// attribution + exact total-bases classification.
//
// Run: npx tsx server/mlb/pregamePowerRadar/finalBoxScoreOutcome.test.ts

import { resolveOutcomeFromFinalBoxScore } from "./finalBoxScoreOutcome";
import type { PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Minimal player-stats map matching buildMlbPlayerStats' shape (id/name/batting/
// pitching). Only the batting fields getMlbStatValue reads are needed.
function statsMap(
  batterId: string,
  batting: Record<string, number>,
) {
  return new Map([[batterId, { id: batterId, name: "Test Batter", batting, pitching: {} }]]) as any;
}

// Minimal signal — the resolver only reads batterId + everPubliclyFlagged.
function signal(overrides: Partial<PregamePowerSignal> = {}): PregamePowerSignal {
  return {
    batterId: "12345",
    batterName: "Test Batter",
    everPubliclyFlagged: true,
    ...overrides,
  } as PregamePowerSignal;
}

// ── A publicly-flagged HR grades as a userVisible pregame_win ─────────────────
{
  const o = resolveOutcomeFromFinalBoxScore(
    signal(),
    statsMap("12345", { homeRuns: 1, totalBases: 4, hits: 1, rbi: 2 }),
  );
  ok(o != null, "HR present → outcome resolved (not null)");
  ok(o?.hitHr === true, "homeRuns=1 → hitHr true — the HR that was going unmarked now settles");
  ok(o?.outcome === "pregame_win", "flagged HR → pregame_win");
  ok(o?.userVisible === true, "publicly-flagged HR → userVisible (turns the card green)");
  ok(o?.totalBases === 4, "totalBases carried from the MLB box score");
  ok(o?.tbOutcome === "tb_success", "4 TB from an exact MLB box score → tb_success (isExact:true)");
  ok(o?.rbiRecorded === 2, "rbi carried through");
  ok(o?.hitRecorded === true, "hits>0 → hitRecorded");
}

// ── An unflagged HR still grades as a win, but internal-only ─────────────────
{
  const o = resolveOutcomeFromFinalBoxScore(
    signal({ everPubliclyFlagged: false }),
    statsMap("12345", { homeRuns: 2, totalBases: 8, hits: 2, rbi: 3 }),
  );
  ok(o?.hitHr === true && o?.outcome === "pregame_win", "unflagged HR → pregame_win (internal)");
  ok(o?.userVisible === false, "unflagged HR → not userVisible (never leaks into the public log)");
}

// ── No HR grades as an internal calibration_miss (fetched box ⇒ game is final) ─
{
  const o = resolveOutcomeFromFinalBoxScore(
    signal(),
    statsMap("12345", { homeRuns: 0, totalBases: 1, hits: 1, rbi: 0 }),
  );
  ok(o?.hitHr === false, "homeRuns=0 → hitHr false");
  ok(o?.outcome === "calibration_miss", "no HR → calibration_miss");
  ok(o?.userVisible === false, "calibration_miss is never a public loss");
}

// ── Batter absent from the final box score → null (never fabricated) ─────────
{
  const o = resolveOutcomeFromFinalBoxScore(
    signal({ batterId: "99999" }),
    statsMap("12345", { homeRuns: 1, totalBases: 4, hits: 1, rbi: 1 }),
  );
  ok(o === null, "batter not in the fetched box score → null, never a fabricated grade");
}

// ── Inning/half degrade to the canonical-hit fallback (no play feed here) ────
{
  const o = resolveOutcomeFromFinalBoxScore(
    signal(),
    statsMap("12345", { homeRuns: 1, totalBases: 4, hits: 1, rbi: 1 }),
    { hitInning: 7, hitHalf: "B" },
  );
  ok(o?.hrInning === 7, "canonical hit inning used when the fetched box carries no play feed");
  ok(o?.hrHalf === "bottom", "canonical half normalized (B → bottom)");
  ok(o?.firstAbPregameWin === "unknown", "no AB-sequencing data → firstAb 'unknown', never a silent false");
}

// ── Missing totalBases stays unknown, never fabricated ───────────────────────
{
  const o = resolveOutcomeFromFinalBoxScore(
    signal(),
    statsMap("12345", { homeRuns: 1, hits: 1, rbi: 1 }), // no totalBases field
  );
  ok(o?.hitHr === true, "HR still grades even when totalBases is absent");
  ok(o?.totalBases === null, "absent totalBases → null, never fabricated");
  ok(o?.tbOutcome === "tb_unknown", "absent totalBases → tb_unknown");
}

console.log(`\nfinalBoxScoreOutcome.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
