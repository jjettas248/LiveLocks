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

  const doReload = () => {
    if (refreshing) return;
    refreshing = true;
    try { console.log("[LL_PWA_REFRESH]", { trigger: "controllerchange" }); } catch {}
    window.location.reload();
  };

  // A new build activated. Reloading immediately would interrupt a user mid-action
  // (typing in the calculator, reviewing a slip). If the tab is hidden, reload
  // silently. If it's visible, surface a non-blocking banner and reload on the
  // user's terms — or automatically the next time they navigate away.
  const showUpdateBanner = () => {
    if (document.getElementById("ll-update-banner")) return;
    const banner = document.createElement("div");
    banner.id = "ll-update-banner";
    banner.setAttribute("role", "status");
    banner.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:max(16px,env(safe-area-inset-bottom,16px));" +
      "z-index:2147483647;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;" +
      "background:#111118;color:#fff;border:1px solid #2a2a35;box-shadow:0 8px 24px rgba(0,0,0,.45);" +
      "font:500 13px/1.2 system-ui,-apple-system,sans-serif;max-width:92vw;";
    const label = document.createElement("span");
    label.textContent = "New version available";
    const btn = document.createElement("button");
    btn.textContent = "Refresh";
    btn.style.cssText =
      "appearance:none;border:0;border-radius:8px;padding:6px 12px;background:#3b82f6;color:#fff;" +
      "font:600 13px system-ui,sans-serif;cursor:pointer;";
    btn.onclick = doReload;
    banner.appendChild(label);
    banner.appendChild(btn);
    document.body.appendChild(banner);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") doReload();
    });
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
        if (document.visibilityState === "hidden") {
          doReload();
        } else {
          showUpdateBanner();
        }
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
