// HR Radar freshness overlay (2026-06)
// ─────────────────────────────────────────────────────────────────────────
// The /api/mlb/hr-radar/ladder endpoint serves DB rows (hrRadarAlerts) that
// are reconciled from the engine only every HR_RADAR_RECONCILE_MS (~20s),
// while the in-memory canonical store (hrRadarCanonicalStore) is updated on
// every state poll (~10s). So the DB ladder can lag the live engine by up to
// one reconcile interval — long enough to hide a just-promoted FIRE signal.
//
// This pure overlay reads the FRESHER source (the canonical store) and:
//   1. Re-buckets each LIVE row to the canonical section when it differs
//      (the canonical store is strictly fresher, so it wins for live rows).
//   2. Refreshes the row's userStage + live score from the canonical state.
//   3. Surfaces actionable (FIRE/READY) canonical rows that have no DB row yet
//      so a fresh signal is never hidden behind the reconcile lag.
//   4. Stamps freshness provenance (freshSource / freshAgeMs) for diagnostics.
//
// Invariants (mirrors CLAUDE.md §3.x):
//   • TERMINAL rows are never touched — cashed/dead come from the DB and are
//     authoritative. The overlay only ever moves rows WITHIN the live buckets.
//   • No engine math here. It re-buckets and copies already-computed values.
//   • Additive & no-op when the canonical store is empty (partial data safe).

import type { CanonicalHrRadarState } from "./hrRadarCanonicalStore";
import { buildHrRadarDisplayContract } from "./hrRadarDisplayContract";

type LadderEntry = Record<string, any> & { playerId: string; gameId: string };

export interface OverlayLadder {
  sections: {
    attackNow: LadderEntry[];
    ready: LadderEntry[];
    building: LadderEntry[];
    watch: LadderEntry[];
    cashed: LadderEntry[];
    dead: LadderEntry[];
  };
  counts?: Record<string, number>;
  [k: string]: unknown;
}

export interface OverlayDiagnostics {
  canonicalActive: number;   // active, non-terminal canonical rows considered
  rebucketed: number;        // live rows moved to a fresher canonical bucket
  scoreRefreshed: number;    // live rows whose score/stage was refreshed
  surfaced: number;          // actionable rows synthesized (no DB row yet)
  fireSurfaced: number;      // of which were FIRE
  maxLiveRowAgeMs: number | null;   // oldest canonical updatedAt age on a live row (engine→API lag)
  maxEvidenceAgeMs: number | null;  // oldest contact-evidence age (contact→API propagation)
}

// Live ladder buckets, in stage order.
const LIVE_BUCKETS = ["attackNow", "ready", "building", "watch"] as const;
type LiveBucket = (typeof LIVE_BUCKETS)[number];

// Canonical section → live ladder bucket. Terminal/inactive sections map to
// null (DB-authoritative; the overlay leaves them alone).
const SECTION_TO_BUCKET: Record<string, LiveBucket | null> = {
  FIRE: "attackNow",
  READY: "ready",
  BUILD: "building",
  WATCH: "watch",
  CASHED: null,
  MISSED: null,
  "MODEL REVIEW": null,
  EXPIRED: null,
  INACTIVE: null,
};

function keyOf(gameId: string | number, playerId: string | number): string {
  return `${gameId}_${playerId}`;
}

function ageMsOf(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

// Build a minimal live ladder entry from a canonical state. Only used for
// actionable (FIRE/READY) rows the DB hasn't persisted yet, so a fresh signal
// is visible immediately. All display-rich fields stay undefined (the client
// card treats them as optional); record-eligibility follows the FIRE-only
// official contract.
function synthesizeEntry(s: CanonicalHrRadarState, nowMs: number): LadderEntry {
  const isFire = s.section === "FIRE";
  return {
    playerId: String(s.playerId),
    playerName: s.playerName,
    team: s.team ?? "",
    gameId: String(s.gameId),
    currentStatus: "live",
    userStage: s.userStage,
    currentSignalScore10: s.displayScore10 ?? null,
    conversionProbability: null,
    detectedInning: s.detectedInning ?? null,
    currentInning: s.latestEvidenceInning ?? s.detectedInning ?? null,
    headlineReason: s.triggerReasons?.[0] ?? null,
    supportingReasons: s.triggerReasons ?? [],
    cleanReasons: s.triggerReasons ?? [],
    badges: [],
    // FIRE-only official record (2026-06).
    displayRecordEligible: isFire,
    officialSignalStage: isFire ? "fire" : null,
    // Freshness provenance — this row exists ONLY because the engine is ahead
    // of the DB reconcile.
    freshSource: "canonical_only",
    freshAgeMs: ageMsOf(s.updatedAt, nowMs) ?? 0,
    freshEvidenceAgeMs: ageMsOf(s.latestEvidenceAt, nowMs),
  };
}

/**
 * Overlay the fresher canonical-store state onto a DB-backed ladder. Mutates
 * and returns the same ladder object (live buckets only) plus diagnostics.
 * No-op for terminal buckets and when `canonicalStates` is empty.
 */
export function applyCanonicalFreshnessOverlay(
  ladder: OverlayLadder,
  canonicalStates: CanonicalHrRadarState[],
  nowMs: number,
): { ladder: OverlayLadder; diagnostics: OverlayDiagnostics } {
  const diagnostics: OverlayDiagnostics = {
    canonicalActive: 0,
    rebucketed: 0,
    scoreRefreshed: 0,
    surfaced: 0,
    fireSurfaced: 0,
    maxLiveRowAgeMs: null,
    maxEvidenceAgeMs: null,
  };

  // Index active, non-terminal canonical rows that map to a live bucket.
  const byKey = new Map<string, CanonicalHrRadarState>();
  for (const s of canonicalStates) {
    if (!s.active || s.terminal) continue;
    if (!SECTION_TO_BUCKET[s.section]) continue;
    byKey.set(keyOf(s.gameId, s.playerId), s);
    diagnostics.canonicalActive++;
  }

  // Re-bucket existing live rows. Canonical (fresher) wins when present;
  // otherwise the row stays where the DB put it.
  const next: Record<LiveBucket, LadderEntry[]> = {
    attackNow: [], ready: [], building: [], watch: [],
  };
  const seen = new Set<string>();
  for (const bucket of LIVE_BUCKETS) {
    const rows = ladder.sections[bucket] ?? [];
    for (const e of rows) {
      const key = keyOf(e.gameId, e.playerId);
      seen.add(key);
      const canon = byKey.get(key);
      let target: LiveBucket = bucket;
      if (canon) {
        const mapped = SECTION_TO_BUCKET[canon.section]!;
        if (mapped !== bucket) {
          target = mapped;
          diagnostics.rebucketed++;
        }
        e.userStage = canon.userStage;
        e.currentStatus = "live";
        if (canon.displayScore10 != null) {
          e.currentSignalScore10 = canon.displayScore10;
          e.displayCurrentScore10 = canon.displayScore10;
          diagnostics.scoreRefreshed++;
        }
        const age = ageMsOf(canon.updatedAt, nowMs);
        const evidenceAge = ageMsOf(canon.latestEvidenceAt, nowMs);
        e.freshSource = "canonical";
        e.freshAgeMs = age;
        e.freshEvidenceAgeMs = evidenceAge;
        if (age != null) diagnostics.maxLiveRowAgeMs = Math.max(diagnostics.maxLiveRowAgeMs ?? 0, age);
        if (evidenceAge != null) diagnostics.maxEvidenceAgeMs = Math.max(diagnostics.maxEvidenceAgeMs ?? 0, evidenceAge);
        // Re-stamp the display contract for the (possibly new) bucket so a
        // promoted row never carries stale stage label / actionability /
        // record-eligibility from its old DB bucket. FIRE-only official record:
        // a row canonical now says is FIRE becomes record-eligible ("Counts in
        // record"); anything below FIRE is not. Mirrors getHrRadarLadder's
        // Object.assign(entry, buildHrRadarDisplayContract(entry, sectionKey)).
        e.officialSignalStage = canon.section === "FIRE" ? "fire" : null;
        Object.assign(e, buildHrRadarDisplayContract(e as any, target));
      } else if (e.freshSource == null) {
        e.freshSource = "db";
      }
      next[target].push(e);
    }
  }

  // A player already resolved in a terminal bucket must NEVER be re-surfaced as
  // live, even if a stale active canonical state lingers (the DB resolution is
  // authoritative). Seed `seen` with terminal keys so surfacing skips them.
  for (const bucket of ["cashed", "dead"] as const) {
    for (const e of ladder.sections[bucket] ?? []) {
      seen.add(keyOf(e.gameId, e.playerId));
    }
  }

  // Surface actionable canonical rows the DB hasn't persisted yet (FIRE/READY
  // only — never inject BUILD/WATCH noise, which the DB will catch up on).
  for (const [key, s] of Array.from(byKey.entries())) {
    if (seen.has(key)) continue;
    const bucket = SECTION_TO_BUCKET[s.section];
    if (bucket !== "attackNow" && bucket !== "ready") continue;
    next[bucket].push(synthesizeEntry(s, nowMs));
    diagnostics.surfaced++;
    if (bucket === "attackNow") diagnostics.fireSurfaced++;
  }

  ladder.sections.attackNow = next.attackNow;
  ladder.sections.ready = next.ready;
  ladder.sections.building = next.building;
  ladder.sections.watch = next.watch;

  // Recompute counts (terminal buckets unchanged).
  const cashed = ladder.sections.cashed?.length ?? 0;
  const dead = ladder.sections.dead?.length ?? 0;
  ladder.counts = {
    ...(ladder.counts ?? {}),
    attackNow: next.attackNow.length,
    ready: next.ready.length,
    building: next.building.length,
    watch: next.watch.length,
    cashed,
    dead,
    total:
      next.attackNow.length + next.ready.length + next.building.length +
      next.watch.length + cashed + dead,
  };

  return { ladder, diagnostics };
}

// Bucket → coarse user stage label, for the read-only diagnostic report.
const BUCKET_TO_STAGE: Record<LiveBucket, string> = {
  attackNow: "fire",
  ready: "ready",
  building: "build",
  watch: "track",
};

export interface FreshnessReportRow {
  gameId: string;
  playerId: string;
  playerName: string | null;
  dbStage: string | null;
  canonicalStage: string | null;
  overlayApplied: boolean;        // overlay would touch this row (refresh/rebucket/surface)
  source: "db" | "canonical" | "canonical_only";
  freshAgeMs: number | null;      // canonical updatedAt → now
  freshEvidenceAgeMs: number | null; // canonical latestEvidenceAt → now
  dbUpdatedAt: string | null;
  canonicalUpdatedAt: string | null;
  reasonSkipped: string | null;   // why the overlay left the row on the DB value
}

export interface FreshnessReport {
  generatedAt: string;
  nowMs: number;
  summary: {
    liveDbRows: number;
    canonicalActive: number;
    overlayApplied: number;       // rows the overlay would touch
    rebucketed: number;           // rows whose DB bucket disagrees with the fresher canonical
    canonicalOnly: number;        // actionable rows the DB hasn't persisted yet
    duplicateCount: number;       // (game,player) keys appearing in >1 section
    staleCount: number;           // live DB rows whose stage lags the fresher canonical
  };
  rows: FreshnessReportRow[];
}

/**
 * READ-ONLY freshness report. Computes what the overlay WOULD do for the
 * current ladder + canonical store WITHOUT mutating either — for the admin
 * diagnostic endpoint. Never writes; never changes overlay behavior.
 */
export function computeHrRadarFreshnessReport(
  ladder: OverlayLadder,
  canonicalStates: CanonicalHrRadarState[],
  nowMs: number,
): FreshnessReport {
  // Index active, non-terminal canonical rows mapping to a live bucket.
  const byKey = new Map<string, CanonicalHrRadarState>();
  let canonicalActive = 0;
  for (const s of canonicalStates) {
    if (!s.active || s.terminal) continue;
    if (!SECTION_TO_BUCKET[s.section]) continue;
    byKey.set(keyOf(s.gameId, s.playerId), s);
    canonicalActive++;
  }

  // Duplicate detection across ALL sections (live + terminal).
  const keyCounts = new Map<string, number>();
  for (const bucket of ["attackNow", "ready", "building", "watch", "cashed", "dead"] as const) {
    for (const e of ladder.sections[bucket] ?? []) {
      const k = keyOf(e.gameId, e.playerId);
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
  }
  let duplicateCount = 0;
  for (const n of Array.from(keyCounts.values())) if (n > 1) duplicateCount++;

  // Keys present in terminal buckets — these are never surfaced as live.
  const terminalKeys = new Set<string>();
  for (const bucket of ["cashed", "dead"] as const) {
    for (const e of ladder.sections[bucket] ?? []) terminalKeys.add(keyOf(e.gameId, e.playerId));
  }

  const rows: FreshnessReportRow[] = [];
  const seen = new Set<string>();
  let liveDbRows = 0, overlayApplied = 0, rebucketed = 0, staleCount = 0;

  for (const bucket of LIVE_BUCKETS) {
    for (const e of ladder.sections[bucket] ?? []) {
      liveDbRows++;
      const key = keyOf(e.gameId, e.playerId);
      seen.add(key);
      const canon = byKey.get(key);
      const dbStage = (e.userStage as string) ?? BUCKET_TO_STAGE[bucket];
      const dbUpdatedAt = (e.updatedAt as string) ?? (e.signalDetectedAt as string) ?? (e.detectedAt as string) ?? null;
      if (canon) {
        const mapped = SECTION_TO_BUCKET[canon.section]!;
        const moved = mapped !== bucket;
        if (moved) { rebucketed++; staleCount++; }
        overlayApplied++;
        rows.push({
          gameId: String(e.gameId),
          playerId: String(e.playerId),
          playerName: (e.playerName as string) ?? canon.playerName ?? null,
          dbStage,
          canonicalStage: canon.userStage ?? canon.section,
          overlayApplied: true,
          source: "canonical",
          freshAgeMs: ageMsOf(canon.updatedAt, nowMs),
          freshEvidenceAgeMs: ageMsOf(canon.latestEvidenceAt, nowMs),
          dbUpdatedAt,
          canonicalUpdatedAt: canon.updatedAt,
          reasonSkipped: null,
        });
      } else {
        rows.push({
          gameId: String(e.gameId),
          playerId: String(e.playerId),
          playerName: (e.playerName as string) ?? null,
          dbStage,
          canonicalStage: null,
          overlayApplied: false,
          source: "db",
          freshAgeMs: null,
          freshEvidenceAgeMs: null,
          dbUpdatedAt,
          canonicalUpdatedAt: null,
          reasonSkipped: "no_active_canonical",
        });
      }
    }
  }

  // Actionable canonical rows the DB hasn't persisted yet (FIRE/READY only),
  // excluding any already resolved in a terminal bucket.
  let canonicalOnly = 0;
  for (const [key, s] of Array.from(byKey.entries())) {
    if (seen.has(key) || terminalKeys.has(key)) continue;
    const bucket = SECTION_TO_BUCKET[s.section];
    if (bucket !== "attackNow" && bucket !== "ready") continue;
    canonicalOnly++;
    overlayApplied++;
    rows.push({
      gameId: String(s.gameId),
      playerId: String(s.playerId),
      playerName: s.playerName ?? null,
      dbStage: null,
      canonicalStage: s.userStage ?? s.section,
      overlayApplied: true,
      source: "canonical_only",
      freshAgeMs: ageMsOf(s.updatedAt, nowMs),
      freshEvidenceAgeMs: ageMsOf(s.latestEvidenceAt, nowMs),
      dbUpdatedAt: null,
      canonicalUpdatedAt: s.updatedAt,
      reasonSkipped: null,
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    nowMs,
    summary: {
      liveDbRows,
      canonicalActive,
      overlayApplied,
      rebucketed,
      canonicalOnly,
      duplicateCount,
      staleCount,
    },
    rows,
  };
}
