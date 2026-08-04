// Plate HR V2 — stabilized recent-contact-form invariants (§8.3, PR5 / PR5.1).
//
// Proves: recent HR COUNT can never contribute; a season baseline is REQUIRED to
// surface a stabilized metric (a tiny recent sample is never passed through raw);
// each metric is shrunk by its OWN valid-measurement count; unknown barrel status
// is treated as missing (not a non-barrel); the leakage boundary is mandatory
// (fail-closed on a non-finite boundary) and the window is hard-capped at 50;
// EV90/air%/barrel% come from the real per-event stream while pulled-air is
// season-only and xHR-per-contact is always null; baseline domains are validated.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/recentContactForm.test.ts

import {
  computeRecentContactForm,
  reliabilityWeight,
  normalizeWindowMax,
  neutralRecentContactForm,
  buildRecentContactFormEvidence,
  recomputeRecentContactFormFromEvidence,
  type RecentContactEventLite,
  type RecentContactFormSeasonBaseline,
  type RecentContactFormEvidencePayload,
} from "./recentContactForm";
import { validateSourcePayload } from "./plateHrV2Snapshots";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const BOUNDARY = Date.parse("2026-07-01T00:00:00.000Z");
const BASE: RecentContactFormSeasonBaseline = { avgEv: 90, ev90: 105, airBallPct: 40, barrelPct: 7, pulledAirShare: 0.35 };

/** N events ending just before `endMs`, one per hour. */
function events(n: number, ev: number | null, la: number | null, barrel: boolean | null, endMs = BOUNDARY - 3_600_000, result = "field_out"): RecentContactEventLite[] {
  const out: RecentContactEventLite[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ exitVelocity: ev, launchAngle: la, isBarrel: barrel, result, timestamp: new Date(endMs - (n - 1 - i) * 3_600_000).toISOString() });
  }
  return out;
}

// ── no events → neutral ───────────────────────────────────────────────────────
{
  const r = computeRecentContactForm({ events: [], asOfExclusiveMs: BOUNDARY, seasonBaseline: { avgEv: 90, ev90: 105, airBallPct: 40, barrelPct: 7 } });
  ok(JSON.stringify(r) === JSON.stringify(neutralRecentContactForm()), "no events + no season pulled-air → neutral all-null leaf");
}

// ── PR5.1 gap 3: fail-closed on a non-finite leakage boundary ─────────────────
{
  const e = events(30, 100, 20, true);
  ok(JSON.stringify(computeRecentContactForm({ events: e, asOfExclusiveMs: null, seasonBaseline: BASE })) === JSON.stringify(neutralRecentContactForm()), "null boundary fails closed to neutral (never disables the boundary)");
  ok(JSON.stringify(computeRecentContactForm({ events: e, asOfExclusiveMs: NaN, seasonBaseline: BASE })) === JSON.stringify(neutralRecentContactForm()), "NaN boundary fails closed to neutral");
  ok(JSON.stringify(computeRecentContactForm({ events: e, asOfExclusiveMs: Infinity, seasonBaseline: BASE })) === JSON.stringify(neutralRecentContactForm()), "Infinity boundary fails closed to neutral");
}

// ── PR5.1 gap 3: window normalization (hard cap 50; invalid → 50) ─────────────
{
  ok(normalizeWindowMax(1000) === 50, "windowMax > 50 hard-capped to 50");
  ok(normalizeWindowMax(0) === 50 && normalizeWindowMax(-5) === 50, "non-positive windowMax → 50");
  ok(normalizeWindowMax(NaN) === 50 && normalizeWindowMax(Infinity) === 50 && normalizeWindowMax(undefined) === 50, "non-finite/absent windowMax → 50");
  ok(normalizeWindowMax(1.9) === 1 && normalizeWindowMax(30) === 30, "fractional windowMax floored; valid passes through");
  const r = computeRecentContactForm({ events: events(80, 100, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE, windowMax: 1000 });
  ok(r.effectiveBbe === 50, `oversized windowMax still capped at 50 in compute (got ${r.effectiveBbe})`);
}

// ── leakage boundary excludes the game being scored ───────────────────────────
{
  const before = events(3, 100, 20, true, BOUNDARY - 3_600_000);
  const after = events(2, 100, 20, true, BOUNDARY + 10 * 3_600_000);
  const r = computeRecentContactForm({ events: [...before, ...after], asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  ok(r.effectiveBbe === 3, `only events strictly before the boundary count (got ${r.effectiveBbe})`);
}

// ── recent HR COUNT can never contribute (result is never read) ───────────────
{
  const evs = events(30, 100, 20, true, BOUNDARY - 3_600_000, "field_out");
  const hrs = evs.map((e) => ({ ...e, result: "home_run" }));
  const a = computeRecentContactForm({ events: evs, asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  const b = computeRecentContactForm({ events: hrs, asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  ok(JSON.stringify(a) === JSON.stringify(b), "changing every result to home_run changes no feature (no HR-count leakage)");
}

// ── reliability weight: monotonic, capped ─────────────────────────────────────
{
  ok(reliabilityWeight(0) === 0, "reliability(0) = 0");
  ok(reliabilityWeight(1) < reliabilityWeight(15) && reliabilityWeight(15) < reliabilityWeight(50), "reliability increases with sample");
  ok(reliabilityWeight(1e9) <= 0.85 + 1e-9, "reliability capped");
}

// ── PR5.1 gap 4: a season baseline is REQUIRED (no raw passthrough) ───────────
{
  const noBase = computeRecentContactForm({ events: events(50, 110, 20, true), asOfExclusiveMs: BOUNDARY });
  ok(noBase.recentFormEv === null && noBase.recentFormEv90 === null && noBase.recentFormAirBallPct === null && noBase.recentFormBarrelPct === null, "no season baseline → stabilized metrics are null (never raw)");
  // A 1-BBE spike WITH a baseline is heavily shrunk toward the baseline.
  const spike = computeRecentContactForm({ events: events(1, 120, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  ok(spike.recentFormEv! > 88 && spike.recentFormEv! < 92, `a 1-BBE spike is shrunk hard toward the baseline (got ${spike.recentFormEv}, baseline 90)`);
}

// ── 15-BBE regressed; 25–50 > spike (all EV valid) ────────────────────────────
{
  const spike3 = computeRecentContactForm({ events: events(3, 110, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  const win15 = computeRecentContactForm({ events: events(15, 110, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  const win50 = computeRecentContactForm({ events: events(50, 110, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  ok(spike3.recentFormEv! < win15.recentFormEv! && win15.recentFormEv! < win50.recentFormEv!, "more BBE → less regression toward baseline");
  ok(win50.recentFormEv! < 110, "even a full window is stabilized (never all-in on recent)");
}

// ── PR5.1 gap 4: per-metric denominator (one valid LA among 50 rows) ──────────
{
  // 50 valid-EV rows; only ONE has a valid launch angle (an air ball).
  const evs = events(49, 110, null, true);
  evs.push({ exitVelocity: 110, launchAngle: 25, isBarrel: true, result: "double", timestamp: new Date(BOUNDARY - 3_600_000).toISOString() });
  const r = computeRecentContactForm({ events: evs, asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  // EV uses its 50-count weight → pulled toward recent 110.
  ok(r.recentFormEv! > 100, `EV blended with its full 50-count weight (got ${r.recentFormEv})`);
  // Air% uses ITS count (=1) → w≈0.048 → stays near the baseline 40, NOT near 100.
  ok(r.recentFormAirBallPct! < 50, `air% shrunk by its own 1-sample weight, near baseline not raw 100% (got ${r.recentFormAirBallPct})`);
}

// ── PR5.1 gap 4: unknown barrel status is missing, not non-barrel ─────────────
{
  // Valid EV/LA but barrel flag unknown (null) on every event.
  const r = computeRecentContactForm({ events: events(40, 100, 20, null), asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  ok(r.recentFormBarrelPct === BASE.barrelPct, `unknown barrel status → no recent barrel signal → season baseline (got ${r.recentFormBarrelPct}, not 0)`);
}

// ── PR5.1 gap 4: baseline domain validation ───────────────────────────────────
{
  const bad: RecentContactFormSeasonBaseline = { avgEv: 999, ev90: -5, airBallPct: 250, barrelPct: -1, pulledAirShare: 5 };
  const r = computeRecentContactForm({ events: events(40, 100, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: bad });
  ok(r.recentFormEv === null && r.recentFormEv90 === null && r.recentFormAirBallPct === null && r.recentFormBarrelPct === null && r.recentFormPulledAirShare === null, "out-of-domain baseline metrics are treated as absent → null");
}

// ── EWMA emphasizes recency (blended toward a neutral baseline) ───────────────
{
  const older = events(20, 80, 20, false, BOUNDARY - 21 * 3_600_000);
  const newer = events(20, 120, 20, true, BOUNDARY - 3_600_000);
  const r = computeRecentContactForm({ events: [...older, ...newer], asOfExclusiveMs: BOUNDARY, seasonBaseline: { avgEv: 100 } });
  ok(r.recentFormEv! > 100, `EWMA weights recent BBE more, lifting the blend above a 100 baseline (got ${r.recentFormEv})`);
}

// ── EV90 / air% / barrel% blended from the per-event stream ───────────────────
{
  const mix: RecentContactEventLite[] = [
    ...events(45, 95, 5, false, BOUNDARY - 6 * 3_600_000),
    ...events(5, 110, 25, true, BOUNDARY - 3_600_000),
  ];
  const r = computeRecentContactForm({ events: mix, asOfExclusiveMs: BOUNDARY, seasonBaseline: BASE });
  ok(r.recentFormEv90 != null && r.recentFormAirBallPct != null && r.recentFormBarrelPct != null, "EV90/air%/barrel% surface from a well-covered window");
}

// ── pulled-air is season-only; xHR-per-contact is always null ─────────────────
{
  const r = computeRecentContactForm({ events: events(30, 100, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: { pulledAirShare: 0.42 } });
  ok(r.recentFormPulledAirShare === 0.42, "pulled-air share comes from the season baseline (never per-event)");
  ok(r.recentFormXHrPerContact === null, "xHR-per-contact is always null (no per-event xSLG stream)");
}

// ── season pulled-air surfaces even with zero recent events ───────────────────
{
  const r = computeRecentContactForm({ events: [], asOfExclusiveMs: BOUNDARY, seasonBaseline: { pulledAirShare: 0.31 } });
  ok(r.recentFormPulledAirShare === 0.31 && r.effectiveBbe === 0 && r.reliabilityWeight === 0, "season pulled-air surfaces at zero recent BBE with zero reliability weight");
}

// ── PR5.1 gap 2: content-addressed contact_events evidence + round-trip ───────
{
  const mixed: RecentContactEventLite[] = [
    ...events(30, 96, 8, false, BOUNDARY - 4 * 3_600_000),
    ...events(12, 108, 24, true, BOUNDARY - 3_600_000),
  ];
  const built = buildRecentContactFormEvidence({
    events: mixed, asOfExclusiveMs: BOUNDARY, retrievalAtMs: BOUNDARY, batterId: "b1",
    schemaVersion: "plate_hr_v2_features_v2", seasonBaseline: BASE,
  });
  ok(built.evidence != null, "a populated window yields a contact_events evidence descriptor");
  const ev = built.evidence!;
  ok(ev.evidenceKind === "contact_events" && ev.entityType === "batter" && ev.entityId === "b1", "descriptor is a batter contact_events source");
  ok(ev.availableAt === ev.fetchedAt && ev.availabilitySource === "fetched_at" && ev.provenanceIncomplete === false, "provenance is fetched_at with availableAt === fetchedAt");
  ok(ev.dataThroughAt != null && Date.parse(ev.dataThroughAt) < BOUNDARY, "dataThroughAt is the max event time, strictly before the boundary");
  // The captured evidence RE-DERIVES to the stored derived vector (exactly).
  const payload = ev.authorizedPayload as RecentContactFormEvidencePayload;
  const rederived = recomputeRecentContactFormFromEvidence(payload);
  ok(JSON.stringify(rederived) === JSON.stringify(built.inputs), "captured raw evidence recomputes to the stored derived vector");
  // The payload passes strict contact_events validation.
  ok(validateSourcePayload("contact_events", payload).ok, "the contact_events payload passes strict validation");
  // Empty / malformed payloads are rejected.
  ok(!validateSourcePayload("contact_events", { events: [], asOfExclusiveMs: BOUNDARY, windowMax: 50, seasonBaseline: {} }).ok, "empty events payload rejected");
  ok(!validateSourcePayload("contact_events", { events: [{ exitVelocity: "x", launchAngle: null, isBarrel: null, timestamp: "2026-06-01T00:00:00.000Z" }], asOfExclusiveMs: BOUNDARY, windowMax: 50 }).ok, "non-numeric EV in an event rejected");
  ok(!validateSourcePayload("contact_events", { events: payload.events, asOfExclusiveMs: NaN, windowMax: 50 }).ok, "non-finite asOfExclusiveMs rejected");
  // No in-window events → no evidence to content-address.
  const none = buildRecentContactFormEvidence({ events: [], asOfExclusiveMs: BOUNDARY, retrievalAtMs: BOUNDARY, batterId: "b1", schemaVersion: "v2", seasonBaseline: BASE });
  ok(none.evidence === null, "no in-window events → no evidence descriptor");
}

console.log(`\nrecentContactForm.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
