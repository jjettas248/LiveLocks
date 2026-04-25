import { useEffect, useState } from "react";

type Status = "ok" | "stale" | "unknown";

interface VersionState {
  frontend: string | null;
  server: string | null;
  serviceWorker: string | null;
  serverError: string | null;
  swState: "controlled" | "uncontrolled" | "unsupported" | "unknown";
}

function readFrontendVersion(): string | null {
  const meta = document.querySelector('meta[name="app-version"]');
  return meta?.getAttribute("content")?.trim() || null;
}

async function fetchServerVersion(timeoutMs = 2500): Promise<{ version: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/version", {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!res.ok) return { version: null, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { version?: string };
    return { version: (data?.version || "").trim() || null, error: null };
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "timeout" : err?.message || "fetch failed";
    return { version: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchServiceWorkerVersion(): Promise<{ version: string | null; state: VersionState["swState"] }> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { version: null, state: "unsupported" };
  }
  const ctrl = navigator.serviceWorker.controller;
  if (!ctrl) {
    return { version: null, state: "uncontrolled" };
  }
  return new Promise((resolve) => {
    let settled = false;
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { channel.port1.close(); } catch {}
      resolve({ version: null, state: "controlled" });
    }, 1500);
    channel.port1.onmessage = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { channel.port1.close(); } catch {}
      const v = ev?.data?.version ? String(ev.data.version) : null;
      resolve({ version: v, state: "controlled" });
    };
    try {
      ctrl.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ version: null, state: "controlled" });
    }
  });
}

function classify(state: VersionState): Status {
  const { frontend, server, serviceWorker, swState } = state;

  // Without a known frontend or server version we cannot judge anything.
  if (!frontend || !server) return "unknown";

  // Any explicit version mismatch is stale.
  if (frontend !== server) return "stale";
  if (serviceWorker && serviceWorker !== server) return "stale";

  // To call this "in sync" we need positive evidence that the SW is on the
  // right build OR that the SW is intentionally not in play. Otherwise
  // (uncontrolled / timed-out / unknown) we cannot promise the user that the
  // SW cache is current — degrade to "unknown" so an admin investigates.
  const swVerified = !!serviceWorker && serviceWorker === server;
  const swNotApplicable = swState === "unsupported";
  if (swVerified || swNotApplicable) return "ok";
  return "unknown";
}

function colorFor(status: Status): string {
  if (status === "ok") return "text-green-400";
  if (status === "stale") return "text-amber-400";
  return "text-muted-foreground";
}

function dotFor(status: Status): string {
  if (status === "ok") return "bg-green-400";
  if (status === "stale") return "bg-amber-400";
  return "bg-muted-foreground";
}

export function DiagnosticsFooter() {
  const [state, setState] = useState<VersionState>({
    frontend: null,
    server: null,
    serviceWorker: null,
    serverError: null,
    swState: "unknown",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  async function refresh() {
    setRefreshing(true);
    const frontend = readFrontendVersion();
    const [serverRes, swRes] = await Promise.all([
      fetchServerVersion(),
      fetchServiceWorkerVersion(),
    ]);
    setState({
      frontend,
      server: serverRes.version,
      serviceWorker: swRes.version,
      serverError: serverRes.error,
      swState: swRes.state,
    });
    setLastChecked(new Date());
    setRefreshing(false);
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = classify(state);
  const swLabel =
    state.serviceWorker ??
    (state.swState === "uncontrolled"
      ? "uncontrolled"
      : state.swState === "unsupported"
      ? "unsupported"
      : "—");
  const checkedAtLabel = lastChecked
    ? lastChecked.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <div
      data-testid="admin-diagnostics-footer"
      className="mt-6 rounded-xl border border-border bg-card/60 backdrop-blur-sm px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        <div className="flex items-center gap-2 font-semibold text-foreground/90">
          <span className={`inline-block w-2 h-2 rounded-full ${dotFor(status)}`} />
          <span>Build diagnostics</span>
          <span className={`ml-1 uppercase tracking-wider ${colorFor(status)}`} data-testid="text-build-status">
            {status === "ok" ? "in sync" : status === "stale" ? "stale" : "unknown"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Frontend:</span>
          <code
            className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded"
            data-testid="text-frontend-version"
          >
            {state.frontend ?? "—"}
          </code>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Server:</span>
          <code
            className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded"
            data-testid="text-server-version"
          >
            {state.server ?? (state.serverError ? `err: ${state.serverError}` : "—")}
          </code>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Service worker:</span>
          <code
            className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded"
            data-testid="text-sw-version"
          >
            {swLabel}
          </code>
        </div>

        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span>Checked:</span>
          <span data-testid="text-diagnostics-checked-at">{checkedAtLabel}</span>
        </div>

        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          data-testid="button-diagnostics-refresh"
          className="ml-auto px-2 py-1 rounded-md border border-border text-foreground hover:bg-muted disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {status === "stale" && (
        <div
          className="mt-2 text-[11px] text-amber-300/90"
          data-testid="text-diagnostics-stale-help"
        >
          A version mismatch was detected. Affected clients should auto-reload on next boot.
          If this banner persists for an admin tab, hard-refresh (⌘/Ctrl+Shift+R) once.
        </div>
      )}
    </div>
  );
}
