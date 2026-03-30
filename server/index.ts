import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import { registerRoutes, registerAnalyticsRoutes, registerPlaysRoutes, registerTestAlertRoute, registerCalibrationRoutes } from "./routes";
import { liveOrchestrator } from "./mlb/liveGameOrchestrator";
import { autoResolveAlerts } from "./analyticsResolver";
import { gradePersistedPlays } from "./services/gradePersistedPlays";
import { storage } from "./storage";
import { serveStatic } from "./static";
import { createServer } from "http";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripeClient";
import cron from "node-cron";
import { db, pool } from "./db";
import { users } from "@shared/schema";
import { and, isNull, eq, gte, lte, sql } from "drizzle-orm";
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

  // Schema migration: add email-verification columns if they don't exist yet.
  // Safe to run on every startup — uses IF NOT EXISTS so it's a no-op once applied.
  try {
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS email_verification_token text,
        ADD COLUMN IF NOT EXISTS original_email text,
        ADD COLUMN IF NOT EXISTS normalized_email text,
        ADD COLUMN IF NOT EXISTS signup_fingerprint text,
        ADD COLUMN IF NOT EXISTS verification_last_sent_at timestamp;
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_normalized_email_unique ON users(normalized_email);
    `);
    console.log("[startup] Schema migration: email-verification columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning:", err.message);
  }

  // Schema migration: add daily-play-reset columns (Task #66) if they don't exist yet.
  try {
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS plays_used_today integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS plays_reset_date text,
        ADD COLUMN IF NOT EXISTS unlocked_game_ids_today text NOT NULL DEFAULT '[]';
    `);
    console.log("[startup] Schema migration: daily-plays columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (daily-plays):", err.message);
  }

  // Schema migration: add espn_athlete_id to players table (Task #83) if it doesn't exist yet.
  try {
    await pool.query(`
      ALTER TABLE players
        ADD COLUMN IF NOT EXISTS espn_athlete_id integer;
    `);
    console.log("[startup] Schema migration: espn_athlete_id column ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (espn-athlete-id):", err.message);
  }

  // Schema migration: create stripe_events idempotency table if it doesn't exist.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    console.log("[startup] Schema migration: stripe_events table ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (stripe-events):", err.message);
  }

  // Schema migration: add engine_version to persisted_plays table (Task #100) if it doesn't exist yet.
  try {
    await pool.query(`
      ALTER TABLE persisted_plays
        ADD COLUMN IF NOT EXISTS engine_version text;
    `);
    console.log("[startup] Schema migration: engine_version column ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (engine-version):", err.message);
  }

  // Schema migration: add projection/sportsbook/derived_line to persisted_plays (Task #97)
  try {
    await pool.query(`
      ALTER TABLE persisted_plays
        ADD COLUMN IF NOT EXISTS projection numeric,
        ADD COLUMN IF NOT EXISTS sportsbook text,
        ADD COLUMN IF NOT EXISTS derived_line boolean;
    `);
    console.log("[startup] Schema migration: persisted_plays signal snapshot columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (persisted-plays-snapshot):", err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE persisted_plays
        ADD COLUMN IF NOT EXISTS market_type text,
        ADD COLUMN IF NOT EXISTS final_prob_over numeric,
        ADD COLUMN IF NOT EXISTS final_prob_under numeric,
        ADD COLUMN IF NOT EXISTS display_confidence numeric,
        ADD COLUMN IF NOT EXISTS player_volatility_score numeric,
        ADD COLUMN IF NOT EXISTS combo_covariance_estimate numeric,
        ADD COLUMN IF NOT EXISTS fragility_penalty numeric,
        ADD COLUMN IF NOT EXISTS fragility_reasons text;
    `);
    console.log("[startup] Schema migration: persisted_plays full diagnostics columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (full-diagnostics):", err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS churned_at timestamp,
        ADD COLUMN IF NOT EXISTS churned_from_tier text;
    `);
    console.log("[startup] Schema migration: churn tracking columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (churn-tracking):", err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS reset_password_token text,
        ADD COLUMN IF NOT EXISTS reset_password_expiry timestamp;
    `);
    console.log("[startup] Schema migration: password reset columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (password-reset):", err.message);
  }

  // Backfill: mark pre-existing users (no verification token) as email-verified
  // so they are not locked out by the new emailVerified gate.
  try {
    await db
      .update(users)
      .set({ emailVerified: true, normalizedEmail: sql`LOWER(TRIM(${users.email}))` })
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
  registerCalibrationRoutes(app);

  // Start MLB live game orchestrator (Phase A — admin-only, fire-and-forget)
  liveOrchestrator.start();

  // Remove duplicate plays and alerts once on startup (fire-and-forget)
  storage.cleanDuplicatePlays().then(r => { if (r.removed > 0) console.log(`[startup] Cleaned ${r.removed} duplicate persisted plays`); }).catch(console.warn);
  storage.cleanDuplicateAlerts().then(r => { if (r.removed > 0) console.log(`[startup] Cleaned ${r.removed} duplicate halftime alerts`); }).catch(console.warn);

  // Auto-resolve halftime alerts every 60 minutes; run once after 5 min delay on startup
  setTimeout(() => autoResolveAlerts(storage).catch(console.warn), 5 * 60 * 1000);
  setInterval(() => autoResolveAlerts(storage).catch(console.warn), 60 * 60 * 1000);

  // Grade persisted plays every 3 minutes; run once after 2 min delay on startup
  setTimeout(() => gradePersistedPlays(storage).catch(console.warn), 2 * 60 * 1000);
  setInterval(() => gradePersistedPlays(storage).catch(console.warn), 3 * 60 * 1000);

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

  // ─── Email lifecycle: backfill → blast → 15-min cron ───────────────────────

  async function runEmailFlagBackfill(): Promise<void> {
    const now = new Date();
    const h24 = now.getTime() - 24 * 60 * 60 * 1000;
    const h12 = now.getTime() - 12 * 60 * 60 * 1000;

    // Only silence welcome/walkthrough — these were already handled by the old email flow.
    // sentDay3 and sentWinback are intentionally NOT backfilled so the cron can send them.
    const rWelcome     = await db.update(users).set({ sentWelcome: true })
      .where(and(eq(users.emailVerified, true), eq(users.sentWelcome, false), lte(users.createdAt, new Date(h24))))
      .returning({ id: users.id });
    const rWalkthrough = await db.update(users).set({ sentWalkthrough: true })
      .where(and(eq(users.emailVerified, true), eq(users.sentWalkthrough, false), lte(users.createdAt, new Date(h12))))
      .returning({ id: users.id });
    const rPro         = await db.update(users).set({ sentProWelcome: true })
      .where(and(eq(users.subscriptionTier, "all"), eq(users.sentProWelcome, false)))
      .returning({ id: users.id });
    const rAllSports   = await db.update(users).set({ sentAllSportsWelcome: true })
      .where(and(eq(users.subscriptionTier, "elite"), eq(users.sentAllSportsWelcome, false)))
      .returning({ id: users.id });

    console.log(`[email-backfill] Complete — welcome:${rWelcome.length} walkthrough:${rWalkthrough.length} proWelcome:${rPro.length} allSportsWelcome:${rAllSports.length} rows updated`);
  }

  // One-time correction: DISABLED — this was resetting sentDay3/sentWinback on every restart,
  // causing those emails to be re-sent repeatedly. The correction was applied successfully
  // and should not run again.
  async function runEmailFlagCorrection(): Promise<void> {
    console.log("[email-correction] Skipped — one-time correction already applied");
  }

  async function runWallHitBlast(): Promise<void> {
    console.log("[startup blast] Checking for eligible wall-hit users...");
    const eligible = await db
      .select()
      .from(users)
      .where(
        and(
          isNull(users.subscriptionTier),
          eq(users.emailVerified, true),
          eq(users.sentWall, false),
          gte(users.playsUsed, 3)
        )
      );

    console.log(`[startup blast] Found ${eligible.length} eligible users`);
    let sent = 0;
    for (const user of eligible) {
      try {
        await sendWallEmail(user.email);
        await storage.updateUserEmailFlags(user.id, { sentWall: true });
        console.log(`[startup blast] user ${user.id} — wall sent`);
        sent++;
      } catch (err: any) {
        console.error(`[startup blast] user ${user.id} — wall failed: ${err.message}`);
      }
    }
    console.log(`[startup blast] Complete — ${sent}/${eligible.length} sent`);
  }

  const FREE_PLAY_LIMIT = 3;

  async function runLifecycleCron(): Promise<void> {
    console.log("[email-cron] Starting lifecycle cycle");
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const h12 = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const d3  = new Date(now.getTime() - 3  * 24 * 60 * 60 * 1000);
    const d7  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);

    const allVerified = await db.select().from(users).where(eq(users.emailVerified, true));

    const counts = { welcome: 0, walkthrough: 0, day3: 0, winback: 0, wall: 0, proWelcome: 0, allSportsWelcome: 0 };

    async function claimAndSend(
      userId: number,
      email: string,
      flagKey: string,
      sendFn: () => Promise<any>,
      label: string
    ): Promise<boolean> {
      const flagObj: Record<string, boolean> = { [flagKey]: true };
      await storage.updateUserEmailFlags(userId, flagObj as any);
      try {
        await sendFn();
        console.log(`[email-cron] user ${userId} — ${label} sent`);
        return true;
      } catch (err: any) {
        await storage.updateUserEmailFlags(userId, { [flagKey]: false } as any).catch(() => {});
        console.error(`[email-cron] user ${userId} — ${label} failed (flag rolled back): ${err.message}`);
        return false;
      }
    }

    for (const user of allVerified) {
      if (user.subscriptionTier === "all" && !user.sentProWelcome) {
        const fresh = await storage.getUserById(user.id);
        if (fresh && !fresh.sentProWelcome && fresh.subscriptionTier === "all") {
          if (await claimAndSend(user.id, user.email, "sentProWelcome", () => sendProWelcomeEmail(user.email), "proWelcome")) counts.proWelcome++;
        }
        continue;
      }

      if (user.subscriptionTier === "elite" && !user.sentAllSportsWelcome) {
        const fresh = await storage.getUserById(user.id);
        if (fresh && !fresh.sentAllSportsWelcome && fresh.subscriptionTier === "elite") {
          if (await claimAndSend(user.id, user.email, "sentAllSportsWelcome", () => sendAllSportsWelcomeEmail(user.email), "allSportsWelcome")) counts.allSportsWelcome++;
        }
        continue;
      }

      if (user.subscriptionTier !== null) continue;

      try {
        const createdAt = user.createdAt ? new Date(user.createdAt) : null;

        if (!user.sentWelcome) {
          const fresh = await storage.getUserById(user.id);
          if (fresh && !fresh.sentWelcome) {
            if (await claimAndSend(user.id, user.email, "sentWelcome", () => sendWelcomeEmail(user.email), "welcome")) counts.welcome++;
          }
          continue;
        }

        if (!user.sentWalkthrough && user.playsUsed === 0 && createdAt && createdAt <= h12) {
          if (await claimAndSend(user.id, user.email, "sentWalkthrough", () => sendHowToEmail(user.email), "walkthrough")) counts.walkthrough++;
          continue;
        }

        if (!user.sentDay3 && user.playsUsed >= 1 && user.playsUsed < FREE_PLAY_LIMIT && createdAt && createdAt <= d3) {
          if (await claimAndSend(user.id, user.email, "sentDay3", () => sendNudgeEmail(user.email, user.playsUsed, FREE_PLAY_LIMIT - user.playsUsed), "day3")) counts.day3++;
          continue;
        }

        if (!user.sentWinback && user.playsUsed === 0 && createdAt && createdAt <= d7) {
          if (await claimAndSend(user.id, user.email, "sentWinback", () => sendWinbackEmail(user.email), "winback")) counts.winback++;
          continue;
        }

        if (!user.sentWall && user.playsUsed >= FREE_PLAY_LIMIT) {
          if (await claimAndSend(user.id, user.email, "sentWall", () => sendWallEmail(user.email), "wall")) counts.wall++;
          continue;
        }

      } catch (err: any) {
        console.error(`[email-cron] user ${user.id} — cycle error: ${err.message}`);
      }
    }

    console.log(`[email-cron] Cycle complete — welcome:${counts.welcome} walkthrough:${counts.walkthrough} day3:${counts.day3} winback:${counts.winback} wall:${counts.wall} proWelcome:${counts.proWelcome} allSportsWelcome:${counts.allSportsWelcome}`);
  }

  // Startup sequence: backfill → blast → schedule 15-min lifecycle cron
  (async () => {
    try { await runEmailFlagBackfill(); } catch (e: any) { console.error("[email-backfill] failed:", e.message); }
    try { await runEmailFlagCorrection(); } catch (e: any) { console.error("[email-correction] failed:", e.message); }
    try { await runWallHitBlast(); } catch (e: any) { console.error("[startup blast] failed:", e.message); }
    cron.schedule("*/15 * * * *", () => runLifecycleCron().catch(console.error), { timezone: "America/New_York" });
    console.log("[email-cron] Lifecycle cron scheduled (*/15)");
  })();

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
})().catch((err: any) => {
  console.error("[startup] Fatal unhandled error — process will exit:", err.message, err.stack);
  process.exit(1);
});
