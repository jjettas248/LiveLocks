export interface BallparkPalData {
  parkFactor: number;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  humidity: number | null;
  isIndoors: boolean;
}

export interface BaseballSavantData {
  exitVelocity: number | null;
  launchAngle: number | null;
  hitDistance: number | null;
  hardHitRateSeason: number | null;
  barrelRateProxySeason: number | null;
  xBA: number | null;
  xSLG: number | null;
}

export interface MLBComData {
  battingOrderSlot: number;
  pitchCount: number;
  timesThrough: number;
  inning: number;
  isTopInning: boolean;
  currentHits: number;
  currentTotalBases: number;
  currentStrikeouts: number;
  currentHomeRuns: number;
  plateAppearances: number;
  atBats: number;
}

export interface ESPNMLBData {
  gameStatus: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  inning: number;
  isTopInning: boolean;
  playerStats: Record<string, any>;
}

export async function fetchBallparkPalData(
  _gameId: string
): Promise<BallparkPalData> {
  return {
    parkFactor: 1.0,
    temperature: null,
    windSpeed: null,
    windDirection: null,
    humidity: null,
    isIndoors: false,
  };
}

export async function fetchBaseballSavantData(
  _playerId: string,
  _gameId: string
): Promise<BaseballSavantData> {
  return {
    exitVelocity: null,
    launchAngle: null,
    hitDistance: null,
    hardHitRateSeason: null,
    barrelRateProxySeason: null,
    xBA: null,
    xSLG: null,
  };
}

export async function fetchMLBComData(
  _playerId: string,
  _gameId: string
): Promise<MLBComData> {
  return {
    battingOrderSlot: 5,
    pitchCount: 0,
    timesThrough: 1,
    inning: 1,
    isTopInning: true,
    currentHits: 0,
    currentTotalBases: 0,
    currentStrikeouts: 0,
    currentHomeRuns: 0,
    plateAppearances: 0,
    atBats: 0,
  };
}

export async function fetchESPNMLBData(
  _gameId: string
): Promise<ESPNMLBData> {
  return {
    gameStatus: "In Progress",
    homeTeam: "",
    awayTeam: "",
    homeScore: 0,
    awayScore: 0,
    inning: 1,
    isTopInning: true,
    playerStats: {},
  };
}
