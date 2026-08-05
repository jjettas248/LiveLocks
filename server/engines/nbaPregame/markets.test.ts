// Run: npx tsx server/engines/nbaPregame/markets.test.ts
// Pregame Targets PR3 — NBA market registry: 8 launch markets, combo→component
// decomposition, standalone threes, documentation-only push/OT semantics, NO line.
import {
  NBA_BASE_STATS,
  NBA_JOINT_STATS,
  NBA_STANDALONE_STATS,
  NBA_COMBO_COMPONENTS,
  NBA_LAUNCH_MARKETS,
  NBA_MARKET_REGISTRY,
  getNbaMarketDefinition,
  isNbaMarketKey,
  isNbaBaseStat,
  isNbaComboMarketKey,
  isNbaJointStat,
  type NbaMarketKey,
} from "./markets";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── Launch set is exactly the 8 documented markets ──────────────────────────
{
  ok(NBA_LAUNCH_MARKETS.length === 8, "exactly 8 launch markets");
  const expected = ["points", "rebounds", "assists", "three_pointers_made", "pts_reb", "pts_ast", "reb_ast", "pra"];
  ok(expected.every((k) => (NBA_LAUNCH_MARKETS as readonly string[]).includes(k)), "all 8 expected keys present");
  ok(Object.keys(NBA_MARKET_REGISTRY).length === 8, "registry has 8 entries");
  ok(NBA_LAUNCH_MARKETS.every((k) => NBA_MARKET_REGISTRY[k] !== undefined), "every launch key resolves in registry");
}

// ── Base markets are single-stat ────────────────────────────────────────────
{
  for (const s of NBA_BASE_STATS) {
    const def = getNbaMarketDefinition(s as NbaMarketKey);
    ok(def.kind === "base", `${s} is a base market`);
    ok(def.components.length === 1 && def.components[0] === s, `${s} decomposes to itself`);
  }
  ok(NBA_BASE_STATS.length === 4, "4 base stats");
}

// ── Combo decomposition matches official box-score sums ─────────────────────
{
  ok(NBA_MARKET_REGISTRY.pts_reb.components.join("+") === "points+rebounds", "pts_reb = points+rebounds");
  ok(NBA_MARKET_REGISTRY.pts_ast.components.join("+") === "points+assists", "pts_ast = points+assists");
  ok(NBA_MARKET_REGISTRY.reb_ast.components.join("+") === "rebounds+assists", "reb_ast = rebounds+assists");
  ok(NBA_MARKET_REGISTRY.pra.components.join("+") === "points+rebounds+assists", "pra = points+rebounds+assists");
  for (const k of Object.keys(NBA_COMBO_COMPONENTS) as (keyof typeof NBA_COMBO_COMPONENTS)[]) {
    ok(NBA_MARKET_REGISTRY[k].kind === "combo", `${k} is a combo market`);
  }
}

// ── three_pointers_made is standalone — never a combo component ──────────────
{
  ok((NBA_STANDALONE_STATS as readonly string[]).includes("three_pointers_made"), "threes is a standalone stat");
  ok(!(NBA_JOINT_STATS as readonly string[]).includes("three_pointers_made"), "threes is NOT a joint stat");
  const everyComboComponent = Object.values(NBA_COMBO_COMPONENTS).flat();
  ok(!everyComboComponent.includes("three_pointers_made" as never), "no combo lists threes as a component");
  // The three joint stats are exactly points/rebounds/assists.
  ok(NBA_JOINT_STATS.length === 3, "3 joint stats");
  ok(["points", "rebounds", "assists"].every((s) => (NBA_JOINT_STATS as readonly string[]).includes(s)), "joint = pts/reb/ast");
}

// ── Every combo component is a JOINT stat (read off the shared joint) ────────
{
  for (const [key, comps] of Object.entries(NBA_COMBO_COMPONENTS)) {
    ok(comps.every((c) => isNbaJointStat(c)), `${key} components are all joint stats`);
  }
}

// ── Documentation-only push + OT semantics (no line, no computation) ─────────
{
  for (const k of NBA_LAUNCH_MARKETS) {
    const def = NBA_MARKET_REGISTRY[k];
    ok(def.pushesOnIntegerLine === true, `${k} documents integer-line push`);
    ok(def.includesOvertime === true, `${k} documents OT inclusion`);
    // Structurally proves NO line/price/EV field leaked into a market definition.
    const keys = Object.keys(def);
    const forbidden = ["line", "price", "odds", "over", "under", "push", "ev", "edge"];
    ok(!keys.some((kk) => forbidden.includes(kk)), `${k} definition carries no line/price/push-value field`);
  }
}

// ── Type guards ──────────────────────────────────────────────────────────────
{
  ok(isNbaMarketKey("pra") && !isNbaMarketKey("steals"), "isNbaMarketKey");
  ok(isNbaBaseStat("points") && !isNbaBaseStat("pra"), "isNbaBaseStat rejects a combo");
  ok(isNbaComboMarketKey("pts_reb") && !isNbaComboMarketKey("points"), "isNbaComboMarketKey rejects a base");
  ok(isNbaJointStat("rebounds") && !isNbaJointStat("three_pointers_made"), "isNbaJointStat rejects threes");
}

// ── Registry is frozen (metadata cannot be mutated at runtime) ───────────────
{
  ok(Object.isFrozen(NBA_MARKET_REGISTRY), "registry object is frozen");
}

console.log(`\nmarkets.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
