/**
 * Bounded ring-buffer helpers.
 *
 * EXTRACTED — DO NOT CHANGE BEHAVIOR WITHOUT REGRESSION REVIEW.
 *
 * Consolidates three previously-duplicated buffer patterns:
 *   - server/mlb/diagnostics.ts        (push + splice cap, MAX_RECORDS=2000)
 *   - server/mlb/diagnosticsBuffer.ts  (pushCapped helper, MAX_ENTRIES=50)
 *   - server/mlb/qualificationAudit.ts (push + while-shift cap, RING_SIZE=50)
 *
 * All three patterns produce the same final array contents (the most recent
 * `maxLen` items, oldest-first). These helpers preserve that exact result.
 */

/**
 * Append `item` to `arr` and evict oldest items in-place so the array length
 * never exceeds `maxLen`. Mathematically equivalent to either:
 *   arr.push(item); if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
 *   arr.push(item); while (arr.length > maxLen) arr.shift();
 */
export function boundedPush<T>(arr: T[], item: T, maxLen: number): void {
  arr.push(item);
  if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
}

/**
 * Return the last `limit` items of `arr` in NEWEST-FIRST order.
 * Mirrors the `arr.slice(-limit).reverse()` pattern used by every
 * diagnosticsBuffer.ts get* function.
 */
export function recentReversed<T>(arr: readonly T[], limit: number): T[] {
  return arr.slice(-limit).reverse();
}

/**
 * Count items in `arr` whose `ts` field is within the last `windowMs`.
 * Mirrors `arr.filter((r) => r.ts >= cutoff).length` used 8x in
 * diagnosticsBuffer.getDiagnosticsCounts.
 */
export function countSinceMs<T extends { ts: number }>(
  arr: readonly T[],
  windowMs: number,
  now: number = Date.now(),
): number {
  const cutoff = now - windowMs;
  let n = 0;
  for (const r of arr) if (r.ts >= cutoff) n++;
  return n;
}
