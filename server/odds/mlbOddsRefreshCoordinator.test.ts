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
  reconsiderDormantMarkets,
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

// ── Signal-aware priority: urgency comes from canonical lifecycle state ──────
// Monitoring/Track uses cached odds only; Build refreshes when materially
// stale; Ready/Strong refreshes briskly; Fire/Elite requires fresh pricing.
_resetMlbOddsRefreshCoordinatorForTests();
registerMarketInterest({ eventId: "evtP", market: "hits", gameStatus: "live", urgency: "watch" });
check("priority: lifecycle watch is monitoring (no routine refresh)", _getInterestForTests("evtP", "hits")?.priority === "monitoring");

registerMarketInterest({ eventId: "evtP", market: "hits", gameStatus: "live", urgency: "build", stale: false });
check("priority: lifecycle build is build (stale-only cadence)", _getInterestForTests("evtP", "hits")?.priority === "build");

registerMarketInterest({ eventId: "evtP", market: "hits", gameStatus: "live", urgency: "strong" });
check("priority: lifecycle strong is ready", _getInterestForTests("evtP", "hits")?.priority === "ready");

registerMarketInterest({ eventId: "evtP", market: "hits", gameStatus: "live", urgency: "elite" });
check("priority: lifecycle elite is actionable", _getInterestForTests("evtP", "hits")?.priority === "actionable");

registerMarketInterest({ eventId: "evtP2", market: "hits", gameStatus: "live", urgency: "build", stale: true });
check("priority: build + materially stale escalates to ready", _getInterestForTests("evtP2", "hits")?.priority === "ready");

registerMarketInterest({ eventId: "evtB", market: "home_runs", gameStatus: "pregame", urgency: "elite" });
check("priority: pregame never exceeds monitoring", _getInterestForTests("evtB", "home_runs")?.priority === "monitoring");

// ── Time alone never refreshes a monitoring market ───────────────────────────
{
  _resetMlbOddsRefreshCoordinatorForTests();
  registerMarketInterest({ eventId: "evtM", market: "hits", gameStatus: "live", urgency: "watch" });
  const afterDiscovery = _getInterestForTests("evtM", "hits")!.lastRefreshedAt;
  check("monitoring: first registration still gets one discovery refresh", afterDiscovery > 0);

  // Simulate a long quiet stretch: a non-material re-registration with a fresh
  // cache must not spend anything.
  registerMarketInterest({ eventId: "evtM", market: "hits", gameStatus: "live", urgency: "watch", stale: false, materialEvent: false });
  check(
    "monitoring: elapsed time with no material event triggers no refresh",
    _getInterestForTests("evtM", "hits")!.lastRefreshedAt === afterDiscovery,
  );

  // A real baseball event with nothing fresh cached may spend.
  // Small real delay so the refresh timestamp is distinguishable from the
  // discovery one (both are Date.now() and would otherwise collide in-ms).
  await new Promise((r) => setTimeout(r, 5));
  registerMarketInterest({ eventId: "evtM", market: "hits", gameStatus: "live", urgency: "watch", stale: true, materialEvent: true });
  check(
    "monitoring: a material baseball event with a stale cache does refresh",
    _getInterestForTests("evtM", "hits")!.lastRefreshedAt > afterDiscovery,
  );
}

// ── Immediate fire on new/promoted interest (never waits for a timer) ─────────
{
  _resetMlbOddsRefreshCoordinatorForTests();
  const before = Date.now();
  registerMarketInterest({ eventId: "evtG", market: "hits", gameStatus: "live", urgency: "elite", stale: true });
  const interest = _getInterestForTests("evtG", "hits");
  check(
    "immediate fire: a brand-new actionable interest stamps lastRefreshedAt synchronously",
    !!interest && interest.lastRefreshedAt >= before && interest.lastRefreshedAt <= Date.now(),
    JSON.stringify(interest),
  );
}

// ── Price floor: dormancy and rediscovery ────────────────────────────────────
{
  _resetMlbOddsRefreshCoordinatorForTests();
  // 2nd inning: best approved price on the evaluated side is -235 -> dormant.
  registerMarketInterest({
    eventId: "evtD1", market: "home_runs", gameStatus: "live", urgency: "build",
    bestPriceForSide: -235, priceEligible: false,
  });
  const dormant = _getInterestForTests("evtD1", "home_runs");
  check("dormant: a sub-floor market is parked, not deleted", dormant !== undefined);
  check("dormant: flagged dormant", dormant?.dormant === true, JSON.stringify(dormant));
  check("dormant: no refresh was issued", dormant?.lastRefreshedAt === 0, String(dormant?.lastRefreshedAt));
  check("dormant: last seen price recorded", dormant?.lastBestPrice === -235);

  // Repeated registrations while still sub-floor keep it dormant and silent.
  registerMarketInterest({
    eventId: "evtD1", market: "home_runs", gameStatus: "live", urgency: "build",
    bestPriceForSide: -240, priceEligible: false,
  });
  check("dormant: still no refresh on repeat sub-floor registrations", _getInterestForTests("evtD1", "home_runs")?.lastRefreshedAt === 0);

  // 5th inning: a real baseball event grants ONE rediscovery opportunity.
  const granted = reconsiderDormantMarkets("evtD1", "inning_change");
  check("rediscovery: a material event grants exactly one opportunity", granted === 1, String(granted));
  check("rediscovery: grant is pending until consumed", _getInterestForTests("evtD1", "home_runs")?.rediscoveryPending === true);

  // The grant buys one refresh even though the last known price is still bad —
  // that request is how we learn the price moved.
  registerMarketInterest({
    eventId: "evtD1", market: "home_runs", gameStatus: "live", urgency: "build",
    bestPriceForSide: -240, priceEligible: false,
  });
  const afterGrant = _getInterestForTests("evtD1", "home_runs");
  check("rediscovery: the grant spends exactly one refresh", afterGrant!.lastRefreshedAt > 0);
  check("rediscovery: the grant is consumed", afterGrant?.rediscoveryPending === false);

  // Price recovered to -175 -> reactivate.
  registerMarketInterest({
    eventId: "evtD1", market: "home_runs", gameStatus: "live", urgency: "build",
    bestPriceForSide: -175, priceEligible: true,
  });
  const reactivated = _getInterestForTests("evtD1", "home_runs");
  check("reactivation: an improved price clears dormancy", reactivated?.dormant === false, JSON.stringify(reactivated));
  check("reactivation: the recovered price is recorded", reactivated?.lastBestPrice === -175);
}
{
  // A market that was never dormant is unaffected by reconsideration.
  _resetMlbOddsRefreshCoordinatorForTests();
  registerMarketInterest({ eventId: "evtD2", market: "hits", gameStatus: "live", urgency: "build", priceEligible: true, bestPriceForSide: -110 });
  check("rediscovery: nothing to grant when no market is dormant", reconsiderDormantMarkets("evtD2", "inning_change") === 0);
  check("rediscovery: a healthy market is never marked dormant", _getInterestForTests("evtD2", "hits")?.dormant === false);
}
{
  // Dormancy is per event — reconsidering one game never touches another.
  _resetMlbOddsRefreshCoordinatorForTests();
  registerMarketInterest({ eventId: "evtD3", market: "hits", gameStatus: "live", priceEligible: false, bestPriceForSide: -300 });
  registerMarketInterest({ eventId: "evtD4", market: "hits", gameStatus: "live", priceEligible: false, bestPriceForSide: -300 });
  reconsiderDormantMarkets("evtD3", "pitcher_change");
  check("rediscovery: scoped to one event", _getInterestForTests("evtD3", "hits")?.rediscoveryPending === true);
  check("rediscovery: other events untouched", _getInterestForTests("evtD4", "hits")?.rediscoveryPending === false);
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
