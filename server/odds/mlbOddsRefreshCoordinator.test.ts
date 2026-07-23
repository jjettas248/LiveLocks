// MLB odds refresh coordinator tests — interest-driven refresh scheduling,
// independent of oddsScheduler.ts (game-state polling).
// Run: npx tsx server/odds/mlbOddsRefreshCoordinator.test.ts
//
// Mocks global.fetch so registerMarketInterest's fire-and-forget refreshes
// resolve harmlessly without a real network call. Sets a fake ODDS_API_KEY
// BEFORE importing the coordinator (dynamic import) since it transitively
// imports oddsService.ts.

process.env.ODDS_API_KEY = process.env.ODDS_API_KEY ?? "test-key-1";

(globalThis as any).fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: (_k: string) => null },
  text: async () => "{}",
  json: async () => ({ bookmakers: [] }),
});

const coordinator = await import("./mlbOddsRefreshCoordinator");
const {
  registerMarketInterest,
  removeGameInterests,
  _getInterestForTests,
  _getInterestCountForTests,
  _resetMlbOddsRefreshCoordinatorForTests,
} = coordinator;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_ODDS_REFRESH_COORDINATOR_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

_resetMlbOddsRefreshCoordinatorForTests();

// ── Dedup by eventId + marketKey ───────────────────────────────────────────────
registerMarketInterest({ eventId: "evtA", market: "hits", gameStatus: "live", stale: false });
check("dedupe: interest tracked after first registration", _getInterestForTests("evtA", "hits") !== undefined);
registerMarketInterest({ eventId: "evtA", market: "hits", gameStatus: "live", stale: false });
registerMarketInterest({ eventId: "evtA", market: "hits", gameStatus: "live", stale: false });
check("dedupe: repeat registrations for the same event+market collapse to one interest", _getInterestCountForTests() === 1);

// ── Priority: watched (fresh/pregame) vs near-actionable (live+stale) ─────────
check("priority: live + fresh (stale=false) is watched (2min cadence)", _getInterestForTests("evtA", "hits")?.priority === "watched");
registerMarketInterest({ eventId: "evtA", market: "hits", gameStatus: "live", stale: true });
check("priority: live + stale promotes to near-actionable (30s cadence)", _getInterestForTests("evtA", "hits")?.priority === "near_actionable");

registerMarketInterest({ eventId: "evtB", market: "home_runs", gameStatus: "pregame" });
check("priority: pregame is watched", _getInterestForTests("evtB", "home_runs")?.priority === "watched");

// ── Immediate fire on new/promoted interest (never waits for a timer) ─────────
{
  const before = Date.now();
  registerMarketInterest({ eventId: "evtG", market: "hits", gameStatus: "live", stale: true });
  const interest = _getInterestForTests("evtG", "hits");
  check(
    "immediate fire: a brand-new near-actionable interest stamps lastRefreshedAt synchronously",
    !!interest && interest.lastRefreshedAt >= before && interest.lastRefreshedAt <= Date.now(),
    JSON.stringify(interest),
  );
}

// ── Unknown status: cache-only — never tracked, never spends quota ────────────
_resetMlbOddsRefreshCoordinatorForTests();
registerMarketInterest({ eventId: "evtC", market: "hits", gameStatus: "unknown" });
check("unknown status: never tracked (cache-only, no quota spend)", _getInterestForTests("evtC", "hits") === undefined);
check("unknown status: interest count stays 0", _getInterestCountForTests() === 0);

// ── Final status: permanently stops refresh scheduling ─────────────────────────
registerMarketInterest({ eventId: "evtD", market: "hits", gameStatus: "live", stale: true });
check("final: interest exists before the game goes final", _getInterestForTests("evtD", "hits") !== undefined);
registerMarketInterest({ eventId: "evtD", market: "hits", gameStatus: "final" });
check("final: registering final status removes the interest immediately", _getInterestForTests("evtD", "hits") === undefined);
registerMarketInterest({ eventId: "evtD", market: "hits", gameStatus: "final" });
check("final: re-registering final on an already-gone interest is a safe no-op", _getInterestForTests("evtD", "hits") === undefined);

// ── removeGameInterests clears every market for a game, leaves others alone ───
registerMarketInterest({ eventId: "evtE", market: "hits", gameStatus: "live", stale: true });
registerMarketInterest({ eventId: "evtE", market: "home_runs", gameStatus: "live", stale: true });
registerMarketInterest({ eventId: "evtF", market: "hits", gameStatus: "live", stale: true });
check(
  "removeGameInterests: evtE has both tracked markets before removal",
  _getInterestForTests("evtE", "hits") !== undefined && _getInterestForTests("evtE", "home_runs") !== undefined,
);
removeGameInterests("evtE");
check(
  "removeGameInterests: both evtE markets gone after removal",
  _getInterestForTests("evtE", "hits") === undefined && _getInterestForTests("evtE", "home_runs") === undefined,
);
check("removeGameInterests: unrelated evtF interest is untouched", _getInterestForTests("evtF", "hits") !== undefined);

console.log(`[MLB_ODDS_REFRESH_COORDINATOR_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
