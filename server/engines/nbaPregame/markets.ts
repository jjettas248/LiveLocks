// PR3 — NBA Pregame Targets: launch market registry.
//
// The canonical, line-free definition of the 8 launch player-prop markets the
// blind projection core produces distributions for. This module is PURE
// METADATA + STRUCTURE: it names the markets, decomposes each combo into its
// official component base stats, and DOCUMENTS (only) the push-on-integer and
// overtime-inclusion semantics that the DECISION layer (PR4) will act on. It
// deliberately contains NO line, no push-mass computation, no OVER/UNDER
// probability, and no odds — a market's registry entry never sees a betting
// line. Push-on-integer is described here so the eventual PR4 line-decision
// layer has an authoritative source; PR3 never evaluates it.
//
// Two structural facts this registry locks (see joint/pointsReboundsAssistsJoint.ts):
//   1. The three "joint" base stats — points, rebounds, assists — are modeled by
//      a single shared joint distribution, because a combo like points+rebounds
//      is a sum of CORRELATED components and must be read off joint states, never
//      convolved from separated marginals.
//   2. three_pointers_made is a STANDALONE base stat. It is NEVER a component of
//      any combo, and points must never be modeled as an independent sum that
//      includes made threes (a three already counts inside points).

/** The four base (single-stat) markets the engine models directly. */
export const NBA_BASE_STATS = ["points", "rebounds", "assists", "three_pointers_made"] as const;
export type NbaBaseStat = (typeof NBA_BASE_STATS)[number];

/**
 * The three base stats that share ONE correlated joint distribution. Every combo
 * market is a sum over a subset of these three — so combos are read off the
 * joint's states (preserving covariance), never built by convolving independent
 * marginals. three_pointers_made is intentionally excluded: it is standalone.
 */
export const NBA_JOINT_STATS = ["points", "rebounds", "assists"] as const;
export type NbaJointStat = (typeof NBA_JOINT_STATS)[number];

/** Base stats modeled on their own, not as part of the (pts,reb,ast) joint. */
export const NBA_STANDALONE_STATS = ["three_pointers_made"] as const;
export type NbaStandaloneStat = (typeof NBA_STANDALONE_STATS)[number];

/** The two combo (multi-stat sum) markets' component decomposition. */
export const NBA_COMBO_COMPONENTS = {
  pts_reb: ["points", "rebounds"],
  pts_ast: ["points", "assists"],
  reb_ast: ["rebounds", "assists"],
  pra: ["points", "rebounds", "assists"],
} as const satisfies Record<string, readonly NbaJointStat[]>;

export type NbaComboMarketKey = keyof typeof NBA_COMBO_COMPONENTS;

/** All 8 launch market keys (4 base + 4 combo). */
export const NBA_LAUNCH_MARKETS = [
  "points",
  "rebounds",
  "assists",
  "three_pointers_made",
  "pts_reb",
  "pts_ast",
  "reb_ast",
  "pra",
] as const;
export type NbaMarketKey = (typeof NBA_LAUNCH_MARKETS)[number];

export type NbaMarketKind = "base" | "combo";

export interface NbaMarketDefinition {
  key: NbaMarketKey;
  kind: NbaMarketKind;
  /**
   * The official component base stats summed to produce this market's count. For
   * a base market this is the single stat itself; for a combo it is the ordered
   * list of joint components. This is the OFFICIAL box-score definition — e.g.
   * `pra = points + rebounds + assists` — not a modeling choice.
   */
  components: readonly NbaBaseStat[];
  /**
   * DOCUMENTATION ONLY. Official NBA player props settle on integer or half
   * lines; on an INTEGER posted line the exact count pushes. PR3 emits only the
   * line-free count PMF — it never receives a line and never computes push mass.
   * The PR4 decision layer reads this flag to know push evaluation is required
   * for an integer line. All 8 launch markets are integer-pushable.
   */
  pushesOnIntegerLine: true;
  /**
   * DOCUMENTATION ONLY. Official box-score totals INCLUDE overtime. The engine's
   * minutes model therefore carries OT as probability mass (see
   * minutes/teamMinutesAllocator.ts), not as a flat bonus; this flag records
   * that the settled stat is OT-inclusive so no downstream layer strips it.
   */
  includesOvertime: true;
}

const BASE_DEF = (key: NbaBaseStat): NbaMarketDefinition => ({
  key,
  kind: "base",
  components: [key],
  pushesOnIntegerLine: true,
  includesOvertime: true,
});

const COMBO_DEF = (key: NbaComboMarketKey): NbaMarketDefinition => ({
  key,
  kind: "combo",
  components: NBA_COMBO_COMPONENTS[key],
  pushesOnIntegerLine: true,
  includesOvertime: true,
});

/** The registry: every launch market keyed by its canonical market key. */
export const NBA_MARKET_REGISTRY: Readonly<Record<NbaMarketKey, NbaMarketDefinition>> = Object.freeze({
  points: BASE_DEF("points"),
  rebounds: BASE_DEF("rebounds"),
  assists: BASE_DEF("assists"),
  three_pointers_made: BASE_DEF("three_pointers_made"),
  pts_reb: COMBO_DEF("pts_reb"),
  pts_ast: COMBO_DEF("pts_ast"),
  reb_ast: COMBO_DEF("reb_ast"),
  pra: COMBO_DEF("pra"),
});

export function isNbaMarketKey(v: unknown): v is NbaMarketKey {
  return typeof v === "string" && (NBA_LAUNCH_MARKETS as readonly string[]).includes(v);
}

export function isNbaBaseStat(v: unknown): v is NbaBaseStat {
  return typeof v === "string" && (NBA_BASE_STATS as readonly string[]).includes(v);
}

export function isNbaComboMarketKey(v: unknown): v is NbaComboMarketKey {
  return typeof v === "string" && v in NBA_COMBO_COMPONENTS;
}

/** True iff `stat` is one of the three (pts,reb,ast) joint components. */
export function isNbaJointStat(v: unknown): v is NbaJointStat {
  return typeof v === "string" && (NBA_JOINT_STATS as readonly string[]).includes(v);
}

export function getNbaMarketDefinition(key: NbaMarketKey): NbaMarketDefinition {
  return NBA_MARKET_REGISTRY[key];
}
