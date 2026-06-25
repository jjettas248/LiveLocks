// [MLB park/wind] Regression for Codex PR #40 P2 — Open-Meteo wind-shift override
// must propagate the fresh bearing and drop the stale MLB-feed sector text, so
// HR Radar stops applying an outdated LF/RF sector after a mid-game wind shift.
//
// Run with: npx tsx server/mlb/parkWindFitWeatherSync.test.ts
//
// Narrow by design: drives the REAL syncOpenMeteoWeather override branch with a
// stubbed fetch, then checks the cache mutation + the resulting park-wind fit.

import type { WeatherCache } from "./dataPullService";

// dataPullService → storage → db.ts requires DATABASE_URL at import. The pg Pool
// connects lazily, so a dummy URL lets the module load; this test never queries.
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const GAME_ID = "TEST_P2_WINDSHIFT";
const VENUE = "Yankee Stadium"; // outdoor, orientation 52° in STADIUM_COORDS
// Fresh Open-Meteo bearing chosen so it maps to a DIFFERENT outfield sector (RF)
// than the stale MLB-feed string ("Out To LF") — the whole point of the fix.
const FRESH_WIND_DEG = 282;

const realFetch = globalThis.fetch;

async function run() {
  // Dynamic import AFTER the DATABASE_URL default is set (ESM hoists static imports).
  const { mlbGameCache, syncOpenMeteoWeather } = await import("./dataPullService");
  const { resolveWindVector, computePlayerParkWindFit } = await import("./parkWindFit");

  // Seed an existing cache as the MLB-feed cold path would: a stale sector string
  // ("Out To LF"), a low wind speed, and no Open-Meteo bearing yet. Non-null
  // temperature forces syncOpenMeteoWeather down the existing-cache OVERRIDE branch.
  mlbGameCache.weather[GAME_ID] = {
    temperature: 75,
    windSpeed: 5,
    windDirection: "out",
    humidity: null,
    fetchedAt: Date.now(),
    venueName: VENUE,
    isIndoors: false,
    windString: "5 mph, Out To LF",
    windDegrees: null,
  } as WeatherCache;

  // Sanity: with the stale string present, the fit maps to LF (the bug's symptom).
  const before = resolveWindVector(
    { venueName: VENUE, windString: mlbGameCache.weather[GAME_ID].windString, windDegrees: mlbGameCache.weather[GAME_ID].windDegrees, windSpeedMph: 5 },
    52,
  );
  assert("precondition: stale windString maps to LF", before.sector === "LF", `got ${before.sector}`);

  // Stub fetch with a fresh Open-Meteo reading: wind picked up to 15 mph from a
  // bearing that is OUT TO RF for Yankee Stadium (drift 10mph ≥ 5 → override wins).
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      current: {
        temperature_2m: 78,
        wind_speed_10m: 15,
        wind_direction_10m: FRESH_WIND_DEG,
        relative_humidity_2m: 55,
        surface_pressure: 1012,
      },
      hourly: {},
      utc_offset_seconds: -14400,
    }),
  })) as unknown as typeof fetch;

  await syncOpenMeteoWeather(GAME_ID, VENUE);

  const c = mlbGameCache.weather[GAME_ID];

  // (1) fresh bearing copied
  assert("override copies fresh windDegrees", c.windDegrees === FRESH_WIND_DEG, `got ${c.windDegrees}`);
  // (2) stale sector string cleared
  assert("override clears stale windString", c.windString == null, `got ${JSON.stringify(c.windString)}`);
  // override actually fired (fresh speed installed)
  assert("override installed fresh wind speed", c.windSpeed === 15, `got ${c.windSpeed}`);

  // (3) resolveWindVector / park-wind fit now use the FRESH bearing (RF), not the
  // stale LF sector text.
  const after = resolveWindVector(
    { venueName: VENUE, windString: c.windString, windDegrees: c.windDegrees, windDirectionCoarse: c.windDirection, windSpeedMph: c.windSpeed },
    52,
  );
  assert("post-override wind vector uses fresh bearing → RF (not LF)", after.sector === "RF", `got ${after.sector}`);

  const fit = computePlayerParkWindFit({
    venueName: VENUE,
    batterHand: "R",
    pullRatePercent: 52,
    windString: c.windString,
    windDegrees: c.windDegrees,
    windDirectionCoarse: c.windDirection,
    windSpeedMph: c.windSpeed,
  });
  assert("post-override fit sector is RF (fresh), not LF (stale)", fit.windSector === "RF", `got ${fit.windSector}`);
  // RHH no longer gets a stale LF pull boost — RF wind is the wrong side for RHH.
  assert("RHH no longer gets stale LF pull-side boost", !/favors RHH pull/.test(fit.label), fit.label);

  // cleanup (cache is local to this scope)
  globalThis.fetch = realFetch;
  delete mlbGameCache.weather[GAME_ID];
}

run()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    globalThis.fetch = realFetch;
    console.log(`\n[parkWindFitWeatherSync] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
    if (failed > 0) process.exit(1);
  });
