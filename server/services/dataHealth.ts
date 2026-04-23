type HealthStatus = "healthy" | "degraded" | "down";

interface KeyCredit {
  keyIndex: number;
  lastRemaining: number | null;
  lastCheckedAt: number | null;
  totalRequestsMade: number;
}

interface OddsAPIHealth {
  status: HealthStatus;
  lastSuccessAt: number;
  lastAttemptAt: number;
  errorCount: number;
  successCount: number;
  requestsRemaining: number | null;
  staleSeconds: number;
  errorRate: number;
  lastErrors: Array<{ timestamp: number; message: string }>;
  perKeyCredits: KeyCredit[];
}

interface DataHealth {
  oddsApi: OddsAPIHealth;
}

const ROLLING_WINDOW_MS = 5 * 60 * 1000;
const recentResults: Array<{ timestamp: number; success: boolean }> = [];

function pruneRecent(now: number) {
  const cutoff = now - ROLLING_WINDOW_MS;
  while (recentResults.length > 0 && recentResults[0].timestamp < cutoff) {
    recentResults.shift();
  }
}

let health: DataHealth = {
  oddsApi: {
    status: "healthy",
    lastSuccessAt: Date.now(),
    lastAttemptAt: Date.now(),
    errorCount: 0,
    successCount: 0,
    requestsRemaining: null,
    staleSeconds: 0,
    errorRate: 0,
    lastErrors: [],
    perKeyCredits: [],
  },
};

function computeStatus(
  lastSuccessAt: number,
  lastAttemptAt: number,
  now: number,
  recentErrorRate: number,
  recentTotal: number
): HealthStatus {
  // "down" / "degraded" must reflect ACTUAL failures, not silence.
  //
  // Previously the badge flipped to "down" purely because lastSuccessAt was
  // more than 5 minutes old, even if the odds layer was perfectly healthy
  // and just running cache-only (no live games requiring a fetch, all books
  // still fresh in the LKG cache, etc). That gave operators and users a
  // false alarm whenever there was a quiet stretch.
  //
  // New rule:
  //   • down     — we've made attempts recently AND every one of them is
  //                failing AND no success has landed in the last 5 minutes.
  //   • degraded — recent error rate is high but we are still landing some
  //                successes (mixed signal — partial outage, key rotation,
  //                throttling, etc).
  //   • healthy  — anything else, including "no recent attempts" (cache-only
  //                / between games / pre-pull window). Silence is normal,
  //                not a problem.

  const staleSeconds = (now - lastSuccessAt) / 1000;
  const attemptStaleSeconds = (now - lastAttemptAt) / 1000;
  const hasRecentAttempts = recentTotal > 0;

  // Hard down: recent attempts, all failing, last success > 5m ago.
  if (hasRecentAttempts && recentErrorRate >= 0.95 && staleSeconds > 300) return "down";
  // Degraded: most recent attempts failing but still some throughput.
  if (hasRecentAttempts && recentErrorRate > 0.7) return "degraded";
  // Anything else (including "no attempts at all") is healthy.
  // attemptStaleSeconds is unused for status today but is exported so
  // operators can see "no attempts in N seconds" via the debug endpoint.
  void attemptStaleSeconds;
  return "healthy";
}

export function updateOddsHealth(params: {
  success: boolean;
  requestsRemaining?: number;
  error?: string;
  keyIndex?: number;
}): void {
  const now = Date.now();
  const h = health.oddsApi;

  h.lastAttemptAt = now;

  recentResults.push({ timestamp: now, success: params.success });
  pruneRecent(now);

  if (params.success) {
    h.lastSuccessAt = now;
    h.successCount++;
    if (params.requestsRemaining !== undefined) {
      h.requestsRemaining = params.requestsRemaining;
    }
  } else {
    h.errorCount++;
    if (params.error) {
      h.lastErrors.push({ timestamp: now, message: params.error });
      if (h.lastErrors.length > 10) {
        h.lastErrors.shift();
      }
    }
  }

  if (params.keyIndex !== undefined) {
    let entry = h.perKeyCredits.find(k => k.keyIndex === params.keyIndex);
    if (!entry) {
      entry = { keyIndex: params.keyIndex!, lastRemaining: null, lastCheckedAt: null, totalRequestsMade: 0 };
      h.perKeyCredits.push(entry);
      h.perKeyCredits.sort((a, b) => a.keyIndex - b.keyIndex);
    }
    entry.totalRequestsMade++;
    if (params.requestsRemaining !== undefined) {
      entry.lastRemaining = params.requestsRemaining;
      entry.lastCheckedAt = now;
    }
  }

  const recentTotal = recentResults.length;
  const recentErrors = recentResults.filter(r => !r.success).length;
  h.errorRate = recentTotal > 0 ? recentErrors / recentTotal : 0;
  h.staleSeconds = (now - h.lastSuccessAt) / 1000;
  h.status = computeStatus(h.lastSuccessAt, h.lastAttemptAt, now, h.errorRate, recentTotal);

  if (h.status !== "healthy") {
    console.warn("[DATA_HEALTH]", {
      status: h.status,
      staleSeconds: h.staleSeconds,
      errorRate: h.errorRate,
      requestsRemaining: h.requestsRemaining,
    });
  }
}

export function getDataHealth(): DataHealth {
  const now = Date.now();
  const h = health.oddsApi;
  pruneRecent(now);
  const recentTotal = recentResults.length;
  const recentErrors = recentResults.filter(r => !r.success).length;
  h.errorRate = recentTotal > 0 ? recentErrors / recentTotal : 0;
  h.staleSeconds = (now - h.lastSuccessAt) / 1000;
  h.status = computeStatus(h.lastSuccessAt, h.lastAttemptAt, now, h.errorRate, recentTotal);
  return health;
}

export function resetDataHealth(): void {
  recentResults.length = 0;
  health = {
    oddsApi: {
      status: "healthy",
      lastSuccessAt: Date.now(),
      lastAttemptAt: Date.now(),
      errorCount: 0,
      successCount: 0,
      requestsRemaining: null,
      staleSeconds: 0,
      errorRate: 0,
      lastErrors: [],
      perKeyCredits: [],
    },
  };
}
