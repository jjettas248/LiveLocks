// HR Overlay — invariant tests.
// Run: npx tsx server/mlb/hr/__tests__/hrOverlay.test.ts

import { computeHROverlay } from "../hrOverlay";
import type { HROverlayInput } from "../hrOverlayTypes";
import { OVERLAY_CLAMP, GATE_THRESHOLDS } from "../hrOverlayConstants";

let pass = 0;
let fail = 0;
function eq(label: string, a: unknown, b: unknown) {
  const ok = a === b;
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
}
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
function close(label: string, a: number, b: number, tol = 0.001) {
  const within = Math.abs(a - b) <= tol;
  if (within) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label} — got ${a.toFixed(6)}, want ≈${b} (tol ${tol})`); }
}

console.log("\n[HR Overlay] running invariant tests\n");

// ── 1. No-op passthrough — empty input → overlayMultiplier === 1.0 ─────────
{
  const result = computeHROverlay({});
  close("Empty input → overlayMultiplier = 1.0", result.overlayMultiplier, 1.0);
  close("Empty input → omega = 0", result.omega, 0.0);
  close("Empty input → softGateFactor = 1.0", result.softGateFactor, 1.0);
  eq("Empty input → no confidencePenalty", result.confidencePenalty, false);
  eq("Empty input → gamma MISSING", result.components.gamma.coverage, "MISSING");
  close("Empty input → gamma score = 0", result.components.gamma.score, 0.0);
}

// ── 2. Pre-2024 season excluded by triad filter ────────────────────────────
{
  const result = computeHROverlay({
    seasonBundles: [{ season: 2023, barrelPerPA: 0.15, maxEV: 115 }],
  });
  eq("2023-only bundle → triad coverage MISSING (no valid seasons)", result.dataCoverage.psi, "MISSING");
  ok("2023-only bundle → LOW_2024_2026_SAMPLE risk", result.risks.includes("LOW_2024_2026_SAMPLE"));
  // The 2023 bundle is excluded so the overlay cannot use its elite barrel rate.
  close("2023-only bundle → overlayMultiplier = 1.0 (no data)", result.overlayMultiplier, 1.0);
}

// ── 3. 2024–2026 bundle blend properly weights seasons ──────────────────────
{
  // All three seasons present with identical barrel rate — weighted blend = same value.
  const result = computeHROverlay({
    seasonBundles: [
      { season: 2024, barrelPerPA: 0.10 },
      { season: 2025, barrelPerPA: 0.10 },
      { season: 2026, barrelPerPA: 0.10 },
    ],
  });
  // psi is PARTIAL (only barrelPerPA in the bundle, not all 4 Ψ inputs) — that's correct.
  ok("Full triad present → psi not MISSING", result.dataCoverage.psi !== "MISSING");
  ok("Full triad present → overlayMultiplier > 1 (above-avg barrel)", result.overlayMultiplier > 1.0);
  ok("Full triad present → no LOW_2024_2026_SAMPLE risk", !result.risks.includes("LOW_2024_2026_SAMPLE"));
}

// ── 4. Recent-OPS-alone: Ω stays small (< 0.15) ───────────────────────────
{
  const result = computeHROverlay({
    recentOPS: 1.100,
    seasonOPS: 0.750,
  });
  ok("OPS-alone → |omega| < 0.15", Math.abs(result.omega) < 0.15,
    `omega=${result.omega}`);
}

// ── 5. Soft gate dampens (not zeros) below contact floors ──────────────────
{
  const result = computeHROverlay({ barrelPerPA: 0.010 }); // well below 0.040 floor
  ok("Low barrel → softGateFactor < 1.0", result.softGateFactor < 1.0,
    `gate=${result.softGateFactor}`);
  ok("Low barrel → softGateFactor >= gateFloor (never zero)",
    result.softGateFactor >= GATE_THRESHOLDS.gateFloor,
    `gate=${result.softGateFactor} floor=${GATE_THRESHOLDS.gateFloor}`);
  eq("Low barrel → confidencePenalty = true", result.confidencePenalty, true);
}

// ── 6. Above-toppedPct ceiling also fires soft gate ────────────────────────
{
  const result = computeHROverlay({ toppedPct: 40.0 }); // above 25.0 ceiling
  ok("High Topped% → softGateFactor < 1.0", result.softGateFactor < 1.0,
    `gate=${result.softGateFactor}`);
  ok("High Topped% → softGateFactor >= gateFloor",
    result.softGateFactor >= GATE_THRESHOLDS.gateFloor);
  eq("High Topped% → confidencePenalty = true", result.confidencePenalty, true);
}

// ── 7. Γ always no-op / MISSING without pitch-type splits ─────────────────
{
  const base = computeHROverlay({});
  eq("No splits → gamma coverage MISSING", base.components.gamma.coverage, "MISSING");
  close("No splits → gamma score = 0", base.components.gamma.score, 0.0);
  // Even when other inputs are rich, Γ stays 0.
  const rich = computeHROverlay({ barrelPerPA: 0.15, fbPct: 48, pullAirPct: 20 });
  close("Rich input, no splits → gamma score still = 0", rich.components.gamma.score, 0.0);
}

// ── 8. Winsorization caps extreme stat ────────────────────────────────────
{
  // Barrel/PA of 0.30 is ~4.6× league baseline (2.0 maxZ → ratio capped at 2.0).
  // Ψ score should be winsorized to 1.0 with all four inputs extreme.
  const result = computeHROverlay({
    barrelPerPA: 0.30,
    maxEV: 125,
    sweetSpotPct: 55,
    xwOBAcon: 0.600,
  });
  ok("Extreme power inputs → psi score winsorized ≤ 1.0",
    result.components.psi.score <= 1.0,
    `psi=${result.components.psi.score}`);
  ok("Extreme power inputs → overlayMultiplier ≤ OVERLAY_CLAMP.max",
    result.overlayMultiplier <= OVERLAY_CLAMP.max,
    `mult=${result.overlayMultiplier}`);
}

// ── 9. Cleanup slot (4) scores higher than bottom-order slot (9) ──────────
{
  const cleanup = computeHROverlay({ battingOrderSlot: 4 });
  const bottomOrder = computeHROverlay({ battingOrderSlot: 9 });
  ok("Slot 4 > slot 9 overlayMultiplier",
    cleanup.overlayMultiplier > bottomOrder.overlayMultiplier,
    `slot4=${cleanup.overlayMultiplier} slot9=${bottomOrder.overlayMultiplier}`);
  ok("Slot 9 → LOW_ORDER_POSITION risk", bottomOrder.risks.includes("LOW_ORDER_POSITION"));
}

// ── 10. Hot streak → positive delta; cold streak → negative delta ─────────
{
  const hot = computeHROverlay({ recentOPS: 1.05, seasonOPS: 0.800 });
  const cold = computeHROverlay({ recentOPS: 0.600, seasonOPS: 0.800 });
  ok("Hot OPS → positive delta score", hot.components.delta.score > 0,
    `score=${hot.components.delta.score}`);
  ok("Cold OPS → negative delta score", cold.components.delta.score < 0,
    `score=${cold.components.delta.score}`);
  ok("Delta score winsorized ≤ 1.0", hot.components.delta.score <= 1.0);
  ok("Delta score winsorized ≥ -1.0", cold.components.delta.score >= -1.0);
}

// ── 11. overlayMultiplier always within clamp bounds ──────────────────────
{
  const cases: HROverlayInput[] = [
    {},
    { barrelPerPA: 0, maxEV: 70, toppedPct: 50 },
    { barrelPerPA: 0.30, fbPct: 60, pullAirPct: 25, xwOBAcon: 0.600, battingOrderSlot: 4 },
    { barrelPerPA: 0.01, recentOPS: 0.400, seasonOPS: 0.900, battingOrderSlot: 9 },
  ];
  for (let i = 0; i < cases.length; i++) {
    const r = computeHROverlay(cases[i]);
    ok(`Case ${i} → overlayMultiplier ≥ ${OVERLAY_CLAMP.min}`,
      r.overlayMultiplier >= OVERLAY_CLAMP.min, `got ${r.overlayMultiplier}`);
    ok(`Case ${i} → overlayMultiplier ≤ ${OVERLAY_CLAMP.max}`,
      r.overlayMultiplier <= OVERLAY_CLAMP.max, `got ${r.overlayMultiplier}`);
  }
}

console.log(`\n[HR Overlay] ${pass}/${pass + fail} cases passed${fail > 0 ? ` (${fail} FAILED)` : ""}\n`);
if (fail > 0) process.exit(1);
