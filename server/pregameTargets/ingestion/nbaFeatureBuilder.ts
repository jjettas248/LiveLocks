// PR5 — NBA ingestion: normalized records → as-of feature rows (PR1 contract).
//
// Emits per-minute rate features (points/rebounds/assists/threes) + a minutes
// feature, one reading per game, honoring the state distinctions and the honest
// knownAt policy (docs/pregame-targets/PR5-source-manifest.md):
//   validAt = source-effective game date;  knownAt = fetchedAt (the real instant
//   THIS pipeline observed the payload) — NEVER the game date, and never a
//   present fetch time back-dated to look historical.
// Because knownAt = fetchedAt, a leakage-safe as-of read before that instant
// correctly excludes the row (forward-supported; historical backtest unsupported).
//
// State rules (missing vs observed_zero kept distinct):
//   minutes null                       → the whole game contributes MISSING readings
//   minutes 0 (DNP-with-row)           → rate features NOT_APPLICABLE (no rate exists)
//   minutes > 0, stat null (omitted)   → that stat MISSING (never 0-for-absent)
//   minutes > 0, stat 0                → OBSERVED_ZERO (rate 0)
//   minutes > 0, stat finite > 0       → OBSERVED (rate = stat/minutes)
//
// Pure; no I/O; no line/price/EV/outcome field anywhere.

import { buildCanonicalId, canonicalGameId } from "../../../shared/pregameTargets/canonicalEntities";
import { instantMs, isStructurallyValidFeatureRow, type AsOfFeatureRow, type FeatureState } from "../../../shared/pregameTargets/featureStore";
import { gameDateToIso } from "./nbaGameLogAdapter";
import type { NbaNormalizedGameRecord } from "./nbaSourceContracts";

export const NBA_FEATURE_VERSION = "nba_gamelog_v1";

/** Per-minute rate feature keys the projection core's posterior bridge consumes. */
export const NBA_RATE_FEATURES = [
  { key: "nba.player.points_per_min", stat: "points" as const },
  { key: "nba.player.rebounds_per_min", stat: "rebounds" as const },
  { key: "nba.player.assists_per_min", stat: "assists" as const },
  { key: "nba.player.three_pointers_made_per_min", stat: "threePointersMade" as const },
];
export const NBA_MINUTES_FEATURE = "nba.player.minutes";

export interface BuildFeatureRowsArgs {
  season: number;
  playerNativeId: string;
  sourceId: string; // the immutable raw snapshotId
  records: readonly NbaNormalizedGameRecord[];
}

export interface FeatureBuildResult {
  rows: AsOfFeatureRow[];
  /** Per-(game,feature) skips with a reason — never silently dropped. */
  skipped: Array<{ gameId: string; featureKey: string; reason: string }>;
}

function makeRow(args: {
  season: number;
  entityCanonicalId: string;
  featureKey: string;
  validAt: string;
  knownAt: string;
  state: FeatureState;
  value: number | null;
  sourceId: string;
  gameCanonicalId: string;
}): AsOfFeatureRow {
  return {
    sport: "nba",
    entityCanonicalId: args.entityCanonicalId,
    entityKind: "player",
    featureKey: args.featureKey,
    featureVersion: NBA_FEATURE_VERSION,
    season: args.season,
    validAt: args.validAt,
    knownAt: args.knownAt,
    state: args.state,
    value: args.value,
    sourceId: args.sourceId,
    derivedFromGameIds: [args.gameCanonicalId],
  };
}

/** Build the as-of feature rows for a player's normalized game records. Pure. */
export function buildNbaFeatureRows(args: BuildFeatureRowsArgs): FeatureBuildResult {
  const entityCanonicalId = buildCanonicalId("nba", "player", args.playerNativeId);
  const rows: AsOfFeatureRow[] = [];
  const skipped: Array<{ gameId: string; featureKey: string; reason: string }> = [];

  for (const rec of args.records) {
    const validAt = gameDateToIso(rec.gameDate);
    const knownAt = rec.timestamps.fetchedAt; // honest: earliest THIS pipeline knew it
    const gameCanonicalId = canonicalGameId(buildCanonicalId("nba", "game", rec.gameId));

    // Unusable temporal anchors → skip with reason (never fabricate an instant).
    if (validAt === "invalid-game-date" || !Number.isFinite(instantMs(validAt))) {
      skipped.push({ gameId: rec.gameId, featureKey: "*", reason: "invalid_game_date" });
      continue;
    }
    if (!Number.isFinite(instantMs(knownAt))) {
      skipped.push({ gameId: rec.gameId, featureKey: "*", reason: "invalid_fetched_at" });
      continue;
    }
    // Impossible: observed before it became true. Reject at ingestion (firewall rule).
    if (instantMs(knownAt) < instantMs(validAt)) {
      skipped.push({ gameId: rec.gameId, featureKey: "*", reason: "known_before_valid" });
      continue;
    }
    if (gameCanonicalId === null) {
      skipped.push({ gameId: rec.gameId, featureKey: "*", reason: "noncanonical_game_id" });
      continue;
    }

    const push = (featureKey: string, state: FeatureState, value: number | null) => {
      const row = makeRow({ season: args.season, entityCanonicalId, featureKey, validAt, knownAt, state, value, sourceId: args.sourceId, gameCanonicalId });
      if (!isStructurallyValidFeatureRow(row)) {
        skipped.push({ gameId: rec.gameId, featureKey, reason: "structurally_invalid" });
        return;
      }
      rows.push(row);
    };

    // Minutes feature.
    if (rec.minutes === null) push(NBA_MINUTES_FEATURE, "missing", null);
    else if (rec.minutes === 0) push(NBA_MINUTES_FEATURE, "observed_zero", 0);
    else push(NBA_MINUTES_FEATURE, "observed", rec.minutes);

    // Per-minute rate features.
    for (const feat of NBA_RATE_FEATURES) {
      const stat = rec[feat.stat];
      if (rec.minutes === null) {
        push(feat.key, "missing", null); // no minutes → cannot know a rate
      } else if (rec.minutes === 0) {
        push(feat.key, "not_applicable", null); // DNP: no rate is defined
      } else if (stat === null) {
        push(feat.key, "missing", null); // provider omitted the stat
      } else if (stat === 0) {
        push(feat.key, "observed_zero", 0); // genuinely zero rate
      } else {
        push(feat.key, "observed", stat / rec.minutes);
      }
    }
  }

  return { rows, skipped };
}
