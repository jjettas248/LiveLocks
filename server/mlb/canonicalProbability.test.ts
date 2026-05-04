// ── MLB Canonical Probability v1 — Validation Harness ──────────────────────
//
// Phase 1 / Section 9 of the MLB Canonical Engine Source-of-Truth fix.
//
// Verifies the canonical probability contract end-to-end without spinning up
// the full engine or DB. Everything below routes through the SAME helpers
// (`getCanonicalSidedProbability`, `validateMlbEngineProbability`,
// `bucketPlaysByCanonicalProb`) used by the orchestrator, persistence layer
// and analytics route — so a regression in any production call site fails
// here too.
//
// Cases:
//   A) recommendedSide=OVER  → persisted prob == calibratedProbabilityOver
//   B) recommendedSide=UNDER → persisted prob == calibratedProbabilityUnder
//      (NOT dominant, NOT signalScore)
//   C) engineProbability missing → trackPlay rejects, signalScore is NEVER
//      substituted, [MLB_PERSIST_REJECT] log fires.
//   D) trackPlay's MLB guard rejects null/NaN/non-finite/<0/>100; 0 and 100
//      boundaries are accepted.
//   E) buildTopPlays surfaces sided enginePct as wire `probability` (not
//      signalScore).
//   F) Orchestrator-shared sided mapping helper resolves OVER and UNDER
//      correctly (locks the contract used at the two production call sites
//      in liveGameOrchestrator.ts).
//   G) Analytics bucketing helper buckets canonical persisted `prob` (not
//      signalScore), proving /api/performance reads the canonical column.
//
// Run:
//   npx tsx server/mlb/canonicalProbability.test.ts
//
// No assertion library; throws on first failure with a descriptive message.

import {
  validateMlbEngineProbability,
  getCanonicalSidedProbability,
  bucketPlaysByCanonicalProb,
  MLB_PROB_BUCKETS,
} from "./probabilityEngine";
import { trackPlay, type TrackableSignal } from "../services/playTracker";
import { buildTopPlays } from "../services/topPlaysService";

// ── Tiny assert helpers ──────────────────────────────────────────────────────
function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `[FAIL] ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`[FAIL] ${label}`);
}

// ── console spy: capture log lines containing a tag ─────────────────────────
function captureConsole<T>(
  tag: string,
  fn: () => Promise<T> | T,
): Promise<{ result: T; matches: string[] }> {
  return (async () => {
    const matches: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const tap = (...args: any[]) => {
      const line = args
        .map((a) => (typeof a === "string" ? a : safeJson(a)))
        .join(" ");
      if (line.includes(tag)) matches.push(line);
    };
    console.log = (...args: any[]) => {
      tap(...args);
      origLog(...args);
    };
    console.warn = (...args: any[]) => {
      tap(...args);
      origWarn(...args);
    };
    try {
      const result = await fn();
      return { result, matches };
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
  })();
}
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── Mock IStorage that captures recordPlay calls ────────────────────────────
function makeMockStorage() {
  const recorded: any[] = [];
  return {
    recorded,
    storage: {
      recordPlay: async (args: any) => {
        recorded.push(args);
        return { id: args.id ?? "mock", isDuplicate: false };
      },
    } as any,
  };
}

function baseSignal(overrides: Partial<TrackableSignal> = {}): TrackableSignal {
  return {
    gameId: "test-game-1",
    playerId: "p1",
    playerName: "Test Hitter",
    team: "TEST",
    sport: "mlb",
    market: "hits",
    direction: "over",
    line: 0.5,
    projection: 1.1,
    probability: 64,
    edge: 12,
    sportsbook: "draftkings",
    derivedLine: false,
    createdAt: Date.now(),
    signalScore: 78,
    confidenceTier: "STRONG",
    ...overrides,
  };
}

// ── Case A — OVER: persisted prob == calibratedProbabilityOver ──────────────
async function caseA() {
  // Use the SAME helper the orchestrator uses (production code path).
  const engineOutput = {
    recommendedSide: "OVER" as const,
    calibratedProbabilityOver: 64,
    calibratedProbabilityUnder: 36,
  };
  const sidedCalibrated = getCanonicalSidedProbability(engineOutput);
  assertEq(sidedCalibrated, 64, "A: getCanonicalSidedProbability(OVER) = 64");

  const valid = validateMlbEngineProbability({
    engineProbability: sidedCalibrated,
    signalScore: 78,
    recommendedSide: "OVER",
  });
  assertEq(valid, 64, "A: validateMlbEngineProbability returns sided value");

  const { recorded, storage } = makeMockStorage();
  const { matches: persistChecks } = await captureConsole(
    "[MLB_PERSIST_CHECK]",
    () =>
      trackPlay(
        baseSignal({
          direction: "over",
          probability: sidedCalibrated,
          signalScore: 78,
        }),
        storage,
      ),
  );
  assertEq(recorded.length, 1, "A: storage.recordPlay called exactly once");
  assertEq(recorded[0].prob, 64, "A: persisted prob equals OVER calibrated");
  assertEq(recorded[0].engineProb, 64, "A: persisted engineProb equals OVER calibrated");
  assertTrue(
    recorded[0].prob !== 78 && recorded[0].engineProb !== 78,
    "A: signalScore was NOT substituted as probability",
  );
  assertTrue(
    persistChecks.length >= 1,
    "A: [MLB_PERSIST_CHECK] log fired on persist",
  );
  console.log("[PASS] Case A — OVER recommendation persists OVER probability (64).");
}

// ── Case B — UNDER: persisted prob == calibratedProbabilityUnder ────────────
async function caseB() {
  const engineOutput = {
    recommendedSide: "UNDER" as const,
    calibratedProbabilityOver: 61, // dominant — must NOT be persisted
    calibratedProbabilityUnder: 39,
  };
  const sidedCalibrated = getCanonicalSidedProbability(engineOutput);
  assertEq(sidedCalibrated, 39, "B: getCanonicalSidedProbability(UNDER) = 39");

  const valid = validateMlbEngineProbability({
    engineProbability: sidedCalibrated,
    signalScore: 78,
    recommendedSide: "UNDER",
  });
  assertEq(valid, 39, "B: validateMlbEngineProbability returns UNDER sided value");

  const { recorded, storage } = makeMockStorage();
  await trackPlay(
    baseSignal({
      direction: "under",
      probability: sidedCalibrated,
      signalScore: 78,
    }),
    storage,
  );
  assertEq(recorded[0].prob, 39, "B: persisted prob equals UNDER calibrated (NOT dominant 61)");
  assertEq(recorded[0].engineProb, 39, "B: persisted engineProb equals UNDER calibrated");
  assertTrue(
    recorded[0].prob !== 61 && recorded[0].prob !== 78,
    "B: dominant probability and signalScore were both excluded",
  );
  console.log("[PASS] Case B — UNDER recommendation persists UNDER probability (39).");
}

// ── Case C — missing engineProbability → REJECT, signalScore not used ───────
async function caseC() {
  const valid = validateMlbEngineProbability({
    engineProbability: null,
    signalScore: 78,
    recommendedSide: "OVER",
  });
  assertEq(valid, null, "C: validateMlbEngineProbability returns null when missing");

  const { recorded, storage } = makeMockStorage();
  const { result, matches: rejectLogs } = await captureConsole(
    "[MLB_PERSIST_REJECT]",
    () =>
      trackPlay(
        baseSignal({
          probability: Number.NaN as unknown as number,
          signalScore: 78,
        }),
        storage,
      ),
  );
  assertEq(recorded.length, 0, "C: storage.recordPlay was NEVER called");
  assertEq(result.id, "", "C: trackPlay returned empty id (rejected)");
  assertTrue(
    rejectLogs.length >= 1,
    "C: [MLB_PERSIST_REJECT] log fired on invalid persist",
  );
  // The reject log must NOT have substituted signalScore as the probability.
  const log = rejectLogs[0] || "";
  assertTrue(
    !/"prob"\s*:\s*78/.test(log) && !/probability\s*:\s*78/.test(log),
    "C: reject log does not show signalScore (78) substituted as probability",
  );
  console.log("[PASS] Case C — invalid probability is rejected; reject log fires; signalScore (78) is NOT persisted.");
}

// ── Case D — Range guards: <0, >100, non-finite are rejected ────────────────
async function caseD() {
  const cases = [
    { prob: -1, label: "D: negative" },
    { prob: 101, label: "D: >100" },
    { prob: Number.POSITIVE_INFINITY, label: "D: infinity" },
    { prob: Number.NaN, label: "D: NaN" },
  ];
  for (const c of cases) {
    const v = validateMlbEngineProbability({
      engineProbability: c.prob,
      signalScore: 50,
      recommendedSide: "OVER",
    });
    assertEq(v, null, `${c.label} → validate returns null`);

    const { recorded, storage } = makeMockStorage();
    await trackPlay(
      baseSignal({ probability: c.prob as unknown as number }),
      storage,
    );
    assertEq(recorded.length, 0, `${c.label} → trackPlay rejects (recordPlay not called)`);
  }
  for (const p of [0, 100]) {
    const v = validateMlbEngineProbability({
      engineProbability: p,
      signalScore: 50,
      recommendedSide: "OVER",
    });
    assertEq(v, p, `D: boundary ${p} accepted`);
  }
  console.log("[PASS] Case D — out-of-range / non-finite probabilities rejected; 0 and 100 boundaries accepted.");
}

// ── Case E — buildTopPlays surfaces sided enginePct as `probability` ────────
function caseE() {
  const overSig = {
    playerId: "p1",
    playerName: "OverGuy",
    market: "hits",
    bookLine: 0.5,
    enginePct: 67,
    edge: 17,
    projection: 1.0,
    recommendedSide: "OVER",
    gameId: "g1",
    signalScore: 80,
  };
  const underSig = {
    playerId: "p2",
    playerName: "UnderGuy",
    market: "hits_allowed",
    bookLine: 6.5,
    enginePct: 62,
    edge: 12,
    projection: 4.5,
    recommendedSide: "UNDER",
    gameId: "g2",
    signalScore: 90,
  };

  const top = buildTopPlays([], [], [overSig, underSig], 10);
  assertEq(top.length, 2, "E: 2 MLB plays surface");

  const overTop = top.find((p) => p.playerOrTeam === "OverGuy");
  const underTop = top.find((p) => p.playerOrTeam === "UnderGuy");
  assertTrue(overTop != null && underTop != null, "E: both plays present");
  assertEq(overTop!.probability, 67, "E: OVER play surfaces enginePct (67), not signalScore (80)");
  assertEq(overTop!.side, "OVER", "E: OVER side preserved");
  assertEq(underTop!.probability, 62, "E: UNDER play surfaces UNDER calibrated (62), not signalScore (90)");
  assertEq(underTop!.side, "UNDER", "E: UNDER side preserved");
  console.log("[PASS] Case E — buildTopPlays exposes recommended-side calibrated probability on the wire.");
}

// ── Case F — Orchestrator-shared sided mapping helper ───────────────────────
// liveGameOrchestrator.ts now imports `getCanonicalSidedProbability` from
// probabilityEngine.ts and uses it at BOTH sided-resolution call sites
// (qualification check and final canonical assignment). Locking this helper
// here means a regression in either production site fails this case too.
function caseF() {
  const overOut = {
    recommendedSide: "OVER" as const,
    calibratedProbabilityOver: 71,
    calibratedProbabilityUnder: 29,
  };
  assertEq(getCanonicalSidedProbability(overOut), 71, "F: OVER sided = 71");

  const underOut = {
    recommendedSide: "UNDER" as const,
    calibratedProbabilityOver: 55,
    calibratedProbabilityUnder: 45,
  };
  assertEq(getCanonicalSidedProbability(underOut), 45, "F: UNDER sided = 45 (NOT 55 dominant)");

  // Defensive: an unknown side string falls through to UNDER (matches
  // production ternary). We still document this with an assertion.
  const fallback = getCanonicalSidedProbability({
    recommendedSide: "UNKNOWN",
    calibratedProbabilityOver: 60,
    calibratedProbabilityUnder: 40,
  });
  assertEq(fallback, 40, "F: unknown side falls through to UNDER branch (matches production ternary)");
  console.log("[PASS] Case F — shared sided-mapping helper resolves OVER/UNDER correctly at the orchestrator contract level.");
}

// ── Case G — Analytics bucketing reads canonical persisted `prob` ───────────
// /api/performance now calls bucketPlaysByCanonicalProb (same helper as this
// test). Mock rows where `prob != signalScore != edge` so we can prove the
// bucket math keys off canonical `prob` and nothing else.
function caseG() {
  const mockRows = [
    // 60-64% bucket: 2 plays, 1 hit, 1 miss → 50% wr
    { prob: 62, result: "hit", signalScore: 99, edgeGap: 50 },
    { prob: 64, result: "miss", signalScore: 50, edgeGap: 99 },
    // 65-69% bucket: 1 play, 1 push (excluded from wr denominator)
    { prob: 67, result: "push", signalScore: 10, edgeGap: 10 },
    // 70-74% bucket: 1 play, 1 hit → 100% wr
    { prob: 73, result: "hit", signalScore: 5, edgeGap: 5 },
    // 75%+ bucket: 0 plays
    // Out-of-range (50% — below lowest bucket): excluded entirely
    { prob: 50, result: "hit", signalScore: 90, edgeGap: 90 },
  ];

  const buckets = bucketPlaysByCanonicalProb(mockRows);
  assertEq(buckets.length, 4, "G: 4 buckets returned");
  assertEq(buckets[0].label, "60-64%", "G: bucket 0 label");
  assertEq(buckets[0].total, 2, "G: 60-64% total = 2");
  assertEq(buckets[0].hits, 1, "G: 60-64% hits = 1");
  assertEq(buckets[0].winRate, 50.0, "G: 60-64% wr = 50%");

  assertEq(buckets[1].label, "65-69%", "G: bucket 1 label");
  assertEq(buckets[1].total, 1, "G: 65-69% total = 1 (push counted in total)");
  assertEq(buckets[1].hits, 0, "G: 65-69% hits = 0");
  assertEq(buckets[1].winRate, 0, "G: 65-69% wr = 0 (push excluded from denominator)");

  assertEq(buckets[2].label, "70-74%", "G: bucket 2 label");
  assertEq(buckets[2].total, 1, "G: 70-74% total = 1");
  assertEq(buckets[2].hits, 1, "G: 70-74% hits = 1");
  assertEq(buckets[2].winRate, 100.0, "G: 70-74% wr = 100%");

  assertEq(buckets[3].total, 0, "G: 75%+ total = 0");

  // Negative control: if bucketing read `signalScore` instead of `prob`, every
  // row at signalScore=99/90/50/10/5 would either fall into different buckets
  // or be excluded. Re-bucketing a copy with prob/signalScore swapped must
  // produce a different distribution.
  const swapped = mockRows.map((r) => ({ prob: r.signalScore, result: r.result }));
  const swappedBuckets = bucketPlaysByCanonicalProb(swapped);
  const swappedTotals = swappedBuckets.map((b) => b.total).join(",");
  const canonicalTotals = buckets.map((b) => b.total).join(",");
  assertTrue(
    swappedTotals !== canonicalTotals,
    "G: bucketing canonically depends on `prob` field (swap test produces different totals)",
  );

  // Sanity: shared bucket constant matches /api/performance.
  assertEq(MLB_PROB_BUCKETS.length, 4, "G: MLB_PROB_BUCKETS has 4 entries");
  assertEq(MLB_PROB_BUCKETS[0].label, "60-64%", "G: shared bucket 0 label matches");
  console.log("[PASS] Case G — analytics bucketing reads canonical persisted `prob`, not signalScore or edge.");
}

// ── Runner ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("── MLB Canonical Probability v1 — Validation Harness ──");
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  caseE();
  caseF();
  caseG();
  console.log("\n✓ ALL CASES PASSED — recommended-side calibrated probability is canonical across engine → persistence → wire → analytics.");
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /canonicalProbability\.test\.ts$/.test(process.argv[1]);

if (isDirect) {
  main().catch((err) => {
    console.error("[FAIL]", err?.message ?? err);
    process.exit(1);
  });
}

export { main as runMlbCanonicalProbabilityTests };
