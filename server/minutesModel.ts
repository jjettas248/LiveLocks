import type { PlayoffRotationProfile } from "./services/nbaRotationHistoryService";

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
  seasonPhase?: "early" | "mid" | "late" | "playoffs";
  // ── Phase 2: real playoff rotation truth ─────────────────────────────────
  // When present and seasonPhase==="playoffs", drives base + adjustments
  // instead of generic season-average heuristics.
  playoffRotationProfile?: PlayoffRotationProfile | null;
}

export interface MinutesResult {
  expectedRemainingMinutes: number;
  closingProbability: number;
  minutesConfidence: "low" | "medium" | "high";
  // ── Phase 2 diagnostics: surface playoff rotation truth used ─────────────
  playoffRotationBase?: number | null;
  playoffRoleCertainty?: number | null;
  closeGameTrustScore?: number | null;
  coachShortBenchIndex?: number | null;
  coachStarRideIndex?: number | null;
  rotationRankEstimate?: number | null;
  playoffMinutesDataSource?: string | null;
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
  const isPlayoffs = ctx.seasonPhase === "playoffs";
  const profile = isPlayoffs ? ctx.playoffRotationProfile ?? null : null;

  const gameMinutesRemaining =
    Math.max(0, 4 - currentPeriod) * 12 +
    (currentPeriod >= 1 && currentPeriod <= 4 ? clockMins : 0);

  // ── 1. Base rotation projection ──────────────────────────────────────
  // PHASE 2: For playoffs with a usable profile, build the base from real
  // playoff role evidence rather than season averages. Priority stack:
  //   nonBlowoutPlayoffMinutesAvg → sameSeriesMinutesAvg →
  //   recentPlayoffMinutesAvg3 → recentPlayoffMinutesAvg5 →
  //   projectedMinutes → avgMinutes
  let playoffRotationBase: number | null = null;
  let playoffMinutesDataSource: string | null = null;
  if (profile && profile.dataSource !== "none") {
    if (profile.nonBlowoutPlayoffMinutesAvg != null) {
      playoffRotationBase = profile.nonBlowoutPlayoffMinutesAvg;
      playoffMinutesDataSource = "non_blowout";
    } else if (profile.sameSeriesMinutesAvg != null) {
      playoffRotationBase = profile.sameSeriesMinutesAvg;
      playoffMinutesDataSource = "same_series";
    } else if (profile.recentPlayoffMinutesAvg3 != null) {
      playoffRotationBase = profile.recentPlayoffMinutesAvg3;
      playoffMinutesDataSource = "recent_3";
    } else if (profile.recentPlayoffMinutesAvg5 != null) {
      playoffRotationBase = profile.recentPlayoffMinutesAvg5;
      playoffMinutesDataSource = "recent_5";
    }
    if (playoffMinutesDataSource && profile.dataSource === "regular_season_fallback") {
      playoffMinutesDataSource = `${playoffMinutesDataSource}_rs_fallback`;
    }
  }

  const rotationBase = playoffRotationBase ?? ctx.projectedMinutes ?? avgMinutes;
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

  // ── 3b. Season-phase adjustments to closing probability ─────────────
  if (isPlayoffs) {
    if (baseRotationMinutes >= 34) {
      closingProbability = Math.min(0.995, closingProbability + 0.04);
    } else if (baseRotationMinutes >= 30) {
      closingProbability = Math.min(0.99, closingProbability + 0.03);
    } else if (baseRotationMinutes < 24) {
      closingProbability = Math.max(0.20, closingProbability - 0.06);
    }
    // Playoff anchor floor — when no profile is available, fall back to a
    // small additional bump for stable rotation pieces (avgMinutes >= 30 with
    // meaningful usage). Avoids inflating volatile or fringe roles.
    if (!profile && avgMinutes >= 30 && usageRate >= 0.20) {
      closingProbability = Math.min(0.99, closingProbability + 0.02);
    }
    // PHASE 2C: close-game trust multiplier
    if (profile?.closeGameTrustScore != null) {
      const trust = profile.closeGameTrustScore; // 0-1
      // Symmetric: high trust pushes closing prob up, low trust drags down.
      const adj = (trust - 0.5) * 0.12; // ±6 pts
      closingProbability = Math.max(0.10, Math.min(0.995, closingProbability + adj));
    }
  }

  // ── 4. Close-game extension ──────────────────────────────────────────
  let closeGameExtensionMultiplier = 0.05;
  if (isPlayoffs) {
    if (baseRotationMinutes >= 34) closeGameExtensionMultiplier = 0.10;
    else if (baseRotationMinutes >= 30) closeGameExtensionMultiplier = 0.085;
    else if (baseRotationMinutes < 24) closeGameExtensionMultiplier = 0.03;

    // PHASE 2A: stable starter / star floor — coach lets them eat late
    if (
      profile &&
      (profile.playoffRoleCertainty ?? 0) >= 0.72 &&
      (profile.rotationRankEstimate ?? 99) <= 5 &&
      (scoreDiff === undefined || Math.abs(scoreDiff) <= 12)
    ) {
      closeGameExtensionMultiplier = Math.max(closeGameExtensionMultiplier, 0.11);
    }
    // PHASE 2B: fringe role penalty — pulled in clutch
    if (
      profile && (
        (profile.playoffRoleCertainty != null && profile.playoffRoleCertainty < 0.45) ||
        (profile.rotationRankEstimate != null && profile.rotationRankEstimate >= 8) ||
        (profile.playoffMinutesVariance != null && profile.playoffMinutesVariance > 30)
      )
    ) {
      closeGameExtensionMultiplier = Math.min(closeGameExtensionMultiplier, 0.025);
    }
    // PHASE 2D: short-bench coach concentrates minutes top-7
    if (profile?.coachShortBenchIndex != null && profile.coachShortBenchIndex >= 0.65) {
      if ((profile.rotationRankEstimate ?? 99) <= 7) {
        closeGameExtensionMultiplier += 0.015;
      } else {
        closeGameExtensionMultiplier = Math.max(0, closeGameExtensionMultiplier - 0.02);
      }
    }
    // PHASE 2E: star-ride coach lets top-3 hit 38-42
    if (profile?.coachStarRideIndex != null && profile.coachStarRideIndex >= 0.65 &&
        (profile.rotationRankEstimate ?? 99) <= 3) {
      closeGameExtensionMultiplier += 0.02;
    }
  } else if (ctx.seasonPhase === "late" && baseRotationMinutes < 28) {
    closeGameExtensionMultiplier *= 0.9;
  }

  if (
    scoreDiff !== undefined &&
    Math.abs(scoreDiff) <= 8 &&
    currentPeriod >= 4
  ) {
    remainingMinutes *= 1 + closingProbability * closeGameExtensionMultiplier;
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
  // Playoff stars with strong role certainty get more headroom; fringe roles
  // get a tighter cap so noise can't inflate them.
  let maxMultiplier = 1.25;
  if (isPlayoffs) {
    if (rotationBase >= 32) maxMultiplier = 1.32;
    if (
      profile &&
      (profile.playoffRoleCertainty ?? 0) >= 0.75 &&
      (profile.rotationRankEstimate ?? 99) <= 5
    ) {
      maxMultiplier = Math.max(maxMultiplier, 1.34);
    }
    if (
      profile &&
      (profile.playoffRoleCertainty ?? 1) < 0.45
    ) {
      maxMultiplier = Math.min(maxMultiplier, 1.18);
    }
  }
  const maxProjectedMinutes = rotationBase * maxMultiplier;
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
    playoffRotationBase,
    playoffRoleCertainty: profile?.playoffRoleCertainty ?? null,
    closeGameTrustScore: profile?.closeGameTrustScore ?? null,
    coachShortBenchIndex: profile?.coachShortBenchIndex ?? null,
    coachStarRideIndex: profile?.coachStarRideIndex ?? null,
    rotationRankEstimate: profile?.rotationRankEstimate ?? null,
    playoffMinutesDataSource,
  };
}
