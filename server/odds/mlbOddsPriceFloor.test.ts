// MLB Live Edge active-polling price floor — unit tests.
// Run: npx tsx server/odds/mlbOddsPriceFloor.test.ts
//
// The floor is SIDE-SPECIFIC. The question is never "does either side of this
// market price at -200 or better?" — it is "is the side LiveLocks is actually
// evaluating available at -200 or better?". A juicy price on the side we would
// never recommend must not rescue the side we would.

import {
  MLB_ACTIVE_POLL_PRICE_FLOOR,
  bestApprovedPriceForSide,
  isPriceEligible,
  evaluatePriceFloor,
  isApprovedBook,
  recordEvaluatedSide,
  getEvaluatedSide,
  _resetPriceFloorForTests,
  type ApprovedBookPrice,
} from "./mlbOddsPriceFloor";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_ODDS_PRICE_FLOOR_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function book(b: string, overOdds: number | null, underOdds: number | null, line = 0.5): ApprovedBookPrice {
  return { book: b, line, overOdds, underOdds };
}

// ─── Group A: the floor value itself ──────────────────────────────────────────
check("A1: floor is -200", MLB_ACTIVE_POLL_PRICE_FLOOR === -200);
check("A2: -200 exactly is eligible", isPriceEligible(-200) === true);
check("A3: -201 is suppressed", isPriceEligible(-201) === false);
check("A4: -199 is eligible", isPriceEligible(-199) === true);
check("A5: -175 is eligible", isPriceEligible(-175) === true);
check("A6: -105 is eligible", isPriceEligible(-105) === true);
check("A7: +120 is eligible", isPriceEligible(120) === true);
check("A8: +250 is eligible", isPriceEligible(250) === true);
check("A9: -225 is suppressed", isPriceEligible(-225) === false);
check("A10: -300 is suppressed", isPriceEligible(-300) === false);
check("A11: unknown price is eligible (one discovery request)", isPriceEligible(null) === true);

// ─── Group B: approved books only ─────────────────────────────────────────────
check("B1: draftkings is approved", isApprovedBook("draftkings"));
check("B2: fanduel is approved", isApprovedBook("fanduel"));
check("B3: hardrockbet is approved", isApprovedBook("hardrockbet"));
check("B4: betmgm is NOT approved", !isApprovedBook("betmgm"));
check("B5: prizepicks is NOT approved", !isApprovedBook("prizepicks"));
check("B6: bovada is NOT approved", !isApprovedBook("bovada"));

{
  // A non-approved book quoting a great price must be ignored entirely.
  const books = [book("draftkings", -240, 190), book("bovada", -110, -110)];
  const best = bestApprovedPriceForSide(books, "OVER");
  check("B7: non-approved books are excluded from the best price", best === -240, String(best));
  check("B8: ...so the market is suppressed despite bovada -110", evaluatePriceFloor(books, "OVER").eligible === false);
}

// ─── Group C: best price on the EVALUATED side ────────────────────────────────
{
  // Spec example: DK -225, FD -190, HRB -210 -> eligible at -190.
  const books = [book("draftkings", -225, 185), book("fanduel", -190, 160), book("hardrockbet", -210, 175)];
  const verdict = evaluatePriceFloor(books, "OVER");
  check("C1: best OVER price across approved books is -190", verdict.bestPrice === -190, String(verdict.bestPrice));
  check("C2: eligible because the best OVER price clears the floor", verdict.eligible === true);
  check("C3: reason is 'eligible'", verdict.reason === "eligible");
}
{
  // Spec example: DK -230, FD -215, HRB -205 -> not eligible.
  const books = [book("draftkings", -230, 190), book("fanduel", -215, 180), book("hardrockbet", -205, 170)];
  const verdict = evaluatePriceFloor(books, "OVER");
  check("C4: best OVER price is -205", verdict.bestPrice === -205, String(verdict.bestPrice));
  check("C5: suppressed — every approved book is worse than -200", verdict.eligible === false);
  check("C6: reason is 'below_floor'", verdict.reason === "below_floor");
}

// ─── Group D: the opposite side can NEVER rescue the evaluated side ───────────
{
  // OVER: DK -225 | FD -210 | HRB -215.  UNDER: FD +175.
  const books = [
    book("draftkings", -225, null),
    book("fanduel", -210, 175),
    book("hardrockbet", -215, null),
  ];
  const over = evaluatePriceFloor(books, "OVER");
  check("D1: evaluated side OVER is suppressed", over.eligible === false, JSON.stringify(over));
  check("D2: the +175 UNDER did not leak into the OVER best price", over.bestPrice === -210, String(over.bestPrice));

  const under = evaluatePriceFloor(books, "UNDER");
  check("D3: the same market evaluated UNDER is eligible at +175", under.eligible === true && under.bestPrice === 175, JSON.stringify(under));
}
{
  // OVER best -240, UNDER best +160, evaluated side OVER -> stays suppressed.
  const books = [book("draftkings", -240, 160), book("fanduel", -250, 155)];
  const over = evaluatePriceFloor(books, "OVER");
  check("D4: OVER -240 remains suppressed despite UNDER +160", over.eligible === false && over.bestPrice === -240, JSON.stringify(over));
}
{
  // Genuine pitcher UNDER market: Over +125 / Under -150 -> UNDER is eligible.
  const books = [book("draftkings", 125, -150), book("fanduel", 120, -155)];
  const under = evaluatePriceFloor(books, "UNDER");
  check("D5: a pitcher UNDER at -150 is eligible", under.eligible === true && under.bestPrice === -150, JSON.stringify(under));
  // And an UNDER worse than the floor is suppressed even though Over is plus-money.
  const heavy = [book("draftkings", 190, -240), book("fanduel", 185, -230)];
  check("D6: a pitcher UNDER at -230 is suppressed despite Over +190", evaluatePriceFloor(heavy, "UNDER").eligible === false);
}

// ─── Group E: unseen pricing gets discovery, not starvation ───────────────────
{
  check("E1: no books at all -> discovery", evaluatePriceFloor([], "OVER").reason === "discovery");
  check("E2: null books -> discovery", evaluatePriceFloor(null, "OVER").reason === "discovery");
  check("E3: discovery is eligible", evaluatePriceFloor(null, "OVER").eligible === true);
  // Books present but silent on this side = unseen for that side.
  const books = [book("draftkings", null, -150)];
  check("E4: side with no quote -> discovery", evaluatePriceFloor(books, "OVER").reason === "discovery");
  check("E5: the quoted side still evaluates normally", evaluatePriceFloor(books, "UNDER").bestPrice === -150);
}

// ─── Group F: evaluated-side memory ───────────────────────────────────────────
{
  _resetPriceFloorForTests();
  check("F1: defaults to OVER before any signal exists", getEvaluatedSide("evt1", "hits", "Aaron Judge") === "OVER");
  recordEvaluatedSide("evt1", "hits_allowed", "Gerrit Cole", "UNDER");
  check("F2: a stamped UNDER is remembered", getEvaluatedSide("evt1", "hits_allowed", "Gerrit Cole") === "UNDER");
  check("F3: lookup is name-case/whitespace insensitive", getEvaluatedSide("evt1", "hits_allowed", "  gerrit cole ") === "UNDER");
  check("F4: a different market is unaffected", getEvaluatedSide("evt1", "pitcher_strikeouts", "Gerrit Cole") === "OVER");
  check("F5: a different event is unaffected", getEvaluatedSide("evt2", "hits_allowed", "Gerrit Cole") === "OVER");
  _resetPriceFloorForTests();
  check("F6: reset clears the memory", getEvaluatedSide("evt1", "hits_allowed", "Gerrit Cole") === "OVER");
}

// ─── Group G: malformed input never throws ────────────────────────────────────
{
  const junk = [
    { book: "draftkings", line: 0.5, overOdds: Number.NaN, underOdds: null },
    { book: "fanduel", line: 0.5, overOdds: Infinity, underOdds: null },
  ] as ApprovedBookPrice[];
  check("G1: NaN/Infinity prices are ignored", bestApprovedPriceForSide(junk, "OVER") === null);
  check("G2: undefined books array is safe", bestApprovedPriceForSide(undefined, "OVER") === null);
}

console.log(`[MLB_ODDS_PRICE_FLOOR_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[MLB_ODDS_PRICE_FLOOR_TEST] OK");
