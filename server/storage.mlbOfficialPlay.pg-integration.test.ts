/**
 * MLB Live Edge Trust Recovery — REAL POSTGRES integration test for
 * storage.ts's recordMlbOfficialPlay atomic-insert path.
 *
 * This is NOT a mocked-IStorage test — it opens a real connection (via
 * DATABASE_URL) and exercises the actual INSERT ... ON CONFLICT DO NOTHING
 * SQL, the actual UNIQUE constraint on official_episode_key, and the actual
 * settlePlay UPDATE.
 *
 * Requires a real, reachable Postgres with the current shared/schema.ts
 * schema applied (e.g. via `drizzle-kit push`). Run with:
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname \
 *     npx tsx server/storage.mlbOfficialPlay.pg-integration.test.ts
 *
 * Proves:
 *   1. Two concurrent insert attempts for one episode create exactly one row.
 *   2. The losing writer's returned id/isDuplicate reflects the actual
 *      winning row, never its own uninserted candidate.
 *   3. Opposite-side contention produces no second row (flipBlocked path).
 *   4. Same-side higher-score re-entry does not mutate the frozen snapshot.
 *   5. A matching legacy null-key MLB row prevents a second episode.
 *   6. The winning row's fields belong entirely to one writer — never a
 *      hybrid of two concurrent payloads.
 *   7. Grading (settlePlay) touches only result/finalStat/settledAt.
 *   8. NBA's upsert-on-higher-score path is unchanged.
 */

if (!process.env.DATABASE_URL) {
  console.error("SKIPPED — DATABASE_URL not set. This test requires a real reachable Postgres instance.");
  console.error("Run: DATABASE_URL=postgres://user:pass@host:5432/db npx tsx server/storage.mlbOfficialPlay.pg-integration.test.ts");
  process.exit(1);
}

import { storage } from "./storage";
import { db, pool } from "./db";
import { persistedPlays } from "@shared/schema";
import { eq, like } from "drizzle-orm";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
}

const RUN_TAG = `pgtest${Date.now()}`;

function mlbPlay(overrides: Record<string, any> = {}) {
  return {
    id: `${RUN_TAG}-${Math.random().toString(36).slice(2, 10)}`,
    gameId: `${RUN_TAG}-g1`,
    playerId: `${RUN_TAG}-p1`,
    playerName: "Integration Test Player",
    team: "NYY",
    sport: "mlb",
    market: "hits",
    direction: "over",
    line: 1.5,
    prob: 62,
    sportsbook: "draftkings",
    derivedLine: false,
    gameDate: "2026-07-30",
    timestamp: new Date(),
    duplicateGuard: `${RUN_TAG}-dupguard-${Math.random()}`,
    signalScore: 50,
    confidenceTier: "STRONG",
    officialEpisodeKey: `mlb:v1:${RUN_TAG}-g1:${RUN_TAG}-p1:hits`,
    oddsSourceUpdatedAt: Date.now(),
    oddsFetchedAt: Date.now(),
    rawProbability: 58,
    officialEligibilityVersion: "mlb_official_eligibility_v1",
    officialEligibilityReasons: undefined,
    dataQuality: "full",
    currentStatKnown: true,
    calibrationVersion: "cal-v1",
    ...overrides,
  };
}

async function cleanup() {
  await db.delete(persistedPlays).where(like(persistedPlays.id, `${RUN_TAG}%`));
}

async function rowsForEpisode(episodeKey: string) {
  return db.select().from(persistedPlays).where(eq(persistedPlays.officialEpisodeKey, episodeKey));
}

async function run() {
  await cleanup();

  // ── Test 1 + 2 + 6: concurrent inserts for one episode ──────────────────
  {
    const episodeKey = `mlb:v1:${RUN_TAG}-gconcurrent:${RUN_TAG}-pconcurrent:hits`;
    const playA = mlbPlay({
      id: `${RUN_TAG}-A`,
      gameId: `${RUN_TAG}-gconcurrent`,
      playerId: `${RUN_TAG}-pconcurrent`,
      officialEpisodeKey: episodeKey,
      duplicateGuard: `${RUN_TAG}-dupA`,
      odds: -150,
      rawProbability: 11.11,
    });
    const playB = mlbPlay({
      id: `${RUN_TAG}-B`,
      gameId: `${RUN_TAG}-gconcurrent`,
      playerId: `${RUN_TAG}-pconcurrent`,
      officialEpisodeKey: episodeKey,
      duplicateGuard: `${RUN_TAG}-dupB`,
      odds: -999,
      rawProbability: 22.22,
    });

    const [resultA, resultB] = await Promise.all([
      storage.recordPlay(playA as any),
      storage.recordPlay(playB as any),
    ]);

    const rows = await rowsForEpisode(episodeKey);
    check("1.1 exactly one row exists for the contested episode after concurrent inserts", rows.length === 1, rows.map(r => r.id));

    const winnerId = rows[0]?.id;
    const oneIsDuplicate = resultA.isDuplicate !== resultB.isDuplicate;
    check("1.2 exactly one writer reports isDuplicate:false (won) and the other true (lost)", oneIsDuplicate, { resultA, resultB });

    const winningResult = resultA.isDuplicate ? resultB : resultA;
    const losingResult = resultA.isDuplicate ? resultA : resultB;
    check("2.1 the losing writer's returned id equals the ACTUAL winning row's id, not its own candidate id", losingResult.id === winnerId, { losingResultId: losingResult.id, winnerId });
    check("2.2 the winning writer's returned id also equals the actual row id", winningResult.id === winnerId);

    // ── Test 6: winning row is entirely one writer's payload, never hybrid ──
    const winningRow = rows[0];
    const wasA = winningRow.id === playA.id;
    const expectedOdds = wasA ? -150 : -999;
    const expectedRawProb = wasA ? "11.11" : "22.22";
    check("6.1 winning row's odds belongs entirely to one writer (never blended)", Number(winningRow.odds) === expectedOdds, winningRow.odds);
    check("6.2 winning row's rawProbability belongs entirely to the same writer", winningRow.rawProbability === expectedRawProb, winningRow.rawProbability);
  }

  // ── Test 3: opposite-side contention → flipBlocked, no second row ───────
  {
    const gameId = `${RUN_TAG}-gflip`;
    const playerId = `${RUN_TAG}-pflip`;
    const episodeKey = `mlb:v1:${gameId}:${playerId}:hits`;

    const overResult = await storage.recordPlay(mlbPlay({
      id: `${RUN_TAG}-flipOver`,
      gameId, playerId, officialEpisodeKey: episodeKey,
      direction: "over",
      duplicateGuard: `${RUN_TAG}-flipdup1`,
    }) as any);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); origLog(...args); };
    const underResult = await storage.recordPlay(mlbPlay({
      id: `${RUN_TAG}-flipUnder`,
      gameId, playerId, officialEpisodeKey: episodeKey,
      direction: "under",
      duplicateGuard: `${RUN_TAG}-flipdup2`,
    }) as any);
    console.log = origLog;

    const rows = await rowsForEpisode(episodeKey);
    check("3.1 opposite-side re-entry produces no second row", rows.length === 1, rows.map(r => ({ id: r.id, direction: r.direction })));
    check("3.2 the surviving row keeps the FIRST writer's direction (over)", rows[0]?.direction === "over", rows[0]?.direction);
    check("3.3 opposite-side re-entry is reported as a duplicate", underResult.isDuplicate === true);
    check("3.4 flipBlocked:true was logged for the opposite-side conflict", logs.some(l => l.includes("flipBlocked") && l.includes("true")), logs.filter(l => l.includes("MLB_OFFICIAL_EPISODE_DUPLICATE")));
  }

  // ── Test 4: same-side higher-score re-entry does not mutate ─────────────
  {
    const gameId = `${RUN_TAG}-gscore`;
    const playerId = `${RUN_TAG}-pscore`;
    const episodeKey = `mlb:v1:${gameId}:${playerId}:hits`;

    await storage.recordPlay(mlbPlay({
      id: `${RUN_TAG}-scoreLow`,
      gameId, playerId, officialEpisodeKey: episodeKey,
      signalScore: 40,
      line: 1.5,
      duplicateGuard: `${RUN_TAG}-scoredup1`,
    }) as any);

    await storage.recordPlay(mlbPlay({
      id: `${RUN_TAG}-scoreHigh`,
      gameId, playerId, officialEpisodeKey: episodeKey,
      signalScore: 95,
      line: 3.5, // deliberately different so a mutation would be obvious
      duplicateGuard: `${RUN_TAG}-scoredup2`,
    }) as any);

    const rows = await rowsForEpisode(episodeKey);
    check("4.1 still exactly one row after a higher-score same-side re-entry", rows.length === 1);
    check("4.2 signalScore is frozen at the FIRST writer's value (40), never bumped to 95", Number(rows[0]?.signalScore) === 40, rows[0]?.signalScore);
    check("4.3 line is frozen at the first writer's value (1.5), never overwritten to 3.5", Number(rows[0]?.line) === 1.5, rows[0]?.line);
  }

  // ── Test 5: legacy null-key row prevents a second episode ───────────────
  {
    const gameId = `${RUN_TAG}-glegacy`;
    const playerId = `${RUN_TAG}-plegacy`;
    const legacyId = `${RUN_TAG}-legacyRow`;

    // Simulate a pre-recovery row: same game+player+market, but no
    // officialEpisodeKey (as every MLB row looked before this recovery).
    await db.insert(persistedPlays).values({
      id: legacyId,
      gameId, playerId,
      playerName: "Legacy Player",
      sport: "mlb",
      market: "hits",
      direction: "over",
      line: "1.5",
      prob: "55",
      gameDate: "2026-07-01",
      timestamp: new Date(),
      duplicateGuard: `${RUN_TAG}-legacydup`,
      officialEpisodeKey: null,
    });

    const newEpisodeKey = `mlb:v1:${gameId}:${playerId}:hits`;
    const result = await storage.recordPlay(mlbPlay({
      id: `${RUN_TAG}-newAttempt`,
      gameId, playerId, officialEpisodeKey: newEpisodeKey,
      duplicateGuard: `${RUN_TAG}-newattemptdup`,
    }) as any);

    const allRowsForGamePlayerMarket = await db.select().from(persistedPlays)
      .where(eq(persistedPlays.gameId, gameId));

    check("5.1 no second row created — legacy row is recognized as the existing episode", allRowsForGamePlayerMarket.length === 1, allRowsForGamePlayerMarket.map(r => r.id));
    check("5.2 recordPlay returns the LEGACY row's id, not a new candidate id", result.id === legacyId, result);
    check("5.3 recordPlay reports isDuplicate:true against the legacy row", result.isDuplicate === true);
  }

  // ── Test 7: grading touches only settlement fields ───────────────────────
  {
    const gameId = `${RUN_TAG}-ggrade`;
    const playerId = `${RUN_TAG}-pgrade`;
    const episodeKey = `mlb:v1:${gameId}:${playerId}:hits`;

    const insertResult = await storage.recordPlay(mlbPlay({
      id: `${RUN_TAG}-gradeRow`,
      gameId, playerId, officialEpisodeKey: episodeKey,
      duplicateGuard: `${RUN_TAG}-gradedup`,
      odds: -110,
      line: 1.5,
      prob: 62,
    }) as any);

    const before = (await db.select().from(persistedPlays).where(eq(persistedPlays.id, insertResult.id)))[0];
    await storage.settlePlay(insertResult.id, "hit", 3, new Date());
    const after = (await db.select().from(persistedPlays).where(eq(persistedPlays.id, insertResult.id)))[0];

    check("7.1 result updated by settlePlay", after.result === "hit");
    check("7.2 finalStat updated by settlePlay", Number(after.finalStat) === 3);
    check("7.3 settledAt updated by settlePlay", after.settledAt != null);
    check("7.4 line untouched by settlement", after.line === before.line, { before: before.line, after: after.line });
    check("7.5 prob untouched by settlement", after.prob === before.prob);
    check("7.6 odds untouched by settlement", after.odds === before.odds);
    check("7.7 officialEpisodeKey untouched by settlement", after.officialEpisodeKey === before.officialEpisodeKey);
    check("7.8 firstPublicAt untouched by settlement", String(after.firstPublicAt) === String(before.firstPublicAt));
    check("7.9 signalScore untouched by settlement", after.signalScore === before.signalScore);
  }

  // ── Test 8: NBA upsert-on-higher-score path is unchanged ────────────────
  {
    const nbaDupGuard = `${RUN_TAG}-nbadup`;
    const nbaPlay = (overrides: Record<string, any>) => ({
      id: `${RUN_TAG}-nba-${Math.random().toString(36).slice(2, 8)}`,
      gameId: `${RUN_TAG}-gnba`,
      playerId: `${RUN_TAG}-pnba`,
      playerName: "NBA Test Player",
      sport: "nba",
      market: "points",
      direction: "over",
      line: 20.5,
      prob: 55,
      sportsbook: "draftkings",
      derivedLine: false,
      gameDate: "2026-07-30",
      timestamp: new Date(),
      duplicateGuard: nbaDupGuard,
      signalScore: 40,
      // NBA never sets officialEpisodeKey — the MLB atomic path must not trigger.
      ...overrides,
    });

    const first = await storage.recordPlay(nbaPlay({ signalScore: 40, line: 20.5 }) as any);
    check("8.1 NBA first insert succeeds (isDuplicate:false)", first.isDuplicate === false);

    const second = await storage.recordPlay(nbaPlay({ signalScore: 90, line: 25.5 }) as any);
    check("8.2 NBA second call with higher signalScore reports isDuplicate:true (upsert path)", second.isDuplicate === true);
    check("8.3 NBA second call resolves to the SAME row id (duplicateGuard-keyed)", second.id === first.id);

    const nbaRow = (await db.select().from(persistedPlays).where(eq(persistedPlays.id, first.id)))[0];
    check("8.4 NBA row's signalScore WAS updated to the higher value (mutable, unlike MLB)", Number(nbaRow.signalScore) === 90, nbaRow.signalScore);
    check("8.5 NBA row's line WAS updated (mutable upsert, unlike MLB)", Number(nbaRow.line) === 25.5, nbaRow.line);
    check("8.6 NBA row never received an officialEpisodeKey", nbaRow.officialEpisodeKey === null);
  }

  await cleanup();
  await pool.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(async (err) => {
  console.error("INTEGRATION TEST CRASHED:", err);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});
