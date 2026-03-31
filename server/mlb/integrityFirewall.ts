import type { MLBPropOutput, MLBMarket } from "./types";
import { MARKET_PROJECTION_TOLERANCE, MARKET_PROBABILITY_CAPS } from "./types";

export interface FirewallResult {
  passed: boolean;
  hardReject: boolean;
  rejections: string[];
  warnings: string[];
  cappedOutput: MLBPropOutput;
}

export function runIntegrityFirewall(output: MLBPropOutput): FirewallResult {
  const rejections: string[] = [];
  const warnings: string[] = [];
  const cappedOutput = { ...output };

  if (!Number.isFinite(output.projection)) {
    rejections.push(`projection not finite: ${output.projection}`);
  }

  if (!Number.isFinite(output.bookLine) || output.bookLine <= 0) {
    rejections.push(`bookLine invalid: ${output.bookLine}`);
  }

  if (!Number.isFinite(output.calibratedProbabilityOver) || !Number.isFinite(output.calibratedProbabilityUnder)) {
    rejections.push(`probability not finite: over=${output.calibratedProbabilityOver} under=${output.calibratedProbabilityUnder}`);
  }

  if (!Number.isFinite(output.edge)) {
    rejections.push(`edge not finite: ${output.edge}`);
  }

  const ageMs = Date.now() - output.engineGeneratedAt;
  if (ageMs > 600_000) {
    rejections.push(`stale engine output: ${Math.round(ageMs / 1000)}s old`);
  }

  if (
    Number.isFinite(output.projection) && Number.isFinite(output.bookLine) &&
    output.recommendedSide === "OVER" && output.projection < output.bookLine
  ) {
    rejections.push(`directional contradiction: OVER but projection=${output.projection.toFixed(3)} < line=${output.bookLine}`);
  }
  if (
    Number.isFinite(output.projection) && Number.isFinite(output.bookLine) &&
    output.recommendedSide === "UNDER" && output.projection > output.bookLine
  ) {
    rejections.push(`directional contradiction: UNDER but projection=${output.projection.toFixed(3)} > line=${output.bookLine}`);
  }

  if (Number.isFinite(output.calibratedProbabilityOver) && Number.isFinite(output.calibratedProbabilityUnder)) {
    const maxProb = Math.max(output.calibratedProbabilityOver, output.calibratedProbabilityUnder);
    if (Math.abs(maxProb - 50) > 45) {
      rejections.push(`extreme probability: maxProb=${maxProb.toFixed(1)} (|maxProb-50|=${Math.abs(maxProb - 50).toFixed(1)} > 45 cap)`);
    }
  }

  if (rejections.length > 0) {
    return { passed: false, hardReject: true, rejections, warnings, cappedOutput };
  }

  const cap = MARKET_PROBABILITY_CAPS[output.market];
  if (cap) {
    if (cappedOutput.calibratedProbabilityOver > cap) {
      cappedOutput.calibratedProbabilityOver = cap;
      cappedOutput.calibratedProbabilityUnder = Math.max(2, 100 - cap);
    }
    if (cappedOutput.calibratedProbabilityUnder > cap) {
      cappedOutput.calibratedProbabilityUnder = cap;
      cappedOutput.calibratedProbabilityOver = Math.max(2, 100 - cap);
    }
    cappedOutput.calibratedProbability = Math.max(cappedOutput.calibratedProbabilityOver, cappedOutput.calibratedProbabilityUnder);

    const sidedPct = cappedOutput.recommendedSide === "OVER"
      ? cappedOutput.calibratedProbabilityOver
      : cappedOutput.calibratedProbabilityUnder;
    const bookImpliedPct = output.bookImplied ?? 50;
    cappedOutput.edge = Math.round(((sidedPct - bookImpliedPct) / Math.max(bookImpliedPct, 1)) * 100 * 100) / 100;
    if (!Number.isFinite(cappedOutput.edge)) cappedOutput.edge = 0;
  }

  const tolerance = MARKET_PROJECTION_TOLERANCE[output.market] ?? 0.10;

  if (cappedOutput.recommendedSide === "OVER" && cappedOutput.projection < cappedOutput.bookLine - tolerance) {
    warnings.push(`side/projection tension: OVER but proj=${cappedOutput.projection.toFixed(2)} < line=${cappedOutput.bookLine} - tol=${tolerance}`);
    cappedOutput.recommendedSide = cappedOutput.projection > cappedOutput.bookLine + tolerance ? "OVER"
      : cappedOutput.projection < cappedOutput.bookLine - tolerance ? "UNDER"
      : "NO_EDGE" as any;
    if (cappedOutput.recommendedSide === "UNDER") {
      warnings.push(`firewall corrected side from OVER → UNDER based on projection`);
    } else if (cappedOutput.recommendedSide === "NO_EDGE") {
      cappedOutput.confidenceTier = "NO_EDGE";
      warnings.push(`firewall corrected side to NO_EDGE — projection within tolerance`);
    }
  }
  if (cappedOutput.recommendedSide === "UNDER" && cappedOutput.projection > cappedOutput.bookLine + tolerance) {
    warnings.push(`side/projection tension: UNDER but proj=${cappedOutput.projection.toFixed(2)} > line=${cappedOutput.bookLine} + tol=${tolerance}`);
    cappedOutput.recommendedSide = "OVER" as any;
    warnings.push(`firewall corrected side from UNDER → OVER based on projection`);
  }

  if (cappedOutput.recommendedSide === "OVER" && cappedOutput.calibratedProbabilityOver < cappedOutput.calibratedProbabilityUnder) {
    warnings.push(`side/probability tension after cap: OVER but P(over)=${cappedOutput.calibratedProbabilityOver.toFixed(1)} < P(under)=${cappedOutput.calibratedProbabilityUnder.toFixed(1)}`);
    cappedOutput.recommendedSide = "UNDER" as any;
    warnings.push(`firewall corrected side to match probability direction`);
  }
  if (cappedOutput.recommendedSide === "UNDER" && cappedOutput.calibratedProbabilityUnder < cappedOutput.calibratedProbabilityOver) {
    warnings.push(`side/probability tension after cap: UNDER but P(under)=${cappedOutput.calibratedProbabilityUnder.toFixed(1)} < P(over)=${cappedOutput.calibratedProbabilityOver.toFixed(1)}`);
    cappedOutput.recommendedSide = "OVER" as any;
    warnings.push(`firewall corrected side to match probability direction`);
  }

  if (process.env.DEBUG_PIPELINE === "true") {
    console.log(`[MLB_FIREWALL] player=${output.playerName} market=${output.market} rejected=${rejections.length > 0} warnings=${warnings.length}`);
  }

  return {
    passed: rejections.length === 0 && warnings.length === 0,
    hardReject: rejections.length > 0,
    rejections,
    warnings,
    cappedOutput,
  };
}

export function logFirewallResult(gameId: string, playerName: string, market: MLBMarket, result: FirewallResult): void {
  for (const r of result.rejections) {
    console.warn(`[MLB FIREWALL REJECT][${gameId}] ${playerName}/${market} — ${r}`);
  }
  for (const w of result.warnings) {
    console.log(`[MLB FIREWALL WARN][${gameId}] ${playerName}/${market} — ${w}`);
  }
}
