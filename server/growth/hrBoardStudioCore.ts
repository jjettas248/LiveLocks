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
  HR_BOARD_BRAND_HANDLE,
  HR_BOARD_BRAND_HASHTAG,
  HR_BOARD_BRAND_SITE,
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

// ── Brand + traction tags ──────────────────────────────────────────────────────
//
// X (Twitter) reach for an MLB HR/props account is driven by a small set of
// evergreen, high-volume hashtags plus per-asset niche tags and team cashtags.
// Tags are curated to be compliance-clean (no "lock"/"guaranteed"/etc.) and are
// folded into the copy body so the admin can paste a post that already carries
// the brand handle and tags. The brand SITE (a URL) is intentionally NOT placed
// in copy — it lives only on the image watermark + the opt-in link field.

/** Curated high-traction X hashtags per asset type (most general first). */
const HASHTAG_BANK: Record<HrBoardAssetType, string[]> = {
  daily_board: ["#MLB", "#HomeRunProps", "#MLBPicks", "#PropBets", "#GamblingTwitter"],
  top_player_spotlight: ["#MLB", "#HomeRun", "#PlayerProps", "#MLBTwitter", "#Dinger"],
  top3_watchlist: ["#MLB", "#PropBets", "#MLBPicks", "#Watchlist", "#HomeRunProps"],
  movement_alert: ["#MLB", "#HRRadar", "#LiveBaseball", "#PropBets", "#InGameBets"],
  ready_fire_alert: ["#MLB", "#HRRadar", "#Dinger", "#LiveBaseball", "#GamblingTwitter"],
  cashed_proof: ["#MLB", "#Receipts", "#TrackRecord", "#HomeRun", "#HRRadar"],
  near_miss_transparency: ["#MLB", "#Transparency", "#HRRadar", "#MLBTwitter"],
  postgame_recap: ["#MLB", "#Recap", "#TrackRecord", "#Receipts", "#HomeRun"],
};

/** Always-on platform cashtags appended after any team cashtags. */
const PLATFORM_CASHTAGS = ["$MLB"] as const;

/** Build the hashtag set for an asset: up to 5 niche tags + the brand tag. */
function buildHashtags(assetType: HrBoardAssetType): string[] {
  const bank = HASHTAG_BANK[assetType] ?? ["#MLB", "#HomeRun"];
  const out = bank.slice(0, 5);
  if (!out.includes(HR_BOARD_BRAND_HASHTAG)) out.push(HR_BOARD_BRAND_HASHTAG);
  return out;
}

/** Normalize a team string into a 2–4 char cashtag ticker, or null if unusable. */
function teamTicker(team: unknown): string | null {
  const tk = String(team ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return tk.length >= 2 && tk.length <= 4 ? tk : null;
}

/** Derive cashtags from the featured teams (deduped, max 3) + platform cashtags. */
function buildCashtags(teams: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of teams) {
    const tk = teamTicker(t);
    if (tk && !seen.has(tk)) {
      seen.add(tk);
      out.push(`$${tk}`);
    }
    if (out.length >= 3) break;
  }
  for (const c of PLATFORM_CASHTAGS) if (!out.includes(c)) out.push(c);
  return out;
}

/** FNV-1a hash → deterministic variant selection (keeps copy diverse per day, stable per test). */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}

function pick<T>(arr: T[], seed: string): T {
  return arr[hashStr(seed) % arr.length];
}

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
  /** Teams featured in this asset — drive the cashtags. */
  teams: Array<string | null | undefined>;
  includeLink: boolean;
  link: string | null;
}

function makeAsset(input: MakeAssetInput): HrBoardAsset {
  const cta = HR_BOARD_CTA_TEXT[input.ctaVariant];
  const hashtags = buildHashtags(input.assetType);
  const cashtags = buildCashtags(input.teams);

  // Brand sign-off + tag line. The handle is native text (never a URL) so it is
  // safe in copy; cashtags/hashtags are compliance-clean by construction. The
  // brand SITE is a URL → it stays out of copy and lives only on the image card.
  const tagLine = [...cashtags, ...hashtags].join(" ");
  const brandLine = `${HR_BOARD_BRAND_HANDLE}${tagLine ? `\n${tagLine}` : ""}`;

  // Fold CTA + brand/tag line into the body so compliance covers everything.
  const composed = [input.rawBody, cta, brandLine].filter(Boolean).join("\n\n");
  const compliance = applyCompliance(composed);
  return {
    assetType: input.assetType,
    title: input.title,
    body: compliance.safeCopy,
    imagePayload: {
      ...input.imagePayload,
      handle: input.imagePayload.handle ?? HR_BOARD_BRAND_HANDLE,
      site: input.imagePayload.site ?? HR_BOARD_BRAND_SITE,
    },
    recommendedTiming: input.recommendedTiming,
    sourcePlayerIds: input.sourcePlayerIds,
    sourceSignalIds: input.sourceSignalIds,
    complianceStatus: compliance.complianceStatus,
    blockedTerms: compliance.blockedTerms,
    safeCopy: compliance.safeCopy,
    ctaVariant: input.ctaVariant,
    cta,
    hashtags,
    cashtags,
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
    const header = pick(
      [
        "Today's HR Power Board is live 💣",
        "HR Power Board — who's got pop today 🎯",
        "Loading today's HR Power Board 🧨",
        "The HR Power Board dropped 💥",
      ],
      `daily_board:${date}`,
    );
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
        rawBody: `${header}\n\n${lines}`,
        imagePayload: {
          template: "daily_board",
          title: "HR Power Board",
          subtitle: date,
          rows: toImageRows(top),
          footer: "Setup scores, not picks · 0–10 scale",
          brand: BRAND,
          accent: "Daily Slate",
        },
        recommendedTiming: "Morning slate drop (10–11am ET)",
        sourcePlayerIds: top.map((r) => r.playerId),
        sourceSignalIds: top.map((r) => r.signalId),
        ctaVariant: "board_in_bio",
        teams: top.map((r) => r.team),
        includeLink,
        link,
      }),
    );
  }

  // 2. Top Player Spotlight
  {
    const hook = lead
      ? pick(
          [
            `Top of the board: ${lead.player} (${lead.team}) vs ${lead.opponent}. 🔦`,
            `Spotlight 🔦 — ${lead.player} (${lead.team}) headlines the HR Power Board vs ${lead.opponent}.`,
            `${lead.player} is our #1 power profile today (${lead.team} vs ${lead.opponent}). 💪`,
          ],
          `spotlight:${date}:${lead.playerId}`,
        )
      : "";
    const body = lead
      ? `${hook}\n\nProfile: ${lead.stage} · ${lead.score.toFixed(1)}/10${
          lead.drivers.length ? `\nWhy: ${lead.drivers.join(" · ")}` : ""
        }${lead.parkTags.length ? `\nPark: ${lead.parkTags.join(" · ")}` : ""}${
          lead.pitcherVulnerabilityTags.length
            ? `\nMatchup: ${lead.pitcherVulnerabilityTags.join(" · ")}`
            : ""
        }`
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
          accent: "Player Spotlight",
        },
        recommendedTiming: "Late morning (11am–12pm ET)",
        sourcePlayerIds: lead ? [lead.playerId] : [],
        sourceSignalIds: lead ? [lead.signalId] : [],
        ctaVariant: "follow_for_movement",
        teams: lead ? [lead.team] : [],
        includeLink,
        link,
      }),
    );
  }

  // 3. Top 3 Watchlist
  {
    const header = pick(
      [
        "Today's top 3 HR setups 👀",
        "My 3 favorite power spots on the board 👀",
        "Top 3 dingers I'm watching today 💣",
      ],
      `top3:${date}`,
    );
    const lines =
      top3.length > 0
        ? top3.map((r) => `${r.rank}. ${r.player} (${r.team}) — ${r.stage}`).join("\n")
        : "Watchlist builds when lineups confirm.";
    assets.push(
      makeAsset({
        assetType: "top3_watchlist",
        title: "Top 3 Watchlist",
        rawBody: `${header}\n\n${lines}`,
        imagePayload: {
          template: "daily_board",
          title: "Top 3 Watchlist",
          subtitle: date,
          rows: toImageRows(top3),
          footer: "Watchlist · not betting advice",
          brand: BRAND,
          accent: "Top 3",
        },
        recommendedTiming: "Midday (12–2pm ET)",
        sourcePlayerIds: top3.map((r) => r.playerId),
        sourceSignalIds: top3.map((r) => r.signalId),
        ctaVariant: "movement_on_jump",
        teams: top3.map((r) => r.team),
        includeLink,
        link,
      }),
    );
  }

  // 4. Movement Alert
  {
    const movers = movements.slice(0, 5);
    const header = pick(
      ["Board movement 🚨", "Live board movement 🚨", "Players climbing the board 📈"],
      `movement:${date}`,
    );
    const body =
      movers.length > 0
        ? `${header}\n\n${movers
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
          accent: "Live Movement",
        },
        recommendedTiming: "Live — when a player jumps a stage",
        sourcePlayerIds: movers.map((m) => m.playerId),
        sourceSignalIds: movers.map((m) => m.signalId),
        ctaVariant: "movement_on_jump",
        teams: movers.map((m) => m.team),
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
          accent: "Ready / Fire",
        },
        recommendedTiming: "Live — the moment a player reaches READY/FIRE",
        sourcePlayerIds: hot.map((m) => m.playerId),
        sourceSignalIds: hot.map((m) => m.signalId),
        ctaVariant: "follow_for_movement",
        teams: hot.map((m) => m.team),
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
          accent: "Receipts",
        },
        recommendedTiming: "Postgame (within ~1h of final)",
        sourcePlayerIds: cashed.map((m) => m.playerId),
        sourceSignalIds: cashed.map((m) => m.signalId),
        ctaVariant: "not_a_pick",
        teams: cashed.map((m) => m.team),
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
          accent: "Transparency",
        },
        recommendedTiming: "Postgame (same evening)",
        sourcePlayerIds: nearMiss.map((m) => m.playerId),
        sourceSignalIds: nearMiss.map((m) => m.signalId),
        ctaVariant: "not_a_pick",
        teams: nearMiss.map((m) => m.team),
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
          accent: "Daily Recap",
        },
        recommendedTiming: "Postgame wrap or next-morning recap",
        sourcePlayerIds: [...cashed, ...nearMiss].map((m) => m.playerId),
        sourceSignalIds: [...cashed, ...nearMiss].map((m) => m.signalId),
        ctaVariant: "not_a_pick",
        teams: [...cashed, ...nearMiss].map((m) => m.team),
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
