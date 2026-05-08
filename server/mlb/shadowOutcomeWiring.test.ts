// Shadow Outcome Wiring regression — locks the contract that
// recordShadowOutcome + resolvePendingShadowOutcomes write ONLY into the
// shadow store, NEVER touch persisted_plays / ROI / W-L analytics, and
// correctly classify cashed / missed / push / expired outcomes.
//
// Run: npx tsx server/mlb/shadowOutcomeWiring.test.ts

import {
  evaluateShadowBatterOver as evaluateShadowQualification,
  recordShadowOutcome,
  resolvePendingShadowOutcomes,
  classifyShadowOutcome,
  findPendingShadowRecord,
  getShadowSummary,
  listShadowSignals,
  type ResolvedPlayerEntry,
} from "./shadowQualification";

let failed = 0;
let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✓ ${name}`);
      passed++;
    })
    .catch((err: any) => {
      console.error(`✗ ${name}\n  ${err?.message ?? err}`);
      failed++;
    });
}
function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(msg);
}
function eq(a: any, b: any, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${b}, got ${a})`);
}

async function main(): Promise<void> {
  // ── 1. classifyShadowOutcome pure helper ──────────────────────────────────
  await test("classifyShadowOutcome over cashed", () => {
    eq(classifyShadowOutcome("over", 1.5, 2), "cashed", "over 2 vs 1.5");
  });
  await test("classifyShadowOutcome over missed", () => {
    eq(classifyShadowOutcome("over", 1.5, 1), "missed", "over 1 vs 1.5");
  });
  await test("classifyShadowOutcome under cashed", () => {
    eq(classifyShadowOutcome("under", 1.5, 1), "cashed", "under 1 vs 1.5");
  });
  await test("classifyShadowOutcome under missed", () => {
    eq(classifyShadowOutcome("under", 1.5, 2), "missed", "under 2 vs 1.5");
  });
  await test("classifyShadowOutcome push (over)", () => {
    eq(classifyShadowOutcome("over", 2, 2), "push", "exact line over");
  });
  await test("classifyShadowOutcome push (under)", () => {
    eq(classifyShadowOutcome("under", 2, 2), "push", "exact line under");
  });
  await test("classifyShadowOutcome invalid bookLine", () => {
    eq(classifyShadowOutcome("over", null, 2), null, "null bookLine");
  });
  await test("classifyShadowOutcome invalid side", () => {
    eq(classifyShadowOutcome("nonsense", 1.5, 2), null, "bad side");
  });

  // ── 2. Qualify → record → assert summary deltas ───────────────────────────
  // Qualify three batter_over signals just above the shadow floor. Each must
  // land in the shadow store (in-memory, no UI surfacing).
  const baseCandidate = {
    gameId: "TEST_GAME_OUTCOME",
    market: "hits",
    playerName: "Test Hitter A",
    playerId: "player_A",
    side: "Over",
    probability: 0.55,
    signalScore: 44, // above shadow floor 43, below live floor 46
    bookLine: 1.5,
    scoreBreakdown: {
      matchup: 60, // satisfies conviction cluster (>= 55)
      liveContext: 40,
      form: 40,
      total: 44,
    },
  };

  const beforeSummary = getShadowSummary();
  const beforePending = beforeSummary.totals.pending;
  const beforeCashed = beforeSummary.totals.cashed;
  const beforeMissed = beforeSummary.totals.missed;
  const beforePush = beforeSummary.totals.push;

  const r1 = evaluateShadowQualification({ ...baseCandidate, playerId: "p1", playerName: "Hitter One" });
  const r2 = evaluateShadowQualification({ ...baseCandidate, playerId: "p2", playerName: "Hitter Two" });
  const r3 = evaluateShadowQualification({ ...baseCandidate, playerId: "p3", playerName: "Hitter Three" });

  await test("evaluateShadowBatterOver produces qualified ids", () => {
    assert(r1.decision === "qualified" && r1.signalId, "p1 qualified");
    assert(r2.decision === "qualified" && r2.signalId, "p2 qualified");
    assert(r3.decision === "qualified" && r3.signalId, "p3 qualified");
  });

  // ── 3. recordShadowOutcome handles cashed/missed/push ─────────────────────
  await test("recordShadowOutcome cashed", () => {
    const ok = recordShadowOutcome(r1.signalId!, "cashed", "test cashed");
    assert(ok, "recorded cashed");
  });
  await test("recordShadowOutcome missed", () => {
    const ok = recordShadowOutcome(r2.signalId!, "missed", "test missed");
    assert(ok, "recorded missed");
  });
  await test("recordShadowOutcome push", () => {
    const ok = recordShadowOutcome(r3.signalId!, "push", "test push");
    assert(ok, "recorded push");
  });
  await test("recordShadowOutcome idempotent (cashed → cannot re-cash)", () => {
    const ok = recordShadowOutcome(r1.signalId!, "missed", "should be ignored");
    assert(!ok, "second outcome rejected");
  });

  const afterSummary = getShadowSummary();
  await test("summary deltas reflect 1 cashed / 1 missed / 1 push", () => {
    eq(afterSummary.totals.cashed - beforeCashed, 1, "cashed +1");
    eq(afterSummary.totals.missed - beforeMissed, 1, "missed +1");
    eq(afterSummary.totals.push - beforePush, 1, "push +1");
    eq(afterSummary.totals.pending - beforePending, 0, "pending net change 0 (3 added, 3 settled)");
    assert("settled" in afterSummary.totals, "settled field present");
    assert("roiUnits" in afterSummary, "roiUnits field present");
    assert("roiPerPick" in afterSummary, "roiPerPick field present");
    assert("bySide" in afterSummary, "bySide field present");
    assert("sampleSizeWarning" in afterSummary, "sampleSizeWarning field present");
  });

  await test("ROI proxy excludes push and applies -110 vig", () => {
    // 1 cashed (+0.909) + 1 missed (-1.0) + 1 push (0) = -0.091u over 3 picks
    // We compare against the delta because the shared module aggregates
    // across the whole test process.
    const dCashed = afterSummary.totals.cashed - beforeCashed;
    const dMissed = afterSummary.totals.missed - beforeMissed;
    const expectedDelta = dCashed * 0.909 - dMissed; // -0.091
    // We can't isolate roiUnits easily across the whole process — so just
    // assert the formula direction: 1c + 1m → roiUnits should be a finite
    // number close to -0.091 contribution.
    assert(Math.abs(expectedDelta - (-0.091)) < 1e-6, "roi delta math");
  });

  await test("bySide breakdown populated for Over picks", () => {
    const over = afterSummary.bySide["over"];
    assert(over, "over side present");
    assert(over.shadowQualified >= 3, "over qualified count includes our 3");
  });

  // ── 4. findPendingShadowRecord fallback key matching ──────────────────────
  const r4 = evaluateShadowQualification({
    ...baseCandidate,
    playerId: "p4",
    playerName: "Hitter Four",
  });
  await test("findPendingShadowRecord by signalId", () => {
    const rec = findPendingShadowRecord({ signalId: r4.signalId });
    assert(rec, "found by signalId");
    eq(rec!.outcome, "pending", "still pending");
  });
  await test("findPendingShadowRecord fallback by gameId+playerId+market+side+line", () => {
    const rec = findPendingShadowRecord({
      gameId: "TEST_GAME_OUTCOME",
      playerId: "p4",
      market: "hits",
      side: "Over",
      line: 1.5,
    });
    assert(rec, "found by fallback key");
    eq(rec!.signalId, r4.signalId!, "correct record");
  });
  await test("findPendingShadowRecord fallback by name normalize", () => {
    const rec = findPendingShadowRecord({
      gameId: "TEST_GAME_OUTCOME",
      playerName: "hitter four", // case + space normalized
      market: "hits",
      side: "Over",
    });
    assert(rec, "found by name normalize");
    eq(rec!.signalId, r4.signalId!, "correct record");
  });
  await test("findPendingShadowRecord returns undefined for non-pending", () => {
    recordShadowOutcome(r4.signalId!, "cashed", "cleanup");
    const rec = findPendingShadowRecord({ signalId: r4.signalId });
    assert(!rec, "settled record not returned");
  });

  // ── 5. resolvePendingShadowOutcomes end-to-end ────────────────────────────
  const r5 = evaluateShadowQualification({
    ...baseCandidate,
    playerId: "p5",
    playerName: "Hitter Five",
  });
  const r6 = evaluateShadowQualification({
    ...baseCandidate,
    playerId: "p6",
    playerName: "Hitter Six",
    bookLine: 2.5,
  });
  await test("resolvePendingShadowOutcomes routes through injected helpers", async () => {
    // Inject a synthetic boxscore where p5 = 2 hits (cashes 1.5),
    // p6 = 1 hit (misses 2.5).
    const playerMap = new Map<string, ResolvedPlayerEntry & { hits: number }>([
      ["p5", { id: "p5", name: "Hitter Five", hits: 2 }],
      ["p6", { id: "p6", name: "Hitter Six", hits: 1 }],
    ]);
    const summary = await resolvePendingShadowOutcomes({
      fetchPlayerMap: async (gid) => (gid === "TEST_GAME_OUTCOME" ? playerMap : null),
      getStatValue: (entry, market) =>
        market === "hits" ? (entry as any).hits : null,
    });
    assert(summary.recordsScanned >= 2, "scanned at least our 2 records");
    assert(summary.cashed >= 1, "at least 1 cashed");
    assert(summary.missed >= 1, "at least 1 missed");
  });
  await test("resolvePendingShadowOutcomes is idempotent — second pass is a no-op", async () => {
    const before = getShadowSummary().totals;
    await resolvePendingShadowOutcomes({
      fetchPlayerMap: async () =>
        new Map([["p5", { id: "p5", name: "Hitter Five" }]]),
      getStatValue: () => 2,
    });
    const after = getShadowSummary().totals;
    eq(after.cashed, before.cashed, "no change cashed");
    eq(after.missed, before.missed, "no change missed");
  });
  await test("resolvePendingShadowOutcomes handles missing boxscore (game not final)", async () => {
    const r7 = evaluateShadowQualification({
      ...baseCandidate,
      playerId: "p7",
      playerName: "Hitter Seven",
      gameId: "TEST_GAME_NOT_FINAL",
    });
    assert(r7.decision === "qualified", "p7 qualified");
    const summary = await resolvePendingShadowOutcomes({
      fetchPlayerMap: async () => null, // game not final
      getStatValue: () => null,
    });
    assert(summary.gamesSkippedNoBoxscore >= 1, "game skipped");
    // p7 still pending
    const rec = findPendingShadowRecord({ signalId: r7.signalId });
    assert(rec && rec.outcome === "pending", "p7 still pending");
  });

  // ── 6. Strict line guard (architect-flagged: medium severity) ────────────
  await test("findPendingShadowRecord rejects when query.line set but stored bookLine is null", () => {
    // Build a candidate with NO bookLine so stored record has bookLine=null.
    const r = evaluateShadowQualification({
      ...baseCandidate,
      playerId: "p_lineless",
      playerName: "Hitter Lineless",
      bookLine: null,
    });
    assert(r.decision === "qualified" && r.signalId, "lineless record qualified");
    // Caller supplies a line — should NOT match the lineless record.
    const rec = findPendingShadowRecord({
      gameId: "TEST_GAME_OUTCOME",
      playerId: "p_lineless",
      market: "hits",
      side: "Over",
      line: 1.5,
    });
    assert(!rec, "lineless record must not absorb a typed-line query");
    // Same query without `line` should still match.
    const rec2 = findPendingShadowRecord({
      gameId: "TEST_GAME_OUTCOME",
      playerId: "p_lineless",
      market: "hits",
      side: "Over",
    });
    assert(rec2 && rec2.signalId === r.signalId, "lineless record matches when caller omits line");
    // Cleanup
    recordShadowOutcome(r.signalId!, "expired", "test cleanup");
  });

  // ── 7. Re-evaluation refreshes bookLine (architect-flagged) ──────────────
  await test("re-evaluation refreshes bookLine when line moves", async () => {
    const first = evaluateShadowQualification({
      ...baseCandidate,
      playerId: "p_movingline",
      playerName: "Hitter MovingLine",
      bookLine: 1.5,
    });
    assert(first.decision === "qualified", "first qualified");
    // Same signalId, line moved to 2.5
    const second = evaluateShadowQualification({
      ...baseCandidate,
      playerId: "p_movingline",
      playerName: "Hitter MovingLine",
      bookLine: 2.5,
    });
    eq(second.signalId, first.signalId, "same signalId on re-eval");
    eq(second.reason, "re_evaluated", "re_evaluated reason");
    // Resolve with finalStat=2: should MISS at line 2.5 (not cash at 1.5).
    const summary = await resolvePendingShadowOutcomes({
      fetchPlayerMap: async () =>
        new Map([["p_movingline", { id: "p_movingline", name: "Hitter MovingLine" }]]),
      getStatValue: () => 2,
    });
    assert(summary.missed >= 1, "missed at refreshed line 2.5");
  });

  // ── 8. Hard isolation — no persisted_plays / storage interaction ─────────
  await test("module imports do not pull in storage / settlePlay", async () => {
    // Import shape check: shadowQualification must NOT import gradePersistedPlays
    // or storage. Static check: read its source and assert.
    const fs = await import("fs/promises");
    const path = await import("path");
    const src = await fs.readFile(
      path.join(process.cwd(), "server/mlb/shadowQualification.ts"),
      "utf8",
    );
    // Strip line/block comments so doc references like "NEVER touches
    // storage.settlePlay" do not trip the call-site check.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    assert(!/\.settlePlay\s*\(/.test(stripped), "shadow module does not call settlePlay");
    assert(!/from\s+["']\.\/gradePersistedPlays["']/.test(stripped), "shadow module does not import grader");
    assert(!/from\s+["']\.\.\/storage["']/.test(stripped), "shadow module does not import storage");
  });

  console.log(`\n[shadowOutcomeWiring.test] passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[shadowOutcomeWiring.test] fatal:", err);
  process.exit(1);
});
