// Mound Radar — market-edge provenance consistency at the buildMlbMoundRadar.ts
// integration level (Final Pre-Push Integrity Pass, Section 4; Mound V2
// purity pass, Section 3 line-selection fix). Goes beyond oddsDisplay.test.ts's
// pure-function unit coverage in two ways:
//
//   1. A realistic THREE-book fixture using the real MLB_PROP_BOOKMAKERS
//      allowlist (draftkings, fanduel, hardrockbet — see CLAUDE.md §3.2b),
//      with all three quoting DIFFERENT lines and prices, proving V1's own
//      paired over/under always come from the one book actually chosen for
//      OVER — never a shared "best of all three" fabrication.
//   2. A STRUCTURAL proof, reading buildMlbMoundRadar.ts's real source, that
//      V2's line/price selection (canonicalLine, executablePriceAtLine) is
//      built from the exact same `strikeoutSnap` binding — declared `const`
//      (so it is LANGUAGE-LEVEL impossible to reassign to a different
//      snapshot in between, not just "nothing happens to reassign it
//      today") — with no intervening re-fetch that could introduce a
//      different snapshot between the two reads, AND that the executable
//      price lookup is parameterized by canonicalLine's own line (never
//      marketEdgeContext's price-chosen line) — the structural proof that
//      Blocker 2 (price-driven line selection) is fixed at the real call
//      site, not just inside the standalone oddsDisplay.ts functions.
//
// Together with oddsDisplay.test.ts (the math) this closes the loop Section
// 4 asks for without needing a full mocked run of the orchestrator (which
// has a large real-data dependency surface — see moundV2ShadowWiring.test.ts's
// own doc comment for why that wasn't built).
//
// Run: npx tsx server/mlb/pregame/mound/moundMarketEdgeConsistency.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickBestOverBook, pairedUnderOddsForBook, buildMoundMarketEdgeContext } from "./oddsDisplay";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Fixture proof: real 3-book MLB allowlist, all different lines/prices ───
{
  // The real MLB Live Edge allowlist (CLAUDE.md §3.2b) — three books, never
  // more. hardrockbet posts the best OVER price here specifically to prove
  // the pairing logic doesn't have a hidden preference for draftkings/
  // fanduel (the two most commonly used in other fixtures).
  const books = {
    draftkings: { line: 6.5, overOdds: -125, underOdds: 105 },
    fanduel: { line: 7.5, overOdds: -110, underOdds: -115 },
    hardrockbet: { line: 6.5, overOdds: -102, underOdds: -108 },
  };
  const over = pickBestOverBook(books);
  ok(over?.book === "hardrockbet" && over.odds === -102, `hardrockbet has the best (highest) OVER price across all 3 allowed books (got ${over?.book}/${over?.odds})`);

  const ctx = buildMoundMarketEdgeContext(books, Date.parse("2026-07-30T19:58:00.000Z"));
  ok(ctx?.sportsbook === "hardrockbet" && ctx.line === 6.5, "the market edge context is built from hardrockbet at its own 6.5 line");

  const pairedUnder = pairedUnderOddsForBook(books, ctx?.sportsbook);
  ok(pairedUnder === -108, `the paired under price (-108) is hardrockbet's OWN under price at line 6.5 — never draftkings' better +105 (different book) or fanduel's -115 (different book AND different line 7.5) (got ${pairedUnder})`);
}

// ── Fixture proof: the winning book has NO under price; the other two do ───
// (proves the "honest null, never cross-substituted" property holds even
// with the full real 3-book allowlist, not just a 2-book fixture)
{
  const books = {
    draftkings: { line: 6.5, overOdds: -101, underOdds: null }, // best OVER, but no UNDER at all
    fanduel: { line: 6.5, overOdds: -115, underOdds: -105 },
    hardrockbet: { line: 6.5, overOdds: -120, underOdds: 100 },
  };
  const over = pickBestOverBook(books);
  ok(over?.book === "draftkings", "sanity: draftkings has the best OVER price");
  const paired = pairedUnderOddsForBook(books, over?.book);
  ok(paired === null, "draftkings (the chosen OVER book) has no valid UNDER price -> honestly null, never fanduel's -105 or hardrockbet's +100, even though both are real prices at the same line");
}

// ── Structural proof: buildMlbMoundRadar.ts's V2 line/price selection reads
// from the same const-bound snapshot as V1's own display path, and — the
// critical price-purity property — is parameterized by canonicalLine's OWN
// (price-independent) line, never marketEdgeContext's price-chosen one.
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(dir, "buildMlbMoundRadar.ts"), "utf-8");

  const declMatch = source.match(/const\s+strikeoutSnap\s*=/);
  ok(declMatch !== null, "strikeoutSnap is declared with `const` in buildMlbMoundRadar.ts — reassignment to a different snapshot object is a compile error, not merely absent from today's code");
  ok(!/\blet\s+strikeoutSnap\b/.test(source), "strikeoutSnap is never separately declared with `let` anywhere in the file (no shadowing/mutable escape hatch)");

  const marketEdgeContextLine = source.match(/const\s+marketEdgeContext\s*=\s*buildMoundMarketEdgeContext\(([^)]*)\)/);
  ok(marketEdgeContextLine !== null && /strikeoutSnap\?\.books/.test(marketEdgeContextLine[1]), "V1's own marketEdgeContext is built directly from strikeoutSnap?.books (the same binding), not a separately-fetched snapshot");
  ok(!/\blet\s+marketEdgeContext\b/.test(source), "marketEdgeContext is also `const`, never `let` — it too cannot be reassigned after its one construction from strikeoutSnap?.books");

  const canonicalLineDecl = source.match(/const\s+canonicalLine\s*=\s*selectCanonicalMoundV2Line\(([^)]*)\)/);
  ok(canonicalLineDecl !== null && /strikeoutSnap\?\.books/.test(canonicalLineDecl[1]), "V2's canonicalLine is built from strikeoutSnap?.books (the SAME binding as V1's marketEdgeContext) — never a re-fetched or independently-scoped snapshot");
  ok(!/\blet\s+canonicalLine\b/.test(source), "canonicalLine is `const`, never `let`");

  const executablePriceDecl = source.match(/selectExecutablePriceAtLine\(([^,]*),\s*([^)]*)\)/);
  ok(executablePriceDecl !== null && /strikeoutSnap\?\.books/.test(executablePriceDecl[1]), "selectExecutablePriceAtLine's books argument is strikeoutSnap?.books — the same binding, never a different snapshot");
  ok(
    executablePriceDecl !== null && /canonicalLine\.line/.test(executablePriceDecl[2]),
    "THE critical price-purity property: selectExecutablePriceAtLine's line argument is canonicalLine's OWN (price-independent) line — NEVER marketEdgeContext's price-chosen line. A price search that could reach for a different line than the one the model actually evaluates would silently reintroduce indirect price contamination.",
  );
  ok(!/selectExecutablePriceAtLine\([^)]*marketEdgeContext/.test(source), "selectExecutablePriceAtLine is never called with any marketEdgeContext-derived argument anywhere in this file");

  // Confirm no BLOCKING re-fetch/reassignment of odds happens between the
  // two read sites that could introduce a race even in principle (defense
  // in depth beyond the const-binding guarantees above, which already rule
  // this out at the language level for `strikeoutSnap`/`canonicalLine`
  // themselves). A fire-and-forget cache-warm call for a FUTURE cycle
  // (`getMLBPlayerOdds(...).catch(() => {})`, guarded by `!strikeoutSnap`)
  // is expected and harmless here: it only fires when strikeoutSnap is
  // already null, at which point canonicalLine is already deterministically
  // null too (selectCanonicalMoundV2Line short-circuits on a null books
  // argument) — there is nothing left for a race to corrupt, and since it
  // is never awaited, it cannot run before canonicalLine is computed
  // regardless. What would be a real hazard is an AWAITED re-fetch (which
  // could yield the event loop and interleave other state changes) or a
  // second `readOddsSnapshot(` call — neither exists.
  const firstUseIdx = source.indexOf("const marketEdgeContext = buildMoundMarketEdgeContext(");
  const secondUseIdx = source.indexOf("const canonicalLine = selectCanonicalMoundV2Line(");
  ok(firstUseIdx !== -1 && secondUseIdx !== -1 && firstUseIdx < secondUseIdx, "the two read sites appear in the expected order in source");
  const between = source.slice(firstUseIdx, secondUseIdx);
  ok(!/await\s+getMLBPlayerOdds\(/.test(between), "no AWAITED odds re-fetch appears between the two read sites (a fire-and-forget cache-warm for a future cycle, guarded by !strikeoutSnap, is fine and expected)");
  ok(!/readOddsSnapshot\(/.test(between), "no snapshot re-read call appears between the two read sites — strikeoutSnap is read exactly once from the provider-cache layer");
  const fireAndForgetMatch = between.match(/getMLBPlayerOdds\([^)]*\)\.catch\(/);
  ok(fireAndForgetMatch !== null, "the one getMLBPlayerOdds call that does appear between the two sites is the expected fire-and-forget cache-warm (.catch-chained, never awaited)");
  ok(/if\s*\(oddsEventId\s*&&\s*!strikeoutSnap\)/.test(between), "that fire-and-forget call is guarded by !strikeoutSnap — it only fires in the branch where canonicalLine is already null, so it can never race a real, present snapshot");
}

console.log(`\nmoundMarketEdgeConsistency.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
