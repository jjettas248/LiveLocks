import type { Sport } from "./oddsConfig";
import { getFreshnessThresholds } from "./oddsConfig";
import { annotateSnapshot, snapshotKey } from "./oddsSnapshot";
import type { BookLineSnapshot, OddsSnapshot, ReadOddsSnapshot } from "./oddsSnapshot";
import {
  recordCacheHit,
  recordCacheMiss,
  recordCacheWrite,
  recordLkgServed,
  recordStaleBlock,
  logCacheRead,
  logCacheWrite,
  logFallbackUsed,
  logStaleBlock,
} from "./oddsDiagnostics";

const store = new Map<string, OddsSnapshot>();

function isUsable(books: Record<string, BookLineSnapshot> | undefined): boolean {
  if (!books) return false;
  for (const k of Object.keys(books)) {
    const b = books[k];
    if (b && typeof b.line === "number" && isFinite(b.line) && b.line > 0) return true;
  }
  return false;
}

export interface WriteOddsArgs {
  sport: Sport;
  eventId: string;
  market: string;
  player?: string | null;
  books: Record<string, BookLineSnapshot>;
  isLive: boolean;
  source?: "api" | "cache" | "lkg";
  fetchedAt?: number;
}

export function writeOddsSnapshot(args: WriteOddsArgs): OddsSnapshot | null {
  if (!isUsable(args.books)) {
    return null;
  }
  const snap: OddsSnapshot = {
    sport: args.sport,
    eventId: args.eventId,
    market: args.market,
    player: args.player ?? null,
    books: args.books,
    fetchedAt: args.fetchedAt ?? Date.now(),
    source: args.source ?? "api",
    isLive: args.isLive,
  };
  const key = snapshotKey(snap.sport, snap.eventId, snap.market, snap.player);
  store.set(key, snap);
  recordCacheWrite(snap.sport);
  logCacheWrite(snap.sport, { eventId: snap.eventId, market: snap.market, player: snap.player ?? "_team", books: Object.keys(snap.books).length, isLive: snap.isLive });
  return snap;
}

export interface ReadOddsArgs {
  sport: Sport;
  eventId: string;
  market: string;
  player?: string | null;
  isLive: boolean;
  allowStale?: boolean;
}

export function readOddsSnapshot(args: ReadOddsArgs): ReadOddsSnapshot | null {
  const key = snapshotKey(args.sport, args.eventId, args.market, args.player ?? null);
  const snap = store.get(key);
  if (!snap) {
    recordCacheMiss(args.sport);
    return null;
  }
  const annotated = annotateSnapshot(snap);
  if (annotated.freshness === "expired" && !args.allowStale) {
    recordStaleBlock(args.sport, "expired");
    logStaleBlock(args.sport, { eventId: args.eventId, market: args.market, player: args.player ?? "_team", ageMs: annotated.ageMs });
    return null;
  }
  if (annotated.isStale) {
    recordStaleBlock(args.sport, annotated.freshness);
  }
  recordCacheHit(args.sport);
  logCacheRead(args.sport, { eventId: args.eventId, market: args.market, player: args.player ?? "_team", ageMs: annotated.ageMs, freshness: annotated.freshness });
  return annotated;
}

export function readLastKnownGood(args: ReadOddsArgs): ReadOddsSnapshot | null {
  const key = snapshotKey(args.sport, args.eventId, args.market, args.player ?? null);
  const snap = store.get(key);
  if (!snap) return null;
  recordLkgServed(args.sport);
  logFallbackUsed(args.sport, { eventId: args.eventId, market: args.market, player: args.player ?? "_team", source: snap.source });
  const annotated = annotateSnapshot(snap);
  return { ...annotated, source: "lkg" };
}

export function getCacheSize(): number {
  return store.size;
}

export function getCacheKeys(): string[] {
  return Array.from(store.keys());
}

export function pruneExpired(maxAgeMs = 30 * 60 * 1000): number {
  const now = Date.now();
  let removed = 0;
  store.forEach((snap, k) => {
    if (now - snap.fetchedAt > maxAgeMs) {
      store.delete(k);
      removed++;
    }
  });
  return removed;
}

export function isFreshFromCache(args: ReadOddsArgs): boolean {
  const snap = readOddsSnapshot({ ...args, allowStale: true });
  if (!snap) return false;
  const t = getFreshnessThresholds(args.sport, args.isLive);
  return snap.ageMs <= t.freshMs;
}
