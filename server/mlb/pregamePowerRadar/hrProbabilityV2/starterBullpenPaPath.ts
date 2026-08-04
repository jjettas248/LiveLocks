// ─────────────────────────────────────────────────────────────────────────────
// Plate HR V2 — as-of starter/bullpen PA-path evidence + deterministic derivation
// (PR6.2, the pre-PR8 forward-capture prerequisite for the corrected joint PA-path).
//
// The corrected joint PA-path (PR6/PR6.1) needs real EXPOSURE evidence — projected
// PA vs the starter and the bullpen, an opener signal, and expected-bullpen
// vulnerability. Because of the no-backfill decision, that evidence cannot be
// reconstructed later; it must be CAPTURED as-of at slate build time. This module
// defines the frozen as-of SOURCE contract and a PURE, deterministic derivation of
// the projections the PA-path consumes.
//
// FAIL-CLOSED, by construction:
//   • No generic starter/bullpen defaults — a projection is null (not a league
//     guess) whenever its required source is absent, with an explicit reason.
//   • No market/odds inputs — there is no odds/implied-total field anywhere in the
//     source contract; PA volume comes from a NON-market lineup-turnover projection.
//   • Deterministic — identical sources → identical projection (pure; no clocks).
//   • Missing exposure ⇒ null projectedPaVsStarter/Bullpen ⇒ the PA-path is
//     UNAVAILABLE downstream (missing_pa_path), never a fabricated all-starter path.
//
// This module is pure (no I/O, no snapshot import). The content-addressed evidence
// descriptor is built in starterBullpenPaPathEvidence.ts (which imports the snapshot
// hasher), exactly like recentContactForm.ts ↔ recentContactFormEvidence.ts.
// ─────────────────────────────────────────────────────────────────────────────

const finiteNonNegOrNull = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;

/** Max plausible PA vs one pitcher segment (clamp guard). */
export const MAX_SEGMENT_PA = 6;

// ── As-of source contract (raw sufficient evidence, all fields nullable) ──────

/** Starter workload / removal expectation (season aggregates, as-of pregame). */
export interface StarterWorkloadSource {
  starterId: string;
  /** Mean batters faced per start (drives how deep into the order the starter goes). */
  avgBattersFacedPerStart: number | null;
  /** Mean innings per start (context / opener signal). */
  avgInningsPerStart: number | null;
}

/** Opener / bulk-pitcher classification (explicit; never inferred from a default). */
export interface OpenerClassificationSource {
  /** Explicit opener flag when known; null when the classification is unavailable. */
  isOpener: boolean | null;
  /** Mean outs recorded per start (the raw basis behind an opener classification). */
  avgOutsRecordedPerStart: number | null;
}

/**
 * NON-MARKET basis for this batter's total projected PA. `expectedLineupTurns` is a
 * baseball projection (order position × expected times through the order), NOT an
 * odds/implied-total derivation — market inputs are excluded from the PA-path.
 */
export interface ProjectedPaBasisSource {
  battingOrderSlot: number | null;
  /** Expected total plate appearances for this batter (non-market projection). */
  expectedTotalPa: number | null;
}

/** Expected bullpen composition / availability (as-of pregame). */
export interface BullpenCompositionSource {
  /** Number of relievers expected to be available. */
  relieversExpected: number | null;
  /** Free-text availability note (e.g. "closer unavailable"); provenance only. */
  availabilityNote: string | null;
}

/** Bullpen vulnerability + the sample backing its confidence. */
export interface BullpenVulnerabilitySource {
  bullpenHrPer9: number | null;
  bullpenBarrelAllowedPct: number | null;
  /** Batters-faced (or equivalent) sample backing the bullpen rates. */
  bullpenSample: number | null;
}

/** The full as-of source bundle for one (batter, game). */
export interface StarterBullpenPaPathSources {
  starterWorkload: StarterWorkloadSource | null;
  opener: OpenerClassificationSource | null;
  projectedPaBasis: ProjectedPaBasisSource | null;
  bullpenComposition: BullpenCompositionSource | null;
  bullpenVulnerability: BullpenVulnerabilitySource | null;
}

// ── Deterministic derived projection ─────────────────────────────────────────

export interface StarterBullpenPaPathProjection {
  projectedPaVsStarter: number | null;
  projectedPaVsBullpen: number | null;
  isOpenerLikely: boolean | null;
  bullpenHrPer9: number | null;
  bullpenBarrelAllowedPct: number | null;
  /** [0,1] confidence in the projection from source completeness + sample; null when unusable. */
  confidence: number | null;
  /** Explicit reasons for every projection that could not be derived (fail-closed). */
  missingReasons: string[];
}

/**
 * Deterministically derive the PA-path projections from the as-of sources.
 * Pure + fail-closed: a projection is null with an explicit reason whenever its
 * required source is absent — never a league/generic default.
 */
export function deriveStarterBullpenPaPath(
  sources: StarterBullpenPaPathSources | null | undefined,
): StarterBullpenPaPathProjection {
  const missingReasons: string[] = [];
  const s: Partial<StarterBullpenPaPathSources> = sources ?? {};

  const avgBf = finiteNonNegOrNull(s.starterWorkload?.avgBattersFacedPerStart ?? null);
  const slot = intSlotOrNull(s.projectedPaBasis?.battingOrderSlot ?? null);
  const expectedTotalPa = finiteNonNegOrNull(s.projectedPaBasis?.expectedTotalPa ?? null);

  // ── projectedPaVsStarter ─────────────────────────────────────────────────
  // Expected times this batter faces the starter = how many complete/partial
  // times through the order the starter reaches this slot. timesThroughOrder =
  // avgBattersFaced / 9; the batter at slot s gets an extra look on the (t+1)-th
  // turn only if the starter faces at least s batters into that turn.
  let projectedPaVsStarter: number | null = null;
  if (avgBf == null) missingReasons.push("missing_starter_workload");
  if (slot == null) missingReasons.push("missing_batting_order_slot");
  if (avgBf != null && slot != null) {
    const fullTurns = Math.floor(avgBf / 9);
    const remainder = avgBf - fullTurns * 9; // batters faced into the next turn
    const extraLook = remainder >= slot ? 1 : 0;
    projectedPaVsStarter = clamp(fullTurns + extraLook, 0, MAX_SEGMENT_PA);
  }

  // ── projectedPaVsBullpen ─────────────────────────────────────────────────
  // Total projected PA minus the starter-faced count. Requires a NON-market
  // expectedTotalPa; never inferred from odds.
  let projectedPaVsBullpen: number | null = null;
  if (expectedTotalPa == null) missingReasons.push("missing_pa_basis");
  if (expectedTotalPa != null && projectedPaVsStarter != null) {
    projectedPaVsBullpen = clamp(expectedTotalPa - projectedPaVsStarter, 0, MAX_SEGMENT_PA);
  }

  // ── isOpenerLikely ───────────────────────────────────────────────────────
  // Explicit classification only; when unknown, stays NULL (never a `false`
  // default that would assert "not an opener"). The raw avgOuts basis is captured
  // as provenance but never fabricates the flag on its own.
  let isOpenerLikely: boolean | null = null;
  if (s.opener?.isOpener === true || s.opener?.isOpener === false) {
    isOpenerLikely = s.opener.isOpener;
  } else {
    missingReasons.push("missing_opener_classification");
  }

  // ── bullpen vulnerability (raw passthrough) ──────────────────────────────
  const bullpenHrPer9 = finiteNonNegOrNull(s.bullpenVulnerability?.bullpenHrPer9 ?? null);
  const bullpenBarrelAllowedPct = finiteNonNegOrNull(s.bullpenVulnerability?.bullpenBarrelAllowedPct ?? null);
  if (bullpenHrPer9 == null && bullpenBarrelAllowedPct == null) {
    missingReasons.push("missing_bullpen_vulnerability");
  }

  // ── confidence ───────────────────────────────────────────────────────────
  // From source completeness + the bullpen sample backing. Null when the core
  // exposure projections are missing (nothing to be confident about).
  const confidence = computeConfidence({
    hasStarterPa: projectedPaVsStarter != null,
    hasBullpenPa: projectedPaVsBullpen != null,
    bullpenSample: finiteNonNegOrNull(s.bullpenVulnerability?.bullpenSample ?? null),
    hasBullpenVuln: bullpenHrPer9 != null || bullpenBarrelAllowedPct != null,
  });

  return {
    projectedPaVsStarter,
    projectedPaVsBullpen,
    isOpenerLikely,
    bullpenHrPer9,
    bullpenBarrelAllowedPct,
    confidence,
    missingReasons: dedupe(missingReasons),
  };
}

/** True when the projection carries usable exposure (both segment PAs present). */
export function hasUsableExposure(p: StarterBullpenPaPathProjection): boolean {
  return p.projectedPaVsStarter != null && p.projectedPaVsBullpen != null;
}

// ── Content-addressed evidence payload (pure type + canonicalize + re-derive) ─
// These live in the PURE module so the training reader (plateHrV2Snapshots.ts) can
// re-derive from a stored payload without an import cycle; the hash-using descriptor
// builder is in starterBullpenPaPathEvidence.ts. Mirrors recentContactForm.ts.

/** Provider allowlist for starter_bullpen evidence (bound at read time). */
export const STARTER_BULLPEN_PROVIDERS: ReadonlySet<string> = new Set(["mlb_stats_live"]);

/** The canonical, exactly-re-derivable payload: raw as-of sources + derived projection. */
export interface StarterBullpenPaPathEvidencePayload {
  sources: {
    starterWorkload: { starterId: string; avgBattersFacedPerStart: number | null; avgInningsPerStart: number | null } | null;
    opener: { isOpener: boolean | null; avgOutsRecordedPerStart: number | null } | null;
    projectedPaBasis: { battingOrderSlot: number | null; expectedTotalPa: number | null } | null;
    bullpenComposition: { relieversExpected: number | null; availabilityNote: string | null } | null;
    bullpenVulnerability: { bullpenHrPer9: number | null; bullpenBarrelAllowedPct: number | null; bullpenSample: number | null } | null;
  };
  projection: StarterBullpenPaPathProjection;
}

const finiteOrNullLoose = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const boolOrNull = (x: unknown): boolean | null => (typeof x === "boolean" ? x : null);
const strOrNull = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);

/** Canonicalize the sources into a stable, hashable shape (drops undefined/NaN). */
export function canonicalizeStarterBullpenSources(
  s: StarterBullpenPaPathSources | null | undefined,
): StarterBullpenPaPathEvidencePayload["sources"] {
  const src: Partial<StarterBullpenPaPathSources> = s ?? {};
  return {
    starterWorkload: src.starterWorkload
      ? {
          starterId: String(src.starterWorkload.starterId),
          avgBattersFacedPerStart: finiteOrNullLoose(src.starterWorkload.avgBattersFacedPerStart),
          avgInningsPerStart: finiteOrNullLoose(src.starterWorkload.avgInningsPerStart),
        }
      : null,
    opener: src.opener
      ? { isOpener: boolOrNull(src.opener.isOpener), avgOutsRecordedPerStart: finiteOrNullLoose(src.opener.avgOutsRecordedPerStart) }
      : null,
    projectedPaBasis: src.projectedPaBasis
      ? { battingOrderSlot: finiteOrNullLoose(src.projectedPaBasis.battingOrderSlot), expectedTotalPa: finiteOrNullLoose(src.projectedPaBasis.expectedTotalPa) }
      : null,
    bullpenComposition: src.bullpenComposition
      ? { relieversExpected: finiteOrNullLoose(src.bullpenComposition.relieversExpected), availabilityNote: strOrNull(src.bullpenComposition.availabilityNote) }
      : null,
    bullpenVulnerability: src.bullpenVulnerability
      ? {
          bullpenHrPer9: finiteOrNullLoose(src.bullpenVulnerability.bullpenHrPer9),
          bullpenBarrelAllowedPct: finiteOrNullLoose(src.bullpenVulnerability.bullpenBarrelAllowedPct),
          bullpenSample: finiteOrNullLoose(src.bullpenVulnerability.bullpenSample),
        }
      : null,
  };
}

/**
 * Re-derive the projection a stored payload asserts, straight from its own raw
 * `sources`. The reader requires this to equal the payload's stored `projection`
 * (and the prediction's stored group) — a forged projection cannot survive.
 */
export function recomputeStarterBullpenProjectionFromEvidence(
  payload: StarterBullpenPaPathEvidencePayload,
): StarterBullpenPaPathProjection {
  return deriveStarterBullpenPaPath(payload.sources as StarterBullpenPaPathSources);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function computeConfidence(args: {
  hasStarterPa: boolean;
  hasBullpenPa: boolean;
  bullpenSample: number | null;
  hasBullpenVuln: boolean;
}): number | null {
  if (!args.hasStarterPa || !args.hasBullpenPa) return null;
  // Exposure present → base confidence; bullpen vulnerability + its sample add trust.
  let c = 0.5;
  if (args.hasBullpenVuln) {
    const n = args.bullpenSample ?? 0;
    const sampleTrust = n / (n + 100); // ~100 BF → half trust
    c += 0.5 * clamp01(sampleTrust);
  }
  return clamp01(c);
}

function intSlotOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.round(v);
  return r >= 1 && r <= 9 ? r : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
