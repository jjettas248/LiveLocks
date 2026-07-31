// Mound Radar — Phase 1 official-firewall measurement invariants.
//
// Run: npx tsx server/mlb/pregame/mound/moundOfficialFirewallMeasurement.test.ts

import {
  MOUND_STRUCTURAL_FIREWALL_GAPS,
  buildMoundOfficialFirewallCandidate,
  measureMoundSignalAgainstOfficialFirewall,
  summarizeMoundOfficialFirewallMeasurement,
} from "./moundOfficialFirewallMeasurement";
import type { MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function fakeSignal(over: {
  signalId?: string;
  gameStatus?: string;
  moundDirection?: "follow" | "fade" | null;
  matchupAdjustedStrikeouts?: number | null;
  projectedStrikeouts?: number | null;
  dataCoverageScore?: number | null;
  postedLine?: { line: number | null; sportsbook: string | null; sourceTimestamp: string | null } | null;
}): MoundSignal {
  return {
    signalId: over.signalId ?? "mlb-mound:2026-07-29:g1:p1",
    gameStatus: over.gameStatus ?? "final",
    // "moundDirection" in over (not ??) — an explicitly-passed null must
    // stay null; ?? would silently replace it with the "follow" default,
    // the same pitfall this session already fixed once in moundV1Adapters.ts.
    moundDirection: "moundDirection" in over ? over.moundDirection : "follow",
    matchupAdjustedStrikeouts: over.matchupAdjustedStrikeouts ?? 6.8,
    projectedStrikeouts: over.projectedStrikeouts ?? 6.5,
    diagnostics: {
      dataCoverageScore: over.dataCoverageScore ?? 0.9,
      evaluation: {
        finalPregameSnapshot: {
          champion: {
            dataCoverageScore: over.dataCoverageScore ?? 0.9,
            postedLine: {
              strikeouts: over.postedLine === null ? null : {
                line: over.postedLine?.line ?? 6.5,
                sportsbook: over.postedLine?.sportsbook ?? "draftkings",
                sourceTimestamp: over.postedLine?.sourceTimestamp ?? "2026-07-29T19:58:00.000Z",
                lineUnavailableReason: null,
              },
            },
          },
        },
      },
    },
  } as unknown as MoundSignal;
}

// ── No direction -> not applicable, never fabricates a side ─────────────
{
  const m = measureMoundSignalAgainstOfficialFirewall(fakeSignal({ moundDirection: null }), new Date("2026-07-29T20:00:00Z"));
  ok(m.applicable === false && m.reason === "no_recommended_direction", "a signal with no resolved moundDirection is honestly not applicable, never evaluated with a made-up side");
}

// ── The two structural gaps ALWAYS trip, regardless of everything else being perfect ──
{
  ok(MOUND_STRUCTURAL_FIREWALL_GAPS.length === 2, "exactly 2 documented structural gaps (americanOdds, modelProbability)");

  const perfectFollow = fakeSignal({ moundDirection: "follow" });
  const m1 = measureMoundSignalAgainstOfficialFirewall(perfectFollow, new Date("2026-07-29T20:00:00Z"));
  ok(m1.applicable && m1.result.violations.includes("INVALID_ODDS"), "even a fully-populated Follow signal fails INVALID_ODDS — V1 never captures a price");
  ok(m1.applicable && m1.result.violations.includes("INVALID_PROBABILITY"), "even a fully-populated Follow signal fails INVALID_PROBABILITY — score10 is not a probability");
  ok(m1.applicable && !m1.result.eligible, "these two structural gaps alone are enough to make every real signal ineligible today");

  const perfectFade = fakeSignal({ moundDirection: "fade", postedLine: { line: 6.5, sportsbook: "fanduel", sourceTimestamp: "2026-07-29T19:58:00.000Z" } });
  const m2 = measureMoundSignalAgainstOfficialFirewall(perfectFade, new Date("2026-07-29T20:00:00Z"));
  ok(m2.applicable && m2.result.violations.includes("INVALID_ODDS") && m2.result.violations.includes("INVALID_PROBABILITY"), "the same two structural gaps trip for a Fade signal too — not Follow-specific");
}

// ── Real fields ARE honestly mapped when present (only the 2 structural ones are always-NaN) ──
{
  const signal = fakeSignal({ moundDirection: "follow", postedLine: { line: 6.5, sportsbook: "draftkings", sourceTimestamp: "2026-07-29T19:58:00.000Z" } });
  const candidate = buildMoundOfficialFirewallCandidate(signal, "OVER");
  ok(candidate.line === 6.5, "a real posted line is honestly carried through, never fabricated");
  ok(candidate.sportsbook === "draftkings", "a real sportsbook name is honestly carried through");
  ok(candidate.oddsFetchedAt === "2026-07-29T19:58:00.000Z", "a real fetch timestamp is honestly carried through");
  ok(Number.isNaN(candidate.americanOdds), "americanOdds is always NaN — never a fabricated price");
  ok(Number.isNaN(candidate.modelProbability), "modelProbability is always NaN — never a fabricated probability");
  ok(candidate.expiresAt === null, "expiresAt is honestly null (valid per the firewall, never trips INVALID_EXPIRATION)");
  ok(candidate.modelVersion === "" && candidate.contractVersion === "", "modelVersion/contractVersion are honestly empty, never invented for this measurement");
}

// ── No posted line at all -> honestly reflected as an invalid line, not fabricated ──
{
  const noLine = fakeSignal({ moundDirection: "follow", postedLine: null });
  const m = measureMoundSignalAgainstOfficialFirewall(noLine, new Date("2026-07-29T20:00:00Z"));
  ok(m.applicable && m.result.violations.includes("INVALID_LINE"), "a signal with no posted line at all honestly fails INVALID_LINE, no fallback line invented");
}

// ── Data quality bucketing never produces an invalid enum value ─────────
{
  for (const score of [0.95, 0.6, 0.1, null, undefined]) {
    const signal = fakeSignal({ moundDirection: "follow", dataCoverageScore: score as any });
    const m = measureMoundSignalAgainstOfficialFirewall(signal, new Date("2026-07-29T20:00:00Z"));
    ok(m.applicable && !m.result.violations.includes("INVALID_DATA_QUALITY"), `dataCoverageScore=${score} always buckets into a valid dataQuality enum member`);
  }
}

// ── Aggregation never double-counts and always reports the structural gaps ──
{
  const signals = [
    fakeSignal({ signalId: "s1", moundDirection: "follow" }),
    fakeSignal({ signalId: "s2", moundDirection: "fade" }),
    fakeSignal({ signalId: "s3", moundDirection: null }),
  ];
  const summary = summarizeMoundOfficialFirewallMeasurement(signals, new Date("2026-07-29T20:00:00Z"));
  ok(summary.totalSignals === 3, "totalSignals reflects every signal passed in");
  ok(summary.applicableSignals === 2 && summary.notApplicableSignals === 1, "applicable/not-applicable partition the sample exactly (2 directional, 1 not)");
  ok(summary.eligibleCount === 0 && summary.ineligibleCount === 2, "both applicable signals are ineligible (the 2 structural gaps guarantee this today)");
  ok(summary.violationCounts["INVALID_ODDS"] === 2 && summary.violationCounts["INVALID_PROBABILITY"] === 2, "violation counts tally across the full applicable sample, not just the first signal");
  ok(summary.structuralGaps.length === 2, "the summary always surfaces the 2 documented structural gaps for a human reviewer");
}

console.log(`\nmoundOfficialFirewallMeasurement.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
