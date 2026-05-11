/**
 * Parity test: prove the shared ring-buffer helpers in ./ringBuffer.ts
 * produce IDENTICAL final array state to the three legacy patterns
 * previously inlined in:
 *   - server/mlb/diagnostics.ts        (push + splice)
 *   - server/mlb/diagnosticsBuffer.ts  (push + splice via pushCapped, .slice(-N).reverse(), filter ts>=cutoff)
 *   - server/mlb/qualificationAudit.ts (push + while-shift)
 *
 * Run: `npx tsx server/utils/ringBuffer.test.ts`
 */

import { boundedPush, recentReversed, countSinceMs } from "./ringBuffer";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, a: unknown, b: unknown): void {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}: expected=${JSON.stringify(b)} got=${JSON.stringify(a)}`);
  }
}

// ---------------- Legacy reference patterns ----------------

function legacyPushSplice<T>(arr: T[], item: T, maxLen: number): void {
  arr.push(item);
  if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
}

function legacyPushShift<T>(arr: T[], item: T, maxLen: number): void {
  arr.push(item);
  while (arr.length > maxLen) arr.shift();
}

function legacySliceReverse<T>(arr: readonly T[], limit: number): T[] {
  return arr.slice(-limit).reverse();
}

function legacyCountSince<T extends { ts: number }>(
  arr: readonly T[],
  windowMs: number,
  now: number,
): number {
  const cutoff = now - windowMs;
  return arr.filter((r) => r.ts >= cutoff).length;
}

// ---------------- Test 1: boundedPush vs splice (diagnostics.ts/diagnosticsBuffer.ts) ----------------

for (const cap of [1, 2, 5, 50, 2000]) {
  const newArr: number[] = [];
  const oldArr: number[] = [];
  for (let i = 0; i < cap * 2 + 7; i++) {
    boundedPush(newArr, i, cap);
    legacyPushSplice(oldArr, i, cap);
    check(`boundedPush vs splice cap=${cap} step=${i}`, newArr, oldArr);
  }
}

// ---------------- Test 2: boundedPush vs while-shift (qualificationAudit.ts) ----------------

for (const cap of [1, 5, 50, 100]) {
  const newArr: number[] = [];
  const oldArr: number[] = [];
  for (let i = 0; i < cap * 3; i++) {
    boundedPush(newArr, i, cap);
    legacyPushShift(oldArr, i, cap);
    check(`boundedPush vs shift cap=${cap} step=${i}`, newArr, oldArr);
  }
}

// ---------------- Test 3: cap=0 edge case ----------------

{
  const arr: number[] = [];
  boundedPush(arr, 1, 0);
  boundedPush(arr, 2, 0);
  check("cap=0 evicts everything", arr, []);
}

// ---------------- Test 4: pre-existing oversized arr (defensive) ----------------

{
  const newArr = [10, 20, 30, 40, 50];
  const oldArr = [10, 20, 30, 40, 50];
  boundedPush(newArr, 99, 3);
  legacyPushSplice(oldArr, 99, 3);
  check("oversized pre-existing arr trims to cap", newArr, oldArr);
  check("oversized post state matches", newArr, [40, 50, 99]);
}

// ---------------- Test 5: recentReversed vs slice(-limit).reverse() ----------------

const sample = [10, 20, 30, 40, 50, 60];
for (const lim of [0, 1, 3, 6, 10]) {
  check(
    `recentReversed limit=${lim}`,
    recentReversed(sample, lim),
    legacySliceReverse(sample, lim),
  );
}
check("recentReversed empty", recentReversed([], 5), []);

// ---------------- Test 6: countSinceMs vs filter(ts>=cutoff) ----------------

const NOW = 1_700_000_000_000;
const tsArr = [
  { ts: NOW - 60_000 },
  { ts: NOW - 30_000 },
  { ts: NOW - 5_000 },
  { ts: NOW - 1_000 },
  { ts: NOW },
];
for (const win of [0, 500, 2_000, 10_000, 60_000, 120_000]) {
  check(
    `countSinceMs win=${win}`,
    countSinceMs(tsArr, win, NOW),
    legacyCountSince(tsArr, win, NOW),
  );
}
check("countSinceMs empty", countSinceMs([], 10_000, NOW), 0);

// ---------------- Test 7: simulate diagnosticsBuffer.getDiagnosticsCounts behavior ----------------

{
  type Rec = { ts: number; v: number };
  const records: Rec[] = [];
  const NOW2 = Date.now();
  // Push records the way real production does: pushed-later = larger ts.
  for (let i = 0; i < 80; i++) {
    boundedPush(records, { ts: NOW2 - (79 - i) * 1000, v: i }, 50);
  }
  check("bounded len at cap", records.length, 50);
  // Window count parity vs legacy filter.
  check(
    "10s count parity",
    countSinceMs(records, 10_000, NOW2),
    records.filter((r) => r.ts >= NOW2 - 10_000).length,
  );
  // Recent reversed: pushed-latest comes first (matches getHrWatchDetections etc).
  const r5 = recentReversed(records, 5);
  check("recentReversed length", r5.length, 5);
  for (let i = 0; i < r5.length - 1; i++) {
    if (r5[i].ts < r5[i + 1].ts) {
      failed++;
      failures.push(`recentReversed not newest-first at idx ${i}`);
    } else {
      passed++;
    }
  }
}

// ---------------- Report ----------------
console.log(`[RING_BUFFER_PARITY] passed=${passed} failed=${failed}`);
if (failed > 0) {
  console.error("FAILURES (first 20):");
  for (const f of failures.slice(0, 20)) console.error("  " + f);
  process.exit(1);
}
console.log("[RING_BUFFER_PARITY] OK — shared helpers match legacy buffer behavior exactly");
