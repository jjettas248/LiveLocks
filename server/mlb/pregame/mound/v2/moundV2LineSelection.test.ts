// Mound V2 (shadow) — canonical line-selection neutrality (Final Line-
// Provenance and V1 Purity Correction). Proves selectCanonicalMoundV2Line's
// median + fixed-sportsbook-priority-tiebreak rule has NO systematic
// OVER/UNDER preference — the property the prior "mode, lowest-line
// tie-break" design violated (a 3-way tie of distinct lines always picked
// the easiest-to-clear line, silently inflating OVER qualification whenever
// books disagreed).
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2LineSelection.test.ts

import { selectCanonicalMoundV2Line } from "../oddsDisplay";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Every fixture below uses prices that are DELIBERATELY unremarkable/random —
// the line-selection rule must never look at them at all, so their exact
// values are irrelevant to correctness.
const P = { overOdds: -110, underOdds: -110 };

// ── Required fixture: 5.5 / 6.5 / 7.5 (three distinct lines, one vote each) ──
// The exact case that exposed the OLD rule's bias: a 3-way tie of DISTINCT
// lines. The OLD "lowest wins" rule always picked 5.5 here (the easiest
// line to clear OVER). The median of {5.5, 6.5, 7.5} is unambiguously 6.5 —
// the true middle value, an odd vote count needs no tie-break at all.
{
  const result = selectCanonicalMoundV2Line({
    draftkings: { line: 5.5, ...P },
    fanduel: { line: 6.5, ...P },
    hardrockbet: { line: 7.5, ...P },
  });
  ok(result?.line === 6.5, `5.5/6.5/7.5 -> median is 6.5, the true middle value, NOT 5.5 (the old lowest-tiebreak bug) (got ${result?.line})`);
  ok(result?.booksAtLine.length === 1 && result.booksAtLine[0] === "fanduel", "exactly the one book that posted the winning median line is listed");
}

// ── Required fixture: 5.5 / 5.5 / 6.5 (two books agree on the low line) ────
{
  const result = selectCanonicalMoundV2Line({
    draftkings: { line: 5.5, ...P },
    fanduel: { line: 5.5, ...P },
    hardrockbet: { line: 6.5, ...P },
  });
  ok(result?.line === 5.5, `5.5/5.5/6.5 -> median is 5.5 (the true middle of the sorted sequence [5.5, 5.5, 6.5]) (got ${result?.line})`);
  ok(result?.booksAtLine.length === 2 && result.booksAtLine.includes("draftkings") && result.booksAtLine.includes("fanduel"), "both books that posted the winning line are listed");
}

// ── Required fixture: 5.5 / 6.5 / 6.5 (two books agree on the high line) ───
{
  const result = selectCanonicalMoundV2Line({
    draftkings: { line: 5.5, ...P },
    fanduel: { line: 6.5, ...P },
    hardrockbet: { line: 6.5, ...P },
  });
  ok(result?.line === 6.5, `5.5/6.5/6.5 -> median is 6.5 (the true middle of the sorted sequence [5.5, 6.5, 6.5]) (got ${result?.line})`);
  ok(result?.booksAtLine.length === 2 && result.booksAtLine.includes("fanduel") && result.booksAtLine.includes("hardrockbet"), "both books that posted the winning line are listed");
}

// ── Required fixture: two books, different lines (even vote count, genuine disagreement) ──
// No single line is "the median" of {5.5, 6.5} (their true average, 6.0, was
// never offered by anyone) -> tie-break by FIXED sportsbook priority
// (server/odds/oddsConfig.ts's PREFERRED_BOOKS_BY_SPORT.mlb: draftkings >
// fanduel > hardrockbet), never by which number is lower/higher.
{
  const dkLower = selectCanonicalMoundV2Line({
    draftkings: { line: 5.5, ...P }, // higher priority, lower line
    fanduel: { line: 6.5, ...P },
  });
  ok(dkLower?.line === 5.5, `draftkings(5.5, higher priority)/fanduel(6.5) -> draftkings' own line wins on priority (got ${dkLower?.line})`);

  const dkHigher = selectCanonicalMoundV2Line({
    draftkings: { line: 7.5, ...P }, // higher priority, HIGHER line this time
    fanduel: { line: 6.5, ...P },
  });
  ok(dkHigher?.line === 7.5, `draftkings(7.5, higher priority)/fanduel(6.5) -> draftkings' own line STILL wins on priority, even though its line is now the HIGHER one — proving the tie-break is identity-based, not magnitude-based (got ${dkHigher?.line})`);

  const noDk = selectCanonicalMoundV2Line({
    fanduel: { line: 5.5, ...P },
    hardrockbet: { line: 6.5, ...P },
  });
  ok(noDk?.line === 5.5, `fanduel(5.5, higher priority than hardrockbet)/hardrockbet(6.5) -> fanduel's own line wins on priority (got ${noDk?.line})`);
}

// ── Required fixture: duplicate/stale offers from one sportsbook count as exactly one vote ──
// `books` is keyed by sportsbook name, so a single book can never literally
// appear twice — this proves a single book's entry is never double-counted
// (e.g. against an accidental future refactor that iterates a book's data
// more than once).
{
  const result = selectCanonicalMoundV2Line({
    draftkings: { line: 5.5, ...P },
  });
  ok(result?.line === 5.5 && result?.booksAtLine.length === 1, `a single sportsbook's single offer counts as exactly ONE vote, never duplicated (got line=${result?.line} booksAtLine.length=${result?.booksAtLine.length})`);
}

// ── Required fixture: missing approved books (fewer than the full 3-book allowlist present) ──
{
  const onlyOneBook = selectCanonicalMoundV2Line({ hardrockbet: { line: 8.5, ...P } });
  ok(onlyOneBook?.line === 8.5, "with only one approved book reporting, its own line is the (trivial) median");

  const noBooksAtAll = selectCanonicalMoundV2Line({});
  ok(noBooksAtAll === null, "with zero approved books reporting any line, the result is honestly null, never a fabricated default");
}

// ── No systematic bias: across every distinct-3-line permutation, the median rule always selects the TRUE middle value, never the lowest or highest ──
{
  const permutations = [
    ["draftkings", "fanduel", "hardrockbet"],
    ["draftkings", "hardrockbet", "fanduel"],
    ["fanduel", "draftkings", "hardrockbet"],
    ["fanduel", "hardrockbet", "draftkings"],
    ["hardrockbet", "draftkings", "fanduel"],
    ["hardrockbet", "fanduel", "draftkings"],
  ];
  const lines = [4.5, 6.5, 9.5]; // deliberately asymmetric spacing — a magnitude-biased rule would still show through
  let allMiddleWins = true;
  for (const order of permutations) {
    const books: Record<string, { line: number; overOdds: number; underOdds: number }> = {};
    order.forEach((book, i) => { books[book] = { line: lines[i], ...P }; });
    const result = selectCanonicalMoundV2Line(books);
    if (result?.line !== 6.5) allMiddleWins = false;
  }
  ok(allMiddleWins, "regardless of which book posts which of 3 distinct lines (every book-to-line assignment permuted), the median (6.5) always wins — never systematically the lowest (4.5) or highest (9.5)");
}

// ── No systematic bias: sweeping which book has the lower/higher line in a 2-book disagreement never shows a numeric preference — only a book-identity preference ──
{
  // If the rule had a hidden low-number bias, swapping which book gets the
  // low vs. high line while holding book identity's priority fixed would
  // still always return the SAME priority book's line — which is exactly
  // what SHOULD happen (identity-based), so this asserts that specific
  // invariant across all 3 unordered book pairs.
  const pairs: Array<[string, string]> = [["draftkings", "fanduel"], ["draftkings", "hardrockbet"], ["fanduel", "hardrockbet"]];
  for (const [higherPriorityBook, lowerPriorityBook] of pairs) {
    const lowFirst = selectCanonicalMoundV2Line({ [higherPriorityBook]: { line: 5.0, ...P }, [lowerPriorityBook]: { line: 9.0, ...P } });
    const highFirst = selectCanonicalMoundV2Line({ [higherPriorityBook]: { line: 9.0, ...P }, [lowerPriorityBook]: { line: 5.0, ...P } });
    ok(lowFirst?.line === 5.0, `${higherPriorityBook} (higher priority) posting the LOWER line still wins on identity (got ${lowFirst?.line})`);
    ok(highFirst?.line === 9.0, `${higherPriorityBook} (higher priority) posting the HIGHER line still wins on identity, proving no numeric preference either way (got ${highFirst?.line})`);
  }
}

// ── Price invariance: the rule never reads price at all ────────────────────
{
  const cheap = selectCanonicalMoundV2Line({
    draftkings: { line: 5.5, overOdds: -400, underOdds: 320 },
    fanduel: { line: 6.5, overOdds: -108, underOdds: -112 },
    hardrockbet: { line: 7.5, overOdds: -105, underOdds: -115 },
  });
  const juicy = selectCanonicalMoundV2Line({
    draftkings: { line: 5.5, overOdds: +500, underOdds: -700 },
    fanduel: { line: 6.5, overOdds: -108, underOdds: -112 },
    hardrockbet: { line: 7.5, overOdds: -900, underOdds: 650 },
  });
  ok(cheap?.line === juicy?.line, "swinging prices to opposite extremes on every book, without touching any `line` field, never changes the selected canonical line");
}

console.log(`\nmoundV2LineSelection.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
