// NBA market taxonomy — shared by probabilityEngine and probabilityFinalizer.
// Lives in its own module so the engine and the finalizer don't have to
// import each other.

export type SingleStat =
  | "points"
  | "rebounds"
  | "assists"
  | "steals"
  | "blocks"
  | "threes";

export type ComboStat = "pts_reb" | "pts_ast" | "reb_ast" | "pts_reb_ast";

export type MarketType = SingleStat | ComboStat;

export function isComboMarket(m: string): boolean {
  return (
    m === "pts_reb" ||
    m === "pts_ast" ||
    m === "reb_ast" ||
    m === "pts_reb_ast" ||
    m === "stl_blk"
  );
}
