// HR Radar — "Best Contacts of the Day" spotlight.
//
// A curated top-N view distinct from the "⭐ Top Priority" banner inside
// HrRadarLadder.tsx (which names the single most urgent live play by
// momentum). This surface answers a different question — "what are today's
// best plays overall" — via selectBestContacts (shared/hrRadarBestContacts.ts),
// restricted to Attack + Ready and ranked by the engine's own composite score.
// Reads the same query cache as the Quick Decide / Full Ladder views (same
// queryKey) so mounting this adds zero extra network traffic.

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { selectBestContacts, type BestContactCandidate } from "@shared/hrRadarBestContacts";
import { hrTierTheme } from "@/components/mlb/hrRadarVisuals";
import { hrEntryCurrentScore10, hrEntryHrChancePct } from "@/components/mlb/hrRadarScore";
import { type HrRadarLadderEntry, type HrRadarLadderResponse } from "@/components/mlb/HrRadarLadder";

const SPOTLIGHT_LIMIT = 5;

function toCandidate(entry: HrRadarLadderEntry): BestContactCandidate & { entry: HrRadarLadderEntry } {
  return {
    playerId: entry.playerId,
    gameId: entry.gameId,
    playerName: entry.playerName,
    team: entry.team ?? null,
    userStage: entry.userStage ?? null,
    currentReadinessScore: entry.currentReadinessScore ?? null,
    confidenceTier: entry.confidenceTier ?? null,
    entry,
  };
}

export function HrRadarBestContactsSpotlight() {
  const { data } = useQuery<HrRadarLadderResponse>({
    queryKey: ["/api/mlb/hr-radar/ladder"],
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (prev) => prev,
  });

  const attackNow = data?.sections?.attackNow ?? [];
  const ready = data?.sections?.ready ?? [];
  const candidates = [...attackNow, ...ready]
    .filter((e) => e.isGameFinal !== true)
    .map(toCandidate);
  const picks = selectBestContacts(candidates, SPOTLIGHT_LIMIT);

  if (picks.length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid="hr-radar-best-contacts-spotlight">
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Best Contacts Today
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {picks.map((pick) => {
          const entry = pick.entry;
          const tier = entry.userStage === "fire" ? "fire" : "ready";
          const theme = hrTierTheme(tier);
          const Icon = theme.icon;
          const score10 = hrEntryCurrentScore10(entry);
          const hrChancePct = tier === "fire" ? hrEntryHrChancePct(entry) : null;
          return (
            <Card
              key={`${entry.gameId}_${entry.playerId}`}
              className={`shrink-0 w-40 p-2.5 ${theme.cardTint} ${theme.border} border`}
              data-testid={`card-best-contact-${entry.playerId}`}
            >
              <div className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide ${theme.text}`}>
                <Icon className="w-3 h-3" />
                {theme.label}
              </div>
              <div className="text-sm font-semibold text-foreground truncate mt-1" title={entry.playerName}>
                {entry.playerName}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{entry.team}</div>
              <div className={`text-lg font-bold mt-1 ${theme.text}`}>
                {hrChancePct != null ? `${hrChancePct}%` : score10 != null ? `${score10.toFixed(1)}/10` : "—"}
              </div>
              {entry.headlineReason && (
                <div className="text-[10px] text-muted-foreground line-clamp-2 mt-1">
                  {entry.headlineReason}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
