import { sendPush } from "./webpush";
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

  let usersWithAlerts: any[] = [];
  try {
    const allUsers = await storage.getAllUsers();
    usersWithAlerts = allUsers.filter(
      (u: any) => u.pushAlerts && u.pushSubscription
    );
  } catch (err) {
    console.warn("[alertManager] Failed to fetch users:", err);
    return;
  }

  if (usersWithAlerts.length === 0 && newH2GameIds.length === 0) return;

  for (const play of highConfidencePlays) {
    const fingerprint = `${play.playerName}|${play.statType}|${play.line}`;
    if (alertedPlays.has(fingerprint)) continue;
    alertedPlays.add(fingerprint);

    const dir = play.betDirection === "over" ? "O" : "U";
    const prob = play.betDirection === "over"
      ? play.probability.toFixed(0)
      : (100 - play.probability).toFixed(0);
    const title = "🔒 LiveLocks High-Confidence Play";
    const body = `${play.playerName} ${dir}${play.line} — ${prob}% confidence. Tap to view.`;

    for (const user of usersWithAlerts) {
      sendPush(user.pushSubscription, { title, body, url: "/" }).catch(console.warn);
    }
  }

  for (const gameId of newH2GameIds) {
    alerted2HGames.add(gameId);
    const play = plays.find((p) => p.gameId === gameId);
    if (!play) continue;
    const title = "⏱ LiveLocks: 2H Plays Live";
    const body = `${play.team} vs ${play.opponent} — 2H started. Check your slate.`;

    for (const user of usersWithAlerts) {
      sendPush(user.pushSubscription, { title, body, url: "/" }).catch(console.warn);
    }
  }
}
