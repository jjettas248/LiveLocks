import { sendPush } from "./webpush";
import { sendSms } from "./twilioService";
import type { IStorage } from "./storage";
import { db } from "./db";
import { sentAlerts } from "@shared/schema";
import { eq, and, gt } from "drizzle-orm";

// ── In-memory guards (process-lifetime, fast path) ────────────────────────────
const alertedPlays = new Set<string>();
const alerted2HGames = new Set<string>();
const alertedHalftimeGames = new Set<string>();

// ── Build today's date string (UTC date, matches daily dedup window) ──────────
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── DB-backed SMS dedup ───────────────────────────────────────────────────────
async function sendSmsIfNew(
  userId: number,
  phone: string,
  playKey: string,
  body: string
): Promise<void> {
  const fingerprint = `sms|${userId}|${playKey}|${todayStr()}`;

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await db
      .select({ id: sentAlerts.id })
      .from(sentAlerts)
      .where(
        and(
          eq(sentAlerts.fingerprint, fingerprint),
          gt(sentAlerts.sentAt, cutoff)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(`[SMS] Skipping duplicate alert for user ${userId}: ${playKey}`);
      return;
    }

    await sendSms(phone, body);
    await db.insert(sentAlerts).values({ fingerprint, userId }).onConflictDoNothing();
    console.log(`[SMS] Sent + recorded for user ${userId}: ${playKey}`);
  } catch (err) {
    console.warn(`[SMS] Failed for user ${userId}:`, (err as any).message);
  }
}

// ── DB-backed 2H game alert dedup (survives server restarts) ──────────────────
async function is2HAlertAlreadySent(gameId: string): Promise<boolean> {
  const fingerprint = `2h|${gameId}|${todayStr()}`;
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await db
      .select({ id: sentAlerts.id })
      .from(sentAlerts)
      .where(
        and(
          eq(sentAlerts.fingerprint, fingerprint),
          gt(sentAlerts.sentAt, cutoff)
        )
      )
      .limit(1);
    return existing.length > 0;
  } catch {
    return false;
  }
}

async function record2HAlert(gameId: string): Promise<void> {
  const fingerprint = `2h|${gameId}|${todayStr()}`;
  try {
    await db.insert(sentAlerts).values({ fingerprint, userId: 0 }).onConflictDoNothing();
  } catch {}
}

// ── Main alert dispatcher ─────────────────────────────────────────────────────
export async function checkAndSendAlerts(
  plays: any[],
  storage: IStorage
): Promise<void> {
  if (!plays || plays.length === 0) return;

  const pushAlertPlays = plays.filter(
    (p) => p.probability != null && Math.abs(p.probability - 50) >= 25
  );
  const smsAlertPlays = plays.filter(
    (p) => p.probability != null && Math.abs(p.probability - 50) >= 35
  );

  const newH2GameIds = plays
    .filter((p) => p.statType !== "ncaab_total" && p.statType !== "ncaab_1h_total" && !p.bettingWindow)
    .map((p) => p.gameId)
    .filter((id) => id && !alerted2HGames.has(id));

  const ncaabHalftimeByGame = new Map<string, any>();
  for (const p of plays) {
    if (
      p.bettingWindow === "HALFTIME" &&
      p.over2HProb != null &&
      p.over2HProb >= 85 &&
      p.gameId &&
      !alertedHalftimeGames.has(`${p.gameId}|${todayStr()}`)
    ) {
      const existing = ncaabHalftimeByGame.get(p.gameId);
      if (!existing || p.over2HProb > existing.over2HProb) {
        ncaabHalftimeByGame.set(p.gameId, p);
      }
    }
  }

  if (pushAlertPlays.length === 0 && smsAlertPlays.length === 0 && newH2GameIds.length === 0 && ncaabHalftimeByGame.size === 0) return;

  let allUsers: any[] = [];
  try {
    allUsers = await storage.getAllUsers();
  } catch (err) {
    console.warn("[alertManager] Failed to fetch users:", err);
    return;
  }

  const usersWithPush = allUsers.filter((u: any) => u.pushSubscription);
  const usersWithSms  = allUsers.filter(
    (u: any) => (["all", "elite"].includes(u.subscriptionTier) || u.isAdmin) && u.smsAlerts && u.phoneNumber
  );

  // ── NBA high-confidence prop play alerts ──────────────────────────────────
  const allPropPlays = Array.from(new Set([...pushAlertPlays, ...smsAlertPlays]));
  for (const play of allPropPlays) {
    const playKey = `${play.playerId ?? play.playerName}|${play.statType}|${play.line}|${play.betDirection}|${play.gameId ?? ""}`;
    const processFingerprint = `${playKey}|${todayStr()}`;
    if (alertedPlays.has(processFingerprint)) continue;
    alertedPlays.add(processFingerprint);

    const edge = Math.abs(play.probability - 50);
    const isPushEligible = edge >= 25;
    const isSmsEligible  = edge >= 35;

    const dir  = play.betDirection === "over" ? "O" : "U";
    const prob = play.betDirection === "over"
      ? play.probability.toFixed(0)
      : (100 - play.probability).toFixed(0);

    const title    = "🔒 LiveLocks High-Confidence Play";
    const pushBody = `${play.playerName} ${dir}${play.line} — ${prob}% implied. Tap to view.`;
    const smsBody  = `LiveLocks: ${play.playerName} ${dir}${play.line} — ${prob}% implied. livelocksai.app`;

    const deepLinkData = {
      url: "/",
      tab: "nba",
      gameId:    play.gameId ?? "",
      playerId:  play.playerId ? String(play.playerId) : "",
      market:    play.statType ?? "",
      direction: play.betDirection ?? "",
      line:      play.line ?? 0,
      confidence: Number(prob),
      cardType: "prop",
    };

    if (isPushEligible) {
      for (const user of usersWithPush) {
        sendPush(user.pushSubscription, {
          title, body: pushBody, url: "/", data: deepLinkData,
        }).catch(console.warn);
      }
    }
    if (isSmsEligible) {
      for (const user of usersWithSms) {
        await sendSmsIfNew(user.id, user.phoneNumber, playKey, smsBody);
      }
    }
  }

  // ── NBA 2H-started game alerts (DB-backed dedup) ─────────────────────────
  for (const gameId of newH2GameIds) {
    alerted2HGames.add(gameId);

    const alreadySent = await is2HAlertAlreadySent(gameId);
    if (alreadySent) {
      console.log(`[alertManager] Skipping duplicate 2H alert for game ${gameId} (DB dedup)`);
      continue;
    }

    const play = plays.find((p) => p.gameId === gameId);
    if (!play) continue;

    await record2HAlert(gameId);

    const gameKey  = `2h|${gameId}`;
    const title    = "⏱ LiveLocks: 2H Plays Live";
    const pushBody = `${play.team} vs ${play.opponent} — 2H started. Check your slate.`;
    const smsBody  = `LiveLocks: ${play.team} vs ${play.opponent} — 2H plays are live! livelocksai.app`;

    const deepLinkData = {
      url: "/", tab: "nba", gameId, cardType: "game", trigger: "2h_live",
    };

    for (const user of usersWithPush) {
      sendPush(user.pushSubscription, {
        title, body: pushBody, url: "/", data: deepLinkData,
      }).catch(console.warn);
    }
    for (const user of usersWithSms) {
      await sendSmsIfNew(user.id, user.phoneNumber, gameKey, smsBody);
    }
  }

  // ── NCAAB halftime alerts — ONE per game, only when over2HProb ≥ 85% ─────
  for (const [gameId, play] of Array.from(ncaabHalftimeByGame)) {
    alertedHalftimeGames.add(`${gameId}|${todayStr()}`);

    const line = play.h2TotalLine ?? play.effectiveH2Line;
    const prob = Math.round(play.over2HProb);
    const lineStr = line != null ? ` O/U ${line}` : "";
    const gameKey = `ncaab-halftime|${gameId}`;

    const title    = "🏀 NCAAB Halftime Edge";
    const pushBody = `${play.awayTeam} @ ${play.homeTeam}${lineStr} — ${prob}% over. Halftime play live.`;
    const smsBody  = `LiveLocks NCAAB: ${play.awayTeam} @ ${play.homeTeam}${lineStr} — ${prob}% over at halftime. livelocksai.app`;

    const deepLinkData = {
      url: "/", tab: "ncaab", gameId, cardType: "game", trigger: "halftime",
    };

    console.log(`[alertManager] NCAAB halftime alert: ${play.awayTeam} @ ${play.homeTeam} — ${prob}% over`);

    for (const user of usersWithPush) {
      sendPush(user.pushSubscription, {
        title, body: pushBody, url: "/", data: deepLinkData,
      }).catch(console.warn);
    }
    for (const user of usersWithSms) {
      await sendSmsIfNew(user.id, user.phoneNumber, gameKey, smsBody);
    }
  }
}
