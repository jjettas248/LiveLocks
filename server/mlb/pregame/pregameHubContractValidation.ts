// MLB Pre-Game Hub — runtime contract validation (pure, no I/O).
//
// Kept separate from pregameHubService.ts (which imports storage-touching
// modules) so this pure validation logic — and any test importing it — never
// pulls in a DB dependency. Mirrors the codebase's pure-engine-vs-persistence
// separation convention (e.g. pregamePowerRadar/diagnostics.ts vs
// pregamePowerRadar/pregamePersistence.ts).

import type { PregameRadarTarget, PregameRadarViewKey } from "../../../shared/mlbPregameHub";
import { MOUND_MARKETS } from "./mound/types";

/** Logs and drops any target that fails the contract; never throws. */
export function validateTargets(targets: PregameRadarTarget[], view: PregameRadarViewKey): PregameRadarTarget[] {
  const valid: PregameRadarTarget[] = [];
  for (const t of targets) {
    const problems: string[] = [];
    if (!Number.isFinite(t.score10)) problems.push("non_finite_score10");
    if (!t.actorType) problems.push("missing_actorType");
    if (!t.view) problems.push("missing_view");
    if (view === "mound" && t.tracking.firstAbCashEligible !== false) problems.push("mound_firstAbCashEligible_not_false");
    if (view === "mound" && !(MOUND_MARKETS as readonly string[]).includes(t.primaryMarket.key)) problems.push("mound_disallowed_market");
    if (problems.length > 0) {
      console.warn(`[MLB_PREGAME_CONTRACT_VALIDATION] dropped target id=${t.id} view=${view} problems=${problems.join(",")}`);
      continue;
    }
    valid.push(t);
  }
  return valid;
}
