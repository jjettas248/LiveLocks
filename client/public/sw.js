const CACHE_NAME = "livelocks-v6";
const APP_SHELL = ["/", "/index.html", "/favicon.png", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
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
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data && event.data.type === "CHECK_UPDATE") {
    self.registration.update().catch(() => {});
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
