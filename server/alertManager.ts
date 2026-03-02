import { sendPush } from "./webpush";
import { sendSms } from "./twilioService";
import type { IStorage } from "./storage";

const alertedPlays = new Set<string>();
const alerted2HGames = new Set<string>();

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
  const usersWithSms = allUsers.filter(
    (u: any) => u.subscriptionTier === "elite" && u.smsAlerts && u.phoneNumber
  );

  for (const play of highConfidencePlays) {
    const fingerprint = `${play.playerName}|${play.statType}|${play.line}`;
    if (alertedPlays.has(fingerprint)) continue;
    alertedPlays.add(fingerprint);

    const dir = play.betDirection === "over" ? "O" : "U";
    const prob = play.betDirection === "over"
      ? play.probability.toFixed(0)
      : (100 - play.probability).toFixed(0);
    const title = "🔒 LiveLocks High-Confidence Play";
    const pushBody = `${play.playerName} ${dir}${play.line} — ${prob}% confidence. Tap to view.`;
    const smsBody = `LiveLocks: ${play.playerName} ${dir}${play.line} — ${prob}% confidence. livelocksai.app`;

    for (const user of usersWithPush) {
      sendPush(user.pushSubscription, { title, body: pushBody, url: "/" }).catch(console.warn);
    }
    for (const user of usersWithSms) {
      sendSms(user.phoneNumber, smsBody).catch(console.warn);
    }
  }

  for (const gameId of newH2GameIds) {
    alerted2HGames.add(gameId);
    const play = plays.find((p) => p.gameId === gameId);
    if (!play) continue;
    const title = "⏱ LiveLocks: 2H Plays Live";
    const pushBody = `${play.team} vs ${play.opponent} — 2H started. Check your slate.`;
    const smsBody = `LiveLocks: ${play.team} vs ${play.opponent} — 2H plays are live! livelocksai.app`;

    for (const user of usersWithPush) {
      sendPush(user.pushSubscription, { title, body: pushBody, url: "/" }).catch(console.warn);
    }
    for (const user of usersWithSms) {
      sendSms(user.phoneNumber, smsBody).catch(console.warn);
    }
  }
}
