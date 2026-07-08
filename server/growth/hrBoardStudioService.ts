// ─────────────────────────────────────────────────────────────────────────────
// HR Board Studio — service layer (live data gatherers)
//
// Reads existing engine output (Pre-Game HR Power Board snapshot + canonical HR
// Radar state + outcome stamps) and feeds the PURE builders in
// `hrBoardStudioCore.ts`. The heavy imports (pregame-radar service → DB) live
// here, NOT in the core, so the test suite can exercise the builders fixture-only.
//
// HARD CONSTRAINTS:
//   • Does NOT change HR Radar scoring math or MLB probability logic.
//   • Does NOT recompute projections/confidence — reads server-stamped fields.
//   • Does NOT mutate the snapshot, the canonical store, the bus, or lifecycle.
// ─────────────────────────────────────────────────────────────────────────────

import { todayET } from "../utils/dateUtils";
import { storage } from "../storage";
import {
  peekRadarSnapshot,
  getRadarSnapshot,
} from "../mlb/pregamePowerRadar/pregamePowerRadarService";
import { allSignals as allPregameSignals } from "../mlb/pregamePowerRadar/pregamePowerRadarStore";
import type { PregamePowerSignal } from "../mlb/pregamePowerRadar/types";
import {
  getAllCanonicalHrRadarStates,
  type CanonicalHrRadarState,
} from "../mlb/hrRadarCanonicalStore";
import {
  buildBoardRows,
  buildContentPack,
  buildMovementFeed,
  buildRecap,
  buildLiveBestContactsRows,
  type ContentPackOptions,
  type LiveHrRadarEntry,
} from "./hrBoardStudioCore";
import type {
  HrBoardContentPack,
  HrBoardRow,
  HrBoardTodayResponse,
  HrMovementRow,
  HrRecapResponse,
} from "../../shared/hrBoardStudio";

export {
  buildBoardRows,
  buildContentPack,
  buildMovementFeed,
  buildRecap,
} from "./hrBoardStudioCore";
export type { ContentPackOptions } from "./hrBoardStudioCore";

// ── Live data gatherers (read-only) ───────────────────────────────────────────

async function gatherPregameSignals(forceFresh: boolean): Promise<{
  signals: PregamePowerSignal[];
  source: HrBoardTodayResponse["source"];
}> {
  if (forceFresh) {
    const resolved = await getRadarSnapshot();
    const signals = resolved.snapshot ? Array.from(resolved.snapshot.signals.values()) : [];
    return { signals, source: resolved.source };
  }
  const snap = peekRadarSnapshot();
  if (snap) return { signals: Array.from(snap.signals.values()), source: "memory" };
  // Fall back to whatever the store holds (kicks a background rebuild).
  return { signals: allPregameSignals(), source: "memory" };
}

function gatherStatesForDate(date: string): CanonicalHrRadarState[] {
  // Canonical store is in-memory and session-scoped. Filter to the date when the
  // state carries one; otherwise include it (today's live slate).
  return getAllCanonicalHrRadarStates().filter(
    (s) => s.sessionDate == null || s.sessionDate === date,
  );
}

/** Live HR Radar Attack/Ready entries for `date`, mapped to the shared candidate shape. */
async function gatherLiveLadderEntries(date: string): Promise<LiveHrRadarEntry[]> {
  const ladder = await storage.getHrRadarLadder(date);
  const live = [...ladder.sections.attackNow, ...(ladder.sections.ready ?? [])];
  return live
    .filter((e) => e.isGameFinal !== true)
    .map((e) => ({
      playerId: e.playerId,
      gameId: e.gameId,
      playerName: e.playerName,
      team: e.team ?? null,
      userStage: e.userStage ?? null,
      currentReadinessScore: e.currentReadinessScore ?? null,
      confidenceTier: e.confidenceTier ?? null,
      headlineReason: e.headlineReason ?? null,
      userReasons: e.userReasons,
    }));
}

/** GET /live-best-contacts — today's top live Attack/Ready signals, ranked by composite score. */
export async function getLiveBestContacts(
  limit = 5,
): Promise<{ date: string; generatedAt: string; rows: HrBoardRow[] }> {
  const date = todayET();
  const entries = await gatherLiveLadderEntries(date);
  return {
    date,
    generatedAt: new Date().toISOString(),
    rows: buildLiveBestContactsRows(entries, limit),
  };
}

/** GET /today — ranked board rows for today's slate. */
export async function getTodayBoard(forceFresh = false): Promise<HrBoardTodayResponse> {
  const date = todayET();
  const { signals, source } = await gatherPregameSignals(forceFresh);
  const rows = buildBoardRows(signals);
  const byTier: Record<string, number> = {};
  for (const r of rows) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
  return {
    date,
    generatedAt: new Date().toISOString(),
    source,
    rows,
    counts: { total: rows.length, byTier },
  };
}

/** GET /movement-feed — live movement from the pre-game board. */
export async function getMovementFeed(): Promise<{
  date: string;
  generatedAt: string;
  movements: HrMovementRow[];
}> {
  const date = todayET();
  const { signals } = await gatherPregameSignals(false);
  const rows = buildBoardRows(signals);
  const states = gatherStatesForDate(date);
  return {
    date,
    generatedAt: new Date().toISOString(),
    movements: buildMovementFeed(rows, states),
  };
}

/** POST /generate-pack — today's content pack. */
export async function generateContentPack(opts: ContentPackOptions): Promise<HrBoardContentPack> {
  const date = todayET();
  const { signals } = await gatherPregameSignals(true);
  const rows = buildBoardRows(signals);
  const states = gatherStatesForDate(date);
  const movements = buildMovementFeed(rows, states);
  const liveEntries = await gatherLiveLadderEntries(date);
  const liveRows = buildLiveBestContactsRows(liveEntries);
  return buildContentPack(date, rows, movements, opts, liveRows);
}

/** POST /generate-recap — recap assets for `date` (defaults to today). */
export async function generateRecap(date?: string): Promise<HrRecapResponse> {
  const target = date ?? todayET();
  const { signals } = await gatherPregameSignals(false);
  const rows = buildBoardRows(signals);
  const states = gatherStatesForDate(target);
  const movements = buildMovementFeed(rows, states);
  return buildRecap(target, rows, movements);
}
