// Lineup-released alerts — fires once per game, the first time that game's
// starting lineup is confirmed AND at least one player in it is a genuine
// top-of-board Pre-Game Power Radar HR candidate — reuses the board's own
// public-visibility predicate (wasPubliclyFlaggedPregame) rather than a
// bespoke tier check, so an alert never points at a card the board itself
// hides (e.g. suppressed for insufficient drivers/coverage).
//
// Read-only against the Pre-Game Power Radar snapshot: diffs the previous vs.
// newly-built snapshot to detect the unconfirmed→confirmed transition per
// game, so it never needs to touch rosterService.ts or buildPregamePowerRadar.ts
// (both are intentionally kept free of storage/push imports). Wired in from
// server/index.ts right after each buildPregamePowerRadar() tick resolves.
//
// Two independent delivery channels per game event: push (fingerprint
// `lineup|...`) and email (fingerprint `lineup-email|...`). Each channel
// dedupes and resolves recipient eligibility independently, so a user who is
// only push-eligible still gets pushed even when zero users are email-
// eligible (and vice versa) — neither channel's outcome gates the other.

import { storage } from "../storage";
import { sendPushToUser } from "../pushDelivery";
import { sendLineupAlertEmail, type LineupAlertCandidate } from "../email";
import { resolveAccess } from "../utils/access";
import { slateDateET } from "../utils/dateUtils";
import { hasAlertFingerprint, recordAlertFingerprint } from "../alertDedupe";
import { wasPubliclyFlaggedPregame } from "./pregamePowerRadar/diagnostics";
import type { PregamePowerSnapshot } from "./pregamePowerRadar/pregamePowerRadarStore";
import type { PregamePowerSignal } from "./pregamePowerRadar/types";

// In-memory guard against re-firing within the same process for a game we
// already alerted this build cycle — the DB fingerprint (below) is the
// authoritative, restart-safe dedupe; this just avoids a redundant query.
const _alertedThisProcess = new Set<string>();

type AlertUser = {
  subscriptionTier?: string | null;
  isAdmin?: boolean | null;
  pushSubscription?: string | null;
  emailVerified?: boolean | null;
  emailAlerts?: boolean | null;
};

export function isPushEligibleForLineupAlert(user: AlertUser): boolean {
  return resolveAccess(user.subscriptionTier, user.isAdmin ?? false).hasMLB && !!user.pushSubscription;
}

export function isEmailEligibleForLineupAlert(user: AlertUser): boolean {
  return (
    resolveAccess(user.subscriptionTier, user.isAdmin ?? false).hasMLB &&
    !!user.emailVerified &&
    !!user.emailAlerts
  );
}

function confirmedGameIds(snapshot: PregamePowerSnapshot | null): Set<string> {
  const out = new Set<string>();
  if (!snapshot) return out;
  for (const s of Array.from(snapshot.signals.values())) {
    if (s.lineupStatus === "posted") out.add(s.gameId);
  }
  return out;
}

export async function checkLineupReleaseAlerts(
  previous: PregamePowerSnapshot | null,
  next: PregamePowerSnapshot | null,
): Promise<void> {
  if (!next) return;

  const previouslyConfirmed = confirmedGameIds(previous);

  const newlyQualifyingByGame = new Map<string, PregamePowerSignal[]>();
  for (const s of Array.from(next.signals.values())) {
    if (previouslyConfirmed.has(s.gameId)) continue; // not a fresh confirmation
    if (!wasPubliclyFlaggedPregame(s)) continue; // same gate the public board uses
    const list = newlyQualifyingByGame.get(s.gameId) ?? [];
    list.push(s);
    newlyQualifyingByGame.set(s.gameId, list);
  }

  for (const [gameId, signals] of Array.from(newlyQualifyingByGame)) {
    try {
      await fireLineupAlert(gameId, signals);
    } catch (err) {
      console.warn(`[LL_LINEUP_ALERT_FAILED] gameId=${gameId} message=${(err as Error).message}`);
    }
  }
}

async function fireLineupAlert(gameId: string, signals: PregamePowerSignal[]): Promise<void> {
  const pushFingerprint = `lineup|${gameId}|${slateDateET()}`;
  const emailFingerprint = `lineup-email|${gameId}|${slateDateET()}`;

  const pushDone = _alertedThisProcess.has(pushFingerprint) || (await hasAlertFingerprint(pushFingerprint));
  const emailDone = _alertedThisProcess.has(emailFingerprint) || (await hasAlertFingerprint(emailFingerprint));

  if (pushDone) {
    _alertedThisProcess.add(pushFingerprint);
    console.log(`[LL_LINEUP_ALERT_SUPPRESSED] reason=dedupe fingerprint=${pushFingerprint}`);
  }
  if (emailDone) {
    _alertedThisProcess.add(emailFingerprint);
    console.log(`[LL_LINEUP_EMAIL_SUPPRESSED] reason=dedupe fingerprint=${emailFingerprint}`);
  }
  if (pushDone && emailDone) return;

  let allUsers: any[] = [];
  try {
    allUsers = await storage.getAllUsers();
  } catch (err) {
    console.warn(`[LL_LINEUP_ALERT_SUPPRESSED] reason=user-fetch-failed message=${(err as Error).message}`);
    return;
  }

  const ranked = [...signals].sort((a, b) => b.score10 - a.score10);
  const top = ranked[0];
  const others = ranked.length - 1;

  // ── push branch ──────────────────────────────────────────────────────
  if (!pushDone) {
    const pushRecipients = allUsers.filter(isPushEligibleForLineupAlert);
    if (pushRecipients.length === 0) {
      console.log(`[LL_LINEUP_ALERT_SUPPRESSED] reason=no-eligible-recipients fingerprint=${pushFingerprint}`);
    } else {
      const namesSuffix = others > 0 ? ` (+${others} more HR candidate${others === 1 ? "" : "s"})` : "";
      const title = "🧢 LiveLocks: Lineups Are Live";
      const body = `${top.batterName} (${top.team}) is confirmed in today's lineup — a top HR candidate.${namesSuffix} Tap to view.`;

      console.log(`[LL_LINEUP_ALERT_QUEUED] fingerprint=${pushFingerprint} recipients=${pushRecipients.length} candidates=${signals.length}`);
      _alertedThisProcess.add(pushFingerprint);
      await recordAlertFingerprint(pushFingerprint);

      let sent = 0;
      for (const user of pushRecipients) {
        const result = await sendPushToUser(user, {
          title,
          body,
          url: "/",
          data: {
            tab: "mlb",
            cardType: "pregame_power",
            gameId,
            batterIds: signals.map((s) => s.batterId),
          },
        });
        if (result === "sent") sent++;
      }
      console.log(`[LL_LINEUP_ALERT_SENT] fingerprint=${pushFingerprint} sent=${sent}/${pushRecipients.length}`);
    }
  }

  // ── email branch ─────────────────────────────────────────────────────
  // Own try/catch: sendHtmlEmail (unlike sendPushToUser) re-throws on
  // failure, and this branch must never be able to affect the push branch
  // above or the caller's build loop.
  if (!emailDone) {
    try {
      const emailRecipients = allUsers.filter(isEmailEligibleForLineupAlert);
      if (emailRecipients.length === 0) {
        console.log(`[LL_LINEUP_EMAIL_SUPPRESSED] reason=no-eligible-recipients fingerprint=${emailFingerprint}`);
      } else {
        const candidates: LineupAlertCandidate[] = ranked.map((s) => ({
          name: s.batterName,
          team: s.team,
          opponent: s.opponent,
          score: s.score10.toFixed(1),
        }));

        console.log(`[LL_LINEUP_EMAIL_QUEUED] fingerprint=${emailFingerprint} recipients=${emailRecipients.length} candidates=${signals.length}`);
        _alertedThisProcess.add(emailFingerprint);
        await recordAlertFingerprint(emailFingerprint);

        // Per-recipient try/catch — required because sendLineupAlertEmail
        // re-throws on failure; without this, one bad send would abort the
        // loop and silently skip every recipient after it.
        let sent = 0;
        for (const user of emailRecipients) {
          try {
            await sendLineupAlertEmail(user.email, candidates);
            sent++;
          } catch (err) {
            console.warn(`[LL_LINEUP_EMAIL_FAILED] userId=${user.id} message=${(err as Error).message}`);
          }
        }
        console.log(`[LL_LINEUP_EMAIL_SENT] fingerprint=${emailFingerprint} sent=${sent}/${emailRecipients.length}`);
      }
    } catch (err) {
      console.warn(`[LL_LINEUP_EMAIL_FAILED] gameId=${gameId} message=${(err as Error).message}`);
    }
  }
}
