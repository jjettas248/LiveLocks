// HR Radar promotion alerts — dispatches a real push notification the first
// time a player reaches "ready" (Playable) or "fire" (Attack) in a game.
//
// Wired in via hrRadarCanonicalStore.setHrRadarPromotionHook (server/index.ts
// boot), so this module never needs to be imported by the pure state machine
// or its persistence layer — it's a subscriber, not part of the transition
// graph. Every failure is caught and logged; this can never break HR Radar
// runtime.

import { storage } from "../storage";
import { sendPushToUser } from "../pushDelivery";
import { resolveAccess } from "../utils/access";
import { todayET } from "../utils/dateUtils";
import { hasAlertFingerprint, recordAlertFingerprint } from "../alertDedupe";
import type { CanonicalHrRadarState } from "./hrRadarCanonicalStore";
import type { HrRadarApplyResult } from "./hrRadarStateMachine";

const TIER_COPY: Record<"ready" | "fire", { emoji: string; label: string; body: string }> = {
  ready: {
    emoji: "🎯",
    label: "Playable HR Candidate",
    body: "is now playable for the HR.",
  },
  fire: {
    emoji: "🔥",
    label: "Attack Now",
    body: "is live to attack for the HR.",
  },
};

export async function notifyHrRadarPromotion(
  state: CanonicalHrRadarState,
  apply: HrRadarApplyResult,
): Promise<void> {
  const stage = apply.nextState;
  if (stage !== "ready" && stage !== "fire") return;
  if (!apply.ok || apply.previousState === stage) return;

  const fingerprint = `hrradar|${state.gameId}|${state.playerId}|${stage}|${todayET()}`;
  if (await hasAlertFingerprint(fingerprint)) {
    console.log(`[LL_HR_RADAR_ALERT_SUPPRESSED] reason=dedupe fingerprint=${fingerprint}`);
    return;
  }

  let allUsers: any[] = [];
  try {
    allUsers = await storage.getAllUsers();
  } catch (err) {
    console.warn(`[LL_HR_RADAR_ALERT_SUPPRESSED] reason=user-fetch-failed message=${(err as Error).message}`);
    return;
  }

  const recipients = allUsers.filter((u: any) => {
    const access = resolveAccess(u.subscriptionTier, u.isAdmin ?? false);
    return access.hasMLB && !!u.pushSubscription;
  });

  if (recipients.length === 0) {
    console.log(`[LL_HR_RADAR_ALERT_SUPPRESSED] reason=no-eligible-recipients fingerprint=${fingerprint}`);
    return;
  }

  const copy = TIER_COPY[stage];
  const title = `${copy.emoji} LiveLocks: ${copy.label}`;
  const teamSuffix = state.team ? ` (${state.team})` : "";
  const body = `${state.playerName}${teamSuffix} ${copy.body} Tap to view.`;

  console.log(`[LL_HR_RADAR_ALERT_QUEUED] fingerprint=${fingerprint} recipients=${recipients.length}`);
  await recordAlertFingerprint(fingerprint);

  let sent = 0;
  for (const user of recipients) {
    const result = await sendPushToUser(user, {
      title,
      body,
      url: "/",
      data: {
        tab: "mlb",
        cardType: "hr_radar",
        gameId: state.gameId,
        playerId: state.playerId,
        stage,
      },
    });
    if (result === "sent") sent++;
  }

  console.log(`[LL_HR_RADAR_ALERT_SENT] fingerprint=${fingerprint} sent=${sent}/${recipients.length}`);
}
