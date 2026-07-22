/**
 * HR Radar Research capture (PR 2) — "no champion mutation / no leakage"
 * source scan. Modeled on server/mlb/hrRadarV2NoProductionChange.test.ts.
 *
 * Proves the capture source files cannot touch the champion: no storage
 * writes, no edge-cache writes, no engine/state-machine recompute calls, no
 * signal-bus population, no alert dispatch — and that none of the
 * ablation-only field names (xBA, ERA, raw BvP, ABs-since-last-HR, IBB,
 * generic hot label, leverage) ever appear as identifiers in a champion
 * scoring file, guarding against a future regression that would give them a
 * predetermined positive weight.
 *
 * SELF-MATCH SAFE: this test is NOT in either scanned set, and forbidden
 * tokens are assembled from string parts so the scanner never trips on its
 * own source.
 *
 * Run: npx tsx server/mlb/hrRadarResearch/hrEvalCaptureNoChampionMutation.test.ts
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAMPION_DIR = join(HERE, "..");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── Set 1: the capture source files — must never reference anything that
// mutates champion state. ───────────────────────────────────────────────────
const CAPTURE_FILES = [
  "hrEvaluationCapture.ts",
  "hrFeatureBuilder.ts",
  "hrEvaluationEpochDetector.ts",
  "hrEvaluationWriteQueue.ts",
  "hrEvalCaptureSampling.ts",
  "hrFeatureHash.ts",
  "hrEligibilityEvaluator.ts",
  "hrEvalCaptureDiagnostics.ts",
];

const captureSources = new Map<string, string>();
for (const f of CAPTURE_FILES) {
  captureSources.set(f, stripComments(readFileSync(join(HERE, f), "utf8")));
}

const FORBIDDEN_CHAMPION_MUTATIONS: Array<{ label: string; token: string }> = [
  { label: "no storage writes", token: "storage" + "." },
  { label: "no edge-cache writes", token: "mlbEdge" + "Cache" },
  { label: "no dynamic state recompute", token: "recompute" + "HrAlertState" },
  { label: "no PATH evaluator call", token: "evaluateHR" + "Alert(" },
  { label: "no signal normalization", token: "normalizeMLB" + "Signal" },
  { label: "no auto-persist signals", token: "autoPersist" + "MLBSignals" },
  { label: "no alert dispatch", token: "notifyLifecycle" + "Change" },
  { label: "no canonical-store write", token: "upsert" + "CanonicalHrRadarState" },
];

for (const [file, src] of Array.from(captureSources.entries())) {
  for (const { label, token } of FORBIDDEN_CHAMPION_MUTATIONS) {
    assert(`${file}: ${label}`, !src.includes(token), `found forbidden token "${token}"`);
  }
}

// ── Set 2: no odds/EV/future-outcome leakage tokens in the capture sources ──
const FORBIDDEN_LEAKAGE_TOKENS: Array<{ label: string; token: string }> = [
  { label: "no implied probability", token: "implied" + "Probability" },
  { label: "no expected value", token: "expected" + "Value" },
  { label: "no american odds", token: "american" + "Odds" },
  { label: "no line movement", token: "line" + "Movement" },
  { label: "no book line", token: "book" + "Line" },
];
for (const [file, src] of Array.from(captureSources.entries())) {
  for (const { label, token } of FORBIDDEN_LEAKAGE_TOKENS) {
    assert(`${file}: ${label}`, !src.includes(token), `found forbidden token "${token}"`);
  }
}

// ── Set 3: ablation-only field names must never appear as identifiers in a
// champion scoring file — guards against a future regression giving them a
// predetermined positive weight. ────────────────────────────────────────────
const CHAMPION_SCORING_FILES = [
  "hrConversionModel.ts",
  "hrAlertEngine.ts",
  "HRSignalBuilder.ts",
  "evaluateHRAlert.ts",
];

// Deliberately distinct from any pre-existing champion field name (e.g. the
// champion already has its own differently-named/-cased `abSinceLastHR`
// input from a prior PR, which this PR does not touch or rename).
const ABLATION_ONLY_FIELD_NAMES = [
  "xBaSeasonal",
  "pitcherEraSeasonal",
  "rawBvpHrRate",
  "rawBvpPlateAppearances",
  "atBatsSinceLastHr",
  "seasonIbbRate" + "" /* keep distinct from the champion's own seasonIBBRate casing */,
  "genericHotLabel",
  "leverageIndex",
];

for (const file of CHAMPION_SCORING_FILES) {
  let src: string;
  try {
    src = stripComments(readFileSync(join(CHAMPION_DIR, file), "utf8"));
  } catch (e) {
    assert(`read ${file}`, false, String((e as any)?.message ?? e));
    continue;
  }
  for (const fieldName of ABLATION_ONLY_FIELD_NAMES) {
    const identifierPattern = new RegExp(`\\b${fieldName}\\b`);
    assert(`${file}: no "${fieldName}" identifier (ablation-only, no predetermined weight)`, !identifierPattern.test(src));
  }
}

// `seasonIbbRate` (camelCase "Ibb") is intentionally distinct from the
// champion's pre-existing `seasonIBBRate` (camelCase "IBB") — verify they
// really are different strings so the guard above isn't accidentally inert.
assert(
  "ablation seasonIbbRate is a distinct identifier from champion seasonIBBRate",
  "seasonIbbRate" !== "seasonIBBRate",
);

console.log(`\nhrEvalCaptureNoChampionMutation.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
