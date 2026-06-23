# Cache Invalidation & Deploy Integrity

This document is the authoritative reference for how LiveLocks guarantees that
every browser — including iOS PWA installs — picks up a new build after a
deploy, and how stale data is prevented from surviving deploys.

It is intentionally narrow: deployment / cache integrity + admin visibility
only. It does NOT cover the HR engine, scoring, calibration, Stripe, or any
business-logic code path.

---

## 1. Architecture overview

There are **three** independently-validated invalidation paths. A new build
ships only when at least one of them fires; in practice, all three fire
together so the system is robust to single-path failure.

```
                ┌───────────────────────────────┐
                │  Deploy: APP_VERSION = afcea13│
                └───────────────┬───────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌────────────────┐     ┌────────────────┐     ┌────────────────────┐
│ A. SW byte-diff│     │ B. HTML meta   │     │ C. /api/version    │
│ /sw.js changes │     │ tag changes    │     │ JSON endpoint      │
│ → updatefound  │     │ → checkAppVer  │     │ (server truth)     │
│ → SKIP_WAITING │     │ → reload       │     │ → checkAppVersion  │
│ → controller   │     │                │     │   compare on boot  │
│   change       │     │                │     │                    │
│ → reload       │     │                │     │                    │
└────────────────┘     └────────────────┘     └────────────────────┘
```

### Path A — Service-Worker self-update

`/sw.js` is served by `server/swHandler.ts`, which substitutes the literal
`__APP_VERSION__` token in `client/public/sw.js` with the current `APP_VERSION`
on every request. Headers: `Cache-Control: no-cache, no-store, must-revalidate`.

Because the script body is **byte-different** between deploys (the cache name
becomes `livelocks-<NEW_VERSION>`), the browser's built-in SW update check
detects a new SW, installs it, fires `updatefound`, then `statechange ->
installed`. `client/src/main.tsx` posts `SKIP_WAITING`, which triggers
`controllerchange`, which triggers `window.location.reload()`.

### Path B — HTML meta-tag mismatch

Both the dev (`server/vite.ts`) and prod (`server/static.ts`) HTML handlers
inject `<meta name="app-version" content="<APP_VERSION>" />` before `</head>`
on every request, with full no-cache headers. `client/src/lib/versionCheck.ts`
reads this tag at boot, compares it to `localStorage.ll_app_version`, and
reloads on mismatch.

### Path C — `/api/version` server-truth check

`checkAppVersion()` also fetches `/api/version` (`Cache-Control: no-store`) at
boot. This is the **authoritative** source. It catches the otherwise-invisible
case where the browser is booting from a cached HTML shell whose meta tag
matches localStorage but the server has actually shipped a newer build.

When the server version differs from either the local store or the served HTML,
`checkAppVersion()` clears the Cache Storage API, writes the new version into
localStorage, and reloads with cache-busting query params (`?_v=<ver>&_t=<ms>`).

---

## 2. Cache-Control header inventory (production)

| Path                            | Cache-Control                                  | Why                                           |
| ------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| `/api/version`                  | `no-store, no-cache, must-revalidate`          | Authoritative deploy ID — must never cache    |
| `/api/*` (other)                | (unchanged) — SW also bypasses cache for these | Existing API hygiene; SW does `fetch(req)`    |
| `/sw.js`                        | `no-cache, no-store, must-revalidate`          | New deploy must replace SW immediately        |
| `/`, `/index.html`              | `no-cache, no-store, must-revalidate`          | Shell must always be revalidated              |
| `/manifest.json`                | `no-cache, no-store, must-revalidate`          | PWA metadata changes must propagate           |
| `/favicon.*`                    | `no-cache, no-store, must-revalidate`          | Icon updates after a rebrand must propagate   |
| `/apple-touch-icon*.png`        | `no-cache, no-store, must-revalidate`          | iOS A2HS icon refresh                         |
| `/assets/<hash>.<ext>` (Vite)   | `public, max-age=31536000, immutable`          | Filename includes content hash → safe forever |

---

## 3. React Query stale-data guarantees

The user-visible state most at risk during a deploy is **auth identity** and
**subscription tier**. Here is why stale tier/auth data **cannot survive a
deploy**:

### 3.1 No cross-reload persistence

```
$ rg -n "persistQueryClient|@tanstack/query-persist-client-core" client/
(no matches)
```

There is no `persistQueryClient`, `createSyncStoragePersister`, or any other
React Query persistence layer. The cache is **in-memory only** and is wiped on
every page reload. Any reload — including the one triggered by
`checkAppVersion()` on version mismatch — fully resets the React Query store.

### 3.2 The Service Worker never caches API responses

`client/public/sw.js`:

```js
if (url.pathname.startsWith("/api/")) {
  event.respondWith(fetch(request));
  return;
}
```

`/api/auth/me`, `/api/me`, `/api/live-signals/*`, `/api/halftime-plays`,
`/api/top-plays`, `/api/persisted-plays/*`, `/api/admin/*`, etc. are
**never** stored in any Cache Storage entry by the SW. They go directly to the
network on every request.

### 3.3 Auth/me is fetched on a fast schedule

`client/src/hooks/use-auth.ts`:

```ts
useQuery<AuthUser | null>({
  queryKey: ["/api/auth/me"],
  staleTime: 0,
  refetchInterval: 60_000,
  refetchOnWindowFocus: true,
  retry: false,
});
```

`staleTime: 0` means every render is allowed to re-fetch. `refetchInterval: 60s`
guarantees a fresh tier within 60 seconds even if the user never refocuses the
tab. `refetchOnWindowFocus: true` re-fetches on every visibility change. The
result: tier transitions (free → trial → paid → canceled) propagate to the UI
within **at most 60 seconds**, deploy or no deploy.

### 3.4 `/api/me` is independently polled by the dashboard

`client/src/pages/dashboard.tsx` polls `/api/me` on mount, on window focus,
and every 60s, and writes the result into the `["/api/auth/me"]` query cache
via `setQueryData`. This is a second independent invalidation channel for tier
data — even if the `/api/auth/me` query itself is stuck for some reason (e.g.,
component is unmounted), `/api/me` will still refresh tier in the cache.

### 3.5 Live signals invalidation pattern

Live signals use composite keys (e.g., `["/api/live-signals", selectedGameId]`
and `["/api/mlb/live-stats", gameId]`) and call
`queryClient.invalidateQueries({ queryKey: [...] })` on user actions. After a
deploy-triggered reload these queries do not exist yet — they will be re-created
fresh on the new build's first render.

### 3.6 What's actually in localStorage

```
ll_auth_token                 // bearer token, server-validated on every request
ll_app_version                // version sentinel (this system)
ll_app_version_reload_attempts (sessionStorage) // bounded retry counter
ll_alerts, ll_alerts_onboarded, ll_pwa_dismissed
smsStatus, smsPhone, lastLogDate, slateResetTime, lastSlateReset
mlb_calc_*                    // MLB calculator field memory
TOUR_COMPLETED_KEY            // onboarding tour
```

**No** subscription tier, isAdmin, user object, or any other identity field is
persisted client-side. The token survives reloads (which is desirable: the
user stays logged in across the deploy), but the actual entitlement decision
is always re-fetched from the server on the next mount of `useAuth()`.

### 3.7 Conclusion

Stale auth/tier data **cannot survive a deploy** because:

1. The deploy triggers a hard reload via SW self-update or `checkAppVersion()`.
2. The reload wipes the in-memory React Query store.
3. The first render after reload re-fetches `/api/auth/me` from the network.
4. The SW does not intercept `/api/*` requests.
5. The 60s polling on `/api/me` provides a second independent refresh channel.

---

## 4. Admin diagnostics footer

`client/src/components/admin/DiagnosticsFooter.tsx` is mounted at the bottom of
`client/src/pages/admin.tsx`, regardless of which admin tab is active.

It displays, side-by-side with a status dot:

- **Frontend version** — read from `<meta name="app-version">` in the served HTML
- **Server version** — fetched from `/api/version` (no-store)
- **Service worker version** — obtained via `MessageChannel` postMessage to the
  active SW (`{type: "GET_VERSION"}` → `{type: "SW_VERSION", version, cacheName}`)

Status:

- **in sync** (green dot) — frontend matches server **and** the SW is either
  verified on the same version or genuinely unsupported (no SW available).
- **stale** (amber dot) — frontend differs from server, or the SW reports a
  version different from the server. The user is shown a hint to hard-refresh.
- **unknown** (gray dot) — frontend or server version could not be determined
  (e.g., offline, `/api/version` timeout, server unreachable), **or** the SW
  is in an indeterminate state (uncontrolled, postMessage timeout, no version
  reply). We deliberately downgrade to "unknown" rather than reporting "in
  sync" without positive SW evidence.

The panel auto-refreshes every 60 seconds and has a manual `Refresh` button.
This lets an admin confirm a live user is on the correct build without opening
the browser console — the admin opens the user's tab and looks at the footer.

---

## 5. Mobile PWA behavior (iOS Safari + Add-to-Home-Screen)

iOS PWAs are the worst case for stale shells. Here is exactly what happens
on iOS when a new build is deployed:

### 5.1 The good news

- Service workers **are supported** in standalone PWAs on iOS Safari (since
  iOS 11.3), so Path A is available — but with significant platform caveats
  documented in §5.5 below.
- Our service worker is byte-different per deploy (Path A), so when iOS
  *does* run an SW update check, it will detect a new SW.
- Our `Cache-Control: no-cache, no-store, must-revalidate` headers on
  `index.html`, `sw.js`, `manifest.json`, and favicons are honored by iOS in
  the vast majority of cases.

### 5.2 Update timing on iOS A2HS

When a user opens an installed PWA:

1. iOS dispatches a navigation request to `/`.
2. Our SW intercepts via the `navigate` handler in `sw.js`. It fetches `/`
   from the network and falls back to the cached `/index.html` only on
   network failure.
3. Because the new server returns the new `index.html` (with the new
   `<meta name="app-version">`), the network response wins.
4. In parallel, iOS schedules an SW update check (browsers do this on every
   navigation when the registration is older than 24 hours, and immediately
   when the SW script's `Cache-Control` says no-cache — which ours does).
5. The new `/sw.js` is byte-different → installs → activates → claims clients.
6. The activate handler deletes every cache whose name ≠ the new
   `livelocks-<NEW_VERSION>`, removing the stale shell.
7. `client/src/main.tsx`'s `controllerchange` listener reloads the page,
   completing the upgrade.

### 5.3 Belt-and-braces fallback for iOS

If Path A is delayed (iOS sometimes throttles SW update checks for installed
PWAs to once per 24h on background launches, and update timers are
heuristically scheduled — see §5.5), Path C is the more reliable upgrade
trigger:

- The new HTML shell (served fresh by the no-cache `/` handler) carries the
  new `<meta name="app-version">`.
- `checkAppVersion()` runs **before render** and fetches `/api/version`
  with a 2.5s `AbortController` timeout and `cache: "no-store"`.
- If server version > stored version, the Cache Storage API is wiped and
  the page reloads with cache-busting query params.

In practice this means a fresh iOS PWA cold launch on a working network
will almost always converge to the new build on the first navigation
(usually with one auto-reload). It is *not* a hard guarantee — see §5.5.

### 5.4 What an iOS user actually sees

- **Best case (network fast):** Brief flash, then the new build renders.
- **Typical case:** Brief flash, then a one-time auto-reload (~1s), then the
  new build renders. Bounded retry counter ensures this happens at most
  twice per session.
- **Worst case (offline cold launch):** The cached old shell renders. The
  user sees the previous build until the device gets network and the SW
  update fires, at which point the next focus/visibility-change triggers
  `reg.update()` (already wired in `main.tsx` line 42-46) and the upgrade
  completes.

### 5.5 Known iOS limitations (degraded paths)

- **SW update throttling.** iOS does not always fire an SW update check on
  every cold launch; intervals are heuristic and have been observed up to
  24 hours in background-launch scenarios. Path C compensates as long as
  the network is reachable.
- **Captive portals / DNS hijack.** If `/api/version` returns 200 with
  non-JSON (e.g. a captive-portal HTML interstitial), the parse fails and
  `fetchServerVersion()` returns `null`. We then fall back to the meta-tag
  path (§6.1) and skip the upgrade until the next launch.
- **Offline cold launch.** Same as the worst case in §5.4 above: the user
  sees the cached old shell until network returns.
- **Bounded retry.** The `MAX_RELOAD_ATTEMPTS = 2` counter in
  `versionCheck.ts` guarantees we never enter a reload loop, even if the
  upgrade signal is flapping.
- **Diagnostics footer fallback.** When the SW version cannot be confirmed
  (uncontrolled, postMessage timeout, or `serviceWorker` unavailable), the
  admin diagnostics footer downgrades the status badge to **unknown** rather
  than reporting "in sync" — see §4.

---

## 6. Edge-case behavior — explicit fallback documentation

### 6.1 `/api/version` fetch fails

**Cause:** Network error, server temporarily down, CORS misconfiguration, etc.

**Code path:** `versionCheck.ts:fetchServerVersion()` returns `null`
(`Promise<string | null>`) on any of: 2.5s `AbortController` timeout, network
error, non-2xx response, or non-JSON body. The caller then computes
`truthVersion = serverVersion || buildVersion`, falling back to the HTML
meta tag (which is always served fresh from the no-cache HTML handler).
The diagnostics footer's variant of this function returns
`{ version: null, error }` so the admin badge can show the failure reason
("timeout", "HTTP 503", etc.) — but only the `version` field drives status.

**Behavior:**
- If meta tag matches localStorage → render normally; do nothing.
- If meta tag differs from localStorage → reload using meta tag as truth
  (Path B, with the bounded retry counter in effect).
- If neither meta tag nor server version is available (truly offline first
  load) → `truthVersion` is null and the function returns early; the app
  renders normally.

**Result:** No infinite loop; degrades to Path B; never blocks rendering.

### 6.2 Stale `localStorage.ll_app_version`

**Cause:** Browser was offline during the previous deploy and the local
sentinel was never updated.

**Code path:** First boot after coming online detects mismatch (server or
meta is newer than `ll_app_version`).

**Behavior:**
1. `bumpReloadAttempts()` increments
   `sessionStorage.ll_app_version_reload_attempts` to 1.
2. `localStorage.ll_app_version` is updated to the new truth.
3. Cache Storage API is wiped via `caches.keys() → caches.delete(k)`.
4. Page reloads with `?_v=<new>&_t=<now>`.
5. After reload, version check runs again. Now stored version matches
   server → `clearReloadAttempts()` resets counter.

**Result:** Exactly one reload per stale-version condition; counter clears
on successful convergence.

### 6.3 Stale SW + offline cold launch

**Cause:** PWA opened from app icon while device has no network.

**Code path:**
1. `boot()` calls `checkAppVersion()`.
2. `fetchServerVersion()` fails → `serverVersion = null`.
3. Meta tag is read from the SW-cached `index.html` (matches stored version).
4. No mismatch detected → render normally from cache.

**Behavior:** App renders the previous build from the SW cache. User can
continue using the app offline-first. When network returns, the next
visibility-change handler in `main.tsx:42-46` calls `reg.update()`, which
fetches the new `/sw.js` (byte-different), kicks off the install/activate
cycle, and the controllerchange listener reloads.

**Result:** No false reload while offline; correct upgrade as soon as the
device gets network.

### 6.4 Interrupted deploy (server in a partially-rolled state)

**Cause:** Deploy is in progress; some requests hit the new build, others
hit the old build. (On Railway deploys this window is very short, but it
exists.)

**Possible inconsistencies:**
- `index.html` is from build A but `/sw.js` is from build B.
- `/api/version` returns build A but the cached HTML in browser is build B.
- A hashed asset reference in `index.html` (e.g. `/assets/index-X.js`)
  doesn't exist on the responding server.

**Behavior:**
- Hashed assets that 404 cause the browser to log a load error. We have
  the existing safeguard in `server/static.ts` that returns 404 for missing
  `/assets/*` (instead of falling back to `index.html`), so the browser
  does not silently parse HTML as JavaScript. The page may render in a
  broken state for a few seconds.
- `checkAppVersion()` will detect the version mismatch on the next render
  cycle — either the meta tag and server version disagree (triggering
  reload) or they agree at the new version while localStorage still has
  the old (also triggering reload).
- The bounded retry counter (`MAX_RELOAD_ATTEMPTS = 2`) prevents an
  infinite reload loop if the deploy stays inconsistent.

**Worst-case behavior under sustained inconsistency:**
- After 2 reload attempts, `checkAppVersion()` writes the most recent
  truth into localStorage, clears the reload counter, logs a console.warn
  (`"[versionCheck] Stale build still detected after 2 reload attempts;
  giving up. local=X html=Y server=Z"`), and renders the app with whatever
  the server actually served. The admin diagnostics footer will show the
  mismatch in real time so an operator can see it immediately.

**Result:** No infinite loop is possible; in the pathological case, the
admin footer makes the inconsistency visible.

---

## 7. Files in scope of this system

```
server/version.ts                              # APP_VERSION source
server/swHandler.ts                            # /sw.js token substitution + headers
server/static.ts                               # prod HTML meta + shell-file headers
server/vite.ts                                 # dev HTML meta + headers
server/index.ts                                # /api/version + handler registration
client/public/sw.js                            # cache name + GET_VERSION handshake
client/src/lib/versionCheck.ts                 # boot-time version check
client/src/main.tsx                            # awaits checkAppVersion before render
client/src/components/admin/DiagnosticsFooter.tsx  # admin visibility
client/src/pages/admin.tsx                     # mounts the footer
docs/cache-invalidation.md                     # this document
```

## 8. What this system explicitly does NOT do

- Does not modify the HR engine, scoring, calibration, thresholds, confidence
  ceilings, or volatility suppression in any way.
- Does not modify Stripe billing, webhook processing, or subscription state
  resolution.
- Does not modify session cookies, authentication logic, or password reset
  flows.
- Does not change the React Query default config (`staleTime: Infinity` on
  the global default is unchanged — it was already in place; auth queries
  already opt in to `staleTime: 0` per the analysis above).
- Does not unregister the service worker on version mismatch (which would
  break PWA install state). It only clears caches and reloads.
