// plateTagPresentation — invariants.
// Run: npx tsx client/src/lib/mlb/plateTagPresentation.test.ts
//
// Pins the tone→class palette, the tag classification table, the BvP
// confidence/strength resolver, market-tier renames, and carry/weather
// presentation. This is the regression guard for the Plate Radar visual
// hierarchy rebuild — a future edit can't silently drift a tone, promote
// BvP to standout, or desync tone from CSS class.

import {
  getPlateToneClasses,
  getPlateTagPresentation,
  getBvpPresentation,
  getMarketTierPresentation,
  getCarryPresentation,
  getWeatherSecondaryPresentations,
  type PlateTagTone,
} from "@/lib/mlb/plateTagPresentation";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== plateTagPresentation — Invariant Suite ===\n");

console.log("getPlateToneClasses — single source of truth for tone→color");
{
  const TONES: PlateTagTone[] = ["standout", "supporting", "context", "risk", "neutral"];
  const SUBSTR: Record<PlateTagTone, string> = {
    standout: "emerald",
    supporting: "amber",
    context: "sky",
    risk: "rose",
    neutral: "secondary",
  };
  for (const tone of TONES) {
    const classes = getPlateToneClasses(tone);
    assert(`${tone} classes contain "${SUBSTR[tone]}"`, classes.includes(SUBSTR[tone]), classes);
  }
  // Every tone must be distinct from every other tone's classes.
  const all = TONES.map((t) => getPlateToneClasses(t));
  assert("all 5 tone class strings are distinct", new Set(all).size === 5);
}

console.log("\ngetPlateTagPresentation — exact key match wins");
{
  assert("power_iso → standout", getPlateTagPresentation("power_iso", "positive").tone === "standout");
  assert("power_hrfb → standout", getPlateTagPresentation("power_hrfb", "positive").tone === "standout");
  assert("power_barrel → supporting", getPlateTagPresentation("power_barrel", "positive").tone === "supporting");
  assert("power_hardhit → supporting", getPlateTagPresentation("power_hardhit", "positive").tone === "supporting");
  assert("power_maxev → supporting", getPlateTagPresentation("power_maxev", "positive").tone === "supporting");
  assert("power_pullair → supporting", getPlateTagPresentation("power_pullair", "positive").tone === "supporting");
  assert("power_low → risk", getPlateTagPresentation("power_low", "negative").tone === "risk");
  assert("pv_hr9 → supporting", getPlateTagPresentation("pv_hr9", "positive").tone === "supporting");
  assert("pv_stingy → risk", getPlateTagPresentation("pv_stingy", "negative").tone === "risk");
  assert("fit_platoon → supporting", getPlateTagPresentation("fit_platoon", "positive").tone === "supporting");
  assert("fit_bvp fallback → supporting (never standout)", getPlateTagPresentation("fit_bvp", "positive").tone === "supporting");
  assert("fit_bvp_bad fallback → risk", getPlateTagPresentation("fit_bvp_bad", "negative").tone === "risk");
  assert("pw_roof → context", getPlateTagPresentation("pw_roof", "neutral").tone === "context");
  assert("pw_wind_out → supporting", getPlateTagPresentation("pw_wind_out", "positive").tone === "supporting");
  assert("pw_wind_in → risk", getPlateTagPresentation("pw_wind_in", "negative").tone === "risk");
  assert("pw_temp → supporting", getPlateTagPresentation("pw_temp", "positive").tone === "supporting");
  assert("pw_cold → risk", getPlateTagPresentation("pw_cold", "negative").tone === "risk");
  assert("mkt_hr → context", getPlateTagPresentation("mkt_hr", "neutral").tone === "context");
  assert("mkt_tb → context", getPlateTagPresentation("mkt_tb", "neutral").tone === "context");
  assert("near_hr_form_consecutive → standout", getPlateTagPresentation("near_hr_form_consecutive", "positive").tone === "standout");
  assert("lo_bottom → risk", getPlateTagPresentation("lo_bottom", "negative").tone === "risk");
  assert("neg_order_suppress → risk", getPlateTagPresentation("neg_order_suppress", "negative").tone === "risk");
}

console.log("\ngetPlateTagPresentation — exact label match (warningTags + day-keyed near-HR driver)");
{
  assert('"Near-HR Contact (Strong)" → standout', getPlateTagPresentation("Near-HR Contact (Strong)", "positive").tone === "standout");
  assert('"Near-HR Contact" → supporting', getPlateTagPresentation("Near-HR Contact", "positive").tone === "supporting");
  assert('"Matchup Downgrade" → risk', getPlateTagPresentation("Matchup Downgrade", "negative").tone === "risk");
  assert('"Batter Power Only" → context', getPlateTagPresentation("Batter Power Only", "negative").tone === "context");
  assert('"Needs Live Confirmation" → neutral', getPlateTagPresentation("Needs Live Confirmation", "negative").tone === "neutral");
  assert('"Poor BvP History" fallback → risk', getPlateTagPresentation("Poor BvP History", "negative").tone === "risk");
  assert('"Pitcher Slot Suppression" → risk', getPlateTagPresentation("Pitcher Slot Suppression", "negative").tone === "risk");
  assert('"Weak From Lineup Slot" → risk', getPlateTagPresentation("Weak From Lineup Slot", "negative").tone === "risk");
}

console.log("\ngetPlateTagPresentation — generic direction fallback for unrecognized tags");
{
  const pos = getPlateTagPresentation("totally_unknown_key", "positive");
  const neg = getPlateTagPresentation("totally_unknown_key", "negative");
  const neu = getPlateTagPresentation("totally_unknown_key", "neutral");
  assert("unrecognized positive → supporting (never standout)", pos.tone === "supporting");
  assert("unrecognized negative → risk", neg.tone === "risk");
  assert("unrecognized neutral → context", neu.tone === "context");
  assert("unrecognized classes trace to getPlateToneClasses", pos.classes === getPlateToneClasses("supporting"));
}

console.log("\ngetMarketTierPresentation");
{
  const elite = getMarketTierPresentation("Elite");
  assert("Elite → Prime / standout", elite.displayLabel === "Prime" && elite.tone === "standout");
  assert("Elite classes === getPlateToneClasses(standout)", elite.classes === getPlateToneClasses("standout"));

  const strong = getMarketTierPresentation("Strong");
  assert("Strong → Qualified / supporting (amber, not green)", strong.displayLabel === "Qualified" && strong.tone === "supporting");
  assert("Strong classes === getPlateToneClasses(supporting)", strong.classes === getPlateToneClasses("supporting"));

  const solid = getMarketTierPresentation("Solid");
  assert("Solid → Solid (text unchanged) / context (blue)", solid.displayLabel === "Solid" && solid.tone === "context");

  const watch = getMarketTierPresentation("Watch");
  assert("Watch → Watch / neutral", watch.displayLabel === "Watch" && watch.tone === "neutral");

  const missing = getMarketTierPresentation(undefined);
  assert("missing setupLabel → Watch / neutral (safe fallback)", missing.displayLabel === "Watch" && missing.tone === "neutral");
}

console.log("\ngetBvpPresentation — confidence (sample size) is separate from strength (direction)");
{
  assert("bvpAvailable=false → null (hidden, sample < 5)", getBvpPresentation({ bvpAvailable: false, bvpSampleSize: 2, bvpDirection: "positive" }) === null);
  assert("bvpSampleSize=null → null", getBvpPresentation({ bvpAvailable: true, bvpSampleSize: null, bvpDirection: "positive" }) === null);

  const limited5 = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 5, bvpDirection: "positive", bvpHits: 2 });
  assert("5 AB positive → context, Limited BvP", limited5?.tone === "context" && limited5.label.startsWith("Limited BvP"));

  const limited9neg = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 9, bvpDirection: "negative", bvpHits: 0 });
  assert("9 AB negative → still context/Limited (confidence, not strength)", limited9neg?.tone === "context" && limited9neg.label.startsWith("Limited BvP"));

  const positive10 = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 10, bvpDirection: "positive", bvpHits: 4 });
  assert("10 AB positive → supporting, Positive BvP", positive10?.tone === "supporting" && positive10.label.startsWith("Positive BvP"));
  assert("label includes hits fraction", positive10?.label === "Positive BvP — 4 H in 10 AB");

  const positive25 = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 25, bvpDirection: "positive", bvpHits: 8 });
  assert("25 AB positive → supporting, NOT standout", positive25?.tone === "supporting");

  const positive100 = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 100, bvpDirection: "positive", bvpHits: 30 });
  assert("100 AB positive → still supporting, NEVER standout at any sample size", positive100?.tone === "supporting");

  const negative15 = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 15, bvpDirection: "negative", bvpHits: 1 });
  assert("15 AB negative → risk, Poor BvP", negative15?.tone === "risk" && negative15.label.startsWith("Poor BvP"));
  assert("Poor BvP label format", negative15?.label === "Poor BvP — 1 H in 15 AB");

  const neutral12 = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 12, bvpDirection: "neutral", bvpHits: 3 });
  assert("12 AB neutral → neutral, Neutral BvP", neutral12?.tone === "neutral" && neutral12.label.startsWith("Neutral BvP"));

  const noHits = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 12, bvpDirection: "positive", bvpHits: undefined });
  assert("missing bvpHits degrades to AB-count-only label", noHits?.label === "Positive BvP (12 AB)");

  const nullHits = getBvpPresentation({ bvpAvailable: true, bvpSampleSize: 6, bvpDirection: "positive", bvpHits: null });
  assert("null bvpHits also degrades gracefully", nullHits?.label === "Limited BvP (6 AB)");

  // Every branch's classes must trace back to getPlateToneClasses.
  assert("supporting branch classes match canonical palette", positive10?.classes === getPlateToneClasses("supporting"));
  assert("risk branch classes match canonical palette", negative15?.classes === getPlateToneClasses("risk"));
}

console.log("\ngetCarryPresentation");
{
  const hrCarry = getCarryPresentation({ temperatureF: 89, windMph: 8, windDirectionLabel: "Out", carryLabel: "HR Carry", carryType: "boost" });
  assert("HR Carry → standout, 🔥", hrCarry.tone === "standout" && hrCarry.emoji === "🔥");

  const boost = getCarryPresentation({ temperatureF: 75, windMph: 3, windDirectionLabel: "Crosswind", carryLabel: "Carry Boost", carryType: "boost" });
  assert("Carry Boost → supporting", boost.tone === "supporting");

  const suppressed = getCarryPresentation({ temperatureF: 54, windMph: 14, windDirectionLabel: "In", carryLabel: "Carry Suppressed", carryType: "suppress" });
  assert("Carry Suppressed → risk", suppressed.tone === "risk");

  const neutralAir = getCarryPresentation({ temperatureF: null, windMph: null, windDirectionLabel: null, carryLabel: "Neutral Air", carryType: "neutral" });
  assert("Neutral Air → context", neutralAir.tone === "context");

  const neutralCond = getCarryPresentation({ temperatureF: 70, windMph: 2, windDirectionLabel: "Calm", carryLabel: "Neutral Conditions", carryType: "neutral" });
  assert("Neutral Conditions → neutral", neutralCond.tone === "neutral");

  const unavailable = getCarryPresentation(null);
  assert("null park → Conditions Unavailable / neutral (safe fallback)", unavailable.label === "Conditions Unavailable" && unavailable.tone === "neutral");
}

console.log("\ngetWeatherSecondaryPresentations(park, drivers) — driver-key aware, not string-matched");
{
  const parkHot = { temperatureF: 89, windMph: 8, windDirectionLabel: "Out to LF", carryLabel: "HR Carry" as const, carryType: "boost" as const };

  const windOut = getWeatherSecondaryPresentations(parkHot, [{ key: "pw_wind_out", direction: "positive" }, { key: "pw_temp", direction: "positive" }]);
  const windPill = windOut.find((p) => p.text.includes("mph"));
  const tempPill = windOut.find((p) => !p.text.includes("mph"));
  assert("pw_wind_out driver → wind pill supporting", windPill?.tone === "supporting");
  assert("pw_temp driver → temp pill supporting", tempPill?.tone === "supporting");

  const windIn = getWeatherSecondaryPresentations(parkHot, [{ key: "pw_wind_in", direction: "negative" }, { key: "pw_cold", direction: "negative" }]);
  const windInPill = windIn.find((p) => p.text.includes("mph"));
  const coldPill = windIn.find((p) => !p.text.includes("mph"));
  assert("pw_wind_in driver → wind pill risk", windInPill?.tone === "risk");
  assert("pw_cold driver → temp pill risk", coldPill?.tone === "risk");

  const noDriverButValues = getWeatherSecondaryPresentations(parkHot, []);
  assert("raw values present, no matching driver → context (informational)", noDriverButValues.every((p) => p.tone === "context"));

  const roofByDriver = getWeatherSecondaryPresentations(
    { temperatureF: 72, windMph: null, windDirectionLabel: null, carryLabel: "Neutral Air", carryType: "neutral" },
    [{ key: "pw_roof", direction: "neutral" }],
  );
  assert("pw_roof driver → single Roof Closed pill, neutral", roofByDriver.length === 1 && roofByDriver[0].text === "Roof Closed" && roofByDriver[0].tone === "neutral");

  // Documented fallback: no pw_roof driver present, but carryLabel says Neutral Air.
  const roofByLabelFallback = getWeatherSecondaryPresentations(
    { temperatureF: 72, windMph: 2, windDirectionLabel: "Calm", carryLabel: "Neutral Air", carryType: "neutral" },
    [],
  );
  assert("carryLabel Neutral Air fallback (no pw_roof driver) → still Roof Closed pill", roofByLabelFallback.length === 1 && roofByLabelFallback[0].text === "Roof Closed");

  const nothing = getWeatherSecondaryPresentations(
    { temperatureF: null, windMph: null, windDirectionLabel: null, carryLabel: "Conditions Unavailable", carryType: "unknown" },
    [],
  );
  assert("no driver, no raw value → no pills", nothing.length === 0);
}

console.log("\n=== " + (pass + fail) + " total, " + pass + " passed, " + fail + " failed ===");
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}

if (fail > 0) process.exit(1);
