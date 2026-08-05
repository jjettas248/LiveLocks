// Run: npx tsx server/engines/nbaPregame/frozenNbaProjectionInput.test.ts
// Pregame Targets PR3 — frozen input + canonical hashing: feature hash vs
// projection hash (distinct), envelope excluded, explicit -0/NaN/Inf/undefined
// serialization, deep freeze, byte-identical output for byte-identical input,
// fail-closed on a forbidden price/EV key.
import {
  buildFrozenNbaProjectionInput,
  computeFeatureHash,
  computeProjectionHash,
  stableStringify,
  carriesForbiddenKey,
  deepFreeze,
  NBA_PREGAME_MODEL_VERSION,
  type BuildFrozenNbaInputArgs,
  type FrozenStatInput,
  type FrozenMinutesInput,
  type ProjectionHashPayload,
} from "./frozenNbaProjectionInput";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const STATS: FrozenStatInput[] = [
  { stat: "points", reason: "available", projected: true, ess: 20, rateMean: 0.6, rateVariance: 0.02, moments: { mean: 21, variance: 40 } },
  { stat: "rebounds", reason: "available", projected: true, ess: 18, rateMean: 0.24, rateVariance: 0.01, moments: { mean: 8, variance: 16 } },
];
const MINUTES: FrozenMinutesInput = {
  playerId: "star",
  support: [
    { minutes: 30, prob: 0.25 },
    { minutes: 34, prob: 0.5 },
    { minutes: 38, prob: 0.25 },
  ],
  expectedMinutes: 34,
  dnpProbability: 0,
};

const baseArgs = (over: Partial<BuildFrozenNbaInputArgs> = {}): BuildFrozenNbaInputArgs => ({
  snapshotId: "snap-1",
  capturedAt: "2026-08-05T18:00:00Z",
  playerCanonicalId: "nba:player:1",
  gameCanonicalId: "nba:game:401",
  season: 2026,
  latentStrength: 0.02,
  truncationCaps: { points: 80, rebounds: 40, assists: 30, three_pointers_made: 15 },
  stats: STATS,
  minutes: MINUTES,
  ...over,
});

// ── stableStringify: explicit lossy-value handling (bareword sentinels) ─────
{
  ok(stableStringify(undefined) === "@undefined", "undefined → bareword sentinel");
  ok(stableStringify(NaN) === "@NaN", "NaN → bareword sentinel");
  ok(stableStringify(Infinity) === "@Infinity", "Infinity → bareword sentinel");
  ok(stableStringify(-Infinity) === "@-Infinity", "-Infinity → bareword sentinel");
  ok(stableStringify(-0) === "0", "-0 normalized to 0");
  ok(stableStringify(0) === "0", "+0 is 0");
  // NaN, Infinity, undefined, null all serialize DISTINCTLY (no collision).
  const forms = new Set([stableStringify(NaN), stableStringify(Infinity), stableStringify(-Infinity), stableStringify(undefined), stableStringify(null)]);
  ok(forms.size === 5, "NaN/Inf/-Inf/undefined/null serialize to 5 distinct forms");
  // HARDENING: a special-value token can NEVER collide with a legitimate string
  // identity — the string is always quoted, the token never is.
  ok(stableStringify(NaN) !== stableStringify("@NaN"), "NaN token != the string \"@NaN\"");
  ok(stableStringify(NaN) !== stableStringify("__NaN__"), "NaN token != the string \"__NaN__\"");
  ok(stableStringify(undefined) !== stableStringify("@undefined"), "undefined token != the string \"@undefined\"");
  ok(stableStringify(Infinity) !== stableStringify("@Infinity"), "Infinity token != the string \"@Infinity\"");
  ok(stableStringify(null) !== stableStringify("null"), "null != the string \"null\"");
  // A value carrying the sentinel STRING hashes differently from the special number.
  ok(
    stableStringify({ v: NaN }) !== stableStringify({ v: "@NaN" }),
    "object with NaN differs from object with the string \"@NaN\"",
  );
  // Key ordering is deterministic.
  ok(stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }), "object key order does not matter");
}

// ── Feature hash: deterministic, envelope-excluded ──────────────────────────
{
  const a = buildFrozenNbaProjectionInput(baseArgs());
  const b = buildFrozenNbaProjectionInput(baseArgs({ snapshotId: "snap-2", capturedAt: "2026-08-05T23:59:00Z" }));
  ok(a.featureHash === b.featureHash, "feature hash excludes snapshotId + capturedAt (envelope)");
  ok(typeof a.featureHash === "string" && a.featureHash.length === 64, "feature hash is a sha256 hex string");
  // A PMF-altering change DOES move the hash.
  const c = buildFrozenNbaProjectionInput(baseArgs({ latentStrength: 0.03 }));
  ok(a.featureHash !== c.featureHash, "latentStrength change moves the feature hash");
  const d = buildFrozenNbaProjectionInput(baseArgs({ minutes: { ...MINUTES, expectedMinutes: 33 } }));
  ok(a.featureHash !== d.featureHash, "minutes change moves the feature hash");
  // The standalone threes cap is a PMF-altering input and MUST be hashed.
  const e = buildFrozenNbaProjectionInput(baseArgs({ truncationCaps: { points: 80, rebounds: 40, assists: 30, three_pointers_made: 20 } }));
  ok(a.featureHash !== e.featureHash, "changing the threes truncation cap moves the feature hash");
  const jointCapChange = buildFrozenNbaProjectionInput(baseArgs({ truncationCaps: { points: 90, rebounds: 40, assists: 30, three_pointers_made: 15 } }));
  ok(a.featureHash !== jointCapChange.featureHash, "changing a joint truncation cap moves the feature hash");
}

// ── Byte-identical semantic input → byte-identical serialization + hash ─────
{
  const a = buildFrozenNbaProjectionInput(baseArgs());
  const b = buildFrozenNbaProjectionInput(baseArgs());
  ok(computeFeatureHash(a) === computeFeatureHash(b), "identical semantic input → identical feature hash");
}

// ── Projection hash: distinct from feature hash, output-derived ─────────────
{
  const input = buildFrozenNbaProjectionInput(baseArgs());
  const payload: ProjectionHashPayload = {
    modelVersion: NBA_PREGAME_MODEL_VERSION,
    featureHash: input.featureHash,
    markets: [
      { market: "points", available: true, reason: "available", pmf: [0.1, 0.2, 0.7], mean: 21, variance: 40 },
      { market: "rebounds", available: true, reason: "available", pmf: [0.3, 0.4, 0.3], mean: 8, variance: 16 },
    ],
  };
  const projHash = computeProjectionHash(payload);
  ok(projHash !== input.featureHash, "projection hash is NOT the feature hash");
  ok(projHash.length === 64, "projection hash is sha256 hex");
  // Market ordering does not matter.
  const reordered: ProjectionHashPayload = { ...payload, markets: [payload.markets[1], payload.markets[0]] };
  ok(computeProjectionHash(reordered) === projHash, "projection hash is market-order-independent");
  // A changed output PMF moves the projection hash but NOT the feature hash.
  const changed: ProjectionHashPayload = {
    ...payload,
    markets: [{ ...payload.markets[0], pmf: [0.2, 0.2, 0.6] }, payload.markets[1]],
  };
  ok(computeProjectionHash(changed) !== projHash, "changed output PMF moves the projection hash");
  // Reason-code change alone moves the projection hash (availability states hashed).
  const reasonChanged: ProjectionHashPayload = {
    ...payload,
    markets: [{ ...payload.markets[0], reason: "prior_dominant" }, payload.markets[1]],
  };
  ok(computeProjectionHash(reasonChanged) !== projHash, "reason-code change moves the projection hash");
}

// ── Deep freeze: nested mutation is blocked ─────────────────────────────────
{
  const input = buildFrozenNbaProjectionInput(baseArgs());
  ok(Object.isFrozen(input), "top-level frozen");
  ok(Object.isFrozen(input.stats) && Object.isFrozen(input.stats[0]), "nested stats frozen");
  ok(Object.isFrozen(input.minutes.support) && Object.isFrozen(input.minutes.support[0]), "nested minutes support frozen");
  let mutated = false;
  try {
    (input.stats[0] as unknown as { ess: number }).ess = 999;
    mutated = input.stats[0].ess === 999;
  } catch {
    mutated = false;
  }
  ok(!mutated, "frozen nested field cannot be mutated");
  // deepFreeze idempotent on an already-frozen value.
  ok(deepFreeze(input) === input, "deepFreeze returns the same reference");
}

// ── Blindness: fail closed on a forbidden price/EV/line key ─────────────────
{
  ok(!carriesForbiddenKey(baseArgs()), "clean args carry no forbidden key");
  ok(carriesForbiddenKey({ meta: { americanOdds: -110 } }), "nested americanOdds caught");
  ok(carriesForbiddenKey({ legs: [{ line: 24.5 }] }), "array-nested line caught");
  ok(carriesForbiddenKey({ Sportsbook: "dk" }), "case-insensitive sportsbook caught");
  // The builder throws if a forbidden key is smuggled into the semantic payload.
  const leaky = baseArgs({ minutes: { ...MINUTES, ...( { line: 24.5 } as object) } as FrozenMinutesInput });
  ok(throws(() => buildFrozenNbaProjectionInput(leaky)), "builder throws when a forbidden key leaks in");
  // No forbidden key on a legitimately-built input.
  ok(!carriesForbiddenKey(buildFrozenNbaProjectionInput(baseArgs())), "built input is blind");
}

console.log(`\nfrozenNbaProjectionInput.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
