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
