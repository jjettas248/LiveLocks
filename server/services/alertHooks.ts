export interface AlertCandidate {
  playerId: string;
  playerName: string;
  sport: string;
  market: string;
  signalScore: number;
  probability: number;
  edge: number;
  timing: string;
  gameId: string;
}

export interface AlertThresholds {
  minSignalScore: number;
  minProbability: number;
  minEdge: number;
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  minSignalScore: 70,
  minProbability: 60,
  minEdge: 3,
};

export function shouldTriggerAlert(
  candidate: AlertCandidate,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS
): boolean {
  if (candidate.signalScore < thresholds.minSignalScore) return false;
  if (candidate.probability < thresholds.minProbability) return false;
  if (candidate.edge < thresholds.minEdge) return false;
  return true;
}

export function getMLBInningAlertWindows(): number[] {
  return [1, 5, 7];
}

export function isInAlertWindow(sport: string, timing: string): boolean {
  if (sport === "mlb") {
    const inning = parseInt(timing, 10);
    if (!isNaN(inning)) {
      return getMLBInningAlertWindows().includes(inning);
    }
  }
  if (sport === "nba") {
    return timing === "halftime" || timing === "q3_start";
  }
  return false;
}

export function buildAlertPayload(candidate: AlertCandidate): {
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const sportLabel = candidate.sport.toUpperCase();
  return {
    title: `${sportLabel} Alert: ${candidate.playerName}`,
    body: `${candidate.market} signal — ${candidate.probability.toFixed(0)}% confidence, ${candidate.edge.toFixed(1)}% edge`,
    data: {
      sport: candidate.sport,
      gameId: candidate.gameId,
      playerId: candidate.playerId,
      market: candidate.market,
    },
  };
}

export interface EmailInsight {
  type: "daily_edges" | "weekly_performance" | "hot_player";
  subject: string;
  previewText: string;
  data: Record<string, unknown>;
}

export function buildDailyEdgesInsight(topSignals: AlertCandidate[]): EmailInsight {
  const top3 = topSignals
    .sort((a, b) => b.signalScore - a.signalScore)
    .slice(0, 3);

  return {
    type: "daily_edges",
    subject: "Today's Top Edges",
    previewText: top3.length > 0
      ? `${top3[0].playerName} leads with ${top3[0].probability.toFixed(0)}% confidence`
      : "No strong edges today",
    data: { signals: top3 },
  };
}
