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
  resolveMarketFitPresentation,
  getCarryPresentation,
  getWeatherSecondaryPresentations,
  getPlateDriverDisplayPriority,
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

console.log("\ngetMarketTierPresentation — real tiers, no invented Prime/Qualified");
{
  const elite = getMarketTierPresentation("Elite");
  assert("Elite → Elite / standout", elite.displayLabel === "Elite" && elite.tone === "standout");
  assert("Elite classes === getPlateToneClasses(standout)", elite.classes === getPlateToneClasses("standout"));

  const strong = getMarketTierPresentation("Strong");
  assert("Strong → Strong / supporting (amber, not green)", strong.displayLabel === "Strong" && strong.tone === "supporting");
  assert("Strong classes === getPlateToneClasses(supporting)", strong.classes === getPlateToneClasses("supporting"));

  const solid = getMarketTierPresentation("Solid");
  assert("Solid → Solid (text unchanged) / context (blue)", solid.displayLabel === "Solid" && solid.tone === "context");

  const watch = getMarketTierPresentation("Watch");
  assert("genuine server Watch → Below Solid / neutral", watch.displayLabel === "Below Solid" && watch.tone === "neutral");

  // No invented vocabulary at ANY tier.
  for (const l of ["Elite", "Strong", "Solid", "Watch"] as const) {
    const d = getMarketTierPresentation(l).displayLabel;
    assert(`${l} never renders "Prime"/"Qualified"`, d !== "Prime" && d !== "Qualified", d);
  }
}

console.log("\nresolveMarketFitPresentation — server setupLabel ONLY, never fabricated");
{
  assert("resolveMarketFitPresentation('Elite') → Elite", resolveMarketFitPresentation("Elite")?.displayLabel === "Elite");
  assert("resolveMarketFitPresentation('Strong') → Strong", resolveMarketFitPresentation("Strong")?.displayLabel === "Strong");
  assert("resolveMarketFitPresentation('Solid') → Solid", resolveMarketFitPresentation("Solid")?.displayLabel === "Solid");
  assert("resolveMarketFitPresentation('Watch') → Below Solid (genuine server label)", resolveMarketFitPresentation("Watch")?.displayLabel === "Below Solid");
  // Legacy payload: numeric score but NO server setupLabel → null so the UI shows
  // "unavailable" — the client must never invent a fit ("Below Solid") from a score.
  assert("legacy null setupLabel → null (unavailable, NOT fabricated)", resolveMarketFitPresentation(null) === null);
  assert("legacy undefined setupLabel → null (unavailable, NOT fabricated)", resolveMarketFitPresentation(undefined) === null);
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

  // Roof-closed games get carryLabel "Neutral Conditions" from parkWeatherScore.ts
  // (isIndoors branch), not "Neutral Air" — this fixture reflects the real pairing.
  const roofByDriver = getWeatherSecondaryPresentations(
    { temperatureF: 72, windMph: null, windDirectionLabel: null, carryLabel: "Neutral Conditions", carryType: "neutral" },
    [{ key: "pw_roof", direction: "neutral" }],
  );
  assert("pw_roof driver → single Roof Closed pill, neutral", roofByDriver.length === 1 && roofByDriver[0].text === "🏟️ Roof Closed" && roofByDriver[0].tone === "neutral");

  // Regression: PR review caught that "Neutral Air" was being misread as a
  // roof-closed signal. It's actually stamped for genuinely calm/mild OUTDOOR
  // weather (parkWeatherScore.ts's outdoor branch) — an ordinary open-air game
  // with no pw_roof driver must show its real temp/wind pills, never "Roof Closed".
  const calmOutdoorNoRoofDriver = getWeatherSecondaryPresentations(
    { temperatureF: 72, windMph: 2, windDirectionLabel: "Calm", carryLabel: "Neutral Air", carryType: "neutral" },
    [],
  );
  assert(
    "calm outdoor Neutral Air with no pw_roof driver → real temp/wind pills, NOT Roof Closed",
    calmOutdoorNoRoofDriver.length === 2 && calmOutdoorNoRoofDriver.every((p) => p.text !== "🏟️ Roof Closed"),
    JSON.stringify(calmOutdoorNoRoofDriver),
  );

  const nothing = getWeatherSecondaryPresentations(
    { temperatureF: null, windMph: null, windDirectionLabel: null, carryLabel: "Conditions Unavailable", carryType: "unknown" },
    [],
  );
  assert("no driver, no raw value → no pills", nothing.length === 0);
}

console.log("\ngetPlateTagPresentation — Attack Environment keys (server: attackEnvironment.ts)");
{
  assert("atkenv_power_env → attack", getPlateTagPresentation("atkenv_power_env", "positive").tone === "attack");
  assert("atkenv_extra_base_env → attack", getPlateTagPresentation("atkenv_extra_base_env", "positive").tone === "attack");
  assert("atkenv_weak_pitcher_park → attack", getPlateTagPresentation("atkenv_weak_pitcher_park", "positive").tone === "attack");
  assert("atkenv_weak_pitcher_carry → attack", getPlateTagPresentation("atkenv_weak_pitcher_carry", "positive").tone === "attack");
  assert("atkenv_hostile → risk", getPlateTagPresentation("atkenv_hostile", "negative").tone === "risk");
  const power = getPlateTagPresentation("atkenv_power_env", "positive");
  assert("atkenv_power_env classes trace to the attack palette", power.classes === getPlateToneClasses("attack"));
  assert("attack tone classes distinct from supporting (same rank, different color)", getPlateToneClasses("attack") !== getPlateToneClasses("supporting"));
}

console.log("\ngetPlateDriverDisplayPriority — Attack Environment chips survive the 4-chip cap");
{
  assert("atkenv_* always outranks standout", getPlateDriverDisplayPriority("atkenv_power_env", "attack") < getPlateDriverDisplayPriority("power_iso", "standout"));
  assert("atkenv_* always outranks risk", getPlateDriverDisplayPriority("atkenv_hostile", "risk") < getPlateDriverDisplayPriority("pw_wind_in", "risk"));
  assert("non-atkenv driver keeps its ordinary tone rank (standout < supporting)", getPlateDriverDisplayPriority("power_iso", "standout") < getPlateDriverDisplayPriority("power_barrel", "supporting"));
  assert("non-atkenv attack-toned driver ties with supporting (unchanged from PLATE_TAG_TONE_RANK)", getPlateDriverDisplayPriority("some_future_key", "attack") === getPlateDriverDisplayPriority("power_barrel", "supporting"));

  // Regression: on a card with 4 standout drivers already present, an
  // atkenv_* driver must still sort into the top 4 by simple ascending sort —
  // this is the concrete scenario the priority override exists to prevent.
  const chips = [
    { key: "power_iso", tone: "standout" as PlateTagTone },
    { key: "power_hrfb", tone: "standout" as PlateTagTone },
    { key: "fit_platoon", tone: "standout" as PlateTagTone },
    { key: "lo_top", tone: "standout" as PlateTagTone },
    { key: "atkenv_power_env", tone: "attack" as PlateTagTone },
  ];
  const sorted = chips.slice().sort((a, b) => getPlateDriverDisplayPriority(a.key, a.tone) - getPlateDriverDisplayPriority(b.key, b.tone));
  assert("atkenv_power_env sorts first even against 4 standout chips", sorted[0].key === "atkenv_power_env", JSON.stringify(sorted.map((c) => c.key)));
}

console.log("\n=== " + (pass + fail) + " total, " + pass + " passed, " + fail + " failed ===");
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}

if (fail > 0) process.exit(1);
