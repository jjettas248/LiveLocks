// MLB game-chip normalizers — invariants.
// Run: npx tsx client/src/lib/mlb/mlbNormalizers.test.ts
//
// Guards the slate-ribbon chip view model: pregame scores stay null (no fake
// 0-0), start times are ET-anchored, and the live base/out state is a pure
// read-only mapping of server-stamped gameState that is all-null when absent —
// the client never derives game state itself (Hard Rule #4 territory).

import {
  normalizeMlbGameChip,
  formatMlbDisplayStatus,
  formatMlbDisplayInning,
  deriveBestPlay,
  deriveAllPlayerPlays,
  type GameLike,
  type SignalLike,
} from "@/lib/mlb/mlbNormalizers";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function game(p: Partial<GameLike>): GameLike {
  return { gameId: "g1", awayAbbr: "NYY", homeAbbr: "BOS", ...p };
}

console.log("\n=== MLB Game Chip Normalizers — Invariant Suite ===\n");

// ── 1. Pregame scores stay null (no fake 0-0) ───────────────────────────────
console.log("pregame scores");
{
  const chip = normalizeMlbGameChip(game({ status: "pregame", awayScore: null, homeScore: null }));
  assert("pregame awayScore is null", chip.awayScore === null);
  assert("pregame homeScore is null", chip.homeScore === null);
  assert("pregame isPregame flag", chip.isPregame && !chip.isLive && !chip.isFinal);

  const live = normalizeMlbGameChip(game({ status: "live", awayScore: 3, homeScore: 2 }));
  assert("live scores pass through", live.awayScore === 3 && live.homeScore === 2);

  const zeroZero = normalizeMlbGameChip(game({ status: "live", awayScore: 0, homeScore: 0 }));
  assert("live 0-0 is a real score, not null", zeroZero.awayScore === 0 && zeroZero.homeScore === 0);
}

// ── 2. ET-anchored start time ───────────────────────────────────────────────
console.log("\nET start time");
{
  // 2026-07-01T23:10:00Z == 7:10 PM EDT.
  const status = formatMlbDisplayStatus(game({ status: "pregame", startTime: "2026-07-01T23:10:00Z" }));
  assert("start time renders in ET with suffix", status === "7:10 PM ET", `got "${status}"`);

  // Winter date (EST, UTC-5): 2026-01-15T00:05:00Z == 7:05 PM EST Jan 14.
  const est = formatMlbDisplayStatus(game({ status: "scheduled", startTime: "2026-01-15T00:05:00Z" }));
  assert("EST offset respected", est === "7:05 PM ET", `got "${est}"`);

  const noTime = formatMlbDisplayStatus(game({ status: "pregame", startTime: null }));
  assert("missing start time → Scheduled", noTime === "Scheduled");

  const badTime = formatMlbDisplayStatus(game({ status: "pregame", startTime: "not-a-date" }));
  assert("unparseable start time → Scheduled (no crash)", badTime === "Scheduled", `got "${badTime}"`);
}

// ── 3. gameState absent → all-null (no-op regression guarantee) ─────────────
console.log("\ngameState absent");
{
  const noState = normalizeMlbGameChip(game({ status: "live" }));
  assert("outs null without gameState", noState.outs === null);
  assert("runners null without gameState", noState.runners === null);
  assert("age null without gameState", noState.gameStateAgeMs === null);

  const nullState = normalizeMlbGameChip(game({ status: "live", gameState: null }));
  assert("outs null with gameState=null", nullState.outs === null && nullState.runners === null);

  const emptyState = normalizeMlbGameChip(game({ status: "live", gameState: {} }));
  assert("empty gameState → all-null", emptyState.outs === null && emptyState.runners === null && emptyState.gameStateAgeMs === null);
}

// ── 4. Runners + outs mapping ───────────────────────────────────────────────
console.log("\nrunners + outs");
{
  const chip = normalizeMlbGameChip(game({
    status: "live",
    gameState: { outs: 2, runnersOnBase: ["first", "third"] },
  }));
  assert("outs mapped", chip.outs === 2);
  assert("runners first+third", chip.runners?.first === true && chip.runners?.second === false && chip.runners?.third === true);

  const empty = normalizeMlbGameChip(game({ status: "live", gameState: { outs: 0, runnersOnBase: [] } }));
  assert("bases empty maps to all-false", empty.runners?.first === false && empty.runners?.second === false && empty.runners?.third === false);
  assert("0 outs is valid", empty.outs === 0);

  const badOuts = normalizeMlbGameChip(game({ status: "live", gameState: { outs: 3, runnersOnBase: [] } }));
  assert("outs=3 rejected (mid-flip artifact)", badOuts.outs === null);
  const negOuts = normalizeMlbGameChip(game({ status: "live", gameState: { outs: -1, runnersOnBase: [] } }));
  assert("negative outs rejected", negOuts.outs === null);

  // Not live → base/out state suppressed even if present (stale cache row).
  const pregameWithState = normalizeMlbGameChip(game({
    status: "pregame",
    gameState: { outs: 1, runnersOnBase: ["second"] },
  }));
  assert("pregame suppresses outs/runners", pregameWithState.outs === null && pregameWithState.runners === null);
  const finalWithState = normalizeMlbGameChip(game({
    status: "final",
    gameState: { outs: 2, runnersOnBase: ["first"] },
  }));
  assert("final suppresses outs/runners", finalWithState.outs === null && finalWithState.runners === null);
}

// ── 5. Freshness: ageMs preferred over stampedAt ────────────────────────────
console.log("\nfreshness");
{
  const withAge = normalizeMlbGameChip(game({
    status: "live",
    gameState: { outs: 1, runnersOnBase: [], ageMs: 12_000, stampedAt: Date.now() - 500_000 },
  }));
  assert("server ageMs preferred", withAge.gameStateAgeMs === 12_000);

  const stampedOnly = normalizeMlbGameChip(game({
    status: "live",
    gameState: { outs: 1, runnersOnBase: [], stampedAt: Date.now() - 30_000 },
  }));
  assert(
    "stampedAt fallback ≈ 30s",
    stampedOnly.gameStateAgeMs !== null && stampedOnly.gameStateAgeMs >= 29_000 && stampedOnly.gameStateAgeMs <= 35_000,
    `got ${stampedOnly.gameStateAgeMs}`,
  );

  const futureStamp = normalizeMlbGameChip(game({
    status: "live",
    gameState: { outs: 1, runnersOnBase: [], stampedAt: Date.now() + 60_000 },
  }));
  assert("future stampedAt clamps to 0 (clock skew)", futureStamp.gameStateAgeMs === 0);

  const negAge = normalizeMlbGameChip(game({
    status: "live",
    gameState: { outs: 1, runnersOnBase: [], ageMs: -5 },
  }));
  assert("negative ageMs ignored → null (no stampedAt)", negAge.gameStateAgeMs === null);
}

// ── 6. Inning display fallback unchanged ────────────────────────────────────
console.log("\ninning display");
{
  assert("live inning 0 → Live", formatMlbDisplayInning(game({ status: "live", inning: 0 })) === "Live");
  assert("live inning null → Live", formatMlbDisplayInning(game({ status: "live", inning: null })) === "Live");
  assert("top 7 → ▲7", formatMlbDisplayInning(game({ status: "live", inning: 7, isTopInning: true })) === "▲7");
  assert("bottom 9 → ▼9", formatMlbDisplayInning(game({ status: "live", inning: 9, isTopInning: false })) === "▼9");
  assert("final → Final", formatMlbDisplayInning(game({ status: "final" })) === "Final");
  assert("pregame → empty", formatMlbDisplayInning(game({ status: "pregame" })) === "");
}

// ── 7. deriveBestPlay / deriveAllPlayerPlays — CURRENT enginePct-tier characterization ──
// These two functions derive their 3-bucket confidenceTier ("strong"/"building"/
// "monitor"/null) from raw enginePct thresholds (75/65/55), NOT from the
// server-stamped signalTier/confidenceTier fields also present on SignalLike —
// unlike the sibling deriveMlbRibbonChipSignal above, which reads signalTier
// exclusively. This is a known, documented vocabulary mismatch (see
// docs/architecture/TECH_DEBT_REMAINING.md — "MLB Client Normalizer Contract
// Convergence" follow-up) and is INTENTIONALLY left unconverged on this branch.
// This suite pins the CURRENT behavior as a regression guard so the follow-up
// branch has a precise before/after diff to work against, and so no other
// change accidentally alters this mapping in the meantime.
console.log("\nderiveBestPlay / deriveAllPlayerPlays — enginePct-tier characterization");
{
  function sig(p: Partial<SignalLike> & { playerId: string }): SignalLike {
    return { enginePct: 0, recommendedSide: "OVER", market: "hits", signalScore: 0, ...p };
  }

  // 7a. Threshold boundaries, driven by enginePct alone.
  const strong = deriveBestPlay([sig({ playerId: "p1", enginePct: 75, signalScore: 10 })], "p1");
  assert("enginePct=75 → strong (boundary, inclusive)", strong?.confidenceTier === "strong");

  const building = deriveBestPlay([sig({ playerId: "p1", enginePct: 65, signalScore: 10 })], "p1");
  assert("enginePct=65 → building (boundary, inclusive)", building?.confidenceTier === "building");

  const monitor = deriveBestPlay([sig({ playerId: "p1", enginePct: 55, signalScore: 10 })], "p1");
  assert("enginePct=55 → monitor (boundary, inclusive)", monitor?.confidenceTier === "monitor");

  const belowFloor = deriveBestPlay([sig({ playerId: "p1", enginePct: 54, signalScore: 10 })], "p1");
  assert("enginePct=54 → null (below monitor floor)", belowFloor?.confidenceTier === null);

  // 7b. CURRENT known gap: a server-stamped elite signalTier/confidenceTier is
  // ignored entirely when enginePct is low — this is the exact mismatch the
  // follow-up (MLB Client Normalizer Contract Convergence) is queued to fix.
  const ignoresServerTier = deriveBestPlay(
    [sig({ playerId: "p1", enginePct: 40, signalScore: 10, confidenceTier: "ELITE" })],
    "p1",
  );
  assert(
    "CURRENT: high server confidenceTier does not override a low enginePct-derived tier",
    ignoresServerTier?.confidenceTier === null,
    `got ${JSON.stringify(ignoresServerTier?.confidenceTier)} (expected null under CURRENT unconverged behavior)`,
  );

  // 7c. Best-of pool selection is by signalScore, not enginePct.
  const byScore = deriveBestPlay(
    [
      sig({ playerId: "p1", enginePct: 90, signalScore: 1, market: "hits" }),
      sig({ playerId: "p1", enginePct: 60, signalScore: 99, market: "total_bases" }),
    ],
    "p1",
  );
  assert("best play picked by signalScore, not enginePct", byScore?.market === "total_bases");

  // 7d. alreadyHit signals are excluded from the primary pool but used as a
  // fallback when no active signal exists.
  const excludesAlreadyHit = deriveBestPlay(
    [
      sig({ playerId: "p1", enginePct: 80, signalScore: 5, alreadyHit: true, market: "hits" }),
      sig({ playerId: "p1", enginePct: 70, signalScore: 1, alreadyHit: false, market: "total_bases" }),
    ],
    "p1",
  );
  assert("active (non-alreadyHit) signal preferred over a higher-score alreadyHit one", excludesAlreadyHit?.market === "total_bases");

  const fallsBackToAlreadyHit = deriveBestPlay(
    [sig({ playerId: "p1", enginePct: 80, signalScore: 5, alreadyHit: true, market: "hits" })],
    "p1",
  );
  assert("falls back to alreadyHit signal when no active signal exists", fallsBackToAlreadyHit?.market === "hits");

  assert("null when no signals for playerId at all", deriveBestPlay([sig({ playerId: "other", enginePct: 90 })], "p1") === null);

  // 7e. deriveAllPlayerPlays applies the identical per-item tier mapping,
  // sorted by signalScore descending.
  const all = deriveAllPlayerPlays(
    [
      sig({ playerId: "p1", enginePct: 55, signalScore: 1, market: "hits" }),
      sig({ playerId: "p1", enginePct: 75, signalScore: 2, market: "total_bases" }),
    ],
    "p1",
  );
  assert("deriveAllPlayerPlays sorts by signalScore desc", all.map(p => p.market).join(",") === "total_bases,hits");
  assert("deriveAllPlayerPlays applies the same enginePct thresholds", all[0].confidenceTier === "strong" && all[1].confidenceTier === "monitor");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
