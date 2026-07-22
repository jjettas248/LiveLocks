// Fresh-process READER half of gradeFactorFreshProcessRoundTrip.test.ts.
// Run as a genuinely separate `npx tsx` process (spawned by the driver test)
// so "restart/hydration" is a real process boundary, not just an in-process
// function call. Loads the snapshot the writer half persisted, then proves:
//   - the current signal's gradeFactorSummary hydrates verbatim
//   - a legacy signal's genuine absence hydrates to absence, never fabricated
//   - a locked/final rebuild (carryForwardGradedState) run against the
//     DB-hydrated `prev` freezes the ORIGINAL value, never a freshly
//     recomputed one — proven against a real DB-hydrated prev, not a
//     synthetic in-memory object
//
// Prints "READER_RESULT: N passed, M failed" and exits 1 on any failure.

import { loadPregameSnapshotFromDb } from "./pregamePersistence";
import { carryForwardGradedState } from "./gradedStateCarry";

const sessionDate = process.argv[2];
if (!sessionDate) {
  console.error("usage: tsx _gradeFactorFreshProcessReader.ts <sessionDate>");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  const snapshot = await loadPregameSnapshotFromDb(sessionDate);
  ok(snapshot !== null, "fresh-process load found a persisted snapshot for this sessionDate");
  if (!snapshot) {
    console.log(`READER_RESULT: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const current = snapshot.signals.get("mlb-pregame:fresh-rt:g1:current");
  const legacy = snapshot.signals.get("mlb-pregame:fresh-rt:g1:legacy");
  ok(current != null, "current signal hydrated from a genuinely separate process");
  ok(legacy != null, "legacy signal hydrated from a genuinely separate process");

  // ── 1. Current signal's gradeFactorSummary persists + hydrates verbatim ──
  const currentFactors = (current?.diagnostics as any)?.gradeFactorSummary;
  ok(
    Array.isArray(currentFactors) && currentFactors.length === 3 && currentFactors[0].key === "pitcherVulnerability",
    `current signal's gradeFactorSummary hydrates verbatim across a real process restart (got ${JSON.stringify(currentFactors)})`,
  );

  // ── 2. Legacy signal's genuine absence hydrates to absence ──────────────
  const legacyFactors = (legacy?.diagnostics as any)?.gradeFactorSummary;
  ok(
    legacyFactors === undefined,
    `legacy signal (never had gradeFactorSummary) hydrates to genuine absence, never fabricated (got ${JSON.stringify(legacyFactors)})`,
  );

  // ── 3. Locked/final rebuild against a REAL DB-hydrated prev cannot
  //     recalculate or replace the frozen summary ─────────────────────────
  if (current) {
    const DIFFERENT_FACTORS = [
      { key: "batterPower", label: "Batter Power", displayLabel: "Weak", tone: "risk", value: 1.0, impact: -1.0, direction: "negative" as const },
    ];
    // Simulate what a live rebuild would produce post-lock: same signal
    // identity, but the game has now gone final and a fresh evaluation
    // pass computed a DIFFERENT gradeFactorSummary (proving the freeze
    // wins over a genuinely different, newer computation, not just an
    // identical one).
    const freshRebuilt = {
      ...current,
      gameStatus: "final" as const,
      status: "active" as const, // carryForwardGradedState computes evaluationLocked from fresh.status !== "active" AFTER this call would normally be "locked"; set below
      diagnostics: { ...current.diagnostics, gradeFactorSummary: DIFFERENT_FACTORS },
    };
    // The freeze gate is `fresh.status !== "active"` — set status to "locked"
    // to represent the post-first-pitch rebuild this scenario is testing.
    freshRebuilt.status = "locked" as any;
    carryForwardGradedState(freshRebuilt as any, current);
    const frozen = (freshRebuilt.diagnostics as any).gradeFactorSummary;
    ok(
      JSON.stringify(frozen) === JSON.stringify(currentFactors) && JSON.stringify(frozen) !== JSON.stringify(DIFFERENT_FACTORS),
      `locked/final rebuild against a REAL DB-hydrated prev freezes the ORIGINAL summary, never the freshly (differently) recomputed one (got ${JSON.stringify(frozen)})`,
    );
  }

  // ── 4. Legacy absence remains absent after hydration AND lock ───────────
  if (legacy) {
    const freshRebuiltLegacy = {
      ...legacy,
      gameStatus: "final" as const,
      status: "locked" as any,
      diagnostics: { ...legacy.diagnostics, gradeFactorSummary: [{ key: "x", label: "x", displayLabel: "Strong", tone: "standout", value: 1, impact: 1, direction: "positive" as const }] },
    };
    carryForwardGradedState(freshRebuiltLegacy as any, legacy);
    ok(
      (freshRebuiltLegacy.diagnostics as any).gradeFactorSummary === undefined,
      "legacy signal's absence remains absent after DB hydration AND a locked rebuild — never backfilled",
    );
  }

  console.log(`READER_RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("READER_CRASHED:", err);
  process.exit(1);
});
