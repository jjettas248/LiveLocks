import { storage } from "../storage";
import { fetchMlbBoxScore, buildMlbPlayerStats, getMlbStatValue } from "../services/gradePersistedPlays";
import { normalizeMlbMarketKey } from "../mlb/normalizeMarketKey";

async function main() {
  console.log("[BACKFILL_DNP] Starting one-shot DNP void backfill for stuck MLB plays…");

  const { plays: pending } = await storage.getPlays({ limit: 5000, settled: "pending" });
  const mlbStuck = pending.filter(p => p.sport === "mlb" && p.gameId && p.playerId);
  console.log(`[BACKFILL_DNP] Found ${mlbStuck.length} pending MLB plays`);

  const byGame = new Map<string, typeof mlbStuck>();
  for (const p of mlbStuck) {
    const g = String(p.gameId);
    const list = byGame.get(g) ?? [];
    list.push(p);
    byGame.set(g, list);
  }
  console.log(`[BACKFILL_DNP] Spread across ${byGame.size} games`);

  let voided = 0;
  let stillPending = 0;
  let errored = 0;

  for (const [gameId, plays] of Array.from(byGame)) {
    try {
      const box = await fetchMlbBoxScore(gameId);
      if (!box) {
        stillPending += plays.length;
        continue;
      }
      const playerMap = buildMlbPlayerStats(box);

      for (const play of plays) {
        try {
          const entry = playerMap.get(String(play.playerId));
          if (!entry) {
            stillPending++;
            continue;
          }
          const market = normalizeMlbMarketKey(play.market);
          const finalStat = getMlbStatValue(entry, market);
          if (finalStat !== null) {
            stillPending++;
            continue;
          }
          const battingKeys = Object.keys(entry.batting);
          const pitchingKeys = Object.keys(entry.pitching);
          if (battingKeys.length === 0 && pitchingKeys.length === 0) {
            await storage.settlePlay(play.id, "void", null, new Date());
            voided++;
            if (voided % 25 === 0) console.log(`[BACKFILL_DNP] voided=${voided}…`);
          } else {
            stillPending++;
          }
        } catch (err: any) {
          errored++;
          console.warn(`[BACKFILL_DNP] play ${play.id} error: ${err.message}`);
        }
      }
    } catch (err: any) {
      errored += plays.length;
      console.warn(`[BACKFILL_DNP] game ${gameId} fetch error: ${err.message}`);
    }
  }

  console.log(`[BACKFILL_DNP] DONE — voided=${voided} stillPending=${stillPending} errored=${errored}`);
  process.exit(0);
}

main().catch(err => { console.error("[BACKFILL_DNP] FATAL:", err); process.exit(1); });
