export type SimulationScenario = "neutral" | "cold" | "hot";

export interface SimulationConfig {
  enabled: boolean;
  scenario: SimulationScenario;
}

let _config: SimulationConfig = {
  enabled: false,
  scenario: "neutral",
};

export function getSimulationConfig(): SimulationConfig {
  return { ..._config };
}

export function setSimulationConfig(config: SimulationConfig): void {
  _config = { ...config };
}

export interface SimPlayerArchetype {
  label: string;
  minutes: number;
  fouls: number;
  stats: {
    points: number;
    rebounds: number;
    assists: number;
    threes: number;
  };
  shooting: {
    liveFgm: number;
    liveFga: number;
    liveFtm: number;
    liveFta: number;
    liveFg3m: number;
    liveFg3a: number;
  };
  lines: {
    points: number;
    rebounds: number;
    assists: number;
    threes: number;
    pts_reb_ast: number;
  };
}

export interface SimMockBoard {
  players: SimPlayerArchetype[];
  gameState: {
    period: number;
    displayClock: string;
    homeScore: number;
    awayScore: number;
  };
  gameTotalLine: number;
  opponentTeam: string;
}

export function getMockBoard(scenario: SimulationScenario): SimMockBoard {
  const gameState = {
    neutral: { period: 3, displayClock: "6:00", homeScore: 63, awayScore: 65 },
    cold:    { period: 3, displayClock: "6:00", homeScore: 58, awayScore: 60 },
    hot:     { period: 3, displayClock: "6:00", homeScore: 68, awayScore: 72 },
  }[scenario];

  const gameTotalLine = { neutral: 225, cold: 220, hot: 228 }[scenario];

  const shootingMultiplier = { neutral: 1.0, cold: 0.65, hot: 1.35 }[scenario];

  function scale(base: number): number {
    return Math.round(base * shootingMultiplier * 10) / 10;
  }

  function scaleInt(base: number): number {
    return Math.max(0, Math.round(base * shootingMultiplier));
  }

  const players: SimPlayerArchetype[] = [
    {
      label: "Superstar",
      minutes: 22,
      fouls: 1,
      stats: {
        points: scaleInt(18),
        rebounds: 4,
        assists: 5,
        threes: scaleInt(2),
      },
      shooting: {
        liveFgm: scaleInt(7), liveFga: 13,
        liveFtm: scaleInt(4), liveFta: 5,
        liveFg3m: scaleInt(2), liveFg3a: 5,
      },
      lines: { points: 28.5, rebounds: 7.5, assists: 7.5, threes: 3.5, pts_reb_ast: 44.5 },
    },
    {
      label: "Primary scorer",
      minutes: 20,
      fouls: 2,
      stats: {
        points: scaleInt(14),
        rebounds: 3,
        assists: 2,
        threes: scaleInt(2),
      },
      shooting: {
        liveFgm: scaleInt(6), liveFga: 12,
        liveFtm: scaleInt(2), liveFta: 3,
        liveFg3m: scaleInt(2), liveFg3a: 4,
      },
      lines: { points: 22.5, rebounds: 5.5, assists: 4.5, threes: 2.5, pts_reb_ast: 32.5 },
    },
    {
      label: "Role player",
      minutes: 16,
      fouls: 2,
      stats: {
        points: scaleInt(8),
        rebounds: 5,
        assists: 1,
        threes: scaleInt(1),
      },
      shooting: {
        liveFgm: scaleInt(3), liveFga: 8,
        liveFtm: scaleInt(2), liveFta: 2,
        liveFg3m: scaleInt(1), liveFg3a: 3,
      },
      lines: { points: 14.5, rebounds: 8.5, assists: 2.5, threes: 1.5, pts_reb_ast: 24.5 },
    },
    {
      label: "Rotation big",
      minutes: 18,
      fouls: 3,
      stats: {
        points: scaleInt(10),
        rebounds: 6,
        assists: 1,
        threes: 0,
      },
      shooting: {
        liveFgm: scaleInt(4), liveFga: 9,
        liveFtm: scaleInt(2), liveFta: 4,
        liveFg3m: 0, liveFg3a: 1,
      },
      lines: { points: 16.5, rebounds: 9.5, assists: 2.5, threes: 0.5, pts_reb_ast: 28.5 },
    },
  ];

  return { players, gameState, gameTotalLine, opponentTeam: "NYK" };
}
