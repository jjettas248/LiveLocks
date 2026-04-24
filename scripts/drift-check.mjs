#!/usr/bin/env node
// Sport-isolation drift-check harness.
//
// Calls each sport's pure engine entry function with frozen JSON fixtures
// and snapshots the outputs. Re-runs compare against committed snapshots
// and exit non-zero on drift, so unrelated work that changes engine math
// fails this check immediately.
//
// No test framework. No package.json edit. Uses tsx (already a dep) to
// load the TypeScript engine modules directly.
//
// Usage:
//   node scripts/drift-check.mjs               # verify mode (CI-style)
//   node scripts/drift-check.mjs --update      # regenerate snapshots
//
// Exit codes:
//   0 — all snapshots match (or were just written in --update mode)
//   1 — at least one snapshot drifted
//   2 — a fixture failed to execute (engine threw, fixture malformed, etc.)

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "drift-fixtures");
const SNAPSHOTS_DIR = join(__dirname, "drift-snapshots");
const REPO_ROOT = join(__dirname, "..");

const UPDATE = process.argv.includes("--update");
const ONLY_SPORT = (() => {
  const i = process.argv.indexOf("--sport");
  return i > 0 ? process.argv[i + 1] : null;
})();

const SPORTS = [
  {
    name: "nba",
    enginePath: "server/engines/nba/index.ts",
    exportName: "processNBAEngine",
  },
  {
    name: "mlb",
    enginePath: "server/engines/mlb/index.ts",
    exportName: "processMLBEngine",
  },
  // NCAAB has no isolated engine module today — its surfacing math lives
  // inline in server/routes.ts. Snapshot fixtures for NCAAB document the
  // expected output shape for future engine extraction. Engine harness
  // for NCAAB will be wired once an engine module exists.
];

// ---- helpers ---------------------------------------------------------------

function listFixtures(sport) {
  const dir = join(FIXTURES_DIR, sport);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: basename(f, ".json"),
      path: join(dir, f),
    }));
}

function snapshotPathFor(sport, fixtureName) {
  const dir = join(SNAPSHOTS_DIR, sport);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${fixtureName}.snapshot.json`);
}

// Stable JSON stringify — sorted keys, normalized non-deterministic fields.
// `timestamp` and `dataFreshness` come from Date.now() inside the engines.
// Engines also bake Date.now() into the trailing segment of play `id`s
// (e.g. `nba-203999-PTS-1777071632093`); we strip that 13-digit suffix.
function stableStringify(value) {
  const replacer = (key, v) => {
    if (key === "timestamp" || key === "dataFreshness") return "<dynamic>";
    if (key === "id" && typeof v === "string") {
      return v.replace(/-\d{13}$/, "-<ts>");
    }
    return v;
  };
  return JSON.stringify(sortDeep(value), replacer, 2) + "\n";
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

function diffSummary(expected, actual) {
  // Cheap path-level diff — list keys whose stringified value changed.
  const out = [];
  walk("", expected, actual, out);
  return out.slice(0, 25); // cap to keep output readable
}

function walk(path, a, b, out) {
  if (typeof a !== typeof b) {
    out.push(`${path || "<root>"}: type ${typeof a} → ${typeof b}`);
    return;
  }
  if (a === null || b === null || typeof a !== "object") {
    if (a !== b) out.push(`${path || "<root>"}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    walk(path ? `${path}.${k}` : k, a[k], b[k], out);
  }
}

// Run the engine via a tiny tsx-loaded subprocess so we get full TS support
// without committing the harness to TypeScript or modifying tsconfig/package.json.
function runEngine(sport, fixture) {
  const runnerCode = `
    import { ${sport.exportName} } from ${JSON.stringify(join(REPO_ROOT, sport.enginePath))};
    import { readFileSync } from "node:fs";
    const candidates = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const out = ${sport.exportName}(candidates);
    process.stdout.write(JSON.stringify(out));
  `;
  const tmpRunner = join(REPO_ROOT, `.drift-runner-${sport.name}.mts`);
  writeFileSync(tmpRunner, runnerCode);
  try {
    const res = spawnSync(
      "node_modules/.bin/tsx",
      [tmpRunner, fixture.path],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (res.status !== 0) {
      throw new Error(`tsx exited ${res.status}\nstderr:\n${res.stderr}`);
    }
    return JSON.parse(res.stdout);
  } finally {
    try {
      unlinkSync(tmpRunner);
    } catch {
      // best-effort cleanup
    }
  }
}

// ---- main ------------------------------------------------------------------

let drifted = 0;
let executed = 0;
let errored = 0;
const results = [];

for (const sport of SPORTS) {
  if (ONLY_SPORT && ONLY_SPORT !== sport.name) continue;
  const fixtures = listFixtures(sport.name);
  if (fixtures.length === 0) {
    console.log(`[drift-check] ${sport.name}: no fixtures yet — skipping`);
    continue;
  }
  for (const fx of fixtures) {
    executed++;
    let actual;
    try {
      actual = runEngine(sport, fx);
    } catch (err) {
      errored++;
      results.push({ sport: sport.name, fixture: fx.name, status: "ERROR", message: String(err.message || err) });
      continue;
    }
    const snapPath = snapshotPathFor(sport.name, fx.name);
    const actualText = stableStringify(actual);
    if (UPDATE || !existsSync(snapPath)) {
      writeFileSync(snapPath, actualText);
      results.push({ sport: sport.name, fixture: fx.name, status: UPDATE ? "WRITTEN" : "SEEDED" });
      continue;
    }
    const expectedText = readFileSync(snapPath, "utf8");
    if (expectedText === actualText) {
      results.push({ sport: sport.name, fixture: fx.name, status: "OK" });
    } else {
      drifted++;
      const expected = JSON.parse(expectedText.replace(/"<dynamic>"/g, '"<dynamic>"'));
      const summary = diffSummary(expected, JSON.parse(actualText));
      results.push({
        sport: sport.name,
        fixture: fx.name,
        status: "DRIFT",
        diff: summary,
      });
    }
  }
}

// ---- report ---------------------------------------------------------------

for (const r of results) {
  if (r.status === "OK") {
    console.log(`  ✓ ${r.sport}/${r.fixture}`);
  } else if (r.status === "WRITTEN") {
    console.log(`  ↻ ${r.sport}/${r.fixture} (snapshot updated)`);
  } else if (r.status === "SEEDED") {
    console.log(`  + ${r.sport}/${r.fixture} (snapshot created)`);
  } else if (r.status === "DRIFT") {
    console.log(`  ✗ ${r.sport}/${r.fixture} DRIFT`);
    for (const line of r.diff) console.log(`      ${line}`);
  } else {
    console.log(`  ! ${r.sport}/${r.fixture} ERROR: ${r.message}`);
  }
}

console.log("");
console.log(`[drift-check] executed=${executed} drifted=${drifted} errored=${errored} mode=${UPDATE ? "update" : "verify"}`);

if (errored > 0) process.exit(2);
if (drifted > 0) process.exit(1);
process.exit(0);
