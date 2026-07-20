// Plate Radar — visual symbol preservation regression.
// Run: npx tsx client/src/lib/mlb/plateSymbolPreservation.test.ts
//
// The visual hierarchy rebuild (tone taxonomy, market-tier renames, environment
// row) changes color, prominence, layout, and limited display copy — it must
// NOT remove or replace any existing emoji/icon symbol. This is a structural
// source-inspection guard (no DOM runner in this repo), following the same
// pattern as pregameParkWindDisplay.test.ts.

import { readFileSync } from "fs";
import {
  getMarketTierPresentation,
  getCarryPresentation,
  getWeatherSecondaryPresentations,
} from "@/lib/mlb/plateTagPresentation";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const componentSrc = readFileSync("client/src/components/mlb/PregamePowerRadar.tsx", "utf8");
const libSrc = readFileSync("client/src/lib/mlb/plateTagPresentation.ts", "utf8");

console.log("\n[plateSymbolPreservation] running cases\n");

// ── Market fit vocabulary — real tiers, no invented Prime/Qualified ──────────
// The recovery pass removed the redundant compact per-market tier pills (the
// single "Best Angle" line + expanded HR/TB fit comparison replaced them), so
// the old `{MARKET_EMOJI[setup.market]}` chip usage is intentionally gone. The
// emoji map itself is preserved. Vocabulary now uses the real server tiers.
{
  assert("MARKET_EMOJI still defines home_runs → 🎯", /home_runs:\s*"🎯"/.test(componentSrc));
  assert("MARKET_EMOJI still defines total_bases → 📈", /total_bases:\s*"📈"/.test(componentSrc));

  const hr = getMarketTierPresentation("Elite");
  assert('raw "Elite" → display "Elite" (no invented "Prime")', hr.displayLabel === "Elite");
  const tb = getMarketTierPresentation("Strong");
  assert('raw "Strong" → display "Strong" (no invented "Qualified")', tb.displayLabel === "Strong");
}

// ── Carry emoji — preserved exactly, including 🔥 for HR Carry ──────────────────
{
  const hrCarry = getCarryPresentation({ temperatureF: 89, windMph: 5, windDirectionLabel: "Out", carryLabel: "HR Carry", carryType: "boost" });
  assert("HR Carry emoji is exactly 🔥", hrCarry.emoji === "🔥");
  const boost = getCarryPresentation({ temperatureF: 75, windMph: 3, windDirectionLabel: null, carryLabel: "Carry Boost", carryType: "boost" });
  assert("Carry Boost emoji is exactly 🌬️", boost.emoji === "🌬️");
  const suppressed = getCarryPresentation({ temperatureF: 54, windMph: 14, windDirectionLabel: "In", carryLabel: "Carry Suppressed", carryType: "suppress" });
  assert("Carry Suppressed emoji is exactly 🧊", suppressed.emoji === "🧊");
  const neutralAir = getCarryPresentation({ temperatureF: null, windMph: null, windDirectionLabel: null, carryLabel: "Neutral Air", carryType: "neutral" });
  assert("Neutral Air emoji is exactly ↔", neutralAir.emoji === "↔");
  const neutralCond = getCarryPresentation({ temperatureF: 70, windMph: 2, windDirectionLabel: "Calm", carryLabel: "Neutral Conditions", carryType: "neutral" });
  assert("Neutral Conditions emoji is exactly 🏟️ (stadium symbol)", neutralCond.emoji === "🏟️");
  const unavailable = getCarryPresentation({ temperatureF: null, windMph: null, windDirectionLabel: null, carryLabel: "Conditions Unavailable", carryType: "unknown" });
  assert("Conditions Unavailable emoji is exactly 🚫", unavailable.emoji === "🚫");

  // The environment row renders the carry emoji, not just the label text.
  assert("ParkConditionsRow renders carry.emoji in the primary pill", /\{carry\.emoji\}\s*\{carry\.label\}/.test(componentSrc));
}

// ── Park/venue stadium symbol — preserved in both the venue prefix and the
//    "unavailable" fallback lines ──────────────────────────────────────────────
{
  assert("venue name still prefixed with 🏟️", /🏟️ \{park\.venueName\}/.test(componentSrc));
  assert('"Park context unavailable" fallback still uses 🏟️', /🏟️ Park context unavailable/.test(componentSrc));
}

// ── Wind symbol — the existing lucide <Wind> icon, not a text emoji ─────────────
{
  assert("Wind icon still imported from lucide-react", /import\s*\{[^}]*\bWind\b[^}]*\}\s*from\s*"lucide-react"/.test(componentSrc));
  assert("environment row still renders a <Wind> icon for wind pills", /<Wind className="w-3 h-3" \/>/.test(componentSrc));
  assert("player-specific fit row still renders a <Wind> icon", (componentSrc.match(/<Wind className="w-3 h-3" \/>/g) || []).length >= 2, "expected at least 2 Wind icon usages (environment row + player fit row)");
  // Weather secondary pills carry the "mph" marker the component uses to decide
  // whether to render the Wind icon — confirms the pill text still round-trips
  // the wind reading (not silently dropped when converting to a pill).
  const windPill = getWeatherSecondaryPresentations(
    { temperatureF: 80, windMph: 10, windDirectionLabel: "Out to LF", carryLabel: "Carry Boost", carryType: "boost" },
    [{ key: "pw_wind_out", direction: "positive" }],
  ).find((p) => p.text.includes("mph"));
  assert("wind secondary pill text includes the mph reading", windPill != null && /mph/.test(windPill.text), windPill?.text);
}

// ── Roof/indoor symbol — 🏟️, matching the existing parkWindFit.ts "Roof closed"
//    glyph, carried into the new secondary pill rather than rendered text-only ──
{
  const roofPill = getWeatherSecondaryPresentations(
    { temperatureF: 72, windMph: null, windDirectionLabel: null, carryLabel: "Neutral Conditions", carryType: "neutral" },
    [{ key: "pw_roof", direction: "neutral" }],
  );
  assert("roof-closed secondary pill carries the 🏟️ symbol, not text-only", roofPill.length === 1 && roofPill[0].text.startsWith("🏟️"), roofPill[0]?.text);
}

// ── Player-specific park/wind fit emoji — unchanged (server-stamped, rendered
//    verbatim; this only confirms the render site wasn't dropped) ───────────────
{
  assert("fit row still renders fit.emoji verbatim", /\{fit\.emoji\}/.test(componentSrc));
}

// ── Lock / tier / expand-collapse icons — untouched by this rebuild ─────────────
{
  assert("Lock icon still imported", /import\s*\{[^}]*\bLock\b[^}]*\}\s*from\s*"lucide-react"/.test(componentSrc));
  assert('"Locked at first pitch" still renders the Lock icon', /<Lock className="w-3 h-3" \/> Locked at first pitch/.test(componentSrc));
  assert("Flame/Zap/Target tier icons still imported", /import\s*\{[^}]*\bFlame\b[^}]*\bZap\b[^}]*\bTarget\b[^}]*\}\s*from\s*"lucide-react"/.test(componentSrc));
  assert("TierIcon selection logic (Flame/Zap/Target) still present", /TierIcon = s\.tier === "nuclear" \|\| s\.tier === "elite" \? Flame : s\.tier === "strong" \? Zap : Target/.test(componentSrc));
  assert("ChevronDown/ChevronUp expand-collapse icons still imported", /import\s*\{[^}]*ChevronDown[^}]*ChevronUp[^}]*\}\s*from\s*"lucide-react"/.test(componentSrc));
  assert("expand/collapse button still swaps ChevronDown/ChevronUp", /\{expanded \? <ChevronUp className="w-3 h-3" \/> : <ChevronDown className="w-3 h-3" \/>\}/.test(componentSrc));
}

console.log(`\n[plateSymbolPreservation] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
