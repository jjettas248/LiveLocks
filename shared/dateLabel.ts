// Shared — plain calendar-date label formatting.
//
// A `YYYY-MM-DD` date key (e.g. an ET slate/session date) must never be
// handed to `new Date(dateKey)` for display: that parses as UTC midnight, and
// formatting it back out in a timezone west of UTC (any US timezone) renders
// the PRIOR calendar day. formatPlainDateLabel anchors the parsed date at
// noon local time instead, so the day-of-week/month/day can never shift.

/** "2026-07-01" → "Wed, Jul 1". Never shifts the visible day. */
export function formatPlainDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}
