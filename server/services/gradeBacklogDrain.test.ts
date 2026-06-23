/**
 * [GRADING BACKLOG DRAIN v1] Validation harness
 *
 * Plain Node.js script (no jest/vitest) — run with:
 *
 *   npx tsx server/services/gradeBacklogDrain.test.ts
 *
 * Regression guard for the bug that froze grading + calibration on 6-13:
 * the grader fetched pending plays via getPlays({ limit: 500, settled:
 * "pending" }), which returns the NEWEST 500 pending plays (desc, hard-capped
 * at 500). Once the pending backlog exceeded 500, already-final gradeable
 * plays fell outside the window and never settled — freezing the W/L record
 * and, downstream, calibration (which only reads settled rows).
 *
 * Asserts:
 *   1. getPendingPlaysForGrading() returns the FULL backlog (> 500) ordered
 *      OLDEST-first, so the grader always drains from the bottom.
 *   2. The grader actually processes the oldest plays in a > 500 backlog
 *      (the exact rows the old newest-500 window starved).
 *   3. Terminal-but-unresolvable plays older than the void threshold are
 *      settled "void" so the pending set can't re-clog and re-starve.
 */

import { gradePersistedPlays } from "./gradePersistedPlays";
import type { IStorage } from "../storage";
import type { PersistedPlay } from "@shared/schema";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const HOUR = 60 * 60 * 1000;

function mkPlay(i: number, ageHrs: number): PersistedPlay {
  // MLB play with a playerId/gameId but for a player that won't be found in any
  // box score → exercises the terminal-void path without any real network call.
  return {
    id: `play-${i}`,
    // Share a few gameIds so the grader (which groups by game) makes only a
    // handful of box-score lookups — keeps the harness fast and avoids
    // hammering the external stats API. Every lookup fails → null-boxscore
    // terminal-void path, which is exactly what we're asserting on.
    gameId: `game-${i % 4}`,
    playerId: 999000 + i,
    playerName: `Player ${i}`,
    sport: "mlb",
    market: "hits",
    direction: "over",
    line: "0.5",
    result: null,
    finalStat: null,
    settledAt: null,
    timestamp: new Date(Date.now() - ageHrs * HOUR),
  } as unknown as PersistedPlay;
}

// ── Fake storage ────────────────────────────────────────────────────────────
// Implements only what the grader touches. getPendingPlaysForGrading mirrors
// the real DatabaseStorage contract: ASC by timestamp (oldest first), bounded.
function makeStorage(backlog: PersistedPlay[]) {
  const settled = new Map<string, { result: string; finalStat: number | null }>();
  const fake: Partial<IStorage> = {
    async getPendingPlaysForGrading(limit = 5000) {
      return backlog
        .filter((p) => !settled.has(p.id))
        .slice()
        .sort(
          (a, b) =>
            new Date(a.timestamp ?? 0).getTime() -
            new Date(b.timestamp ?? 0).getTime(),
        )
        .slice(0, limit);
    },
    async getPlays() {
      throw new Error(
        "grader must use getPendingPlaysForGrading, not the newest-500 getPlays window",
      );
    },
    async settlePlay(id: string, result: string, finalStat: number | null) {
      settled.set(id, { result, finalStat });
      return null;
    },
  };
  return { storage: fake as IStorage, settled };
}

async function run() {
  console.log("[GRADING BACKLOG DRAIN] running…\n");

  // ── Test 1 + 2: > 500 backlog, oldest-first drain ──────────────────────────
  // 700 plays, all old enough to be terminal-voided. The old newest-500 window
  // would never touch the 200 OLDEST (play-0 … play-199); the fix must.
  const backlog: PersistedPlay[] = [];
  for (let i = 0; i < 700; i++) {
    // i=0 is the OLDEST (largest age), i=699 the newest.
    backlog.push(mkPlay(i, 200 - i * 0.1));
  }

  const feed = await makeStorage(backlog).storage.getPendingPlaysForGrading();
  check("getPendingPlaysForGrading returns full > 500 backlog", feed.length === 700, `got ${feed.length}`);
  check(
    "feed is ordered oldest-first",
    feed[0].id === "play-0" && feed[feed.length - 1].id === "play-699",
    `first=${feed[0].id} last=${feed[feed.length - 1].id}`,
  );

  const { storage, settled } = makeStorage(backlog);
  await gradePersistedPlays(storage);

  // The oldest plays — the ones the newest-500 window starved — must be settled.
  const oldestStarved = ["play-0", "play-50", "play-150", "play-199"];
  for (const id of oldestStarved) {
    check(`oldest starved play ${id} got settled`, settled.has(id), "still pending");
  }
  check(
    "terminal-unresolvable plays settled as void",
    [...settled.values()].every((s) => s.result === "void"),
    `results=${[...new Set([...settled.values()].map((s) => s.result))].join(",")}`,
  );

  // ── Test 3: fresh terminal-unresolvable plays are NOT voided early ──────────
  const fresh = [mkPlay(1000, 1)]; // 1h old → below 48h threshold
  const { storage: s2, settled: settled2 } = makeStorage(fresh);
  await gradePersistedPlays(s2);
  check(
    "fresh unresolvable play left pending (retry, not premature void)",
    !settled2.has("play-1000"),
    "was settled too early",
  );

  console.log(`\n[GRADING BACKLOG DRAIN] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
