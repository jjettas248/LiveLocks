type HealthStatus = "healthy" | "degraded" | "down";

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
}

interface DataHealth {
  oddsApi: OddsAPIHealth;
}

// Singleton health state
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
  },
};

function computeStatus(lastSuccessAt: number, now: number, errorRate: number): HealthStatus {
  const staleSeconds = (now - lastSuccessAt) / 1000;

  if (staleSeconds > 300) return "down";
  if (errorRate > 0.4) return "degraded";
  return "healthy";
}

export function updateOddsHealth(params: {
  success: boolean;
  requestsRemaining?: number;
  error?: string;
}): void {
  const now = Date.now();
  const h = health.oddsApi;

  h.lastAttemptAt = now;

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

  const totalAttempts = h.successCount + h.errorCount;
  h.errorRate = totalAttempts > 0 ? h.errorCount / totalAttempts : 0;
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
  h.staleSeconds = (now - h.lastSuccessAt) / 1000;
  h.status = computeStatus(h.lastSuccessAt, now, h.errorRate);
  return health;
}

export function resetDataHealth(): void {
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
    },
  };
}
