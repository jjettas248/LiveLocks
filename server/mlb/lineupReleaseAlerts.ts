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

import { storage } from "../storage";
import { sendPushToUser } from "../pushDelivery";
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

function confirmedGameIds(snapshot: PregamePowerSnapshot | null): Set<string> {
  const out = new Set<string>();
  if (!snapshot) return out;
  for (const s of Array.from(snapshot.signals.values())) {
    if (s.lineupStatus === "confirmed") out.add(s.gameId);
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
  const fingerprint = `lineup|${gameId}|${slateDateET()}`;
  if (_alertedThisProcess.has(fingerprint)) return;
  if (await hasAlertFingerprint(fingerprint)) {
    _alertedThisProcess.add(fingerprint);
    console.log(`[LL_LINEUP_ALERT_SUPPRESSED] reason=dedupe fingerprint=${fingerprint}`);
    return;
  }

  let allUsers: any[] = [];
  try {
    allUsers = await storage.getAllUsers();
  } catch (err) {
    console.warn(`[LL_LINEUP_ALERT_SUPPRESSED] reason=user-fetch-failed message=${(err as Error).message}`);
    return;
  }

  const recipients = allUsers.filter((u: any) => {
    const access = resolveAccess(u.subscriptionTier, u.isAdmin ?? false);
    return access.hasMLB && !!u.pushSubscription;
  });

  if (recipients.length === 0) {
    console.log(`[LL_LINEUP_ALERT_SUPPRESSED] reason=no-eligible-recipients fingerprint=${fingerprint}`);
    return;
  }

  const ranked = [...signals].sort((a, b) => b.score10 - a.score10);
  const top = ranked[0];
  const others = ranked.length - 1;
  const namesSuffix = others > 0 ? ` (+${others} more HR candidate${others === 1 ? "" : "s"})` : "";

  const title = "🧢 LiveLocks: Lineups Are Live";
  const body = `${top.batterName} (${top.team}) is confirmed in today's lineup — a top HR candidate.${namesSuffix} Tap to view.`;

  console.log(`[LL_LINEUP_ALERT_QUEUED] fingerprint=${fingerprint} recipients=${recipients.length} candidates=${signals.length}`);
  _alertedThisProcess.add(fingerprint);
  await recordAlertFingerprint(fingerprint);

  let sent = 0;
  for (const user of recipients) {
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

  console.log(`[LL_LINEUP_ALERT_SENT] fingerprint=${fingerprint} sent=${sent}/${recipients.length}`);
}
