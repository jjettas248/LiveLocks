// Run: npx tsx server/pregameTargets/replay/liveReplayParity.test.ts
//
// The parity guarantee: reconstructing a decision "live" (a store holding only
// what had arrived by the decision instant) and "replay" (a store holding the
// entire history, filtered by knownAt) must produce byte-identical inputs —
// because both go through the same AsOfFeatureStore.buildInputSet path.

import type { AsOfFeatureRow } from "../../../shared/pregameTargets/featureStore";
import { instantMs } from "../../../shared/pregameTargets/featureStore";
import { createInMemoryAsOfFeatureStore } from "../featureStore/asOfFeatureStore";
import {
  replayOrigin,
  replayRollingOrigins,
  serializeReplayResult,
  type ReplayOrigin,
} from "./historicalReplayHarness";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function feat(over: Partial<AsOfFeatureRow>): AsOfFeatureRow {
  return {
    sport: "nba",
    entityCanonicalId: "nba:player:1",
    entityKind: "player",
    featureKey: "f",
    featureVersion: "v1",
    season: 2026,
    validAt: "2026-01-10T02:30:00.000Z",
    knownAt: "2026-01-11T00:00:00.000Z",
    state: "observed",
    value: 0.1,
    sourceId: "s",
    ...over,
  };
}

const T = "2026-01-12T18:00:00.000Z";
const beforeT = "2026-01-11T00:00:00.000Z";
const afterT = "2026-01-13T00:00:00.000Z";

// Full history: f1 has an early reading AND a later correction; f2 arrives only
// after the decision; f3 is a valid early reading derived from the target game.
const history: AsOfFeatureRow[] = [
  feat({ featureKey: "f1", knownAt: beforeT, value: 0.1, sourceId: "s1" }),
  feat({ featureKey: "f1", knownAt: afterT, value: 0.99, sourceId: "s2" }), // correction, after T
  feat({ featureKey: "f2", knownAt: afterT, value: 0.2, sourceId: "s3" }), // only known after T
  feat({ featureKey: "f3", knownAt: beforeT, value: 0.3, sourceId: "s4", derivedFromGameIds: ["nba:game:TARGET"] }),
];

const origin: ReplayOrigin = {
  sport: "nba",
  entityCanonicalId: "nba:player:1",
  predictionAt: T,
  featureKeys: ["f1", "f2", "f3"],
  targetGameId: "nba:game:TARGET",
};

// ── Live vs replay produce byte-identical reconstructions ────────────────────
{
  const replayStore = createInMemoryAsOfFeatureStore();
  replayStore.writeMany(history); // knows everything

  const liveStore = createInMemoryAsOfFeatureStore();
  liveStore.writeMany(history.filter((r) => instantMs(r.knownAt) <= instantMs(T))); // only what had arrived

  const replayResult = replayOrigin(replayStore, origin);
  const liveResult = replayOrigin(liveStore, origin);
  ok(
    serializeReplayResult(replayResult) === serializeReplayResult(liveResult),
    "live and replay reconstructions are byte-identical",
  );

  // And the reconstruction is CORRECT for T:
  ok(replayResult.features.f1?.value === 0.1, "f1 uses the pre-decision reading, not the later correction");
  ok(replayResult.features.f1?.sourceId === "s1", "f1 source is the early snapshot");
  ok(replayResult.missing.includes("f2"), "f2 (known only after T) is missing at T");
  ok(!("f3" in replayResult.features) && replayResult.missing.includes("f3"), "f3 (target-game self-update) is rejected → missing");
  ok(replayResult.rejected.some((r) => r.featureKey === "f3" && r.violations.includes("same_game_self_update")), "f3 rejection reason recorded");
}

// ── Corrections apply monotonically: a later decision sees the correction ─────
{
  const store = createInMemoryAsOfFeatureStore();
  store.writeMany(history);
  const laterOrigin: ReplayOrigin = { ...origin, predictionAt: "2026-01-14T00:00:00.000Z", featureKeys: ["f1"] };
  const later = replayOrigin(store, laterOrigin);
  ok(later.features.f1?.value === 0.99 && later.features.f1?.sourceId === "s2", "after the correction's knownAt, the as-of read returns the corrected value");
}

// ── Determinism: same store + origin → identical serialization, any insert order
{
  const a = createInMemoryAsOfFeatureStore();
  a.writeMany(history);
  const b = createInMemoryAsOfFeatureStore();
  b.writeMany([...history].reverse());
  ok(
    serializeReplayResult(replayOrigin(a, origin)) === serializeReplayResult(replayOrigin(b, origin)),
    "reconstruction is independent of row insertion order",
  );
}

// ── Rolling origins are ordered by predictionAt and each is as-of correct ────
{
  const store = createInMemoryAsOfFeatureStore();
  store.writeMany(history);
  const origins: ReplayOrigin[] = [
    { ...origin, predictionAt: "2026-01-14T00:00:00.000Z", featureKeys: ["f1"] },
    { ...origin, predictionAt: T, featureKeys: ["f1"] },
  ];
  const results = replayRollingOrigins(store, origins);
  ok(results[0].predictionAt === T, "rolling origins are processed in ascending predictionAt order");
  ok(results[0].features.f1?.value === 0.1, "earlier origin sees the pre-correction value");
  ok(results[1].features.f1?.value === 0.99, "later origin sees the corrected value");
}

// ── Tie-break determinism when two readings share knownAt ────────────────────
{
  const store = createInMemoryAsOfFeatureStore();
  store.writeMany([
    feat({ featureKey: "tie", knownAt: beforeT, validAt: "2026-01-10T00:00:00.000Z", value: 1, sourceId: "aaa" }),
    feat({ featureKey: "tie", knownAt: beforeT, validAt: "2026-01-10T00:00:00.000Z", value: 2, sourceId: "bbb" }),
  ]);
  const r = replayOrigin(store, { ...origin, featureKeys: ["tie"], targetGameId: undefined });
  ok(r.features.tie?.sourceId === "bbb", "identical knownAt+validAt tie-breaks deterministically by sourceId");
}

// ── Stored rows are detached from caller mutation (append-only immutability) ─
{
  const store = createInMemoryAsOfFeatureStore();
  const mutable = feat({ featureKey: "mut", knownAt: beforeT, value: 0.5, sourceId: "sm", derivedFromGameIds: ["g1"] });
  store.write(mutable);
  const o: ReplayOrigin = { ...origin, featureKeys: ["mut"], targetGameId: undefined };
  const before = serializeReplayResult(replayOrigin(store, o));
  // Caller mutates its OWN object after handing it to write().
  (mutable as { value: number }).value = 999;
  const after = serializeReplayResult(replayOrigin(store, o));
  ok(before === after, "mutating the caller's row after write does not change stored/replayed history");
  ok(Object.isFrozen(store.all()[0]), "stored rows are frozen (append-only; a correction is a new row)");
}

console.log(`\nliveReplayParity.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
