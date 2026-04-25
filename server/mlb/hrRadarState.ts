export type HrRadarState = "watch" | "building" | "attack" | "cashed" | "missed";

export function resolveHrRadarState(input: {
  hasHomeRun: boolean;
  gameFinal: boolean;
  wasCalled: boolean;
  signalScore: number;
  nearHrCount: number;
  hardContactCount: number;
}): HrRadarState {
  if (input.hasHomeRun) return "cashed";
  if (input.gameFinal && input.wasCalled) return "missed";
  if (input.signalScore >= 7 || input.nearHrCount >= 2) return "attack";
  if (input.signalScore >= 4 || input.hardContactCount >= 1) return "building";
  return "watch";
}
