// Plate HR Probability V2 — label disposition rule invariants (PR 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2LabelRules.test.ts

import { derivePlateHrV2Label, type PlateHrV2LabelDecisionInput } from "./plateHrV2LabelRules";
import type { PlateHrV2BatterOutcomeFact } from "./plateHrV2OutcomeSource";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const BASE = {
  snapshotId: "plate-hr-v2:plate_hr_v2_features_v1:2026-07-20:g1:b1",
  labelVersion: "plate_hr_v2_label_v1",
  gameId: "g1",
  batterId: "b1",
  nowIso: "2026-07-21T04:00:00.000Z",
};

function batterFact(overrides: Partial<PlateHrV2BatterOutcomeFact> = {}): PlateHrV2BatterOutcomeFact {
  return {
    hasBoxScoreRow: true, ab: 4, bb: 0, paCountObserved: 4, hrCountToday: 0, firstHr: null,
    ...overrides,
  };
}

// ── 1. final + batter row + PA>0 + no HR -> resolved, hitHrToday:false ──────
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: batterFact(), anyBoxScoreRowsForGame: true,
  });
  ok(label.labelDisposition === "resolved", "final + PA>0 -> resolved");
  ok(label.resolutionReason === "game_final", "resolutionReason is game_final");
  ok(label.hitHrToday === false, "hitHrToday is a fully valid resolved false, not null");
  ok(label.resolvedAt === BASE.nowIso, "resolvedAt is stamped for a resolved row");
}

// ── 2. final + batter row + PA>0 + HR -> resolved, hitHrToday:true ──────────
{
  const firstHr = { inning: 4, half: "bottom" as const, plateAppearanceNumber: 2, firstAb: false };
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: batterFact({ hrCountToday: 1, firstHr }), anyBoxScoreRowsForGame: true,
  });
  ok(label.labelDisposition === "resolved" && label.hitHrToday === true, "final + HR -> resolved, hitHrToday:true");
  ok(label.hrInning === 4 && label.hrHalf === "bottom" && label.hrPlateAppearanceNumber === 2, "HR location fields populated from firstHr");
  ok(label.hrFirstAb === false, "hrFirstAb reflects firstHr.firstAb");
  ok(label.hrEventId === "plate-hr-v2-hr:g1:b1:2", "hrEventId synthesized deterministically");
}

// ── 3. final + batter row + PA=0 -> excluded/no_pa_recorded ─────────────────
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: batterFact({ ab: 0, bb: 0, paCountObserved: 0 }), anyBoxScoreRowsForGame: true,
  });
  ok(label.labelDisposition === "excluded" && label.resolutionReason === "no_pa_recorded", "final + PA=0 -> excluded/no_pa_recorded");
  ok(label.hitHrToday === null, "hitHrToday is null for an excluded row, never a fabricated boolean");
  ok(label.paCountObserved === 0, "paCountObserved is still preserved (0) even though excluded");
}

// ── 4. final + no batter row + other batters resolved -> excluded/no_pa_recorded (presumed scratch) ──
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: null, anyBoxScoreRowsForGame: true,
  });
  ok(label.labelDisposition === "excluded" && label.resolutionReason === "no_pa_recorded", "final + missing batter row but other rows exist -> presumed scratch");
  ok(label.paCountObserved === null && label.hrCountToday === null, "no batter facts available -> null, not fabricated");
}

// ── 5. final + no batter row + zero rows for the whole game -> excluded/identity_unresolved ──
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: null, anyBoxScoreRowsForGame: false,
  });
  ok(label.labelDisposition === "excluded" && label.resolutionReason === "identity_unresolved", "final + zero rows for the game -> identity_unresolved, distinct from a presumed scratch");
}

// ── 6. postponed -> censored/game_postponed ─────────────────────────────────
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "postponed", gamePk: "1" },
    batter: null, anyBoxScoreRowsForGame: false,
  });
  ok(label.labelDisposition === "censored" && label.resolutionReason === "game_postponed", "postponed -> censored/game_postponed");
  ok(label.hitHrToday === null, "censored rows never carry a hitHrToday value");
}

// ── 7. suspended (not final) -> censored/game_suspended_unresolved ─────────
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "suspended", gamePk: "1" },
    batter: null, anyBoxScoreRowsForGame: false,
  });
  ok(label.labelDisposition === "censored" && label.resolutionReason === "game_suspended_unresolved", "suspended -> censored/game_suspended_unresolved");
}

// ── 8. in_progress / unknown -> defensive manual_review fallback ───────────
{
  for (const status of ["in_progress", "unknown"] as const) {
    const label = derivePlateHrV2Label({
      ...BASE, game: { gameStatus: status, gamePk: "1" },
      batter: null, anyBoxScoreRowsForGame: false,
    });
    ok(label.labelDisposition === "manual_review", `${status} -> defensive manual_review fallback`);
    ok(label.resolvedAt === null, `${status} manual_review row has resolvedAt:null (not yet resolved)`);
  }
}

// ── 9. Multi-HR: hrCountToday reflects the full count, hrFirstAb/inning reflect only the FIRST ──
{
  const firstHr = { inning: 1, half: "top" as const, plateAppearanceNumber: 1, firstAb: true };
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: batterFact({ hrCountToday: 3, firstHr }), anyBoxScoreRowsForGame: true,
  });
  ok(label.hrCountToday === 3, "hrCountToday reflects the full multi-HR count");
  ok(label.hrFirstAb === true && label.hrPlateAppearanceNumber === 1, "HR location fields reflect only the first HR, not the 2nd/3rd");
}

// ── 10. Structural invariant: hrCountToday>0 never pairs with firstHr-derived nulls ──
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: batterFact({ hrCountToday: 1, firstHr: { inning: 2, half: "top", plateAppearanceNumber: 1, firstAb: true } }),
    anyBoxScoreRowsForGame: true,
  });
  ok(
    !(label.hrCountToday! > 0 && label.hrPlateAppearanceNumber === null),
    "hrCountToday>0 is never paired with a null hrPlateAppearanceNumber",
  );
}

// ── 11. Output always passes the real contract schema (every branch above already proves this via a thrown-on-failure .parse() inside derivePlateHrV2Label — this test proves it doesn't silently swallow a parse failure by checking labelSource is always a valid enum value) ──
{
  const label = derivePlateHrV2Label({
    ...BASE, game: { gameStatus: "final", gamePk: "1" },
    batter: batterFact(), anyBoxScoreRowsForGame: true,
  });
  ok(label.labelSource === "engine", "labelSource is always 'engine' — a human hasn't touched anything yet");
}

console.log(`\nplateHrV2LabelRules.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
