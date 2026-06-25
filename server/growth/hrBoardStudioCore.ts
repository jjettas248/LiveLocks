// ─────────────────────────────────────────────────────────────────────────────
// HR Board Studio — pure asset builders (no live-data / DB imports)
//
// All functions here are PURE: data in, assets out. They are isolated from the
// live gatherers (which import the pregame-radar service → DB) so the test suite
// can exercise content/movement/recap generation with fixtures and no database.
//
// These builders read existing engine output verbatim — they never recompute a
// projection, score, or lifecycle stage.
// ─────────────────────────────────────────────────────────────────────────────

import { getHrRadarOutcomeStamp } from "../mlb/hrRadarOutcomeStamp";
import { CALLED_HIT_OUTCOME_STATUSES } from "../mlb/hrRadarSection";
import type { CanonicalHrRadarState } from "../mlb/hrRadarCanonicalStore";
import type { PregamePowerSignal, PregamePowerTier } from "../mlb/pregamePowerRadar/types";
import { applyCompliance } from "./hrBoardCompliance";
import {
  HR_BOARD_CTA_TEXT,
  type CtaVariant,
  type HrBoardAsset,
  type HrBoardAssetType,
  type HrBoardContentPack,
  type HrBoardImagePayload,
  type HrBoardImageRow,
  type HrBoardRow,
  type HrMovementRow,
  type HrRecapResponse,
  type HrRecapSummary,
} from "../../shared/hrBoardStudio";

// ── Tier / stage display ──────────────────────────────────────────────────────

const TIER_RANK: Record<PregamePowerTier, number> = {
  nuclear: 6,
  elite: 5,
  strong: 4,
  power_watch: 3,
  watch: 2,
  track: 1,
};

const TIER_LABEL: Record<PregamePowerTier, string> = {
  nuclear: "Nuclear",
  elite: "Elite",
  strong: "Strong",
  power_watch: "Power Watch",
  watch: "Watch",
  track: "Track",
};

const SECTION_RANK: Record<string, number> = {
  FIRE: 6,
  READY: 5,
  CASHED: 4,
  BUILD: 3,
  WATCH: 2,
  "MODEL REVIEW": 1,
  MISSED: 0,
  EXPIRED: 0,
  INACTIVE: -1,
};

const BRAND = "LiveLocks HR Power Board" as const;

function normName(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function num(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10;
}

// ── Board rows ────────────────────────────────────────────────────────────────

function parkTagsFor(signal: PregamePowerSignal): string[] {
  const tags: string[] = [];
  const pc = signal.parkContext;
  if (!pc) return tags;
  if (
    pc.carryLabel &&
    pc.carryLabel !== "Conditions Unavailable" &&
    pc.carryLabel !== "Neutral Conditions" &&
    pc.carryLabel !== "Neutral Air"
  ) {
    tags.push(pc.carryLabel);
  }
  if (pc.windDirectionLabel && pc.windDirectionLabel !== "Calm") {
    tags.push(`Wind ${pc.windDirectionLabel}`);
  }
  return tags;
}

function pitcherVulnTagsFor(signal: PregamePowerSignal): string[] {
  const tags: string[] = [];
  const d = signal.diagnostics;
  if (signal.handednessMatchup) tags.push(signal.handednessMatchup);
  if (d) {
    if (num(d.pitcherVulnerabilityScore) != null && (d.pitcherVulnerabilityScore as number) >= 6) {
      tags.push("Vulnerable Pitcher");
    }
    if (d.pitcherOrderSplitDirection === "vulnerable") {
      tags.push("Weak vs Lineup Slot");
    }
  }
  return tags;
}

/**
 * Convert raw pre-game power signals into ranked board rows. Suppressed signals
 * are excluded (they never surface publicly). PURE — sort/rank only.
 */
export function buildBoardRows(signals: PregamePowerSignal[]): HrBoardRow[] {
  const visible = signals.filter((s) => !s.suppressed);
  visible.sort((a, b) => {
    const sa = num(a.score10) ?? 0;
    const sb = num(b.score10) ?? 0;
    if (sb !== sa) return sb - sa;
    return (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0);
  });
  return visible.map((s, i) => ({
    rank: i + 1,
    signalId: s.signalId,
    playerId: String(s.batterId),
    player: s.batterName,
    team: s.team,
    opponent: s.opponent,
    game: `${s.team} vs ${s.opponent}`,
    gameId: String(s.gameId),
    gameTime: s.startsAt ?? null,
    score: round1(num(s.score10) ?? 0) ?? 0,
    stage: TIER_LABEL[s.tier] ?? s.tier,
    tier: s.tier,
    drivers: (s.drivers ?? [])
      .filter((d) => d.direction === "positive")
      .map((d) => d.label)
      .filter(Boolean)
      .slice(0, 4),
    tags: (s.tags ?? []).slice(0, 6),
    parkTags: parkTagsFor(s),
    pitcherVulnerabilityTags: pitcherVulnTagsFor(s),
  }));
}

// ── Movement feed ─────────────────────────────────────────────────────────────

function resultLabelFor(state: CanonicalHrRadarState): string | null {
  const stamp = getHrRadarOutcomeStamp(state.gameId, state.playerId);
  if (stamp) {
    if (CALLED_HIT_OUTCOME_STATUSES.has(stamp.outcomeStatus)) {
      return stamp.outcomeStatus === "called_near_hr" ? "Near Miss" : "HR Cashed";
    }
    if (stamp.outcomeStatus === "called_miss") return "Missed";
  }
  switch (state.lifecycleState) {
    case "cashed":
      return "HR Cashed";
    case "missed":
      return "Missed";
    case "model_review":
      return "Model Review";
    case "expired":
      return "Expired";
    default:
      return null;
  }
}

function matchBoardRow(
  state: CanonicalHrRadarState,
  rowsByGamePlayer: Map<string, HrBoardRow>,
  rowsByName: Map<string, HrBoardRow>,
): HrBoardRow | null {
  const byId = rowsByGamePlayer.get(`${state.gameId}_${state.playerId}`);
  if (byId) return byId;
  const byName = rowsByName.get(`${state.gameId}_${normName(state.playerName)}`);
  return byName ?? null;
}

/**
 * Build the movement feed: pre-game board players who entered / moved through the
 * live HR Radar. PURE — reads canonical stage/score/result fields, never derives
 * new lifecycle state or score.
 */
export function buildMovementFeed(
  rows: HrBoardRow[],
  states: CanonicalHrRadarState[],
): HrMovementRow[] {
  const rowsByGamePlayer = new Map<string, HrBoardRow>();
  const rowsByName = new Map<string, HrBoardRow>();
  for (const r of rows) {
    rowsByGamePlayer.set(`${r.gameId}_${r.playerId}`, r);
    rowsByName.set(`${r.gameId}_${normName(r.player)}`, r);
  }

  const movements: HrMovementRow[] = [];
  for (const state of states) {
    // Only pre-game board players who actually moved into the radar.
    if (state.lifecycleState === "inactive") continue;
    const row = matchBoardRow(state, rowsByGamePlayer, rowsByName);
    if (!row) continue;

    const pregameScore = round1(num(row.score));
    const currentScore = round1(num(state.displayScore10));
    const scoreChange =
      pregameScore != null && currentScore != null ? round1(currentScore - pregameScore) : null;

    movements.push({
      signalId: row.signalId,
      playerId: state.playerId,
      player: state.playerName || row.player,
      team: state.team || row.team,
      game: row.game,
      gameId: row.gameId,
      pregameRank: row.rank,
      previousStage: row.stage,
      currentStage: state.section,
      movementTime: state.updatedAt,
      topDriver: state.triggerReasons?.[0] ?? row.drivers[0] ?? null,
      pregameScore,
      currentScore,
      scoreChange,
      result: resultLabelFor(state),
    });
  }

  movements.sort((a, b) => {
    const ra = SECTION_RANK[a.currentStage] ?? 0;
    const rb = SECTION_RANK[b.currentStage] ?? 0;
    if (rb !== ra) return rb - ra;
    return Date.parse(b.movementTime) - Date.parse(a.movementTime);
  });
  return movements;
}

// ── Asset assembly ────────────────────────────────────────────────────────────

function toImageRows(rows: HrBoardRow[]): HrBoardImageRow[] {
  return rows.map((r) => ({
    rank: r.rank,
    player: r.player,
    team: r.team,
    score: r.score,
    stage: r.stage,
    drivers: r.drivers.slice(0, 2),
  }));
}

interface MakeAssetInput {
  assetType: HrBoardAssetType;
  title: string;
  rawBody: string;
  imagePayload: HrBoardImagePayload;
  recommendedTiming: string;
  sourcePlayerIds: string[];
  sourceSignalIds: string[];
  ctaVariant: CtaVariant;
  includeLink: boolean;
  link: string | null;
}

function makeAsset(input: MakeAssetInput): HrBoardAsset {
  const cta = HR_BOARD_CTA_TEXT[input.ctaVariant];
  // CTA is native text (never a URL) — fold it into the body so compliance
  // covers it too.
  const composed = cta ? `${input.rawBody}\n\n${cta}` : input.rawBody;
  const compliance = applyCompliance(composed);
  return {
    assetType: input.assetType,
    title: input.title,
    body: compliance.safeCopy,
    imagePayload: input.imagePayload,
    recommendedTiming: input.recommendedTiming,
    sourcePlayerIds: input.sourcePlayerIds,
    sourceSignalIds: input.sourceSignalIds,
    complianceStatus: compliance.complianceStatus,
    blockedTerms: compliance.blockedTerms,
    safeCopy: compliance.safeCopy,
    ctaVariant: input.ctaVariant,
    cta,
    includeLink: input.includeLink,
    // Links never appear in copy — only here, and only when toggled on.
    link: input.includeLink ? input.link : null,
  };
}

export interface ContentPackOptions {
  includeLink?: boolean;
  link?: string | null;
}

/**
 * Build the top-of-funnel / live content pack from the board + movement feed.
 * Always returns assets, even for an empty board. PURE.
 */
export function buildContentPack(
  date: string,
  rows: HrBoardRow[],
  movements: HrMovementRow[],
  opts: ContentPackOptions = {},
): HrBoardContentPack {
  const includeLink = opts.includeLink === true;
  const link = opts.link ?? null;
  const assets: HrBoardAsset[] = [];

  const top = rows.slice(0, 8);
  const top3 = rows.slice(0, 3);
  const lead = rows[0] ?? null;

  // 1. Daily Board Post
  {
    const lines =
      top.length > 0
        ? top
            .map((r) => `${r.rank}. ${r.player} (${r.team}) — ${r.stage} · ${r.score.toFixed(1)}`)
            .join("\n")
        : "Board builds when lineups confirm. Tracking today's slate.";
    assets.push(
      makeAsset({
        assetType: "daily_board",
        title: `HR Power Board — ${date}`,
        rawBody: `Today's HR Power Board signals 🎯\n\n${lines}`,
        imagePayload: {
          template: "daily_board",
          title: "HR Power Board",
          subtitle: date,
          rows: toImageRows(top),
          footer: "Setup scores, not picks · 0–10 scale",
          brand: BRAND,
        },
        recommendedTiming: "Morning slate drop (10–11am ET)",
        sourcePlayerIds: top.map((r) => r.playerId),
        sourceSignalIds: top.map((r) => r.signalId),
        ctaVariant: "board_in_bio",
        includeLink,
        link,
      }),
    );
  }

  // 2. Top Player Spotlight
  {
    const body = lead
      ? `Top of the board: ${lead.player} (${lead.team}) vs ${lead.opponent}.\n\nProfile: ${lead.stage} · ${lead.score.toFixed(1)}/10${
          lead.drivers.length ? `\nWhy: ${lead.drivers.join(" · ")}` : ""
        }${lead.parkTags.length ? `\nPark: ${lead.parkTags.join(" · ")}` : ""}`
      : "No spotlight yet — board fills in as lineups confirm.";
    assets.push(
      makeAsset({
        assetType: "top_player_spotlight",
        title: lead ? `Spotlight — ${lead.player}` : "Spotlight",
        rawBody: body,
        imagePayload: {
          template: "spotlight",
          title: lead ? lead.player : "HR Spotlight",
          subtitle: lead ? `${lead.team} vs ${lead.opponent}` : date,
          rows: lead ? toImageRows([lead]) : [],
          footer: "Top setup on today's board",
          brand: BRAND,
        },
        recommendedTiming: "Late morning (11am–12pm ET)",
        sourcePlayerIds: lead ? [lead.playerId] : [],
        sourceSignalIds: lead ? [lead.signalId] : [],
        ctaVariant: "follow_for_movement",
        includeLink,
        link,
      }),
    );
  }

  // 3. Top 3 Watchlist
  {
    const lines =
      top3.length > 0
        ? top3.map((r) => `${r.rank}. ${r.player} (${r.team}) — ${r.stage}`).join("\n")
        : "Watchlist builds when lineups confirm.";
    assets.push(
      makeAsset({
        assetType: "top3_watchlist",
        title: "Top 3 Watchlist",
        rawBody: `Today's top 3 HR setups 👀\n\n${lines}`,
        imagePayload: {
          template: "daily_board",
          title: "Top 3 Watchlist",
          subtitle: date,
          rows: toImageRows(top3),
          footer: "Watchlist · not betting advice",
          brand: BRAND,
        },
        recommendedTiming: "Midday (12–2pm ET)",
        sourcePlayerIds: top3.map((r) => r.playerId),
        sourceSignalIds: top3.map((r) => r.signalId),
        ctaVariant: "movement_on_jump",
        includeLink,
        link,
      }),
    );
  }

  // 4. Movement Alert
  {
    const movers = movements.slice(0, 5);
    const body =
      movers.length > 0
        ? `Board movement 🚨\n\n${movers
            .map(
              (m) =>
                `${m.player} (${m.team}): ${m.previousStage} → ${m.currentStage}${
                  m.pregameRank ? ` · was #${m.pregameRank} pre-game` : ""
                }`,
            )
            .join("\n")}`
        : "No movement yet — watching the board. I'll post when someone jumps.";
    assets.push(
      makeAsset({
        assetType: "movement_alert",
        title: "Movement Alert",
        rawBody: body,
        imagePayload: {
          template: "movement",
          title: "Board Movement",
          subtitle: date,
          rows: movers.map((m) => ({
            player: m.player,
            team: m.team,
            stage: `${m.previousStage} → ${m.currentStage}`,
            score: m.currentScore ?? undefined,
          })),
          footer: "Live movement from the pre-game board",
          brand: BRAND,
        },
        recommendedTiming: "Live — when a player jumps a stage",
        sourcePlayerIds: movers.map((m) => m.playerId),
        sourceSignalIds: movers.map((m) => m.signalId),
        ctaVariant: "movement_on_jump",
        includeLink,
        link,
      }),
    );
  }

  // 5. Ready/Fire Alert
  {
    const hot = movements.filter((m) => m.currentStage === "READY" || m.currentStage === "FIRE");
    const top1 = hot[0] ?? null;
    const body = top1
      ? `${top1.currentStage} 🔥\n\n${top1.player} (${top1.team}) just hit ${top1.currentStage}${
          top1.pregameRank ? ` — was #${top1.pregameRank} on the pre-game board` : ""
        }.${top1.topDriver ? `\nDriver: ${top1.topDriver}` : ""}`
      : "No READY/FIRE yet today. Watching the live board.";
    assets.push(
      makeAsset({
        assetType: "ready_fire_alert",
        title: top1 ? `${top1.currentStage} — ${top1.player}` : "Ready/Fire Alert",
        rawBody: body,
        imagePayload: {
          template: "movement",
          title: top1 ? `${top1.currentStage}: ${top1.player}` : "Ready/Fire",
          subtitle: top1 ? `${top1.team} · ${top1.game}` : date,
          rows: hot.slice(0, 5).map((m) => ({
            player: m.player,
            team: m.team,
            stage: m.currentStage,
            score: m.currentScore ?? undefined,
          })),
          footer: "Live READY/FIRE movement",
          brand: BRAND,
        },
        recommendedTiming: "Live — the moment a player reaches READY/FIRE",
        sourcePlayerIds: hot.map((m) => m.playerId),
        sourceSignalIds: hot.map((m) => m.signalId),
        ctaVariant: "follow_for_movement",
        includeLink,
        link,
      }),
    );
  }

  const flagged = assets.filter((a) => a.complianceStatus === "flagged").length;
  return {
    date,
    generatedAt: new Date().toISOString(),
    includeLink,
    assets,
    counts: { total: assets.length, flagged },
  };
}

// ── Recap / proof ─────────────────────────────────────────────────────────────

interface RecapBuckets {
  cashed: HrMovementRow[];
  nearMiss: HrMovementRow[];
  missed: HrMovementRow[];
}

function bucketRecap(movements: HrMovementRow[]): RecapBuckets {
  const cashed: HrMovementRow[] = [];
  const nearMiss: HrMovementRow[] = [];
  const missed: HrMovementRow[] = [];
  for (const m of movements) {
    if (m.result === "HR Cashed") cashed.push(m);
    else if (m.result === "Near Miss") nearMiss.push(m);
    else if (m.result === "Missed") missed.push(m);
  }
  return { cashed, nearMiss, missed };
}

/**
 * Build postgame recap / proof assets for `date`. Works with no HRs (returns a
 * transparency-oriented recap) and with cashed results (proof + recap). PURE.
 */
export function buildRecap(
  date: string,
  rows: HrBoardRow[],
  movements: HrMovementRow[],
): HrRecapResponse {
  const { cashed, nearMiss, missed } = bucketRecap(movements);
  const assets: HrBoardAsset[] = [];

  // Cashed Proof
  {
    const body =
      cashed.length > 0
        ? `Board → cashed ✅\n\n${cashed
            .slice(0, 6)
            .map(
              (m) =>
                `${m.player} (${m.team})${
                  m.pregameRank ? ` — #${m.pregameRank} pre-game` : ""
                } → ${m.previousStage} → ${m.currentStage} → HR`,
            )
            .join("\n")}`
        : "No HRs off the board today. Posting the full record either way — proof works both ways.";
    assets.push(
      makeAsset({
        assetType: "cashed_proof",
        title: "Cashed Proof",
        rawBody: body,
        imagePayload: {
          template: "proof",
          title: cashed.length > 0 ? "Board → Cashed" : "Daily Proof",
          subtitle: date,
          rows: cashed.slice(0, 6).map((m) => ({
            player: m.player,
            team: m.team,
            stage: `#${m.pregameRank ?? "—"} → HR`,
            score: m.currentScore ?? undefined,
          })),
          footer: "Pre-game board → live cash · receipts only",
          brand: BRAND,
        },
        recommendedTiming: "Postgame (within ~1h of final)",
        sourcePlayerIds: cashed.map((m) => m.playerId),
        sourceSignalIds: cashed.map((m) => m.signalId),
        ctaVariant: "not_a_pick",
        includeLink: false,
        link: null,
      }),
    );
  }

  // Near-Miss Transparency
  {
    const body =
      nearMiss.length > 0
        ? `Near misses, posted for transparency 📊\n\n${nearMiss
            .slice(0, 6)
            .map(
              (m) =>
                `${m.player} (${m.team})${
                  m.pregameRank ? ` — #${m.pregameRank} pre-game` : ""
                }: deep fly / near miss`,
            )
            .join("\n")}`
        : "No near-miss flags to report today.";
    assets.push(
      makeAsset({
        assetType: "near_miss_transparency",
        title: "Near-Miss Transparency",
        rawBody: body,
        imagePayload: {
          template: "proof",
          title: "Near Misses",
          subtitle: date,
          rows: nearMiss.slice(0, 6).map((m) => ({
            player: m.player,
            team: m.team,
            stage: m.currentStage,
            score: m.currentScore ?? undefined,
          })),
          footer: "Transparency · not betting advice",
          brand: BRAND,
        },
        recommendedTiming: "Postgame (same evening)",
        sourcePlayerIds: nearMiss.map((m) => m.playerId),
        sourceSignalIds: nearMiss.map((m) => m.signalId),
        ctaVariant: "not_a_pick",
        includeLink: false,
        link: null,
      }),
    );
  }

  // Postgame Recap
  {
    const body = `HR Power Board recap — ${date} 📋\n\nCashed: ${cashed.length}\nNear misses: ${nearMiss.length}\nMissed: ${missed.length}\nBoard size: ${rows.length}\n\nEvery result posted — that's the record.`;
    assets.push(
      makeAsset({
        assetType: "postgame_recap",
        title: `Recap — ${date}`,
        rawBody: body,
        imagePayload: {
          template: "recap",
          title: "Daily Recap",
          subtitle: date,
          rows: [
            ...cashed.slice(0, 3).map((m) => ({ player: m.player, team: m.team, stage: "HR ✅" })),
            ...nearMiss.slice(0, 2).map((m) => ({
              player: m.player,
              team: m.team,
              stage: "Near Miss",
            })),
          ],
          footer: `Cashed ${cashed.length} · Near ${nearMiss.length} · Missed ${missed.length}`,
          brand: BRAND,
        },
        recommendedTiming: "Postgame wrap or next-morning recap",
        sourcePlayerIds: [...cashed, ...nearMiss].map((m) => m.playerId),
        sourceSignalIds: [...cashed, ...nearMiss].map((m) => m.signalId),
        ctaVariant: "not_a_pick",
        includeLink: false,
        link: null,
      }),
    );
  }

  const summary: HrRecapSummary = {
    cashed: cashed.length,
    nearMiss: nearMiss.length,
    missed: missed.length,
  };
  return { date, generatedAt: new Date().toISOString(), assets, summary };
}
