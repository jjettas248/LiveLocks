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
import cron from "node-cron";
import { db } from "./db";
import { users } from "@shared/schema";
import { and, between, isNull, eq, gte, lte } from "drizzle-orm";
import {
  sendWelcomeEmail,
  sendHowToEmail,
  sendNudgeEmail,
  sendWallEmail,
  sendWinbackEmail,
  sendProWelcomeEmail,
  sendAllSportsWelcomeEmail,
  sendVerificationEmail,
  sendPaymentIssueEmail,
} from "./email";

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
  if (!process.env.RESEND_API_KEY) {
    console.warn("[email] WARNING: RESEND_API_KEY is missing — no emails will be sent. Configure it in environment secrets and verify the sending domain team@livelocksai.app is set up in Resend.");
  }

  // Backfill: mark pre-existing users as email-verified so they are not blocked
  // by the new emailVerified gate. Only affects users created before this feature.
  try {
    const backfillResult = await db
      .update(users)
      .set({ emailVerified: true })
      .where(and(eq(users.emailVerified, false), isNull(users.emailVerificationToken)));
    console.log("[startup] Legacy user email-verified backfill complete");
  } catch (err: any) {
    console.warn("[startup] Legacy user backfill skipped:", err.message);
  }

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

  if (process.env.NODE_ENV !== "production") {
    app.get("/api/test-email", async (req: Request, res: Response) => {
      const type = req.query.type as string;
      const to = req.query.to as string;

      if (!type || !to) {
        return res.status(400).json({ success: false, error: "Missing 'type' or 'to' query params" });
      }

      try {
        switch (type) {
          case "welcome":
            await sendWelcomeEmail(to);
            break;
          case "howto":
            await sendHowToEmail(to);
            break;
          case "nudge":
            await sendNudgeEmail(to, 7, 8);
            break;
          case "wall":
            await sendWallEmail(to);
            break;
          case "winback":
            await sendWinbackEmail(to);
            break;
          case "pro":
            await sendProWelcomeEmail(to);
            break;
          case "allsports":
            await sendAllSportsWelcomeEmail(to);
            break;
          case "verify":
            await sendVerificationEmail(to, "test-token-12345");
            break;
          case "payment_issue":
            await sendPaymentIssueEmail(to);
            break;
          default:
            return res.status(400).json({ success: false, error: `Unknown email type: ${type}` });
        }
        return res.json({ success: true, type });
      } catch (err: any) {
        return res.status(500).json({ success: false, error: err.message });
      }
    });
  }

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

  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        const now = new Date();

        const fourDaysAgo = new Date(now);
        fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
        const threeDaysAgo = new Date(now);
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        const nudgeUsers = await db
          .select()
          .from(users)
          .where(
            and(
              isNull(users.subscriptionTier),
              between(users.createdAt, fourDaysAgo, threeDaysAgo),
              gte(users.playsUsed, 1),
              lte(users.playsUsed, 14)
            )
          );

        for (const user of nudgeUsers) {
          sendNudgeEmail(user.email, user.playsUsed, 15 - user.playsUsed).catch((err: any) => {
            console.error(`[cron] Failed to send nudge email to ${user.email}:`, err.message);
          });
        }

        const fifteenDaysAgo = new Date(now);
        fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
        const fourteenDaysAgo = new Date(now);
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

        const winbackUsers = await db
          .select()
          .from(users)
          .where(
            and(
              isNull(users.subscriptionTier),
              between(users.createdAt, fifteenDaysAgo, fourteenDaysAgo),
              eq(users.playsUsed, 0)
            )
          );

        for (const user of winbackUsers) {
          sendWinbackEmail(user.email).catch((err: any) => {
            console.error(`[cron] Failed to send winback email to ${user.email}:`, err.message);
          });
        }

        console.log(`[cron] Daily email job complete: ${nudgeUsers.length} nudge, ${winbackUsers.length} winback`);
      } catch (err: any) {
        console.error("[cron] Daily email job failed:", err.message);
      }
    },
    { timezone: "America/New_York" }
  );

  // Daily cleanup: remove unverified accounts older than 24 hours.
  // Strategy: hard-delete. Unverified users are blocked from plays (requirePlayAccess)
  // so they cannot accumulate meaningful dependent rows. The only FK (sent_alerts.user_id)
  // is cleaned up first inside deleteUnverifiedOlderThan.
  cron.schedule(
    "30 3 * * *",
    async () => {
      try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const removed = await storage.deleteUnverifiedOlderThan(cutoff);
        if (removed > 0) {
          console.log(`[cron] Cleaned up ${removed} unverified accounts older than 24h`);
        }
      } catch (err: any) {
        console.error("[cron] Unverified account cleanup failed:", err.message);
      }
    },
    { timezone: "America/New_York" }
  );
})();
