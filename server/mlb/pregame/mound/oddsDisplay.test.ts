// Mound Radar — best-odds display helpers, invariants (Final Pre-Push
// Integrity Pass). Specifically proves pairedUnderOddsForBook can never
// combine an OVER price from one book with an UNDER price from a
// DIFFERENT book or line.
//
// American-odds convention used throughout this file's fixtures: for prices
// of the same sign, the NUMERICALLY LARGER value is the better price for the
// bettor (-110 is better than -120; +110 is better than +100), and any
// positive price beats any negative one. pickBestOverBook's `>` comparison
// (matching the sibling server/mlb/pregamePowerRadar/oddsDisplay.ts exactly)
// already encodes this correctly — these fixtures must respect that
// direction or they assert the wrong book "wins".
//
// Run: npx tsx server/mlb/pregame/mound/oddsDisplay.test.ts

import {
  pickBestOverBook,
  pairedUnderOddsForBook,
  buildMoundMarketEdgeContext,
  selectCanonicalMoundV2Line,
  selectExecutablePriceAtLine,
} from "./oddsDisplay";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── pickBestOverBook picks the best OVER price across books ────────────────
{
  const books = {
    draftkings: { line: 6.5, overOdds: -110, underOdds: 100 },
    fanduel: { line: 6.5, overOdds: -120, underOdds: -110 },
  };
  const best = pickBestOverBook(books);
  ok(best?.book === "draftkings" && best.odds === -110, `picks the book with the best (numerically largest / least-negative) OVER price (got ${best?.book}/${best?.odds})`);
}

// ── pairedUnderOddsForBook returns the SAME book's own under price ──────────
{
  const books = {
    draftkings: { line: 6.5, overOdds: -110, underOdds: 100 },
    fanduel: { line: 6.5, overOdds: -120, underOdds: 110 }, // a BETTER under price at a DIFFERENT (losing-on-OVER) book
  };
  const over = pickBestOverBook(books);
  ok(over?.book === "draftkings", "sanity: draftkings has the best OVER price (-110 beats -120)");
  const pairedUnder = pairedUnderOddsForBook(books, over?.book);
  ok(pairedUnder === 100, `the paired under price comes from draftkings (over's own book), NOT fanduel's better +110 (got ${pairedUnder})`);
}

// ── Cross-book pairing is structurally impossible even with a materially different line ──
{
  const books2 = {
    draftkings: { line: 6.5, overOdds: -100, underOdds: 105 },
    fanduel: { line: 7.5, overOdds: -140, underOdds: 130 },
  };
  const over2 = pickBestOverBook(books2);
  ok(over2?.book === "draftkings" && over2.line === 6.5, "sanity: over is chosen from draftkings at line 6.5 (-100 beats -140)");
  const pairedUnder2 = pairedUnderOddsForBook(books2, over2?.book);
  ok(pairedUnder2 === 105, `the paired under price (105) corresponds to the SAME line (6.5) draftkings posted for over — never fanduel's 7.5-line under price (130) (got ${pairedUnder2})`);
}

// ── A book with no valid under price honestly returns null, never fabricated ──
{
  const books = {
    draftkings: { line: 6.5, overOdds: -110, underOdds: null },
    fanduel: { line: 6.5, overOdds: -130, underOdds: -110 },
  };
  const over = pickBestOverBook(books);
  ok(over?.book === "draftkings", "sanity: over comes from draftkings (-110 beats -130)");
  const paired = pairedUnderOddsForBook(books, over?.book);
  ok(paired === null, "when draftkings (the chosen over book) has no valid under price, the paired result is honestly null — NEVER cross-substituted from fanduel's real -110");
}

// ── Non-finite / underscore-prefixed entries never leak through ────────────
{
  const books = {
    draftkings: { line: 6.5, overOdds: -120, underOdds: NaN },
    _meta: { line: 6.5, overOdds: -50, underOdds: -50 } as any,
  };
  ok(pairedUnderOddsForBook(books, "draftkings") === null, "a non-finite underOdds is treated as missing, not a real price");
  ok(pairedUnderOddsForBook(books, "_meta") === null, "an underscore-prefixed pseudo-book key is never used as a real sportsbook (defensive; callers should never pass one, but this must still refuse to fabricate) — pairedUnderOddsForBook now rejects it directly, mirroring pickBestOverBook's own book.startsWith('_') guard");
}

// ── Null/undefined inputs never throw ───────────────────────────────────────
{
  ok(pairedUnderOddsForBook(null, "draftkings") === null, "null books -> null, never throws");
  ok(pairedUnderOddsForBook(undefined, "draftkings") === null, "undefined books -> null, never throws");
  ok(pairedUnderOddsForBook({}, null) === null, "null sportsbook -> null, never throws");
  ok(pairedUnderOddsForBook({}, undefined) === null, "undefined sportsbook -> null, never throws");
}

// ── buildMoundMarketEdgeContext + pairedUnderOddsForBook together produce fully consistent provenance ──
{
  const books = {
    draftkings: { line: 6.5, overOdds: -100, underOdds: 100 },
    fanduel: { line: 7.5, overOdds: -140, underOdds: -102 },
  };
  const fetchedAt = Date.parse("2026-07-30T19:58:00.000Z");
  const ctx = buildMoundMarketEdgeContext(books, fetchedAt);
  ok(ctx?.sportsbook === "draftkings" && ctx.line === 6.5, `sanity: the OVER context is draftkings/6.5 (got ${ctx?.sportsbook}/${ctx?.line})`);
  const under = pairedUnderOddsForBook(books, ctx?.sportsbook);
  ok(under === 100, `the resulting frozen quote's over (line=${ctx?.line}, sportsbook=${ctx?.sportsbook}) and under (${under}) are internally consistent — same book, same line, same fetch moment, never fanduel's 7.5-line pricing`);
}

// ── selectCanonicalMoundV2Line — mode across books, NEVER price ────────────
// (Mound V2 purity pass, Section 3: the line V2's model evaluates must be
// chosen without looking at any price at all.)
{
  ok(selectCanonicalMoundV2Line(null) === null, "null books -> null, never throws");
  ok(selectCanonicalMoundV2Line({}) === null, "empty books -> null");
  ok(selectCanonicalMoundV2Line({ _meta: { line: 6.5, overOdds: -50, underOdds: -50 } as any }) === null, "an underscore-prefixed pseudo-book key never counts as a real posted line");
  ok(selectCanonicalMoundV2Line({ draftkings: { line: NaN, overOdds: -110, underOdds: 100 } }) === null, "a non-finite line is treated as not posted, never a fabricated line");

  // 3 books at 6.5, 1 book at 7.5 -> mode is 6.5, regardless of price.
  const modeBooks = {
    draftkings: { line: 6.5, overOdds: -300, underOdds: 250 }, // deliberately the WORST over price of the group
    fanduel: { line: 6.5, overOdds: -110, underOdds: -110 },
    hardrockbet: { line: 6.5, overOdds: -108, underOdds: -112 },
    onextra: { line: 7.5, overOdds: 200, underOdds: -250 }, // deliberately the BEST over price of the group, at a DIFFERENT line
  };
  const mode = selectCanonicalMoundV2Line(modeBooks);
  ok(mode?.line === 6.5, `the mode line (3 books) wins over the minority line (1 book) EVEN THOUGH the minority line's book posts the best price (got ${mode?.line})`);
  ok(mode?.booksAtLine.length === 3 && mode.booksAtLine.includes("draftkings") && mode.booksAtLine.includes("fanduel") && mode.booksAtLine.includes("hardrockbet"), "booksAtLine lists exactly the 3 books that posted the winning line, sorted");
  ok(!mode?.booksAtLine.includes("onextra"), "the minority-line book is excluded from booksAtLine — its price can never rescue its line into contention");

  // Tie (2 books at 6.5, 2 books at 7.5) -> deterministic lowest-value tie-break.
  const tieBooks = {
    draftkings: { line: 7.5, overOdds: -110, underOdds: -110 },
    fanduel: { line: 7.5, overOdds: -110, underOdds: -110 },
    hardrockbet: { line: 6.5, overOdds: -110, underOdds: -110 },
    onextra: { line: 6.5, overOdds: -110, underOdds: -110 },
  };
  const tie = selectCanonicalMoundV2Line(tieBooks);
  ok(tie?.line === 6.5, `a tied book-count breaks toward the strictly LOWER line value (6.5, not 7.5) — deterministic regardless of object key order (got ${tie?.line})`);

  // Price invariance: changing ONLY prices (never lines) cannot change the result.
  const samePricesChanged = { ...modeBooks, draftkings: { ...modeBooks.draftkings, overOdds: +500 }, onextra: { ...modeBooks.onextra, overOdds: -500 } };
  const afterPriceChange = selectCanonicalMoundV2Line(samePricesChanged);
  ok(afterPriceChange?.line === mode?.line, "swinging prices to the opposite extreme (without touching any `line` field) never changes the selected canonical line");
}

// ── selectExecutablePriceAtLine — price comparison ONLY among books already restricted to the fixed line ──
{
  ok(selectExecutablePriceAtLine(null, 6.5) === null, "null books -> null, never throws");

  const books = {
    draftkings: { line: 6.5, overOdds: -110, underOdds: -105 },
    fanduel: { line: 6.5, overOdds: -102, underOdds: -115 }, // best price AT the target line
    hardrockbet: { line: 7.5, overOdds: +250, underOdds: -350 }, // best price overall, but at a DIFFERENT line
  };
  const atLine = selectExecutablePriceAtLine(books, 6.5);
  ok(atLine?.sportsbook === "fanduel" && atLine.overPrice === -102, `the best price is chosen ONLY among books that posted the exact target line — hardrockbet's far better +250 at 7.5 is never eligible (got ${atLine?.sportsbook}/${atLine?.overPrice})`);
  ok(atLine?.underPrice === -115, "the paired under price is fanduel's own (the same book chosen for over), never a different book's");

  const noBookAtLine = selectExecutablePriceAtLine(books, 9.5);
  ok(noBookAtLine === null, "when no book posted the exact requested line, the result is honestly null — never falls back to a different line's price");

  const missingUnder = selectExecutablePriceAtLine({ draftkings: { line: 6.5, overOdds: -110, underOdds: null } }, 6.5);
  ok(missingUnder?.sportsbook === "draftkings" && missingUnder.underPrice === null, "a book with a real over price but no under price at all still returns the over side, with underPrice honestly null (never fabricated)");
}

// ── End-to-end: canonical line selection is price-independent, but the SUBSEQUENT executable-price search legitimately uses price once the line is fixed ──
{
  const books = {
    draftkings: { line: 6.5, overOdds: -140, underOdds: 115 },
    fanduel: { line: 6.5, overOdds: -105, underOdds: -120 },
    hardrockbet: { line: 7.5, overOdds: -110, underOdds: -110 },
  };
  const canonical = selectCanonicalMoundV2Line(books);
  ok(canonical?.line === 6.5, "sanity: 6.5 is the 2-book majority line");
  const executable = canonical ? selectExecutablePriceAtLine(books, canonical.line) : null;
  ok(executable?.sportsbook === "fanduel" && executable.overPrice === -105, "once the line is fixed independently of price, price legitimately determines WHICH BOOK's price is captured for display/executability/ROI");
}

console.log(`\noddsDisplay.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
