// Characterization test for buildMlbEdgeEntriesDebugView — pins the exact
// output shapes the two admin debug routes depend on:
//   GET /api/admin/live-debug        — the full MlbEdgeDebugEntry (superset)
//   GET /api/admin/mlb-live-debug    — the same entries minus `sport`/`preservedAt`
// (routes.ts derives the mlb-live-debug shape via destructuring omission —
// this test mirrors that same omission rather than re-deriving field logic,
// so it catches any accidental shape drift in either route.)
// Run: npx tsx server/mlb/edgeCacheDebugView.test.ts

import { buildMlbEdgeEntriesDebugView, type MlbEdgeDebugCacheEntryInput } from "./edgeCacheDebugView";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_EDGE_DEBUG_VIEW_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

const NOW = 1_700_000_000_000;

const fixtures: Array<[string, MlbEdgeDebugCacheEntryInput]> = [
  // 1. Fully populated entry, preservedAt set, arrays non-empty.
  [
    "746376",
    {
      updatedAt: NOW - 5_000,
      createdAt: NOW - 60_000,
      outputs: [{}, {}],
      qualifiedSignals: [{}],
      allSignals: [{}, {}, {}],
      isDegraded: false,
      signalLocked: true,
      preservedAt: NOW - 5_000,
      gameCardTags: ["live", "close_game"],
    },
  ],
  // 2. No preservedAt, no tags, isDegraded true — exercises every `?? default`.
  [
    "746377",
    {
      updatedAt: NOW - 120_000,
      createdAt: NOW - 200_000,
      isDegraded: true,
    },
  ],
  // 3. updatedAt = 0 — the ageSec-null branch (falsy updatedAt).
  [
    "746378",
    {
      updatedAt: 0,
      createdAt: NOW - 10_000,
      outputs: [],
      qualifiedSignals: [],
      allSignals: [],
      isDegraded: false,
      signalLocked: false,
      gameCardTags: [],
    },
  ],
];

const view = buildMlbEdgeEntriesDebugView(fixtures, NOW);

// ─── Group A: shape + ordering ─────────────────────────────────────────────
{
  check("A1: one entry per input pair, in input order", view.length === 3 && view.map((e) => e.gameId).join(",") === "746376,746377,746378");
}

// ─── Group B: /api/admin/live-debug full superset shape ────────────────────
{
  const e1 = view[0];
  check(
    "B1: entry keys are exactly the expected superset",
    JSON.stringify(Object.keys(e1).sort()) ===
      JSON.stringify(["ageSec", "allSignals", "createdAt", "gameId", "isDegraded", "outputs", "preservedAt", "qualifiedSignals", "signalLocked", "sport", "tags", "updatedAt"].sort()),
  );
  check("B2: sport is stamped 'mlb'", e1.sport === "mlb");
  check("B3: gameId passes through from the entry key", e1.gameId === "746376");
  check("B4: ageSec computed from now - updatedAt", e1.ageSec === 5);
  check("B5: array fields reduced to counts", e1.outputs === 2 && e1.qualifiedSignals === 1 && e1.allSignals === 3);
  check("B6: preservedAt passed through when set", e1.preservedAt === NOW - 5_000);
  check("B7: tags passed through", JSON.stringify(e1.tags) === JSON.stringify(["live", "close_game"]));

  const e2 = view[1];
  check("B8: missing arrays default to count 0", e2.outputs === 0 && e2.qualifiedSignals === 0 && e2.allSignals === 0);
  check("B9: missing signalLocked defaults to false", e2.signalLocked === false);
  check("B10: isDegraded true passes through", e2.isDegraded === true);
  check("B11: missing preservedAt defaults to null (not undefined)", e2.preservedAt === null);
  check("B12: missing gameCardTags defaults to []", JSON.stringify(e2.tags) === "[]");

  const e3 = view[2];
  check("B13: falsy updatedAt (0) yields ageSec null", e3.ageSec === null);
}

// ─── Group C: /api/admin/mlb-live-debug narrower shape ──────────────────────
// Mirrors routes.ts's own destructuring omission exactly.
{
  const narrowed = view.map(({ sport: _sport, preservedAt: _preservedAt, ...rest }) => rest);
  const n1 = narrowed[0];
  check("C1: omits sport and preservedAt", !("sport" in n1) && !("preservedAt" in n1));
  check(
    "C2: keeps every other field byte-identical to the live-debug shape",
    JSON.stringify(Object.keys(n1).sort()) ===
      JSON.stringify(["ageSec", "allSignals", "createdAt", "gameId", "isDegraded", "outputs", "qualifiedSignals", "signalLocked", "tags", "updatedAt"].sort()),
  );
  check("C3: gameId/ageSec/counts unaffected by the omission", n1.gameId === "746376" && n1.ageSec === 5 && n1.outputs === 2);
}

console.log(`[MLB_EDGE_DEBUG_VIEW_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[MLB_EDGE_DEBUG_VIEW_TEST] OK");
