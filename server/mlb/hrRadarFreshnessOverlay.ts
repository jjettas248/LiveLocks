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
          diagnostics.scoreRefreshed++;
        }
        const age = ageMsOf(canon.updatedAt, nowMs);
        const evidenceAge = ageMsOf(canon.latestEvidenceAt, nowMs);
        e.freshSource = "canonical";
        e.freshAgeMs = age;
        e.freshEvidenceAgeMs = evidenceAge;
        if (age != null) diagnostics.maxLiveRowAgeMs = Math.max(diagnostics.maxLiveRowAgeMs ?? 0, age);
        if (evidenceAge != null) diagnostics.maxEvidenceAgeMs = Math.max(diagnostics.maxEvidenceAgeMs ?? 0, evidenceAge);
      } else if (e.freshSource == null) {
        e.freshSource = "db";
      }
      next[target].push(e);
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
