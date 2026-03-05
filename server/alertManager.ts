import { sendPush } from "./webpush";
import { sendSms } from "./twilioService";
import type { IStorage } from "./storage";
import { db } from "./db";
import { sentAlerts } from "@shared/schema";
import { eq, and, gt } from "drizzle-orm";

// ── In-memory guards (process-lifetime, fast path) ────────────────────────────
const alertedPlays = new Set<string>();
const alerted2HGames = new Set<string>();

// ── Build today's date string (UTC date, matches daily dedup window) ──────────
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── DB-backed SMS dedup ───────────────────────────────────────────────────────
// fingerprint format: sms|userId|playKey|date
// Returns true if the alert is new (not yet sent), and marks it as sent.
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

// ── Main alert dispatcher ─────────────────────────────────────────────────────
export async function checkAndSendAlerts(
  plays: any[],
  storage: IStorage
): Promise<void> {
  if (!plays || plays.length === 0) return;

  const highConfidencePlays = plays.filter(
    (p) => Math.abs(p.probability - 50) >= 40
  );

  const newH2GameIds = plays
    .filter((p) => p.statType !== "ncaab_total" && p.statType !== "ncaab_1h_total")
    .map((p) => p.gameId)
    .filter((id) => id && !alerted2HGames.has(id));

  if (highConfidencePlays.length === 0 && newH2GameIds.length === 0) return;

  let allUsers: any[] = [];
  try {
    allUsers = await storage.getAllUsers();
  } catch (err) {
    console.warn("[alertManager] Failed to fetch users:", err);
    return;
  }

  const usersWithPush = allUsers.filter((u: any) => u.pushAlerts && u.pushSubscription);
  const usersWithSms  = allUsers.filter(
    (u: any) => ["all", "elite"].includes(u.subscriptionTier) && u.smsAlerts && u.phoneNumber
  );

  // ── High-confidence prop play alerts ────────────────────────────────────────
  for (const play of highConfidencePlays) {
    // Process-level dedup (survives per-polling-cycle; resets on restart)
    const playKey = `${play.playerId ?? play.playerName}|${play.statType}|${play.line}|${play.betDirection}|${play.gameId ?? ""}`;
    const processFingerprint = `${playKey}|${todayStr()}`;
    if (alertedPlays.has(processFingerprint)) continue;
    alertedPlays.add(processFingerprint);

    const dir  = play.betDirection === "over" ? "O" : "U";
    const prob = play.betDirection === "over"
      ? play.probability.toFixed(0)
      : (100 - play.probability).toFixed(0);

    const title    = "🔒 LiveLocks High-Confidence Play";
    const pushBody = `${play.playerName} ${dir}${play.line} — ${prob}% confidence. Tap to view.`;
    const smsBody  = `LiveLocks: ${play.playerName} ${dir}${play.line} — ${prob}% confidence. livelocksai.app`;

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

    for (const user of usersWithPush) {
      sendPush(user.pushSubscription, {
        title, body: pushBody, url: "/", data: deepLinkData,
      }).catch(console.warn);
    }

    for (const user of usersWithSms) {
      await sendSmsIfNew(user.id, user.phoneNumber, playKey, smsBody);
    }
  }

  // ── 2H-started game alerts ───────────────────────────────────────────────────
  for (const gameId of newH2GameIds) {
    alerted2HGames.add(gameId);
    const play = plays.find((p) => p.gameId === gameId);
    if (!play) continue;

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
}
