export function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function dateToET(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function daysAgoET(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateToET(d);
}

/**
 * "Sports slate" day — like todayET() but the day doesn't roll over at
 * midnight ET; it rolls over at 6am ET. Late-night West-coast games that
 * finish after midnight ET still belong to the slate that started the
 * evening before. Used anywhere a build/session needs to agree with game
 * discovery on which day's slate is currently in play (see
 * gameDiscoveryService.discoverTodaysGames, which uses this same cutoff).
 */
export function slateDateET(now: Date = new Date()): string {
  // Read the wall-clock date + hour in America/New_York via Intl so the 6am
  // cutoff is DST-aware (a fixed UTC-5 offset would make the cutoff land at
  // 7am during EDT — the bulk of the MLB season).
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  let year = get("year");
  let month = get("month");
  let day = get("day");
  const hour = get("hour") % 24; // some ICU builds render midnight as "24"

  if (hour < 6) {
    const prevDay = new Date(Date.UTC(year, month - 1, day));
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    year = prevDay.getUTCFullYear();
    month = prevDay.getUTCMonth() + 1;
    day = prevDay.getUTCDate();
  }

  const m = String(month).padStart(2, "0");
  const d2 = String(day).padStart(2, "0");
  return `${year}-${m}-${d2}`;
}
