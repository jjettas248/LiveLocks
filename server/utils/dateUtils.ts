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
  const estOffset = -5 * 60; // EST = UTC-5 (standard); close enough for a 6am cutoff
  const estMs = now.getTime() + (now.getTimezoneOffset() + estOffset) * 60 * 1000;
  const est = new Date(estMs);
  if (est.getHours() < 6) {
    est.setDate(est.getDate() - 1);
  }
  const y = est.getFullYear();
  const m = String(est.getMonth() + 1).padStart(2, "0");
  const d2 = String(est.getDate()).padStart(2, "0");
  return `${y}-${m}-${d2}`;
}
