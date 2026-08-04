// Plate HR V2 — PR6.2 starter/bullpen PA-path capture: derivation + evidence +
// as-of eligibility + payload validation.
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/starterBullpenPaPath.test.ts

import {
  deriveStarterBullpenPaPath,
  hasUsableExposure,
  recomputeStarterBullpenProjectionFromEvidence,
  canonicalizeStarterBullpenSources,
  type StarterBullpenPaPathSources,
} from "./starterBullpenPaPath";
import { buildStarterBullpenPaPathEvidence } from "./starterBullpenPaPathEvidence";
import { validateSourcePayload, isSourceEvidenceEligible, canonicalHash } from "./plateHrV2Snapshots";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const FULL: StarterBullpenPaPathSources = {
  starterWorkload: { starterId: "660271", avgBattersFacedPerStart: 21, avgInningsPerStart: 5.1 },
  opener: { isOpener: false, avgOutsRecordedPerStart: 15 },
  projectedPaBasis: { battingOrderSlot: 3, expectedTotalPa: 4.2 },
  bullpenComposition: { relieversExpected: 4, availabilityNote: null },
  bullpenVulnerability: { bullpenHrPer9: 1.4, bullpenBarrelAllowedPct: 9, bullpenSample: 300 },
};

// ── Deterministic derivation with an exact numeric case ───────────────────────
{
  // avgBf=21 → 2 full turns (18) + remainder 3; slot 3 ≤ 3 → 1 extra look → 3 PA vs starter.
  // expectedTotalPa 4.2 − 3 = 1.2 vs bullpen.
  const p = deriveStarterBullpenPaPath(FULL);
  ok(p.projectedPaVsStarter === 3, `projectedPaVsStarter=3 (got ${p.projectedPaVsStarter})`);
  ok(Math.abs((p.projectedPaVsBullpen ?? -9) - 1.2) < 1e-9, `projectedPaVsBullpen=1.2 (got ${p.projectedPaVsBullpen})`);
  ok(p.isOpenerLikely === false, "isOpenerLikely echoes explicit false");
  ok(p.bullpenHrPer9 === 1.4 && p.bullpenBarrelAllowedPct === 9, "bullpen vuln passthrough");
  ok(p.confidence != null && p.confidence > 0.5, "confidence rises with bullpen sample");
  ok(p.missingReasons.length === 0, "full sources → no missing reasons");
  ok(hasUsableExposure(p), "full sources → usable exposure");

  // Slot sensitivity: slot 5 with remainder 3 → 3 < 5 → no extra look → 2 PA vs starter.
  const p5 = deriveStarterBullpenPaPath({ ...FULL, projectedPaBasis: { battingOrderSlot: 5, expectedTotalPa: 4.2 } });
  ok(p5.projectedPaVsStarter === 2, `slot 5 → 2 PA vs starter (got ${p5.projectedPaVsStarter})`);

  // Determinism: identical sources → identical projection.
  ok(canonicalHash(deriveStarterBullpenPaPath(FULL)) === canonicalHash(p), "deterministic derivation");
}

// ── Fail-closed: missing sources yield null projections + reasons, NO defaults ─
{
  const none = deriveStarterBullpenPaPath({
    starterWorkload: null, opener: null, projectedPaBasis: null, bullpenComposition: null, bullpenVulnerability: null,
  });
  ok(none.projectedPaVsStarter === null, "no starter workload → null starter PA (no league guess)");
  ok(none.projectedPaVsBullpen === null, "no PA basis → null bullpen PA");
  ok(none.isOpenerLikely === null, "no opener classification → null (never a false default)");
  ok(none.bullpenHrPer9 === null && none.bullpenBarrelAllowedPct === null, "no bullpen vuln → null");
  ok(none.confidence === null, "no exposure → null confidence");
  ok(!hasUsableExposure(none), "no sources → no usable exposure");
  ok(none.missingReasons.includes("missing_starter_workload"), "reason: missing_starter_workload");
  ok(none.missingReasons.includes("missing_pa_basis"), "reason: missing_pa_basis");
  ok(none.missingReasons.includes("missing_opener_classification"), "reason: missing_opener_classification");
  ok(none.missingReasons.includes("missing_bullpen_vulnerability"), "reason: missing_bullpen_vulnerability");
  ok(deriveStarterBullpenPaPath(null).missingReasons.length > 0, "null bundle → fail-closed");
}

// ── Partial-source degradation ────────────────────────────────────────────────
{
  // Starter workload present, PA basis absent → starter PA derived, bullpen PA null.
  const noBasis = deriveStarterBullpenPaPath({ ...FULL, projectedPaBasis: { battingOrderSlot: 3, expectedTotalPa: null } });
  ok(noBasis.projectedPaVsStarter === 3, "partial: starter PA still derived");
  ok(noBasis.projectedPaVsBullpen === null, "partial: bullpen PA null without PA basis");
  ok(!hasUsableExposure(noBasis), "partial: no usable exposure without both segments");
  ok(noBasis.missingReasons.includes("missing_pa_basis"), "partial: missing_pa_basis reason");

  // Bullpen vuln absent but exposure present → exposure usable, vuln null.
  const noVuln = deriveStarterBullpenPaPath({ ...FULL, bullpenVulnerability: null });
  ok(hasUsableExposure(noVuln), "partial: exposure usable without bullpen vuln");
  ok(noVuln.bullpenHrPer9 === null, "partial: bullpen vuln null");
  ok(noVuln.confidence != null && noVuln.confidence <= 0.5, "partial: confidence lower without bullpen vuln");
}

// ── No market inputs: PA volume is a NON-market projection (expectedTotalPa) ───
{
  // The source contract has NO odds/implied-total field; bullpen PA is driven only
  // by the non-market expectedTotalPa. Changing it (and nothing market-like) moves
  // the split — there is no market lever to test because none exists by construction.
  const a = deriveStarterBullpenPaPath({ ...FULL, projectedPaBasis: { battingOrderSlot: 3, expectedTotalPa: 4.2 } });
  const b = deriveStarterBullpenPaPath({ ...FULL, projectedPaBasis: { battingOrderSlot: 3, expectedTotalPa: 5.0 } });
  ok((b.projectedPaVsBullpen ?? 0) > (a.projectedPaVsBullpen ?? 0), "non-market expectedTotalPa drives bullpen PA");
  ok(!("teamImpliedRuns" in (FULL.projectedPaBasis as object)), "no market field on the PA basis source");
}

// ── Evidence descriptor: content-addressed, provenance-complete, re-derivable ──
{
  const built = buildStarterBullpenPaPathEvidence({ batterId: "545361", sources: FULL, retrievalAtMs: Date.parse("2026-07-20T15:00:00Z"), schemaVersion: "plate_hr_v2_features_v2" });
  ok(built.evidence != null, "usable exposure → evidence built");
  const ev = built.evidence!;
  ok(ev.evidenceKind === "starter_bullpen", "evidenceKind starter_bullpen");
  ok(ev.provider === "mlb_stats_live" && ev.entityType === "batter" && ev.entityId === "545361", "provider/entity binding");
  ok(ev.availabilitySource === "fetched_at" && ev.availableAt === ev.fetchedAt, "fetched_at ⇒ availableAt===fetchedAt");
  ok(ev.provenanceIncomplete === false, "provenance complete");
  ok(ev.contentHash === canonicalHash(ev.authorizedPayload), "content hash addresses the payload");
  // Re-derive the projection straight from the payload's own sources.
  const payload = ev.authorizedPayload as any;
  ok(canonicalHash(recomputeStarterBullpenProjectionFromEvidence(payload)) === canonicalHash(payload.projection),
    "payload projection re-derives from its own sources");

  // Fail-closed: no usable exposure → no evidence to content-address.
  const noExp = buildStarterBullpenPaPathEvidence({ batterId: "545361", sources: { starterWorkload: null, opener: null, projectedPaBasis: null, bullpenComposition: null, bullpenVulnerability: null }, retrievalAtMs: Date.parse("2026-07-20T15:00:00Z"), schemaVersion: "plate_hr_v2_features_v2" });
  ok(noExp.evidence === null, "no exposure → evidence null (missing_pa_path downstream)");
  ok(!Number.isFinite(NaN) && buildStarterBullpenPaPathEvidence({ batterId: "x", sources: FULL, retrievalAtMs: NaN, schemaVersion: "v" }).evidence === null, "non-finite retrieval → evidence null");
}

// ── Payload validation (write + read): forged/malformed rejected ──────────────
{
  const built = buildStarterBullpenPaPathEvidence({ batterId: "545361", sources: FULL, retrievalAtMs: Date.parse("2026-07-20T15:00:00Z"), schemaVersion: "v2" });
  const payload = built.evidence!.authorizedPayload;
  ok(validateSourcePayload("starter_bullpen", payload).ok, "valid payload passes");

  // Forged projection (doesn't re-derive from sources) → rejected.
  const forged = JSON.parse(JSON.stringify(payload));
  forged.projection.projectedPaVsBullpen = 3.9; // inconsistent with sources
  ok(!validateSourcePayload("starter_bullpen", forged).ok, "forged projection rejected (not re-derivable)");

  // Unexpected field → rejected.
  const extra = JSON.parse(JSON.stringify(payload));
  extra.projection.__unauthorized__ = 1;
  ok(!validateSourcePayload("starter_bullpen", extra).ok, "unexpected projection field rejected");
  const extraSrc = JSON.parse(JSON.stringify(payload));
  extraSrc.sources.__unauthorized__ = 1;
  ok(!validateSourcePayload("starter_bullpen", extraSrc).ok, "unexpected source field rejected");

  // No-exposure projection → rejected (nothing to content-address).
  const noExp = JSON.parse(JSON.stringify(payload));
  noExp.projection.projectedPaVsStarter = null;
  noExp.projection.projectedPaVsBullpen = null;
  ok(!validateSourcePayload("starter_bullpen", noExp).ok, "no-exposure payload rejected");
}

// ── As-of / no-lookahead eligibility (point-in-time rule = lineup/probable) ────
{
  const predictionAsOf = "2026-07-20T17:00:00Z";
  const firstPitch = "2026-07-20T17:10:00Z";
  const evAt = (available: string) => ({
    evidenceKind: "starter_bullpen" as const,
    dataThroughAt: available, availableAt: available, validForAt: null,
    reconstructed: false, provenanceIncomplete: false,
  });
  ok(isSourceEvidenceEligible(evAt("2026-07-20T15:00:00Z"), predictionAsOf, firstPitch).eligible,
    "available before prediction ≤ first pitch → eligible");
  ok(!isSourceEvidenceEligible(evAt("2026-07-20T17:30:00Z"), predictionAsOf, firstPitch).eligible,
    "available AFTER prediction → ineligible (no lookahead)");
  ok(!isSourceEvidenceEligible(evAt("2026-07-20T15:00:00Z"), "2026-07-20T17:20:00Z", firstPitch).eligible,
    "prediction after first pitch → ineligible");
  ok(!isSourceEvidenceEligible({ ...evAt("2026-07-20T15:00:00Z"), provenanceIncomplete: true }, predictionAsOf, firstPitch).eligible,
    "provenance incomplete → ineligible");
}

console.log(`\nstarterBullpenPaPath.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
