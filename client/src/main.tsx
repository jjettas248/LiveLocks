import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { checkAppVersion } from "./lib/versionCheck";

async function boot() {
  await checkAppVersion();
  createRoot(document.getElementById("root")!).render(<App />);
}

boot();

if ("serviceWorker" in navigator) {
  let refreshing = false;

  const promptUpdate = (worker: ServiceWorker) => {
    worker.postMessage({ type: "SKIP_WAITING" });
  };

  // Phase 7 — PWA Stabilization. Surface SW lifecycle / cache /
  // notification-routing diagnostics in the page console under
  // [LL_PWA_*] / [LL_NOTIFICATION_ROUTE] tags. Pure observation; the SW
  // already broadcasts the events.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "LL_PWA_REFRESH") {
      try { console.log("[LL_PWA_REFRESH]", msg.payload); } catch {}
    } else if (msg.type === "LL_PWA_CACHE_INVALIDATE") {
      try { console.log("[LL_PWA_CACHE_INVALIDATE]", msg.payload); } catch {}
    } else if (msg.type === "LL_NOTIFICATION_ROUTE") {
      try { console.log("[LL_NOTIFICATION_ROUTE]", msg.payload); } catch {}
    }
  });

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");

      if (reg.waiting && navigator.serviceWorker.controller) {
        promptUpdate(reg.waiting);
      }

      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            promptUpdate(newWorker);
          }
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        try { console.log("[LL_PWA_REFRESH]", { trigger: "controllerchange" }); } catch {}
        window.location.reload();
      });

      setInterval(() => {
        reg.update().catch(() => {});
      }, 5 * 60 * 1000);

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          reg.update().catch(() => {});
        }
      });
    } catch {}
  });
}
