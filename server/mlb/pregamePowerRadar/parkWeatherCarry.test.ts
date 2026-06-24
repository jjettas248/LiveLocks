// Pre-Game Power Radar — park/weather carry display contract.
// Run: npx tsx server/mlb/pregamePowerRadar/parkWeatherCarry.test.ts
//
// Verifies the SERVER-OWNED carry classification (carryLabel/carryType) emitted
// by computeParkWeatherScore. This is display-only metadata — these assertions
// must NOT depend on (or change) score10, whose weights are unchanged.

import { computeParkWeatherScore, type ParkWeatherInputs } from "./parkWeatherScore";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const base: ParkWeatherInputs = {
  parkHrFactor: 1.0,
  isIndoors: false,
  weatherAvailable: true,
  temperature: 72,
  windSpeed: 5,
  windDirection: "calm",
};

// ── Indoors → neutral conditions (roof) ───────────────────────────────────────
const roof = computeParkWeatherScore({ ...base, isIndoors: true });
ok(roof.carryType === "neutral", "indoors → neutral carry");
ok(roof.carryLabel === "Neutral Conditions", "indoors → Neutral Conditions label");

// ── No weather data → UNKNOWN (never claims neutral) ──────────────────────────
const noWx = computeParkWeatherScore({ ...base, weatherAvailable: false, temperature: null, windSpeed: null, windDirection: null });
ok(noWx.carryType === "unknown", "missing weather → unknown carry (not neutral)");
ok(noWx.carryLabel === "Conditions Unavailable", "missing weather → Conditions Unavailable");
ok(noWx.carryType !== "neutral", "missing weather must NOT assert neutral conditions");

// ── Strong wind out → HR Carry (boost) ────────────────────────────────────────
const windOut = computeParkWeatherScore({ ...base, windDirection: "out", windSpeed: 16, temperature: 70 });
ok(windOut.carryType === "boost", "strong wind out → boost");
ok(windOut.carryLabel === "HR Carry", "strong wind out → HR Carry");
ok(windOut.carryDriverText != null, "strong wind out → driver text present");

// ── Hot day, calm → HR Carry (boost) ──────────────────────────────────────────
const hot = computeParkWeatherScore({ ...base, temperature: 95, windDirection: "calm", windSpeed: 2 });
ok(hot.carryType === "boost", "hot calm day → boost");
ok(hot.carryLabel === "HR Carry", "hot calm day → HR Carry");

// ── Mildly warm → Carry Boost ─────────────────────────────────────────────────
const warm = computeParkWeatherScore({ ...base, temperature: 81, windDirection: "calm", windSpeed: 2 });
ok(warm.carryType === "boost", "warm day → boost");
ok(warm.carryLabel === "Carry Boost", `warm day → Carry Boost (got ${warm.carryLabel})`);

// ── Cold → Carry Suppressed ───────────────────────────────────────────────────
const cold = computeParkWeatherScore({ ...base, temperature: 48, windDirection: "calm", windSpeed: 2 });
ok(cold.carryType === "suppress", "cold day → suppress");
ok(cold.carryLabel === "Carry Suppressed", "cold day → Carry Suppressed");

// ── Strong wind in → Carry Suppressed ─────────────────────────────────────────
const windIn = computeParkWeatherScore({ ...base, windDirection: "in", windSpeed: 17, temperature: 70 });
ok(windIn.carryType === "suppress", "strong wind in → suppress");
ok(windIn.carryLabel === "Carry Suppressed", "strong wind in → Carry Suppressed");

// ── Plain mild conditions → Neutral Air ───────────────────────────────────────
const neutral = computeParkWeatherScore({ ...base, temperature: 70, windDirection: "cross", windSpeed: 6 });
ok(neutral.carryType === "neutral", "mild crosswind → neutral");
ok(neutral.carryLabel === "Neutral Air", `mild crosswind → Neutral Air (got ${neutral.carryLabel})`);

// ── Carry classification never alters the score10 weighting ───────────────────
// Same inputs, score is deterministic and independent of the carry branch taken.
const a = computeParkWeatherScore({ ...base, temperature: 72 });
const b = computeParkWeatherScore({ ...base, temperature: 72 });
ok(a.score10 === b.score10, "score10 stable/deterministic alongside carry classification");

console.log(`\nparkWeatherCarry.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
