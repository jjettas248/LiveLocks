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
  }

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
