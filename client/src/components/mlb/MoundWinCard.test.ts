// MoundWinCard — public-copy invariant (static source check).
// Run: npx tsx client/src/components/mlb/MoundWinCard.test.ts
//
// Locked product rule: "Cashed" is reserved exclusively for a real market-
// graded result. MoundRadarRecord/MoundRadarFadeRecord render model-baseline
// aggregates, so their rendered `label` strings must never contain the word
// "Cashed" — this is a plain-text source scan (no React render harness exists
// in this codebase's test convention) that pins the exact rendered strings so
// a future edit can't silently reintroduce it.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("\n=== MoundWinCard — Public Copy Invariant Suite ===\n");

const source = readFileSync(join(__dirname, "MoundWinCard.tsx"), "utf-8");

// Extract every `label="..."` prop value passed to <Stat ... /> — the exact
// user-visible strings this component renders.
const labelMatches = Array.from(source.matchAll(/label="([^"]+)"/g)).map((m) => m[1]);

assert("MoundWinCard.tsx has label props to check (sanity)", labelMatches.length > 0);
assert(
  "no rendered <Stat label=...> string contains the word 'Cashed'",
  labelMatches.every((l) => !/cashed/i.test(l)),
);
assert("MoundRadarRecord's confirmed-count label reads 'Pitcher Reads Confirmed'", labelMatches.includes("Pitcher Reads Confirmed"));
assert("MoundRadarFadeRecord's confirmed-count label reads 'Fade Reads Confirmed' — distinct from the Follow label, not a copy-paste duplicate", labelMatches.includes("Fade Reads Confirmed"));

console.log(`\nMoundWinCard.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
