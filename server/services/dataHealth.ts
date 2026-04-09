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

function computeStatus(lastSuccessAt: number, now: number, recentErrorRate: number): HealthStatus {
  const staleSeconds = (now - lastSuccessAt) / 1000;

  if (staleSeconds > 300) return "down";
  if (recentErrorRate > 0.7) return "degraded";
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
  h.status = computeStatus(h.lastSuccessAt, now, h.errorRate);

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
  h.status = computeStatus(h.lastSuccessAt, now, h.errorRate);
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
