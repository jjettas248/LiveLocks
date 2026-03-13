import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import { registerRoutes, registerAnalyticsRoutes, registerPlaysRoutes, registerTestAlertRoute } from "./routes";
import { liveOrchestrator } from "./mlb/liveGameOrchestrator";
import { autoResolveAlerts } from "./analyticsResolver";
import { storage } from "./storage";
import { serveStatic } from "./static";
import { createServer } from "http";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripeClient";

const app = express();
const httpServer = createServer(app);

app.set("trust proxy", 1);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[stripe] DATABASE_URL not set, skipping Stripe init");
    return;
  }
  try {
    console.log("[stripe] Running migrations...");
    await runMigrations({ databaseUrl });
    console.log("[stripe] Migrations done");

    const stripeSync = await getStripeSync();

    const domains = process.env.REPLIT_DOMAINS?.split(",")[0];
    if (domains) {
      const webhookBaseUrl = `https://${domains}`;
      await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
      console.log("[stripe] Webhook configured");
    }

    stripeSync.syncBackfill()
      .then(() => console.log("[stripe] Backfill complete"))
      .catch((err: any) => console.error("[stripe] Backfill error:", err.message));
  } catch (err: any) {
    console.warn("[stripe] Init warning (non-fatal):", err.message);
  }
}

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) return res.status(400).json({ error: "Missing stripe-signature" });

    try {
      const { WebhookHandlers } = await import("./webhookHandlers");
      const sig = Array.isArray(signature) ? signature[0] : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("[stripe] Webhook error:", err.message);
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

const PgSession = connectPgSimple(session);
const pgPool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : undefined;

app.use(
  session({
    store: pgPool
      ? new PgSession({ pool: pgPool, tableName: "user_sessions", createTableIfMissing: true })
      : undefined,
    secret: process.env.SESSION_SECRET || "livelocks-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: !!process.env.REPLIT_DOMAINS || process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: (!!process.env.REPLIT_DOMAINS || process.env.NODE_ENV === "production") ? "none" : "lax",
    },
  })
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Health endpoint — must respond before slow startup tasks complete
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await initStripe();
  await registerRoutes(httpServer, app);
  registerAnalyticsRoutes(app);
  registerPlaysRoutes(app);
  registerTestAlertRoute(app);

  // Start MLB live game orchestrator (Phase A — admin-only, fire-and-forget)
  liveOrchestrator.start();

  // Remove duplicate plays and alerts once on startup (fire-and-forget)
  storage.cleanDuplicatePlays().then(r => { if (r.removed > 0) console.log(`[startup] Cleaned ${r.removed} duplicate persisted plays`); }).catch(console.warn);
  storage.cleanDuplicateAlerts().then(r => { if (r.removed > 0) console.log(`[startup] Cleaned ${r.removed} duplicate halftime alerts`); }).catch(console.warn);

  // Auto-resolve plays in background every 60 minutes; run once after 5 min delay on startup
  setTimeout(() => autoResolveAlerts(storage).catch(console.warn), 5 * 60 * 1000);
  setInterval(() => autoResolveAlerts(storage).catch(console.warn), 60 * 60 * 1000);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
