const APP_VERSION = "__APP_VERSION__";
const CACHE_NAME = `livelocks-${APP_VERSION}`;
const APP_SHELL = ["/", "/index.html", "/favicon.png", "/manifest.json"];

// Phase 7 — PWA Stabilization. Diagnostic helper that broadcasts a
// `[LL_PWA_*]` style log payload to all controlled clients so the page
// console reflects service-worker lifecycle events without requiring
// chrome://serviceworker-internals.
function broadcast(type, payload) {
  try {
    self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((list) => {
      for (const client of list) {
        try { client.postMessage({ type, payload }); } catch {}
      }
    });
  } catch {}
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const stale = keys.filter((k) => k !== CACHE_NAME);
      if (stale.length > 0) {
        broadcast("LL_PWA_CACHE_INVALIDATE", { removed: stale, kept: CACHE_NAME, version: APP_VERSION });
      }
      return Promise.all(stale.map((k) => caches.delete(k)));
    })
  );
  self.clients.claim();
  broadcast("LL_PWA_REFRESH", { version: APP_VERSION, cacheName: CACHE_NAME, ts: Date.now() });
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API responses are NEVER cached — live signals must be fresh.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match("/index.html").then((c) => c || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((response) => {
        if (response && response.status === 200 && response.type !== "opaque") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data.type === "GET_VERSION") {
    const payload = { type: "SW_VERSION", version: APP_VERSION, cacheName: CACHE_NAME };
    if (event.ports && event.ports[0]) {
      try { event.ports[0].postMessage(payload); } catch {}
      return;
    }
    self.clients.matchAll({ includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        try { client.postMessage(payload); } catch {}
      }
    });
  }
});

self.addEventListener("push", (event) => {
  let payload = { title: "LiveLocks", body: "New alert", url: "/", data: {} };
  try {
    payload = event.data ? event.data.json() : payload;
  } catch {}

  const deepData = payload.data ?? {};

  const options = {
    body: payload.body,
    icon: "/favicon.png",
    badge: "/favicon.png",
    data: {
      url: payload.url ?? "/",
      ...deepData,
    },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options).then(() => {
      return self.clients.matchAll({ type: "window" }).then((clients) => {
        for (const client of clients) {
          client.postMessage({
            type: "ALERT_RECEIVED",
            payload: {
              title: payload.title,
              body: payload.body,
              ...deepData,
            },
          });
        }
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const data = event.notification.data || {};

  const params = new URLSearchParams();
  if (data.tab) params.set("tab", data.tab);
  if (data.gameId) params.set("gameId", data.gameId);
  if (data.playerId) params.set("playerId", data.playerId);
  if (data.cardType) params.set("cardType", data.cardType);
  if (data.trigger) params.set("trigger", data.trigger);

  const targetUrl = params.toString() ? `/?${params.toString()}` : "/";

  // Phase 7 — emit a routing diagnostic so the client can log
  // `[LL_NOTIFICATION_ROUTE]` consistently regardless of whether an
  // existing window was focused or a new one was opened.
  broadcast("LL_NOTIFICATION_ROUTE", { targetUrl, data, ts: Date.now() });

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus();
          client.postMessage({ type: "NOTIFICATION_NAVIGATE", data });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
