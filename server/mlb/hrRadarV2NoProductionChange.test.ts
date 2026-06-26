/**
 * HR Radar Live v2 Shadow — "no production behavior change" source scan.
 *
 * Proves the v2 shadow source files cannot touch production: no orchestrator
 * hook, no canonical-store writes, no bus/lifecycle/grading calls, no
 * goldmaster bump, no Monte Carlo / simulation / wall-clock randomness, and
 * no official stage other than "fire".
 *
 * SELF-MATCH SAFE: this test is NOT in the scanned set, and forbidden tokens
 * are assembled from string parts so the scanner never trips on its own
 * source.
 *
 * Run: npx tsx server/mlb/hrRadarV2NoProductionChange.test.ts
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The v2 source files (NOT this test — avoids self-match).
const V2_FILES = [
  "hrRadarV2Types.ts",
  "hrRadarAdvancedScoring.ts",
  "hrRadarAdvancedContext.ts",
  "hrRadarV2Shadow.ts",
];

// Strip comments before scanning so documentation that *mentions* a forbidden
// token (e.g. "must NOT bump the goldmaster", "does not call new Date()")
// never trips the scan. We assert on real CODE, not prose.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (skip :// in URLs)
}

const sources = new Map<string, string>();
for (const f of V2_FILES) {
  try {
    sources.set(f, stripComments(readFileSync(join(HERE, f), "utf8")));
  } catch (e) {
    assert(`read ${f}`, false, String((e as any)?.message ?? e));
  }
}

console.log("\n=== HR Radar v2 — No Production Change (source scan) ===\n");

// Forbidden production-mutating / non-deterministic tokens. Built from parts
// so this file does not match itself if it were ever scanned.
const FORBIDDEN: Array<{ label: string; token: string }> = [
  // production write / wiring sites
  { label: "no orchestrator import", token: "liveGameOrchestrator" },
  { label: "no canonical-store write", token: "upsert" + "CanonicalHrRadarState" },
  { label: "no live signal bus", token: "liveSignal" + "Bus" },
  { label: "no bus register ingress", token: "register" + "Signal" },
  { label: "no lifecycle engine", token: "lifecycle" + "Engine" },
  { label: "no lifecycle store", token: "lifecycle" + "Store" },
  { label: "no settlement", token: "settle" + "Play" },
  { label: "no HR grading", token: "grade" + "SingleHRPlay" },
  { label: "no resolve-as-hit grading", token: "resolveHrRadarAlert" + "AsHit" },
  { label: "no goldmaster reference", token: "MLB_GOLDMASTER" + "_VERSION" },
  { label: "no goldmaster guard import", token: "goldmaster" + "Guard" },
  // non-determinism / simulation
  { label: "no Math.random", token: "Math" + ".random" },
  { label: "no monte carlo", token: "monte" + "_carlo" },
  { label: "no montecarlo", token: "monte" + "carlo" },
  { label: "no simulate", token: "sim" + "ulate" },
];

console.log("1. Forbidden tokens absent in every v2 source file");
for (const [file, src] of sources) {
  const lower = src.toLowerCase();
  for (const { label, token } of FORBIDDEN) {
    const hit = lower.includes(token.toLowerCase());
    assert(`1.x ${file}: ${label}`, !hit, hit ? `matched "${token}"` : undefined);
  }
}

// 2. wall-clock new Date() must not appear in pure scoring/compute files.
console.log("\n2. No wall-clock new Date() in scoring/compute");
const newDate = "new " + "Date(";
for (const file of ["hrRadarAdvancedScoring.ts", "hrRadarAdvancedContext.ts", "hrRadarV2Shadow.ts"]) {
  const src = sources.get(file) ?? "";
  assert(`2.x ${file}: no wall-clock new Date()`, !src.includes(newDate), src.includes(newDate) ? "found new Date(" : undefined);
}

// 3. Only "fire" may be assigned to the official stage field.
console.log("\n3. Official stage is FIRE-only");
const shadow = sources.get("hrRadarV2Shadow.ts") ?? "";
const officialAssign = /v2OfficialSignalStage\s*=\s*("[^"]*"|[A-Za-z_][A-Za-z0-9_]*)/g;
let m: RegExpExecArray | null;
let badOfficial: string | null = null;
let sawFireAssign = false;
while ((m = officialAssign.exec(shadow)) != null) {
  const rhs = m[1];
  if (rhs === '"fire"') {
    sawFireAssign = true;
    continue;
  }
  // a bare null default initialization is fine
  if (rhs === "null") continue;
  badOfficial = rhs;
}
assert("3.1 official stage assigned 'fire' somewhere", sawFireAssign);
assert("3.2 official stage never assigned a non-fire literal", badOfficial === null, badOfficial ? `found ${badOfficial}` : undefined);

// 4. Model version is tagged (shadow output is labeled).
console.log("\n4. Shadow model version tagged");
const types = sources.get("hrRadarV2Types.ts") ?? "";
assert("4.1 V2_SHADOW_MODEL_VERSION declared", /V2_SHADOW_MODEL_VERSION\s*=/.test(types));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
