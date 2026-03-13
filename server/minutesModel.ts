export interface MinutesContext {
  playerId: number;
  currentPeriod: number;
  clockMins: number;
  minutesPlayed: number;
  foulCount: number;
  scoreDiff?: number;
  usageRate: number;
  avgMinutes: number;
  h2avgMinutes?: number;
  missingStarterCount?: number;
  projectedMinutes?: number | null;
}

export interface MinutesResult {
  expectedRemainingMinutes: number;
  closingProbability: number;
  minutesConfidence: "low" | "medium" | "high";
}

export function calculateRemainingMinutes(ctx: MinutesContext): MinutesResult {
  const {
    currentPeriod,
    clockMins,
    minutesPlayed,
    foulCount,
    usageRate,
    avgMinutes,
  } = ctx;
  const scoreDiff = ctx.scoreDiff;
  const missingStarterCount = ctx.missingStarterCount ?? 0;

  const gameMinutesRemaining =
    Math.max(0, 4 - currentPeriod) * 12 +
    (currentPeriod >= 1 && currentPeriod <= 4 ? clockMins : 0);

  // ── 1. Base rotation projection ──────────────────────────────────────
  const rotationBase = ctx.projectedMinutes ?? avgMinutes;
  let baseRotationMinutes = rotationBase;
  if (currentPeriod >= 3 && ctx.h2avgMinutes !== undefined && ctx.h2avgMinutes > 3) {
    baseRotationMinutes = ctx.h2avgMinutes;
  }

  const gameFraction =
    currentPeriod >= 3 && ctx.h2avgMinutes !== undefined && ctx.h2avgMinutes > 3
      ? gameMinutesRemaining / 24
      : gameMinutesRemaining / 48;

  let remainingMinutes = baseRotationMinutes * gameFraction;

  // ── 2. Rotation pattern adjustment ───────────────────────────────────
  if (minutesPlayed >= 3) {
    const expectedFirstHalfMinutes = avgMinutes / 2;
    if (minutesPlayed < expectedFirstHalfMinutes * 0.70) {
      remainingMinutes *= 0.85;
    } else if (minutesPlayed > expectedFirstHalfMinutes * 1.15) {
      remainingMinutes *= 1.10;
    }
  }

  // ── 3. Closing lineup probability ────────────────────────────────────
  let closingProbability: number;
  if (avgMinutes >= 34)      closingProbability = 0.95;
  else if (avgMinutes >= 30) closingProbability = 0.85;
  else if (avgMinutes >= 26) closingProbability = 0.70;
  else                       closingProbability = 0.40;

  if (usageRate >= 0.27) closingProbability += 0.05;
  closingProbability = Math.min(0.98, closingProbability);

  // ── 4. Close-game extension ──────────────────────────────────────────
  if (
    scoreDiff !== undefined &&
    Math.abs(scoreDiff) <= 8 &&
    currentPeriod >= 4
  ) {
    remainingMinutes *= 1 + closingProbability * 0.05;
  }

  // ── 5. Blowout reduction ─────────────────────────────────────────────
  if (scoreDiff !== undefined) {
    const absDiff = Math.abs(scoreDiff);
    if (absDiff > 15) {
      remainingMinutes *= 0.85;
    }
    if (absDiff > 22) {
      remainingMinutes *= 0.70;
    }
  }

  // ── 6. Foul risk multiplier ──────────────────────────────────────────
  if (foulCount >= 4) {
    remainingMinutes *= 0.60;
  } else if (foulCount === 3) {
    remainingMinutes *= 0.85;
  }

  // ── 7. Injury rotation expansion ────────────────────────────────────
  if (missingStarterCount >= 2) {
    remainingMinutes *= 1.10;
  } else if (missingStarterCount >= 1) {
    remainingMinutes *= 1.05;
  }

  // ── 8. Max minutes guard ─────────────────────────────────────────────
  const maxProjectedMinutes = rotationBase * 1.25;
  const maxRemainingAllowed = Math.max(0, maxProjectedMinutes - minutesPlayed);
  remainingMinutes = Math.min(remainingMinutes, maxRemainingAllowed);

  // ── 9. Game-time bounds clamp ────────────────────────────────────────
  remainingMinutes = Math.max(0, Math.min(remainingMinutes, gameMinutesRemaining));

  // ── 10. Minutes confidence ───────────────────────────────────────────
  let minutesConfidence: "low" | "medium" | "high";
  if (minutesPlayed < 5)       minutesConfidence = "low";
  else if (minutesPlayed <= 15) minutesConfidence = "medium";
  else                          minutesConfidence = "high";

  // ── 11. Return ───────────────────────────────────────────────────────
  return {
    expectedRemainingMinutes: Math.round(remainingMinutes * 10) / 10,
    closingProbability,
    minutesConfidence,
  };
}
