// Mound Radar V2 (shadow) — canonical types.
//
// SHADOW ONLY: nothing in server/mlb/pregame/mound/v2/ is imported by
// buildMlbMoundRadar.ts, scoring.ts, moundDirection.ts,
// moundOutcomeAttribution.ts, evaluationSnapshot.ts, or any storage.ts mound
// method — see the v2/README note in index.ts. score10/tier/primaryMarket/
// settlement are untouched by this module.

export interface MoundV2BatterInput {
  playerId: string;
  battingOrderSlot: number; // 1-9
  /** Pre-blended P(strikeout) for this batter against today's starter — see batterStrikeoutProbability.ts. */
  strikeoutProbability: number;
}

export interface MoundV2WorkloadInputs {
  avgInningsPerStart: number | null;
  /** Same signal workload.ts's "stability" score already uses — innings variance across the pitcher's last 3 starts. */
  ipVarianceLast3: number | null;
  lastStartPitchCount: number | null;
  lastStartInningsPitched: number | null;
  bbPer9: number | null;
}

export interface MoundV2Inputs {
  pitcherId: string;
  workload: MoundV2WorkloadInputs;
  /** Confirmed (or best-known) opposing lineup, ideally all 9 slots. Empty when the lineup is entirely unconfirmed. */
  batters: MoundV2BatterInput[];
  strikeoutsLine?: number | null;
  outsLine?: number | null;
}

export interface MoundV2MarketResult {
  overProbability: number;
  underProbability: number;
  pushProbability: number;
  expectedValue: number;
  /** Null when no line was supplied — over/under/push are all 0 in that case; read expectedValue and the PMF instead. */
  line: number | null;
}

export interface MoundV2Distribution {
  strikeouts: MoundV2MarketResult;
  outs: MoundV2MarketResult;
  /** Full discrete PMFs, index = count. Exposed for diagnostics/backtesting — never fed back into production Mound. */
  strikeoutsPmf: number[];
  outsPmf: number[];
  diagnostics: {
    /** False when either the lineup or the workload inputs were entirely unavailable — the distribution still returns valid, sum-to-1 math using neutral (league-average) fallbacks, but confidence is low. */
    dataAvailable: boolean;
    battersInLineup: number;
    expectedBattersFaced: number;
    expectedOuts: number;
  };
}
