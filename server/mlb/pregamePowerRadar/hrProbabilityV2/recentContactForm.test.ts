// Plate HR V2 — stabilized recent-contact-form invariants (§8.3, PR5).
//
// Proves: recent HR COUNT can never contribute (result is never read); a 15-BBE
// window is regressed toward the season baseline while a 25–50 window earns more
// weight than a tiny spike; missing bat speed is tolerated; the leakage boundary
// excludes the game being scored; EV90/air%/barrel% come from the real per-event
// stream while pulled-air is season-only and xHR-per-contact is always null; and
// no data → a neutral all-null leaf.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/recentContactForm.test.ts

import {
  computeRecentContactForm,
  reliabilityWeight,
  neutralRecentContactForm,
  type RecentContactEventLite,
} from "./recentContactForm";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const BASE = Date.parse("2026-06-01T18:00:00.000Z");
const BOUNDARY = Date.parse("2026-07-01T00:00:00.000Z"); // leakage boundary (session start)

/** N events ending just before `endMs`, one per hour, all with the same EV/LA/barrel. */
function events(n: number, ev: number | null, la: number | null, barrel: boolean | null, endMs = BOUNDARY - 3_600_000, result = "field_out"): RecentContactEventLite[] {
  const out: RecentContactEventLite[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ exitVelocity: ev, launchAngle: la, isBarrel: barrel, result, timestamp: new Date(endMs - (n - 1 - i) * 3_600_000).toISOString() });
  }
  return out;
}

// ── no events → neutral all-null ──────────────────────────────────────────────
{
  const r = computeRecentContactForm({ events: [], asOfExclusiveMs: BOUNDARY });
  ok(JSON.stringify(r) === JSON.stringify(neutralRecentContactForm()), "no events → neutral all-null leaf");
}

// ── leakage boundary excludes the game being scored ───────────────────────────
{
  const before = events(3, 100, 20, true, BOUNDARY - 3_600_000);
  const after = events(2, 100, 20, true, BOUNDARY + 10 * 3_600_000); // at/after boundary
  const r = computeRecentContactForm({ events: [...before, ...after], asOfExclusiveMs: BOUNDARY });
  ok(r.effectiveBbe === 3, `only events strictly before the boundary count (got ${r.effectiveBbe}, want 3)`);
}

// ── recent HR COUNT can never contribute (result is never read) ───────────────
{
  const evs = events(30, 100, 20, true, BOUNDARY - 3_600_000, "field_out");
  const hrs = evs.map((e) => ({ ...e, result: "home_run" }));
  const a = computeRecentContactForm({ events: evs, asOfExclusiveMs: BOUNDARY });
  const b = computeRecentContactForm({ events: hrs, asOfExclusiveMs: BOUNDARY });
  ok(JSON.stringify(a) === JSON.stringify(b), "changing every result to home_run does not change any feature (no HR-count leakage)");
}

// ── reliability weight: monotonic in sample, capped, spike << full window ──────
{
  ok(reliabilityWeight(0) === 0, "reliability(0) = 0");
  ok(reliabilityWeight(3) < reliabilityWeight(15) && reliabilityWeight(15) < reliabilityWeight(25) && reliabilityWeight(25) < reliabilityWeight(50), "reliability increases with effective sample");
  ok(reliabilityWeight(100000) <= 0.85 + 1e-9, "reliability is capped (a hot spike can never dominate)");
}

// ── 15-BBE regressed toward baseline; 25–50 > tiny spike ──────────────────────
{
  const baseline = { avgEv: 90 };
  const recentEv = 100;
  const spike3 = computeRecentContactForm({ events: events(3, recentEv, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: baseline });
  const win15 = computeRecentContactForm({ events: events(15, recentEv, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: baseline });
  const win50 = computeRecentContactForm({ events: events(50, recentEv, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: baseline });
  ok(spike3.recentFormEv! > 90 && spike3.recentFormEv! < win15.recentFormEv!, "a 3-BBE spike is pulled hardest toward the baseline");
  ok(win15.recentFormEv! < win50.recentFormEv!, "a 15-BBE window is more regressed than a 50-BBE window");
  ok(win50.recentFormEv! < 100, "even a full window is stabilized (never all-in on recent)");
  ok(win50.effectiveBbe === 50 && win15.last15Bbe === 15 && spike3.last15Bbe === 3, "effectiveBbe / last15Bbe reported correctly");
}

// ── window cap at 50 (most-recent) ────────────────────────────────────────────
{
  const r = computeRecentContactForm({ events: events(80, 100, 20, true), asOfExclusiveMs: BOUNDARY });
  ok(r.effectiveBbe === 50, `window is capped at 50 most-recent BBE (got ${r.effectiveBbe})`);
}

// ── EWMA emphasizes recency ───────────────────────────────────────────────────
{
  // Older half 80 mph, newer half 120 mph → EWMA (no baseline) > simple mean 100.
  const older = events(20, 80, 20, false, BASE + 19 * 3_600_000);
  const newer = events(20, 120, 20, true, BOUNDARY - 3_600_000);
  const r = computeRecentContactForm({ events: [...older, ...newer], asOfExclusiveMs: BOUNDARY });
  ok(r.recentFormEv! > 100, `EWMA weights recent BBE more than a flat mean (got ${r.recentFormEv})`);
}

// ── EV90 / air% / barrel% from the per-event stream ───────────────────────────
{
  // 9 grounders (LA 5, EV 95) + 1 scorcher (LA 25, EV 110, barrel).
  const mix: RecentContactEventLite[] = [
    ...events(9, 95, 5, false, BOUNDARY - 2 * 3_600_000),
    { exitVelocity: 110, launchAngle: 25, isBarrel: true, result: "double", timestamp: new Date(BOUNDARY - 3_600_000).toISOString() },
  ];
  const r = computeRecentContactForm({ events: mix, asOfExclusiveMs: BOUNDARY });
  ok(r.recentFormEv90! >= 95 && r.recentFormEv90! <= 110, `EV90 is a real percentile of the window (got ${r.recentFormEv90})`);
  ok(Math.abs(r.recentFormAirBallPct! - 10) < 1e-6, `air% = 1/10 air balls = 10% (got ${r.recentFormAirBallPct})`);
  ok(Math.abs(r.recentFormBarrelPct! - 10) < 1e-6, `barrel% = 1/10 = 10% (got ${r.recentFormBarrelPct})`);
}

// ── pulled-air is season-only; xHR-per-contact is always null ─────────────────
{
  const withBaseline = computeRecentContactForm({ events: events(30, 100, 20, true), asOfExclusiveMs: BOUNDARY, seasonBaseline: { pulledAirShare: 0.42 } });
  ok(withBaseline.recentFormPulledAirShare === 0.42, "pulled-air share comes from the season baseline (never per-event)");
  ok(withBaseline.recentFormXHrPerContact === null, "xHR-per-contact is always null (no per-event xSLG stream)");
  const noBaseline = computeRecentContactForm({ events: events(30, 100, 20, true), asOfExclusiveMs: BOUNDARY });
  ok(noBaseline.recentFormPulledAirShare === null, "no season baseline → pulled-air share is null (not fabricated from events)");
}

// ── missing bat speed tolerated (the shape carries none) + missing EV/LA degrade ─
{
  // Events with null EV/LA (only a barrel flag) still produce a barrel% + effectiveBbe.
  const r = computeRecentContactForm({ events: events(12, null, null, true), asOfExclusiveMs: BOUNDARY });
  ok(r.effectiveBbe === 12 && r.recentFormEv === null && r.recentFormEv90 === null && r.recentFormBarrelPct === 100, "missing EV/LA degrade to null (bat speed never required); barrel% still computed");
}

// ── season pulled-air surfaces even with zero recent events ───────────────────
{
  const r = computeRecentContactForm({ events: [], asOfExclusiveMs: BOUNDARY, seasonBaseline: { pulledAirShare: 0.31 } });
  ok(r.recentFormPulledAirShare === 0.31 && r.effectiveBbe === 0 && r.reliabilityWeight === 0, "season pulled-air surfaces at zero recent BBE with zero reliability weight");
}

console.log(`\nrecentContactForm.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
