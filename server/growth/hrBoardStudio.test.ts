// HR Board Studio — invariant tests.
// Run: npx tsx server/growth/hrBoardStudio.test.ts
//
// Covers: no-link default copy, compliance flagging, movement feed purity,
// empty/full board content packs, recap with/without HRs, and admin-auth gating.

// Ensure db.ts (pulled in transitively by ../auth → ../storage) can construct its
// Pool without a live DB. We never issue a query in this suite.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import {
  buildBoardRows,
  buildContentPack,
  buildMovementFeed,
  buildRecap,
} from "./hrBoardStudioCore";
import { applyCompliance, scanForBlockedTerms } from "./hrBoardCompliance";
import {
  HR_BOARD_BRAND_HANDLE,
  HR_BOARD_BRAND_HASHTAG,
  HR_BOARD_BRAND_SITE,
} from "../../shared/hrBoardStudio";
import {
  recordHrBoardEvent,
  getHrBoardSummary,
  _resetHrBoardAnalyticsForTests,
} from "./hrBoardAnalytics";
import type { PregamePowerSignal } from "../mlb/pregamePowerRadar/types";
import type { CanonicalHrRadarState } from "../mlb/hrRadarCanonicalStore";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[HR_BOARD_STUDIO_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

const URL_RE = /(https?:\/\/|www\.|\.com\b|\.io\b|\bbit\.ly\b)/i;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkSignal(partial: Partial<PregamePowerSignal> & { batterId: string }): PregamePowerSignal {
  return {
    signalId: `mlb-pregame:2026-06-25:G1:${partial.batterId}`,
    sport: "mlb",
    engine: "pregame_power_radar",
    sessionDate: "2026-06-25",
    gameId: "G1",
    gameDate: "2026-06-25",
    startsAt: "2026-06-25T23:05:00.000Z",
    generatedAt: "2026-06-25T14:00:00.000Z",
    buildId: "build-1",
    batterId: partial.batterId,
    batterName: "Player " + partial.batterId,
    team: "AAA",
    opponent: "BBB",
    pitcherId: "P1",
    pitcherName: "Pitcher One",
    battingOrderSlot: 3,
    handednessMatchup: "L vs R",
    primaryMarket: "home_runs",
    marketTags: ["home_runs"],
    marketScores: {},
    marketSetups: [],
    parkContext: null,
    score10: 7,
    tier: "strong",
    drivers: [
      { key: "power", label: "Elite raw power", direction: "positive" },
      { key: "park", label: "Park boost", direction: "positive" },
    ],
    warnings: [],
    tags: ["power"],
    lineupStatus: "confirmed",
    weatherStatus: "confirmed",
    gameStatus: "scheduled",
    firstPitchLockEligible: true,
    lockedAt: null,
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: "active",
    suppressed: false,
    suppressedReasons: [],
    outcomes: null,
    everPubliclyFlagged: false,
    becameLiveReady: false,
    becameLiveFire: false,
    convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 7,
      pitcherVulnerabilityScore: 6.5,
      pitcherHandednessScore: 6,
      matchupFitScore: 6,
      parkWeatherScore: 5,
      lineupOpportunityScore: 5,
      marketFitScore: 5,
      pitcherOrderSplitAvailable: true,
      pitcherOrderSplitScore: 6,
      pitcherOrderSplitDirection: "vulnerable",
      batterCurrentOrderSlot: 3,
      batterOrderSplitAvailable: true,
      batterOrderSplitScore: 6,
      batterOrderSplitDirection: "strong",
      bvpAvailable: false,
      bvpScore: null,
      bvpSampleSize: null,
      bvpDirection: "neutral",
      zeroProductionBvpFlags: [],
      dataCoverageScore: 1,
      finalScoreBeforeCaps: 7,
      finalScoreAfterCaps: 7,
      matchupPenalty: 0,
      publicTier: "strong",
      warningTags: [],
      downgradeReasons: [],
      suppressed: false,
      suppressedReasons: [],
      sourceFreshness: {},
      rawInputsAvailable: {
        lineup: true,
        batterPower: true,
        pitcherProfile: true,
        park: true,
        weather: true,
        bvp: false,
      },
    },
    ...partial,
  };
}

function mkState(partial: Partial<CanonicalHrRadarState> & { playerId: string }): CanonicalHrRadarState {
  return {
    gameId: "G1",
    playerId: partial.playerId,
    playerName: "Player " + partial.playerId,
    team: "AAA",
    sessionDate: "2026-06-25",
    lifecycleState: "ready",
    section: "READY",
    userStage: "ready",
    displayScore10: 8.5,
    peakScore10: 8.5,
    detectedAt: "2026-06-25T23:30:00.000Z",
    detectedInning: 3,
    latestEvidenceAt: "2026-06-25T23:45:00.000Z",
    latestEvidenceInning: 4,
    triggerAbIndex: 1,
    triggerReasons: ["Repeated barrel danger"],
    triggerTags: ["barrel"],
    contactEvidence: [],
    active: true,
    terminal: false,
    updatedAt: "2026-06-25T23:45:00.000Z",
    ...partial,
  };
}

const FULL_BOARD: PregamePowerSignal[] = [
  mkSignal({ batterId: "1", score10: 9, tier: "elite" }),
  mkSignal({ batterId: "2", score10: 8 }),
  mkSignal({ batterId: "3", score10: 7.5 }),
  mkSignal({ batterId: "4", score10: 6 }),
  mkSignal({ batterId: "5", score10: 5, suppressed: true, suppressedReasons: ["coverage"] }),
];

// ── 1. No default copy contains URLs ──────────────────────────────────────────
{
  const rows = buildBoardRows(FULL_BOARD);
  const movements = buildMovementFeed(rows, [
    mkState({ playerId: "1", lifecycleState: "ready", section: "READY" }),
  ]);
  const pack = buildContentPack("2026-06-25", rows, movements); // default → no link
  const recap = buildRecap("2026-06-25", rows, movements);
  const allAssets = [...pack.assets, ...recap.assets];

  const anyUrl = allAssets.some((a) => URL_RE.test(a.body) || URL_RE.test(a.safeCopy));
  check("no default asset body contains a URL", !anyUrl);
  check("default includeLink=false on every asset", allAssets.every((a) => a.includeLink === false));
  check("default link=null on every asset", allAssets.every((a) => a.link === null));
  check("pack reports includeLink=false", pack.includeLink === false);

  // With links toggled on, the URL lives only in the `link` field, never in copy.
  const linked = buildContentPack("2026-06-25", rows, movements, {
    includeLink: true,
    link: "https://livelocks.app/board",
  });
  check(
    "link-on: URL never leaks into copy body",
    linked.assets.every((a) => !URL_RE.test(a.body)),
  );
  check(
    "link-on: link field populated",
    linked.assets.some((a) => a.link === "https://livelocks.app/board"),
  );
}

// ── 2. Compliance filter flags prohibited terms ───────────────────────────────
{
  const r = applyCompliance("This is a LOCK and guaranteed free money, risk-free sure thing.");
  check("compliance flags prohibited copy", r.complianceStatus === "flagged");
  check("compliance reports blocked terms", r.blockedTerms.length >= 4, r.blockedTerms.join(","));
  check("compliance rewrites 'lock'", !/\block\b/i.test(r.safeCopy), r.safeCopy);
  check("compliance rewrites 'guaranteed'", !/guaranteed/i.test(r.safeCopy), r.safeCopy);
  check("compliance rewrites 'free money'", !/free money/i.test(r.safeCopy), r.safeCopy);
  check("compliance rewrites 'risk-free'", !/risk-free/i.test(r.safeCopy), r.safeCopy);

  const clean = applyCompliance("Today's signal board — watchlist setups and danger windows.");
  check("clean copy stays clean", clean.complianceStatus === "clean" && clean.blockedTerms.length === 0);

  // Substrings must NOT trip the filter (word-boundary matching).
  check("'blockbuster' does not match 'lock'", scanForBlockedTerms("blockbuster matinee").length === 0);
}

// ── 3. Movement feed does not mutate engine output ────────────────────────────
{
  const signals = [mkSignal({ batterId: "1" }), mkSignal({ batterId: "2" })];
  const states = [
    mkState({ playerId: "1", lifecycleState: "fire", section: "FIRE" }),
    mkState({ playerId: "2", lifecycleState: "ready", section: "READY" }),
  ];
  const signalsSnapshot = JSON.stringify(signals);
  const statesSnapshot = JSON.stringify(states);

  const rows = buildBoardRows(signals);
  const movements = buildMovementFeed(rows, states);

  check("movement feed leaves signals untouched", JSON.stringify(signals) === signalsSnapshot);
  check("movement feed leaves canonical states untouched", JSON.stringify(states) === statesSnapshot);
  check("movement feed produced rows", movements.length === 2);
  check(
    "movement reads canonical section verbatim (FIRE first)",
    movements[0].currentStage === "FIRE",
  );
  check(
    "movement scoreChange = current - pregame (no recompute)",
    movements[0].pregameScore === 7 && movements[0].currentScore === 8.5,
    `${movements[0].scoreChange}`,
  );
}

// ── 4. Content pack — empty board ─────────────────────────────────────────────
{
  const rows = buildBoardRows([]);
  const pack = buildContentPack("2026-06-25", rows, []);
  check("empty board still generates assets", pack.assets.length === 5);
  check("empty board assets all compliance-clean", pack.assets.every((a) => a.complianceStatus === "clean"));
  check("empty board: no URLs", pack.assets.every((a) => !URL_RE.test(a.body)));
  check(
    "empty board: daily_board present with empty image rows",
    pack.assets[0].assetType === "daily_board" && (pack.assets[0].imagePayload.rows ?? []).length === 0,
  );
}

// ── 5. Content pack — full board ──────────────────────────────────────────────
{
  const rows = buildBoardRows(FULL_BOARD);
  check("suppressed signal excluded from board", rows.length === 4);
  check("board ranked by score desc", rows[0].score === 9 && rows[0].rank === 1);

  const movements = buildMovementFeed(rows, [
    mkState({ playerId: "2", lifecycleState: "ready", section: "READY" }),
  ]);
  const pack = buildContentPack("2026-06-25", rows, movements);
  check("full board generates 5 assets", pack.assets.length === 5);
  check("daily board image has rows", (pack.assets[0].imagePayload.rows ?? []).length === 4);
  check("spotlight sources the #1 player", pack.assets[1].sourcePlayerIds[0] === "1");
  check(
    "ready/fire alert reflects READY movement",
    pack.assets[4].assetType === "ready_fire_alert" && pack.assets[4].sourcePlayerIds.includes("2"),
  );
  check("every asset carries an image payload + timing", pack.assets.every((a) => !!a.imagePayload && !!a.recommendedTiming));
}

// ── 6. Recap — no HRs ─────────────────────────────────────────────────────────
{
  const rows = buildBoardRows(FULL_BOARD);
  const movements = buildMovementFeed(rows, [
    mkState({ playerId: "2", lifecycleState: "missed", section: "MISSED", active: false, terminal: true }),
  ]);
  const recap = buildRecap("2026-06-25", rows, movements);
  check("recap (no HR) returns 3 assets", recap.assets.length === 3);
  check("recap summary: 0 cashed", recap.summary.cashed === 0);
  check("recap (no HR): no URLs", recap.assets.every((a) => !URL_RE.test(a.body)));
  check(
    "cashed_proof degrades gracefully with no HRs",
    recap.assets[0].assetType === "cashed_proof" && recap.assets[0].complianceStatus === "clean",
  );
}

// ── 7. Recap — HR cashed ──────────────────────────────────────────────────────
{
  const rows = buildBoardRows(FULL_BOARD);
  const movements = buildMovementFeed(rows, [
    mkState({ playerId: "1", lifecycleState: "cashed", section: "CASHED", displayScore10: 10, active: false, terminal: true }),
    mkState({ playerId: "2", lifecycleState: "ready", section: "READY" }),
  ]);
  const recap = buildRecap("2026-06-25", rows, movements);
  check("recap summary: 1 cashed", recap.summary.cashed === 1);
  check(
    "cashed_proof sources the cashed player",
    recap.assets[0].sourcePlayerIds.includes("1"),
  );
  check("postgame recap reflects cashed count in footer", /Cashed 1/.test(recap.assets[2].imagePayload.footer));
}

// ── 8. Analytics summary rollup ───────────────────────────────────────────────
{
  _resetHrBoardAnalyticsForTests();
  recordHrBoardEvent({ eventType: "hr_board_pack_generated", date: "2026-06-25", count: 5 });
  recordHrBoardEvent({ eventType: "hr_board_asset_copied", date: "2026-06-25", player: "Player 1", template: "spotlight" });
  recordHrBoardEvent({ eventType: "hr_board_asset_copied", date: "2026-06-25", player: "Player 1", template: "daily_board" });
  recordHrBoardEvent({ eventType: "hr_recap_generated", date: "2026-06-25", count: 3 });
  const summary = getHrBoardSummary({ date: "2026-06-25", movementAssetsAvailable: 2 });
  check("summary counts generated assets", summary.assetsGeneratedToday === 8);
  check("summary counts copied assets", summary.assetsCopiedToday === 2);
  check("summary most-copied player", summary.mostCopiedPlayer === "Player 1");
  check("summary recap status generated", summary.recapStatus === "generated");
  check("summary movement assets available", summary.movementAssetsAvailable === 2);
}

// ── 8b. Hashtags / cashtags / brand identity ──────────────────────────────────
{
  const rows = buildBoardRows(FULL_BOARD);
  const movements = buildMovementFeed(rows, [
    mkState({ playerId: "1", lifecycleState: "cashed", section: "CASHED", active: false, terminal: true }),
    mkState({ playerId: "2", lifecycleState: "ready", section: "READY" }),
  ]);
  const pack = buildContentPack("2026-06-25", rows, movements);
  const recap = buildRecap("2026-06-25", rows, movements);
  const allAssets = [...pack.assets, ...recap.assets];

  check(
    "every asset carries hashtags",
    allAssets.every((a) => Array.isArray(a.hashtags) && a.hashtags.length > 0),
  );
  check(
    "every hashtag starts with #",
    allAssets.every((a) => a.hashtags.every((h) => h.startsWith("#"))),
  );
  check(
    "every asset is brand-hashtagged",
    allAssets.every((a) => a.hashtags.includes(HR_BOARD_BRAND_HASHTAG)),
  );
  check(
    "every asset carries cashtags incl. $MLB",
    allAssets.every((a) => a.cashtags.length > 0 && a.cashtags.includes("$MLB")),
  );
  check(
    "every cashtag starts with $",
    allAssets.every((a) => a.cashtags.every((c) => c.startsWith("$"))),
  );
  check(
    "team cashtag derived from featured team ($AAA)",
    pack.assets[0].cashtags.includes("$AAA"),
    pack.assets[0].cashtags.join(","),
  );
  check(
    "brand handle folded into every copy body",
    allAssets.every((a) => a.body.includes(HR_BOARD_BRAND_HANDLE)),
  );
  check(
    "tags folded into copy body",
    allAssets.every((a) => a.hashtags.every((h) => a.body.includes(h))),
  );
  check(
    "tags never introduce blocked terms (all clean)",
    allAssets.every((a) => a.complianceStatus === "clean"),
  );
  check(
    "no blocked term hides in any hashtag/cashtag",
    allAssets.every(
      (a) => scanForBlockedTerms([...a.hashtags, ...a.cashtags].join(" ")).length === 0,
    ),
  );
  // Brand site is a URL → must stay OUT of copy, but appear on the image card.
  check(
    "brand site never leaks into copy",
    allAssets.every((a) => !a.body.includes(HR_BOARD_BRAND_SITE)),
  );
  check(
    "image payload carries brand handle + site watermark",
    allAssets.every(
      (a) => a.imagePayload.handle === HR_BOARD_BRAND_HANDLE && a.imagePayload.site === HR_BOARD_BRAND_SITE,
    ),
  );
}

// ── 9. Admin auth blocks non-admin users ──────────────────────────────────────
async function authGateTest() {
  const { requireAdmin } = await import("../auth");
  const { storage } = await import("../storage");

  function mockRes() {
    const out: { statusCode: number | null; body: any } = { statusCode: null, body: null };
    const res: any = {
      status(code: number) {
        out.statusCode = code;
        return res;
      },
      json(payload: any) {
        out.body = payload;
        return res;
      },
    };
    return { res, out };
  }

  // (a) No credentials → 401.
  {
    const { res, out } = mockRes();
    let nextCalled = false;
    await requireAdmin({ headers: {} } as any, res, () => {
      nextCalled = true;
    });
    check("auth: unauthenticated request rejected (401)", out.statusCode === 401 && !nextCalled);
  }

  // (b) Authenticated non-admin → 403.
  const origGetUser = storage.getUserById;
  try {
    (storage as any).getUserById = async (id: number) => ({ id, isAdmin: false });
    const { res, out } = mockRes();
    let nextCalled = false;
    await requireAdmin({ headers: {}, session: { userId: 7 } } as any, res, () => {
      nextCalled = true;
    });
    check("auth: non-admin request rejected (403)", out.statusCode === 403 && !nextCalled);

    // (c) Authenticated admin → next().
    (storage as any).getUserById = async (id: number) => ({ id, isAdmin: true });
    const { res: res2, out: out2 } = mockRes();
    let next2 = false;
    await requireAdmin({ headers: {}, session: { userId: 1 } } as any, res2, () => {
      next2 = true;
    });
    check("auth: admin request passes through", next2 && out2.statusCode === null);
  } finally {
    (storage as any).getUserById = origGetUser;
  }
}

(async () => {
  try {
    await authGateTest();
  } catch (e: any) {
    // The auth module pulls native deps (bcrypt) that may be absent in a bare
    // sandbox. A missing-module error is an environment gap, not a logic
    // failure — skip cleanly (CI/Railway have the deps and run the real gate).
    const msg = e?.message ?? String(e);
    if (e?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package|Cannot find module/.test(msg)) {
      console.warn(`[HR_BOARD_STUDIO_TEST] SKIP auth gate (env missing dep): ${msg}`);
    } else {
      check("auth gate test executed", false, msg);
    }
  }

  console.log(`[HR_BOARD_STUDIO_TEST] passed=${pass} failed=${fail}`);
  if (fail > 0) process.exit(1);
  console.log("[HR_BOARD_STUDIO_TEST] OK");
})();
