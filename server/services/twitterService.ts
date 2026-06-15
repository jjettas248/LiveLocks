import { TwitterApi } from "twitter-api-v2";

interface HrHitTweetData {
  playerName: string;
  team: string;
  inning: number;
  hitLabel: string;
  stage: string;
  score10: number | null;
}

interface DailySummaryTweetData {
  date: string;
  cashHits: Array<{ playerName: string; team: string; inning: number }>;
  totalCalled: number;
  totalHit: number;
}

function getClient(): InstanceType<typeof TwitterApi> | null {
  const appKey    = process.env.TWITTER_APP_KEY;
  const appSecret = process.env.TWITTER_APP_SECRET;
  const accessToken  = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!appKey || !appSecret || !accessToken || !accessSecret) return null;
  return new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "fire":  return "Attack Now";
    case "ready": return "Ready";
    case "build": return "Building";
    default:      return "Tracking";
  }
}

export async function postHrHitTweet(
  data: HrHitTweetData,
  imageBuffer?: Buffer,
): Promise<void> {
  const client = getClient();
  if (!client) {
    console.log(`[TWITTER_AUTO_TWEET_SKIP] No credentials — would have tweeted HR hit for ${data.playerName}`);
    return;
  }

  const scoreStr = data.score10 != null ? ` | Score: ${data.score10.toFixed(1)}/10` : "";
  const text = [
    `✅ Called it! ${data.playerName} (${data.team}) just homered in inning ${data.hitLabel}`,
    `LiveLocks HR Radar had ${data.playerName.split(" ")[1] ?? data.playerName} at ${stageLabel(data.stage)}${scoreStr}`,
    `#MLB #HRRadar #PropPulse`,
  ].join("\n\n");

  try {
    let mediaId: string | undefined;
    if (imageBuffer) {
      const uploaded = await client.v1.uploadMedia(imageBuffer, { mimeType: "image/png" });
      mediaId = uploaded;
    }
    await client.v2.tweet({ text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) });
    console.log(`[TWITTER_AUTO_TWEET_SENT] player=${data.playerName} inning=${data.hitLabel}`);
  } catch (e: any) {
    console.warn(`[TWITTER_AUTO_TWEET_FAIL] player=${data.playerName} err=${e.message}`);
  }
}

export async function postDailySummaryTweet(data: DailySummaryTweetData): Promise<void> {
  const client = getClient();
  if (!client) {
    console.log(`[TWITTER_DAILY_TWEET_SKIP] No credentials — would have posted daily summary for ${data.date}`);
    return;
  }
  if (data.cashHits.length === 0) return;

  const hitRate = data.totalCalled > 0
    ? `${Math.round((data.totalHit / data.totalCalled) * 100)}%`
    : "N/A";

  const playerLines = data.cashHits
    .slice(0, 5)
    .map(h => `• ${h.playerName} (${h.team}) — HR inning ${h.inning}`)
    .join("\n");

  const more = data.cashHits.length > 5 ? `\n+${data.cashHits.length - 5} more` : "";

  const text = [
    `📊 LiveLocks HR Radar recap — ${data.date}`,
    `Called: ${data.totalCalled} | Hit: ${data.totalHit} | Rate: ${hitRate}`,
    playerLines + more,
    `#MLB #HRRadar #PropPulse`,
  ].join("\n\n");

  try {
    await client.v2.tweet({ text });
    console.log(`[TWITTER_DAILY_TWEET_SENT] date=${data.date} hits=${data.totalHit}`);
  } catch (e: any) {
    console.warn(`[TWITTER_DAILY_TWEET_FAIL] date=${data.date} err=${e.message}`);
  }
}
