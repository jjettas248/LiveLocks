// Phase C + D: Diagnostics envelope builder and readable driver formatter.
//
// This module is a pure surfacing layer. It does NOT recompute any score,
// projection, or feature — it only reshapes existing data produced upstream
// (markets.ts featureScores, signalScore.ts scoreBreakdown, raw input
// BvP/WeatherPark/Handedness fields) into the wire shape consumed by the
// canonical resolver and the UI. Keeping this isolated makes it impossible
// for the diagnostics layer to drift the underlying numbers.

import type { MLBPropInput, MLBPropOutput } from "./types";
import type { SignalScoreBreakdown } from "./signalScore";
import type {
  MlbSignalDiagnostics,
  CanonicalEngineMode,
} from "../../shared/mlbCanonicalSignal";

interface BuildArgs {
  input: MLBPropInput;
  output: MLBPropOutput;
  scoreBreakdown: SignalScoreBreakdown;
  feedTags: string[];
  signalTags: string[];
  badges: string[];
  riskFlags: string[];
  fallbackUsed: boolean;
}

export function buildSignalDiagnostics(args: BuildArgs): MlbSignalDiagnostics {
  const {
    input,
    output,
    scoreBreakdown,
    feedTags,
    signalTags,
    badges,
    riskFlags,
    fallbackUsed,
  } = args;

  const featureScores: Record<string, number> = output.featureScores ?? {};

  const bvp = input.bvpHistory
    ? {
        atBats: input.bvpHistory.atBats,
        hits: input.bvpHistory.hits,
        homeRuns: input.bvpHistory.homeRuns,
        strikeouts: input.bvpHistory.strikeouts,
        avg: input.bvpHistory.avg,
      }
    : null;

  const weatherPark = input.weatherPark
    ? {
        parkFactor: input.weatherPark.parkFactor,
        windDirection: input.weatherPark.windDirection,
        windSpeed: input.weatherPark.windSpeed,
        isIndoors: input.weatherPark.isIndoors,
        parkHistoryFactor:
          input.weatherPark.parkHistoryFactor
          ?? (input.parkHistoryFactor ?? null),
      }
    : null;

  // Phase E review fix: only emit a handedness snapshot if at least one side
  // is actually known (non-null). Previously we accepted "defined-but-null",
  // which produced a dummy {batterHand:null, pitcherThrows:null} envelope
  // that suppressed the readable-driver line in describeHandedness.
  const hasBatterHand = input.batterHand != null;
  const hasPitcherThrows = input.pitcherThrows != null;
  const handedness = (hasBatterHand || hasPitcherThrows)
    ? {
        batterHand: input.batterHand ?? null,
        pitcherThrows: input.pitcherThrows ?? null,
        pitcherVsHandednessFactor: input.pitcherVsHandednessFactor ?? null,
      }
    : null;

  const engineMode: CanonicalEngineMode = fallbackUsed ? "fallback" : "strict";

  const readableDrivers = buildReadableDrivers({
    input,
    output,
    scoreBreakdown,
    featureScores,
    bvp,
    weatherPark,
    handedness,
    feedTags,
    signalTags,
    badges,
  });

  return {
    scoreBreakdown: {
      probability: scoreBreakdown.probability,
      projection: scoreBreakdown.projection,
      liveContext: scoreBreakdown.liveContext,
      matchup: scoreBreakdown.matchup,
      form: scoreBreakdown.form,
      opportunity: scoreBreakdown.opportunity,
      marketReliability: scoreBreakdown.marketReliability,
      priceValidation: scoreBreakdown.priceValidation,
      eventBoost: scoreBreakdown.eventBoost,
      total: scoreBreakdown.total,
    },
    featureScores,
    bvp,
    weatherPark,
    handedness,
    engineMode,
    feedTags: [...feedTags],
    signalTags: [...signalTags],
    badges: [...badges],
    riskFlags: [...riskFlags],
    readableDrivers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase D: Human-readable driver formatter.
//
// Converts the existing numeric featureScores + raw context (BvP, weather,
// handedness, pitcher analysis) into short user-facing sentences. Strings are
// formatted defensively — any missing data simply yields no line for that
// driver, never a partial "undefined%" string.
// ─────────────────────────────────────────────────────────────────────────────

interface ReadableDriversArgs {
  input: MLBPropInput;
  output: MLBPropOutput;
  scoreBreakdown: SignalScoreBreakdown;
  featureScores: Record<string, number>;
  bvp: MlbSignalDiagnostics["bvp"];
  weatherPark: MlbSignalDiagnostics["weatherPark"];
  handedness: MlbSignalDiagnostics["handedness"];
  feedTags: string[];
  signalTags: string[];
  badges: string[];
}

function pctFromZeroOne(score: number): string {
  // featureScores values are 0..1 floats. Convert to a signed % delta from
  // the neutral 0.5 anchor so "+17%" reads as "17 points above neutral".
  const delta = (score - 0.5) * 100;
  const rounded = Math.round(delta);
  return rounded >= 0 ? `+${rounded}%` : `${rounded}%`;
}

function describeWind(weather: NonNullable<MlbSignalDiagnostics["weatherPark"]>): string | null {
  if (weather.isIndoors) return "Indoor park (no wind effect)";
  if (weather.windDirection == null) return null;
  const speed = weather.windSpeed != null ? ` at ${Math.round(weather.windSpeed)} mph` : "";
  switch (weather.windDirection) {
    case "out": return `Wind blowing out${speed}`;
    case "in":  return `Wind blowing in${speed}`;
    case "cross": return `Crosswind${speed}`;
    case "calm": return "Calm winds";
    default: return null;
  }
}

function describeBvp(bvp: NonNullable<MlbSignalDiagnostics["bvp"]>): string | null {
  if (bvp.atBats < 5) return null;
  const avgStr = bvp.avg != null ? bvp.avg.toFixed(3).replace(/^0/, "") : "—";
  if (bvp.homeRuns >= 2) {
    return `Strong BvP power history: ${bvp.homeRuns} HR in ${bvp.atBats} AB (${avgStr})`;
  }
  if (bvp.avg != null && bvp.avg >= 0.300) {
    return `Strong BvP history: ${bvp.hits}-${bvp.atBats} (${avgStr})`;
  }
  if (bvp.avg != null && bvp.avg <= 0.150 && bvp.atBats >= 8) {
    return `Weak BvP history: ${bvp.hits}-${bvp.atBats} (${avgStr})`;
  }
  if (bvp.strikeouts >= Math.ceil(bvp.atBats * 0.4) && bvp.atBats >= 8) {
    return `BvP strikeout-prone: ${bvp.strikeouts} K in ${bvp.atBats} AB`;
  }
  return null;
}

function describeHandedness(
  hand: NonNullable<MlbSignalDiagnostics["handedness"]>,
  featureScore: number | undefined,
): string | null {
  if (!hand.batterHand || !hand.pitcherThrows) return null;
  const matchup = `${hand.batterHand}HB vs ${hand.pitcherThrows}HP`;
  if (featureScore != null && Number.isFinite(featureScore)) {
    if (featureScore >= 0.65) return `Favorable handedness: ${matchup}`;
    if (featureScore <= 0.35) return `Tough handedness: ${matchup}`;
  }
  return null;
}

function describePark(weather: NonNullable<MlbSignalDiagnostics["weatherPark"]>): string | null {
  const factor = weather.parkFactor;
  if (!Number.isFinite(factor)) return null;
  // parkFactor is a multiplier centered on 1.0 (1.10 = 10% boost).
  const pctDelta = Math.round((factor - 1) * 100);
  if (pctDelta >= 8) return `Park HR boost +${pctDelta}%`;
  if (pctDelta <= -8) return `Park HR suppression ${pctDelta}%`;
  return null;
}

function describeContact(featureScore: number | undefined): string | null {
  if (featureScore == null || !Number.isFinite(featureScore)) return null;
  if (featureScore >= 0.70) return `Hot contact quality (${pctFromZeroOne(featureScore)})`;
  if (featureScore <= 0.30) return `Cold contact quality (${pctFromZeroOne(featureScore)})`;
  return null;
}

function describeForm(featureScore: number | undefined, indicator: string | undefined): string | null {
  if (indicator === "hot") return "Hot rolling form";
  if (indicator === "extreme_cold") return "Extreme cold streak";
  if (indicator === "cold") return "Cold rolling form";
  if (featureScore != null && featureScore >= 0.70) return `Strong recent form (${pctFromZeroOne(featureScore)})`;
  if (featureScore != null && featureScore <= 0.30) return `Weak recent form (${pctFromZeroOne(featureScore)})`;
  return null;
}

function describeOpportunity(featureScore: number | undefined): string | null {
  if (featureScore == null || !Number.isFinite(featureScore)) return null;
  if (featureScore >= 0.70) return `Strong lineup opportunity (${pctFromZeroOne(featureScore)})`;
  if (featureScore <= 0.30) return `Limited lineup opportunity (${pctFromZeroOne(featureScore)})`;
  return null;
}

function describePitcherTrouble(input: MLBPropInput, signalTags: string[]): string | null {
  if (signalTags.includes("PITCHER FATIGUE RISING")) return "Pitcher fatigue rising";
  if (signalTags.includes("VELOCITY DROP DETECTED")) return "Pitcher velocity drop detected";
  if (signalTags.includes("ATTACKABLE PITCHER") || signalTags.includes("PITCHER ATTACKABLE")) {
    return "Attackable pitcher matchup";
  }
  return null;
}

function describeEventBoost(eventBoost: number, signalTags: string[]): string | null {
  if (signalTags.includes("NEAR HR CONTACT DETECTED")) return "Near-HR contact detected";
  if (eventBoost >= 70) return "Major live event boost";
  if (eventBoost >= 40) return "Live event boost active";
  return null;
}

function buildReadableDrivers(args: ReadableDriversArgs): string[] {
  const {
    input,
    output,
    scoreBreakdown,
    featureScores,
    bvp,
    weatherPark,
    handedness,
    signalTags,
  } = args;

  const out: string[] = [];

  // Park & weather
  if (weatherPark) {
    const park = describePark(weatherPark);
    if (park) out.push(park);
    const wind = describeWind(weatherPark);
    if (wind) out.push(wind);
  }

  // Handedness matchup
  if (handedness) {
    const h = describeHandedness(handedness, featureScores.handednessMatchup);
    if (h) out.push(h);
  }

  // Batter form & contact
  const formLine = describeForm(featureScores.hotColdForm, output.formIndicator);
  if (formLine) out.push(formLine);
  const contactLine = describeContact(featureScores.contactQuality);
  if (contactLine) out.push(contactLine);

  // BvP history
  if (bvp) {
    const b = describeBvp(bvp);
    if (b) out.push(b);
  }

  // Lineup opportunity
  const opp = describeOpportunity(featureScores.lineupOpportunity);
  if (opp) out.push(opp);

  // Pitcher trouble
  const ptrouble = describePitcherTrouble(input, signalTags);
  if (ptrouble) out.push(ptrouble);

  // Live event / momentum
  const eb = describeEventBoost(scoreBreakdown.eventBoost, signalTags);
  if (eb) out.push(eb);

  // Cap at 6 lines so UI surfaces stay scannable.
  return out.slice(0, 6);
}
