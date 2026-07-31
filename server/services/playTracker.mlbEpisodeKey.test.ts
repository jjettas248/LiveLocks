/**
 * MLB Live Edge Trust Recovery (Phase 4) — playTracker episode-key regression
 *
 * Verifies trackPlay()'s MLB-specific behavior added by this recovery:
 *   - officialEpisodeKey is computed as `mlb:v1:${gameId}:${playerId}:${market}`
 *     and forwarded to storage.recordPlay — never falling back to playerName.
 *   - A signal with no stable playerId is rejected outright for MLB (no
 *     officialEpisodeKey fallback).
 *   - Provenance fields (oddsSourceUpdatedAt, oddsFetchedAt, rawProbability,
 *     officialEligibilityVersion/Reasons, dataQuality, currentStatKnown,
 *     calibrationVersion) are threaded through to storage.recordPlay.
 *   - NBA/NCAAB signals never get an officialEpisodeKey (byte-identical to
 *     pre-recovery behavior).
 *
 * This test uses a hand-built IStorage mock (matching the existing repo
 * convention in server/services/gradeBacklogDrain.test.ts) rather than a
 * real Postgres instance — storage.ts's actual atomic INSERT/ON CONFLICT
 * SQL behavior cannot be exercised without a live database and is NOT
 * covered here (see CLAUDE.md test list / final report for that limitation).
 *
 * Run with: npx tsx server/services/playTracker.mlbEpisodeKey.test.ts
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/testdb";

import { trackPlay, type TrackableSignal } from "./playTracker";
import type { IStorage } from "../storage";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
}

let capturedRecordPlayArg: any = null;
const mockStorage = {
  recordPlay: async (play: any) => {
    capturedRecordPlayArg = play;
    return { id: play.id, isDuplicate: false };
  },
} as unknown as IStorage;

function baseSignal(overrides: Partial<TrackableSignal> = {}): TrackableSignal {
  return {
    gameId: "game-1",
    playerId: "player-123",
    playerName: "Test Player",
    team: "NYY",
    sport: "mlb",
    market: "hits",
    direction: "over",
    line: 1.5,
    projection: 2.0,
    probability: 62,
    edge: 5,
    sportsbook: "draftkings",
    derivedLine: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function run() {
  // ── officialEpisodeKey format ────────────────────────────────────────────
  {
    capturedRecordPlayArg = null;
    await trackPlay(baseSignal(), mockStorage);
    check(
      "episode key format is mlb:v1:${gameId}:${playerId}:${market}",
      capturedRecordPlayArg?.officialEpisodeKey === "mlb:v1:game-1:player-123:hits",
      capturedRecordPlayArg?.officialEpisodeKey
    );
  }

  // ── missing playerId rejected outright, no playerName fallback ──────────
  {
    capturedRecordPlayArg = null;
    const result = await trackPlay(baseSignal({ playerId: null }), mockStorage);
    check("missing playerId rejects MLB persistence", result.isDuplicate === true && result.id === "");
    check("missing playerId — storage.recordPlay never called", capturedRecordPlayArg === null);
  }

  // ── side flip produces the SAME episode key (not a new one) ─────────────
  {
    capturedRecordPlayArg = null;
    await trackPlay(baseSignal({ direction: "over" }), mockStorage);
    const overKey = capturedRecordPlayArg?.officialEpisodeKey;
    capturedRecordPlayArg = null;
    await trackPlay(baseSignal({ direction: "under" }), mockStorage);
    const underKey = capturedRecordPlayArg?.officialEpisodeKey;
    check("side flip (over vs under) maps to the identical episode key", overKey === underKey && overKey === "mlb:v1:game-1:player-123:hits", { overKey, underKey });
  }

  // ── provenance fields threaded through ───────────────────────────────────
  {
    capturedRecordPlayArg = null;
    const oddsSourceUpdatedAt = Date.now() - 5000;
    const oddsFetchedAt = Date.now();
    await trackPlay(baseSignal({
      oddsSourceUpdatedAt,
      oddsFetchedAt,
      rawProbability: 58.5,
      officialEligibilityVersion: "mlb_official_eligibility_v1",
      officialEligibilityReasons: [],
      dataQuality: "full",
      currentStatKnown: true,
      calibrationVersion: "mlb_calibration_v3",
    }), mockStorage);
    check("oddsSourceUpdatedAt forwarded verbatim (never fetchedAt)", capturedRecordPlayArg?.oddsSourceUpdatedAt === oddsSourceUpdatedAt);
    check("oddsFetchedAt forwarded verbatim and distinct from source time", capturedRecordPlayArg?.oddsFetchedAt === oddsFetchedAt && capturedRecordPlayArg?.oddsFetchedAt !== capturedRecordPlayArg?.oddsSourceUpdatedAt);
    check("rawProbability forwarded", capturedRecordPlayArg?.rawProbability === 58.5);
    check("dataQuality forwarded", capturedRecordPlayArg?.dataQuality === "full");
    check("currentStatKnown forwarded", capturedRecordPlayArg?.currentStatKnown === true);
    check("calibrationVersion forwarded", capturedRecordPlayArg?.calibrationVersion === "mlb_calibration_v3");
  }

  // ── NBA/NCAAB never get an officialEpisodeKey ────────────────────────────
  {
    capturedRecordPlayArg = null;
    await trackPlay(baseSignal({ sport: "nba", direction: "over" }), mockStorage);
    check("NBA signal gets no officialEpisodeKey", capturedRecordPlayArg?.officialEpisodeKey === undefined, capturedRecordPlayArg?.officialEpisodeKey);

    capturedRecordPlayArg = null;
    await trackPlay(baseSignal({ sport: "ncaab", direction: "over" }), mockStorage);
    check("NCAAB signal gets no officialEpisodeKey", capturedRecordPlayArg?.officialEpisodeKey === undefined, capturedRecordPlayArg?.officialEpisodeKey);
  }

  // ── stale fetch time never substitutes for missing source time ──────────
  {
    capturedRecordPlayArg = null;
    await trackPlay(baseSignal({ oddsSourceUpdatedAt: null, oddsFetchedAt: Date.now() }), mockStorage);
    check("oddsFetchedAt present does not backfill a null oddsSourceUpdatedAt", capturedRecordPlayArg?.oddsSourceUpdatedAt == null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
