import { db } from "./db";
import { sentAlerts } from "@shared/schema";
import { eq, and, gt } from "drizzle-orm";

// Shared DB-backed alert dedupe — survives server restarts. Extracted from
// the fingerprint pattern already used in alertManager.ts (sendSmsIfNew,
// is2HAlertAlreadySent) so new alert sources don't reinvent the query.
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function hasAlertFingerprint(fingerprint: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const existing = await db
      .select({ id: sentAlerts.id })
      .from(sentAlerts)
      .where(and(eq(sentAlerts.fingerprint, fingerprint), gt(sentAlerts.sentAt, cutoff)))
      .limit(1);
    return existing.length > 0;
  } catch {
    return false;
  }
}

export async function recordAlertFingerprint(fingerprint: string, userId: number = 0): Promise<void> {
  try {
    await db.insert(sentAlerts).values({ fingerprint, userId }).onConflictDoNothing();
  } catch {}
}
