// Run: npx tsx server/pregameTargets/featureStore/leakageFirewall.test.ts
import type { AsOfFeatureRow } from "../../../shared/pregameTargets/featureStore";
import {
  checkFeatureLeakage,
  isLeakageSafe,
  partitionByLeakage,
  type LeakageContext,
} from "./leakageFirewall";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function row(over: Partial<AsOfFeatureRow> = {}): AsOfFeatureRow {
  return {
    sport: "nba",
    entityCanonicalId: "nba:player:1",
    entityKind: "player",
    featureKey: "nba.player.reb_per_min",
    featureVersion: "v1",
    season: 2026,
    validAt: "2026-01-10T02:30:00.000Z",
    knownAt: "2026-01-10T05:00:00.000Z",
    state: "observed",
    value: 0.18,
    sourceId: "snap-1",
    ...over,
  };
}
const PREDICTION_AT = "2026-01-12T18:00:00.000Z";
const ctx = (over: Partial<LeakageContext> = {}): LeakageContext => ({ predictionAt: PREDICTION_AT, ...over });

// ── The happy path ───────────────────────────────────────────────────────────
{
  ok(isLeakageSafe(row(), ctx()), "a reading known before the decision is safe");
}

// ── future_knownAt ───────────────────────────────────────────────────────────
{
  const r = checkFeatureLeakage(row({ knownAt: "2026-01-13T00:00:00.000Z" }), ctx());
  ok(!r.ok && r.violations.includes("future_knownAt"), "knownAt after predictionAt → future_knownAt");
  // Exactly at the decision instant is allowed (<=).
  ok(isLeakageSafe(row({ knownAt: PREDICTION_AT }), ctx()), "knownAt == predictionAt is allowed");
}

// ── knownAt_before_validAt ───────────────────────────────────────────────────
{
  const r = checkFeatureLeakage(row({ validAt: "2026-01-10T06:00:00.000Z", knownAt: "2026-01-10T05:00:00.000Z" }), ctx());
  ok(!r.ok && r.violations.includes("knownAt_before_validAt"), "observed before it happened → knownAt_before_validAt");
}

// ── same_game_self_update ────────────────────────────────────────────────────
{
  const r = checkFeatureLeakage(
    row({ derivedFromGameIds: ["nba:game:A", "nba:game:TARGET"] }),
    ctx({ targetGameId: "nba:game:TARGET" }),
  );
  ok(!r.ok && r.violations.includes("same_game_self_update"), "provenance includes the target game → self_update");
  ok(
    isLeakageSafe(row({ derivedFromGameIds: ["nba:game:A", "nba:game:B"] }), ctx({ targetGameId: "nba:game:TARGET" })),
    "provenance without the target game is safe",
  );
  ok(isLeakageSafe(row(), ctx({ targetGameId: "nba:game:TARGET" })), "no provenance recorded → not self_update");
}

// ── outcome_in_input ─────────────────────────────────────────────────────────
{
  const r = checkFeatureLeakage(
    row({ featureKey: "nba.player.pts_actual" }),
    ctx({ outcomeFeatureKeys: new Set(["nba.player.pts_actual"]) }),
  );
  ok(!r.ok && r.violations.includes("outcome_in_input"), "a declared-outcome key used as input → outcome_in_input");
}

// ── structural / malformed ───────────────────────────────────────────────────
{
  const r1 = checkFeatureLeakage(row({ state: "observed", value: null }), ctx());
  ok(!r1.ok && r1.violations.includes("structural_invalid"), "broken state↔value pairing → structural_invalid");
  const r2 = checkFeatureLeakage(row({ knownAt: "nonsense" }), ctx());
  ok(!r2.ok && r2.violations.includes("malformed_instants"), "unparseable instant → malformed_instants");
  // A state outside the enum (typo) can no longer clear the firewall.
  const r3 = checkFeatureLeakage(row({ state: "observd" as never, value: null }), ctx());
  ok(!r3.ok && r3.violations.includes("structural_invalid"), "enum-invalid state → structural_invalid (cannot enter inputs)");
}

// ── multiple violations are all reported ─────────────────────────────────────
{
  const r = checkFeatureLeakage(
    row({ knownAt: "2026-01-14T00:00:00.000Z", validAt: "2026-01-15T00:00:00.000Z", state: "missing", value: 3 }),
    ctx(),
  );
  ok(!r.ok && r.violations.length >= 3, "all applicable violations are surfaced together");
}

// ── partition: safe vs rejected; a rejected reading is a genuine absence ──────
{
  const safe = row({ featureKey: "f.safe" });
  const leaky = row({ featureKey: "f.leaky", knownAt: "2026-01-20T00:00:00.000Z" });
  const part = partitionByLeakage([safe, leaky], ctx());
  ok(part.safe.length === 1 && part.safe[0].featureKey === "f.safe", "safe reading passes");
  ok(part.rejected.length === 1 && part.rejected[0].row.featureKey === "f.leaky", "leaky reading is rejected with reasons");
}

// ── missing vs observed_zero: both structurally fine, both pass the firewall ──
{
  ok(isLeakageSafe(row({ state: "observed_zero", value: 0 }), ctx()), "observed_zero passes the firewall");
  ok(isLeakageSafe(row({ state: "missing", value: null }), ctx()), "missing passes the firewall (it's a valid state, not a leak)");
  // The firewall never coerces one into the other — it only accepts/rejects.
  const both = partitionByLeakage(
    [row({ featureKey: "z", state: "observed_zero", value: 0 }), row({ featureKey: "m", state: "missing", value: null })],
    ctx(),
  );
  ok(both.safe.length === 2, "observed_zero and missing are both preserved distinctly, never merged");
}

console.log(`\nleakageFirewall.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
