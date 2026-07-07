export function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function dateToET(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * ET calendar date (midnight rollover, NOT the 6am slate rollover — see
 * slateDateET() below) of an arbitrary timestamp. Use this to convert a raw
 * instant (game start time, ISO timestamp, epoch ms) into an ET date key;
 * use slateDateET() when you need the sports-slate day instead.
 */
export function toEtDateKey(input: Date | string | number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(input));
}

/** ET wall-clock time label (e.g. "7:05 PM ET") of an arbitrary timestamp. */
export function toEtTimeLabel(input: Date | string | number): string {
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(input))} ET`;
}

// daysAgoET / slateDateET now live in shared/slateDate.ts so client code
// (e.g. the Pregame Radar Win History drawer) can walk the same slate-day
// boundaries the server stamps signals with. Re-exported here to keep one
// source of truth and avoid touching the ~30 server files that import them
// from this module.
export { daysAgoET, slateDateET } from "../../shared/slateDate";
