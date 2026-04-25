const VERSION_KEY = "ll_app_version";
const RELOAD_ATTEMPTS_KEY = "ll_app_version_reload_attempts";
const MAX_RELOAD_ATTEMPTS = 2;

function getBuildVersion(): string | null {
  const meta = document.querySelector('meta[name="app-version"]');
  const v = meta?.getAttribute("content")?.trim();
  return v || null;
}

async function fetchServerVersion(timeoutMs = 2500): Promise<string | null> {
  // Hard timeout via AbortController so a stalled connection cannot block boot.
  // On timeout / network failure / non-2xx, return null and let the caller
  // fall back to the meta-tag path documented in cache-invalidation.md §6.1.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/version", {
      cache: "no-store",
      credentials: "omit",
      headers: { "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const v = (data?.version || "").trim();
    return v || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function clearAllCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {}
}

function readReloadAttempts(): number {
  try {
    const v = sessionStorage.getItem(RELOAD_ATTEMPTS_KEY);
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function bumpReloadAttempts(): number {
  const next = readReloadAttempts() + 1;
  try {
    sessionStorage.setItem(RELOAD_ATTEMPTS_KEY, String(next));
  } catch {}
  return next;
}

function clearReloadAttempts(): void {
  try {
    sessionStorage.removeItem(RELOAD_ATTEMPTS_KEY);
  } catch {}
}

function reloadWithCacheBust(version: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("_v", version);
    url.searchParams.set("_t", String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    try {
      window.location.reload();
    } catch {
      window.location.href = window.location.href;
    }
  }
}

/**
 * Boot-time version mismatch detection.
 *
 * Authoritative source is the server (/api/version). The HTML <meta
 * name="app-version"> tag is a fallback used when the network is unreachable.
 * If the server reports a newer build than what this browser is running,
 * the Cache Storage API is wiped and the page is reloaded with a cache-bust
 * query param. A bounded sessionStorage attempt counter prevents reload loops
 * AND prevents silent lock-in on a stale build.
 */
export async function checkAppVersion(): Promise<void> {
  const buildVersion = getBuildVersion();

  let storedVersion: string | null = null;
  try {
    storedVersion = localStorage.getItem(VERSION_KEY);
  } catch {}

  // Try to get server truth. Best effort — if the call fails (offline,
  // first paint while SW is offline, etc), fall back to comparing the
  // HTML meta tag against localStorage.
  const serverVersion = await fetchServerVersion();
  const truthVersion = serverVersion || buildVersion;

  // No truth available at all — nothing we can do; let the app render.
  if (!truthVersion) return;

  // First load on this device — record version and proceed.
  if (!storedVersion) {
    try {
      localStorage.setItem(VERSION_KEY, truthVersion);
    } catch {}
    clearReloadAttempts();
    return;
  }

  // Determine if this client is on a stale build. Two signals must agree
  // to trigger a reload: the local stored version differs from server
  // truth, OR the served HTML meta differs from server truth (meaning
  // the HTML itself was cached).
  const localStale = storedVersion !== truthVersion;
  const htmlStale = !!serverVersion && !!buildVersion && buildVersion !== serverVersion;
  const mismatch = localStale || htmlStale;

  if (!mismatch) {
    clearReloadAttempts();
    return;
  }

  const attempts = readReloadAttempts();

  if (attempts >= MAX_RELOAD_ATTEMPTS) {
    // Bounded — we already tried hard. Update stored version so we don't
    // keep flagging the same mismatch forever, and let the app render.
    // Console-log for diagnostics; user is now stuck on whatever the
    // server actually served, which is the best we can do without
    // forcing a SW unregister.
    try {
      localStorage.setItem(VERSION_KEY, truthVersion);
    } catch {}
    clearReloadAttempts();
    // eslint-disable-next-line no-console
    console.warn(
      `[versionCheck] Stale build still detected after ${attempts} reload attempts; giving up. ` +
        `local=${storedVersion} html=${buildVersion} server=${serverVersion}`,
    );
    return;
  }

  bumpReloadAttempts();

  // Pre-write the truth so that, after reload, if the new HTML matches we
  // converge cleanly and clear the attempt counter on next boot.
  try {
    localStorage.setItem(VERSION_KEY, truthVersion);
  } catch {}

  await clearAllCaches();

  reloadWithCacheBust(truthVersion);

  // Block forever; the page is about to unload.
  await new Promise(() => {});
}
