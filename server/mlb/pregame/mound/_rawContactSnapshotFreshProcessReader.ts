// Fresh-process READER half of rawContactSnapshotFreshProcessRoundTrip.test.ts.
// Run as a genuinely separate `npx tsx` process (spawned by the driver test)
// so "restart/hydration" is a real process boundary, not just an in-process
// function call. Loads the snapshot the writer half persisted, then proves:
//   - the current signal's frozen rawContactSnapshot hydrates verbatim
//   - a legacy signal's genuine absence hydrates to absence, never fabricated
//   - a locked/final rebuild (applyMoundEvaluationSnapshots) run against the
//     DB-hydrated `prev` freezes the ORIGINAL snapshot, never a freshly
//     recomputed one — proven against a real DB-hydrated prev, not a
//     synthetic in-memory object
//   - repeated initialization on identical DB-hydrated inputs does not
//     duplicate or drift the frozen value
//
// Prints "READER_RESULT: N passed, M failed" and exits 1 on any failure.

import { loadMoundSnapshotFromDb } from "./moundPersistence";
import { applyMoundEvaluationSnapshots } from "./evaluationSnapshot";
import type { RawPitcherContactSnapshot } from "./rawPitcherContactSnapshot";

const sessionDate = process.argv[2];
if (!sessionDate) {
  console.error("usage: tsx _rawContactSnapshotFreshProcessReader.ts <sessionDate>");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function differentContactSnap(): RawPitcherContactSnapshot {
  return {
    schemaVersion: 1,
    hr9Allowed: 9.9, barrelAllowedPct: 99.9, hardHitAllowedPct: 99.9, flyBallAllowedPct: 99.9,
    xSLGAllowed: 0.999, xwOBAAllowed: 0.999, bb9: 9.9, ipVariance: 9.9,
    sampleSizes: {
      inningsPitched: 1, homeRunsAllowed: 1, hardHitEligibleBbe: 1,
      barrelEligibleBbe: 1, bbTypeEligibleBbe: 1, xSLGEligibleBbe: 1, xwOBAEligibleBbe: 1,
    },
    availability: {
      hr9Allowed: "available", barrelAllowedPct: "available", hardHitAllowedPct: "available",
      flyBallAllowedPct: "available", xSLGAllowed: "available", xwOBAAllowed: "available",
      bb9: "available", ipVariance: "available",
    },
  };
}

async function main() {
  const snapshot = await loadMoundSnapshotFromDb(sessionDate);
  ok(snapshot !== null, "fresh-process load found a persisted snapshot for this sessionDate");
  if (!snapshot) {
    console.log(`READER_RESULT: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const current = snapshot.signals.get("mlb-mound:fresh-rt-mound:g1:current");
  const legacy = snapshot.signals.get("mlb-mound:fresh-rt-mound:g1:legacy");
  ok(current != null, "current signal hydrated from a genuinely separate process");
  ok(legacy != null, "legacy signal hydrated from a genuinely separate process");

  // ── 1. Current signal's rawContactSnapshot persists + hydrates verbatim ──
  const hydratedContactSnapshot = current?.diagnostics.evaluation?.finalPregameSnapshot?.champion.rawContactSnapshot;
  ok(
    hydratedContactSnapshot !== undefined && hydratedContactSnapshot.hr9Allowed === 1.2 && hydratedContactSnapshot.schemaVersion === 1,
    `current signal's rawContactSnapshot hydrates verbatim across a real process restart (got ${JSON.stringify(hydratedContactSnapshot)})`,
  );

  // ── 2. Legacy signal's genuine absence hydrates to absence ──────────────
  const legacyContactSnapshot = legacy?.diagnostics.evaluation?.finalPregameSnapshot?.champion.rawContactSnapshot;
  ok(
    legacyContactSnapshot === undefined,
    `legacy signal (never had rawContactSnapshot) hydrates to genuine absence, never fabricated (got ${JSON.stringify(legacyContactSnapshot)})`,
  );

  // ── 3. Locked/final rebuild against a REAL DB-hydrated prev cannot mutate the frozen snapshot ──
  if (current) {
    const rates = new Map([[current.pitcherId, { seasonKPer9: 9, seasonAvgInningsPerStart: 6 }]]);
    const prevSignals = new Map([[current.signalId, current]]);
    const freshSignals = new Map([[current.signalId, { ...current, status: "locked" as const, gameStatus: "final" as const }]]);
    // Simulate what a live rebuild would produce post-lock: same signal
    // identity, but a fresh evaluation pass computed a DIFFERENT
    // rawContactSnapshot (proving the freeze wins over a genuinely
    // different, newer computation, not just an identical one).
    const rawMap = new Map([[current.signalId, differentContactSnap()]]);
    applyMoundEvaluationSnapshots(freshSignals, prevSignals, "post-lock-build", rates, rawMap);
    const rebuilt = freshSignals.get(current.signalId)!;
    const frozen = rebuilt.diagnostics.evaluation?.finalPregameSnapshot?.champion.rawContactSnapshot;
    ok(
      JSON.stringify(frozen) === JSON.stringify(hydratedContactSnapshot) && JSON.stringify(frozen) !== JSON.stringify(differentContactSnap()),
      `locked/final rebuild against a REAL DB-hydrated prev freezes the ORIGINAL snapshot, never the freshly (differently) recomputed one (got ${JSON.stringify(frozen)})`,
    );

    // ── 5. Repeated initialization on identical DB-hydrated inputs doesn't duplicate/drift ──
    const freshSignals2 = new Map([[current.signalId, { ...current, status: "locked" as const, gameStatus: "final" as const }]]);
    applyMoundEvaluationSnapshots(freshSignals2, prevSignals, "post-lock-build", rates, rawMap);
    const rebuilt2 = freshSignals2.get(current.signalId)!;
    const frozen2 = rebuilt2.diagnostics.evaluation?.finalPregameSnapshot?.champion.rawContactSnapshot;
    ok(JSON.stringify(frozen2) === JSON.stringify(frozen), "repeated initialization with identical DB-hydrated inputs does not duplicate or drift the frozen value");
  }

  // ── 4. Legacy absence remains absent after hydration AND a locked rebuild ──
  if (legacy) {
    const rates = new Map([[legacy.pitcherId, { seasonKPer9: 9, seasonAvgInningsPerStart: 6 }]]);
    const prevSignals = new Map([[legacy.signalId, legacy]]);
    const freshSignals = new Map([[legacy.signalId, { ...legacy, status: "locked" as const, gameStatus: "final" as const }]]);
    applyMoundEvaluationSnapshots(freshSignals, prevSignals, "post-lock-build", rates, new Map());
    const rebuilt = freshSignals.get(legacy.signalId)!;
    ok(
      rebuilt.diagnostics.evaluation?.finalPregameSnapshot?.champion.rawContactSnapshot === undefined,
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
