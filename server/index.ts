import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool as dbPool } from "./db";
import { registerRoutes, registerAnalyticsRoutes, registerPlaysRoutes, registerTestAlertRoute, registerCalibrationRoutes, registerPerformanceRoutes } from "./routes";
import { liveOrchestrator } from "./mlb/liveGameOrchestrator";
import { updatePlayerPool, updateTeamRosters, getPlayerPoolCount } from "./mlb/rosterService";
import { autoResolveAlerts } from "./analyticsResolver";
import { gradePersistedPlays } from "./services/gradePersistedPlays";
import { storage } from "./storage";
import { serveStatic } from "./static";
import { registerSwHandler } from "./swHandler";
import { getAppVersion } from "./version";
import { createServer } from "http";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
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

    const domains = process.env.REPLIT_DOMAINS?.split(",")[0] || process.env.RAILWAY_PUBLIC_DOMAIN;
    if (domains) {
      const webhookBaseUrl = `https://${domains}`;
      await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
      console.log("[stripe] Webhook configured");
    } else {
      console.log("[stripe] No public domain env var found — register the webhook manually in the Stripe Dashboard (see PRD.md)");
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

// Sessions persist in Postgres (connect-pg-simple → "user_sessions" table)
// so they survive server restarts/redeploys. Reuses the shared ORM pool from
// ./db rather than opening a second connection pool to the same database.
// db.ts throws at import time when DATABASE_URL is missing, so the pool here
// is always present.
const PgSession = connectPgSimple(session);

// Fail fast if SESSION_SECRET is missing in production: falling back to a
// hardcoded, publicly-known secret would let anyone forge signed session
// cookies. Dev keeps the convenience fallback (with a warning) so local
// boots don't require the secret.
const isProduction = !!process.env.REPLIT_DOMAINS || process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && !sessionSecret) {
  throw new Error(
    "SESSION_SECRET must be set in production. Refusing to start with the public dev fallback secret.",
  );
}
if (!isProduction && !sessionSecret) {
  console.warn("[session] SESSION_SECRET not set — using insecure dev fallback (development only).");
}

app.use(
  session({
    store: new PgSession({ pool: dbPool, tableName: "user_sessions", createTableIfMissing: true }),
    secret: sessionSecret || "livelocks-dev-secret",
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

// Lightweight visitor cookie for attribution tracking. Sets an httpOnly
// `lv_visitor` UUID cookie when missing. Never blocks the request.
import { ensureVisitorCookie } from "./services/attributionService";
app.use(ensureVisitorCookie);

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
      ALTER TABLE persisted_plays
        ADD COLUMN IF NOT EXISTS mu numeric,
        ADD COLUMN IF NOT EXISTS sigma numeric,
        ADD COLUMN IF NOT EXISTS z_score numeric;
    `);
    console.log("[startup] Schema migration: persisted_plays mu/sigma/zScore columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (full-diagnostics):", err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE persisted_plays
        ADD COLUMN IF NOT EXISTS signal_score numeric,
        ADD COLUMN IF NOT EXISTS opportunity_score numeric,
        ADD COLUMN IF NOT EXISTS live_score numeric,
        ADD COLUMN IF NOT EXISTS event_boost numeric;
    `);
    console.log("[startup] Schema migration: persisted_plays live opportunity columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (live-opportunity):", err.message);
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

  // Schema migration: HR Radar Phase 0 diagnostic columns (2026-06).
  // These columns were added to shared/schema.ts (commit 9d3c554) and are
  // SELECTed by storage.getHrRadarLadder. If the live DB hasn't had
  // `drizzle-kit push` run against it, every ladder query throws
  // ("column does not exist") and the radar silently serves its empty error
  // fallback — i.e. the radar goes dark even with live games. All columns are
  // additive/nullable, so this IF NOT EXISTS block is a safe no-op once applied.
  // Mirrors migrations/0004_hr_radar_phase0_diagnostics.sql.
  try {
    await pool.query(`
      ALTER TABLE hr_radar_alerts
        ADD COLUMN IF NOT EXISTS raw_pre_cap_score numeric,
        ADD COLUMN IF NOT EXISTS final_score numeric,
        ADD COLUMN IF NOT EXISTS cap_reason text,
        ADD COLUMN IF NOT EXISTS suppression_reason text,
        ADD COLUMN IF NOT EXISTS missing_inputs text[],
        ADD COLUMN IF NOT EXISTS confidence numeric,
        ADD COLUMN IF NOT EXISTS data_quality_flags text[],
        ADD COLUMN IF NOT EXISTS first_seen_at timestamp,
        ADD COLUMN IF NOT EXISTS promoted_at timestamp,
        ADD COLUMN IF NOT EXISTS alert_sent_at timestamp,
        ADD COLUMN IF NOT EXISTS analytics_persisted boolean NOT NULL DEFAULT false;
    `);
    console.log("[startup] Schema migration: hr_radar_alerts Phase 0 diagnostic columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (hr-radar-phase0):", err.message);
  }

  // Schema migration: attribution / conversion tracking (Task #143).
  // Two strictly additive tables — does NOT modify the users table.
  // Idempotent CREATE IF NOT EXISTS; safe to re-run on every boot.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attribution_visits (
        id SERIAL PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        ref TEXT,
        landing_path TEXT,
        referer_host TEXT,
        user_agent_hash TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS attribution_visits_visitor_idx ON attribution_visits(visitor_id);
      CREATE INDEX IF NOT EXISTS attribution_visits_source_idx ON attribution_visits(utm_source);
      CREATE INDEX IF NOT EXISTS attribution_visits_created_at_idx ON attribution_visits(created_at);

      CREATE TABLE IF NOT EXISTS user_attribution (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE,
        visitor_id TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        ref TEXT,
        landing_path TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS user_attribution_user_idx ON user_attribution(user_id);
      CREATE INDEX IF NOT EXISTS user_attribution_source_idx ON user_attribution(utm_source);
    `);
    console.log("[startup] Schema migration: attribution tables ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (attribution):", err.message);
  }

  // Schema migration: lifecycle / alerts-channel / telegram columns (Pass 2 — additive only,
  // all nullable, does NOT reinterpret existing subscriptionTier / entitlement gates).
  try {
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS subscription_status text,
        ADD COLUMN IF NOT EXISTS subscription_source text,
        ADD COLUMN IF NOT EXISTS trial_started_at timestamp,
        ADD COLUMN IF NOT EXISTS trial_ends_at timestamp,
        ADD COLUMN IF NOT EXISTS converted_to_paid_at timestamp,
        ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean,
        ADD COLUMN IF NOT EXISTS trial_abandoned_at timestamp,
        ADD COLUMN IF NOT EXISTS alerts_channel_status text,
        ADD COLUMN IF NOT EXISTS telegram_chat_id text,
        ADD COLUMN IF NOT EXISTS telegram_username text,
        ADD COLUMN IF NOT EXISTS telegram_connected_at timestamp,
        ADD COLUMN IF NOT EXISTS telegram_connection_status text;
    `);
    console.log("[startup] Schema migration: lifecycle columns ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (lifecycle):", err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_login_at timestamp;
    `);
    console.log("[startup] Schema migration: last_login_at column ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (last_login_at):", err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hr_outcomes (
        id SERIAL PRIMARY KEY,
        season INTEGER NOT NULL DEFAULT 2026,
        game_date TEXT NOT NULL,
        batter_name TEXT NOT NULL,
        batter_team TEXT NOT NULL,
        batter_mlb_id TEXT,
        hr_number INTEGER NOT NULL DEFAULT 1,
        runners_on_base INTEGER NOT NULL DEFAULT 0,
        inning INTEGER,
        outs INTEGER,
        launch_angle NUMERIC,
        exit_velocity NUMERIC,
        distance NUMERIC,
        pitch_type TEXT,
        pitcher_name TEXT,
        ballpark TEXT,
        source TEXT NOT NULL DEFAULT 'onlyhomers',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS hr_hot_hitters (
        id SERIAL PRIMARY KEY,
        player_name TEXT NOT NULL,
        team TEXT NOT NULL,
        hr_count INTEGER NOT NULL,
        period TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS hr_ballpark_factors (
        id SERIAL PRIMARY KEY,
        season INTEGER NOT NULL DEFAULT 2026,
        ballpark TEXT NOT NULL,
        hr_count INTEGER NOT NULL DEFAULT 0,
        snapshot_date TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hr_outcomes_dedup_idx ON hr_outcomes(season, game_date, batter_name, hr_number);
      CREATE UNIQUE INDEX IF NOT EXISTS hr_hot_hitters_dedup_idx ON hr_hot_hitters(player_name, period, snapshot_date);
      CREATE UNIQUE INDEX IF NOT EXISTS hr_ballpark_factors_dedup_idx ON hr_ballpark_factors(season, ballpark, snapshot_date);
    `);
    console.log("[startup] Schema migration: OnlyHomers tables ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (onlyhomers):", err.message);
  }

  // Schema migration: nightly batter rolling stat snapshots (Task #129)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batter_rolling_snapshots (
        id SERIAL PRIMARY KEY,
        player_id TEXT NOT NULL,
        player_name TEXT,
        session_date TEXT NOT NULL,
        season INTEGER,
        season_hr_rate NUMERIC,
        hr_rate_last_30 NUMERIC,
        barrel_rate NUMERIC,
        is_hot_hitter BOOLEAN NOT NULL DEFAULT false,
        source TEXT NOT NULL DEFAULT 'nightly_cron',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS batter_rolling_snapshots_dedup_idx
        ON batter_rolling_snapshots(player_id, session_date);
      CREATE INDEX IF NOT EXISTS batter_rolling_snapshots_session_date_idx
        ON batter_rolling_snapshots(session_date);
    `);
    console.log("[startup] Schema migration: batter_rolling_snapshots table ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (batter-rolling-snapshots):", err.message);
  }

  // Schema migration: free-user activation rail analytics (Task #134)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rail_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        event_type TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'free_activation_rail',
        exhausted BOOLEAN,
        plays_used_today INTEGER,
        plays_limit INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS rail_events_event_type_idx ON rail_events(event_type);
      CREATE INDEX IF NOT EXISTS rail_events_created_at_idx ON rail_events(created_at);
    `);
    console.log("[startup] Schema migration: rail_events table ensured");
  } catch (err: any) {
    console.warn("[startup] Schema migration warning (rail-events):", err.message);
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

  // Backfill: any user that already exists at server start has, by definition,
  // already used the app at least once — mark them as having completed the
  // onboarding tour so it does not fire on their next login. Brand-new
  // signups created AFTER startup will keep the default `false` and see
  // the tour exactly once.
  try {
    const result = await db
      .update(users)
      .set({ hasCompletedOnboarding: true })
      .where(eq(users.hasCompletedOnboarding, false));
    const count = (result as any).rowCount ?? 0;
    console.log(`[startup] Onboarding backfill complete (marked ${count} existing users)`);
  } catch (err: any) {
    console.warn("[startup] Onboarding backfill skipped:", err.message);
  }

  await initStripe();

  // Cache-busting infrastructure: serve /sw.js with version-token substitution
  // and /api/version for client-side mismatch detection. Both must be
  // registered BEFORE vite/static so they take precedence over file-based
  // serving of client/public/sw.js.
  registerSwHandler(app);
  app.get("/api/version", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json({ version: getAppVersion() });
  });

  await registerRoutes(httpServer, app);
  registerAnalyticsRoutes(app);
  registerPlaysRoutes(app);
  registerTestAlertRoute(app);
  registerCalibrationRoutes(app);
  registerPerformanceRoutes(app);

  // Start MLB live game orchestrator (Phase A — admin-only, fire-and-forget)
  liveOrchestrator.start();

  // ── MLB Pre-Game Power Radar — guarded scheduled builds ──────────
  // Additive, confirmed-lineup target radar. NOT a blind all-day cron: an
  // initial slate build runs shortly after boot, then a guarded tick rebuilds
  // only when a game is near first pitch (within ~2h) or no snapshot exists for
  // today. The build is internally concurrency-guarded and fully try/catch'd so
  // it can never crash runtime.
  (async () => {
    try {
      const { buildPregamePowerRadar } = await import(
        "./mlb/pregamePowerRadar/buildPregamePowerRadar"
      );
      const { getSnapshot } = await import(
        "./mlb/pregamePowerRadar/pregamePowerRadarStore"
      );
      const { installPregamePersistence } = await import(
        "./mlb/pregamePowerRadar/pregamePersistence"
      );
      const { slateDateET } = await import("./utils/dateUtils");

      // Wire DB persistence (build sink + DB fallback) before the first build.
      installPregamePersistence();

      // Initial slate build (deferred so rosters/weather can populate first).
      setTimeout(() => {
        buildPregamePowerRadar().catch((e) =>
          console.warn("[PREGAME_POWER_RADAR_BOOT] initial build failed:", e?.message),
        );
      }, 90 * 1000);

      // Guarded 15-min tick.
      setInterval(() => {
        try {
          const snap = getSnapshot();
          const needInitial = !snap || snap.sessionDate !== slateDateET();
          let nearFirstPitch = false;
          if (snap) {
            const now = Date.now();
            for (const s of Array.from(snap.signals.values())) {
              if (s.gameStatus === "live") { nearFirstPitch = true; break; }
              if (!s.startsAt) continue;
              const t = Date.parse(s.startsAt);
              if (Number.isFinite(t) && t - now > 0 && t - now < 2 * 60 * 60 * 1000) {
                nearFirstPitch = true;
                break;
              }
            }
          }
          if (needInitial || nearFirstPitch) {
            buildPregamePowerRadar().catch((e) =>
              console.warn("[PREGAME_POWER_RADAR_TICK] build failed:", e?.message),
            );
          }
        } catch (e) {
          console.warn("[PREGAME_POWER_RADAR_TICK] error:", (e as Error).message);
        }
      }, 15 * 60 * 1000);

      // Shadow-outcome grader + live bridge (Phase 4/5) — read-only on the live
      // engine; writes only to the pre-game track. Every 5 min, try/catch.
      const { gradePregameOutcomes } = await import(
        "./mlb/pregamePowerRadar/shadowOutcomes"
      );
      setInterval(() => {
        gradePregameOutcomes().catch((e) =>
          console.warn("[PREGAME_POWER_RADAR_GRADE] failed:", e?.message),
        );
      }, 5 * 60 * 1000);

      console.log("[PREGAME_POWER_RADAR_BOOT] scheduled builds armed");
    } catch (err) {
      console.warn("[PREGAME_POWER_RADAR_BOOT] failed:", (err as Error).message);
    }
  })();

  // ── MLB Mound Radar — guarded scheduled builds ──────────────────
  // Sibling of the Pre-Game Power Radar block above, independent build/grade
  // intervals and independent try/catch so a Mound failure can never affect
  // Plate (or vice versa).
  (async () => {
    try {
      const { buildMlbMoundRadar } = await import("./mlb/pregame/mound/buildMlbMoundRadar");
      const { getMoundSnapshot } = await import("./mlb/pregame/mound/mlbMoundRadarStore");
      const { installMoundPersistence } = await import("./mlb/pregame/mound/moundPersistence");
      const { slateDateET } = await import("./utils/dateUtils");

      installMoundPersistence();

      setTimeout(() => {
        buildMlbMoundRadar().catch((e) =>
          console.warn("[MLB_PREGAME_MOUND_TARGETS] initial build failed:", e?.message),
        );
      }, 100 * 1000);

      setInterval(() => {
        try {
          const snap = getMoundSnapshot();
          const needInitial = !snap || snap.sessionDate !== slateDateET();
          let nearFirstPitch = false;
          if (snap) {
            const now = Date.now();
            for (const s of Array.from(snap.signals.values())) {
              if (s.gameStatus === "live") { nearFirstPitch = true; break; }
              if (!s.startsAt) continue;
              const t = Date.parse(s.startsAt);
              if (Number.isFinite(t) && t - now > 0 && t - now < 2 * 60 * 60 * 1000) {
                nearFirstPitch = true;
                break;
              }
            }
          }
          if (needInitial || nearFirstPitch) {
            buildMlbMoundRadar().catch((e) =>
              console.warn("[MLB_PREGAME_MOUND_TARGETS] tick build failed:", e?.message),
            );
          }
        } catch (e) {
          console.warn("[MLB_PREGAME_MOUND_TARGETS] tick error:", (e as Error).message);
        }
      }, 15 * 60 * 1000);

      const { gradeMoundOutcomes } = await import("./mlb/pregame/mound/moundShadowOutcomes");
      setInterval(() => {
        gradeMoundOutcomes().catch((e) =>
          console.warn("[MLB_PREGAME_OUTCOME_SETTLED] grade failed:", e?.message),
        );
      }, 5 * 60 * 1000);

      console.log("[MLB_PREGAME_MOUND_TARGETS] scheduled builds armed");
    } catch (err) {
      console.warn("[MLB_PREGAME_MOUND_TARGETS] boot failed:", (err as Error).message);
    }
  })();

  // ── NBA Calibration Backfill — boot-time idempotent run ──────────
  // Tags any pre-cutover NBA plays missing the nbaCalV2 marker so the
  // cohort report classifies them correctly. Idempotent: when the table
  // is fully tagged, the first paginated query returns 0 rows and this
  // returns in ≈0 ms. Runs in the background so it never blocks boot.
  (async () => {
    try {
      const { runNbaCalibrationBackfill } = await import(
        "./scripts/nbaCalibrationBackfill"
      );
      const { tagged, skipped } = await runNbaCalibrationBackfill();
      console.log(
        `[NBA_CAL_BACKFILL_BOOT] tagged=${tagged} skipped=${skipped}`,
      );
    } catch (err) {
      console.warn(
        `[NBA_CAL_BACKFILL_BOOT] failed err=${(err as Error).message}`,
      );
    }
  })();

  // ── LiveLocks Batch B — Lifecycle TTL sweeper ────────────────────
  // Promotes inactive non-terminal CanonicalSignals → expired every 5min.
  // Idempotent; safe even when no signals are tracked yet.
  try {
    const { startTtlSweeper } = await import("./services/lifecycleStore");
    startTtlSweeper();
    console.log("[LL_LIFECYCLE_BOOT] ttl sweeper started");
  } catch (err) {
    console.warn("[LL_LIFECYCLE_BOOT] failed:", (err as Error).message);
  }

  // ── LiveLocks Batch C — LiveSignalBus freshness sweeper ──────────
  // Sweeps stale (idle > SIGNAL_FRESHNESS_MS) signals into the
  // expired lifecycle state every 60s. Centralized so no component
  // expires locally — the bus is the single source of expiry truth.
  try {
    const { startBusSweeper } = await import("./services/liveSignalBus");
    startBusSweeper();
    console.log("[LL_SIGNAL_REGISTER] bus boot complete");
    // MLB Shadow Qualification sweeper — expires shadow-qualified signals
    // idle past TTL so the pending bucket doesn't grow unbounded.
    const { startShadowSweeper } = await import("./mlb/shadowQualification");
    startShadowSweeper();
  } catch (err) {
    console.warn("[LL_SIGNAL_REJECTED] bus boot failed:", (err as Error).message);
  }

  // ── LiveLocks Batch D — Alert subscriber drainer ─────────────────
  // Fans bus-lifecycle alert events out to per-user channels every 5s.
  try {
    const { startAlertDrainer } = await import("./services/alertSubscriber");
    startAlertDrainer();

    // Batch E — Analytics aggregators. Read-only periodic snapshots.
    try {
      const { startMlbIntelligenceAggregator } = await import("./analytics/mlbSignalIntelligence");
      const { startHrRadarIntelligenceAggregator, computeCalibrationBuckets } = await import("./analytics/hrRadarIntelligence");
      const { startDriverIntelligenceAggregator } = await import("./analytics/driverIntelligence");
      const { startShadowAnalyticsAggregator } = await import("./analytics/shadowAnalytics");
      startMlbIntelligenceAggregator();
      startHrRadarIntelligenceAggregator();
      startDriverIntelligenceAggregator();
      startShadowAnalyticsAggregator();
      // Audit fix C4 — wire durable outcome-stamp persistence + boot hydration.
      // Every newly-stamped outcome is fire-and-forget upserted to the DB, and
      // the in-memory working set is seeded from recent rows at boot so the
      // empirical-calibration sample survives process restarts.
      try {
        const stampMod = await import("./mlb/hrRadarOutcomeStamp");
        stampMod.setHrRadarOutcomeStampPersister((s) => {
          void storage.persistHrRadarOutcomeStamp(s).catch(() => {});
        });
        const recent = await storage.loadRecentHrRadarOutcomeStamps(21);
        const seeded = stampMod.hydrateHrRadarOutcomeStamps(recent);
        console.log(`[HR_RADAR_STAMP_HYDRATE] seeded=${seeded} from ${recent.length} durable rows`);
      } catch (err: any) {
        console.warn(`[HR_RADAR_STAMP_HYDRATE] wiring failed err=${err?.message ?? err}`);
      }

      // Empirical calibration update — runs every 30 minutes using settled
      // outcome stamps. Audit fix C4 — also run once shortly after boot:
      // `setInterval` alone first fires 30 min in, so after every restart the
      // engine ran static-table-only for half an hour even when settled outcomes
      // were already available. The 60s delay lets the outcome-stamp store hydrate.
      const refreshCalibrationBuckets = async () => {
        try {
          const { setEmpiricalCalibrationBuckets } = await import("./mlb/hrConversionModel");
          const buckets = computeCalibrationBuckets();
          if (buckets.length > 0) setEmpiricalCalibrationBuckets(buckets);
        } catch (err: any) {
          console.warn(`[LL_ANALYTICS_HR_RADAR] calibration cron failed err=${err?.message ?? err}`);
        }
      };
      setTimeout(refreshCalibrationBuckets, 60 * 1000);
      setInterval(refreshCalibrationBuckets, 30 * 60 * 1000);
    } catch (err: any) {
      console.warn(`[LL_ANALYTICS_AGGREGATE] aggregators failed to start err=${err?.message ?? err}`);
    }
    console.log("[LL_ALERT_QUEUED] alert drainer boot complete");
  } catch (err) {
    console.warn("[LL_ALERT_SUPPRESSED] alert drainer boot failed:", (err as Error).message);
  }

  // Auto-sync MLB roster pool at startup + every 24h. Without this the
  // in-memory playerPool is empty and every getPlayer() returns undefined,
  // which starves the handedness feature (resolvedBatterHand=null) and
  // the engine's handedness scoring component never engages.
  const syncMlbRosters = async () => {
    try {
      await updatePlayerPool();
      await updateTeamRosters();
      console.log(`[startup] MLB roster auto-sync complete: pool=${getPlayerPoolCount()} players`);
    } catch (err: any) {
      console.error("[startup] MLB roster auto-sync error:", err?.message ?? err);
    }
  };
  syncMlbRosters();
  setInterval(syncMlbRosters, 24 * 60 * 60 * 1000);

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

  // EADDRINUSE resilience: a stale dev process holding port 5000 has caused
  // silent outages where the engine never finishes starting (no polling, no
  // signals, no UI feedback). Catch the error explicitly, attempt a one-shot
  // cleanup of the holder via lsof, then retry once. If still unavailable,
  // crash loudly with a clearly-tagged STARTUP_FAIL line so it cannot hide
  // among normal logs.
  let listenAttempted = false;
  const startListening = () => {
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
  };

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") {
      console.error(`[STARTUP_FAIL] httpServer error: ${err.message}`);
      throw err;
    }
    if (listenAttempted) {
      console.error(`[STARTUP_FAIL] port ${port} still in use after cleanup attempt — aborting`);
      process.exit(1);
    }
    listenAttempted = true;
    console.error(`[STARTUP_FAIL] port ${port} already in use — attempting one-shot cleanup of stale holder…`);

    // Cross-platform port-holder discovery: lsof / fuser / ss are not always
    // available (e.g. minimal Nix containers ship none of them). Fall back to
    // scanning /proc/*/net/tcp for sockets in LISTEN state on the target port,
    // then resolving owning pids via /proc/*/fd/* socket inodes. This is pure
    // Linux /proc and needs no external binaries.
    const findHoldingPids = (targetPort: number): number[] => {
      try {
        // ESM-safe — this file is "type": "module" and `require` is not
        // defined here, so use the static `node:fs` / `node:path` imports
        // brought in at the top of the module.
        const fs = nodeFs;
        const path = nodePath;
        const portHex = targetPort.toString(16).toUpperCase().padStart(4, "0");
        const tcpFiles = ["/proc/net/tcp", "/proc/net/tcp6"];
        const listeningInodes = new Set<string>();
        for (const f of tcpFiles) {
          if (!fs.existsSync(f)) continue;
          const lines = fs.readFileSync(f, "utf8").split("\n").slice(1);
          for (const line of lines) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 10) continue;
            const localAddr = cols[1] ?? "";
            const state = cols[3] ?? "";
            const inode = cols[9] ?? "";
            if (state !== "0A") continue; // 0A = LISTEN
            if (!localAddr.endsWith(":" + portHex)) continue;
            if (inode && inode !== "0") listeningInodes.add(inode);
          }
        }
        if (listeningInodes.size === 0) return [];
        const pids: number[] = [];
        const procEntries = fs.readdirSync("/proc");
        for (const entry of procEntries) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = Number(entry);
          if (pid === process.pid) continue;
          const fdDir = path.join("/proc", entry, "fd");
          let fdNames: string[];
          try { fdNames = fs.readdirSync(fdDir); } catch { continue; }
          for (const fd of fdNames) {
            let link: string;
            try { link = fs.readlinkSync(path.join(fdDir, fd)); } catch { continue; }
            const m = link.match(/^socket:\[(\d+)\]$/);
            if (m && listeningInodes.has(m[1])) {
              pids.push(pid);
              break;
            }
          }
        }
        return pids;
      } catch (err) {
        console.error(`[STARTUP_FAIL] /proc scan failed: ${(err as Error).message}`);
        return [];
      }
    };

    const stalePids = findHoldingPids(port);
    if (stalePids.length) {
      for (const pid of stalePids) {
        try {
          process.kill(pid, "SIGKILL");
          console.error(`[STARTUP_FAIL] killed stale pid ${pid} holding port ${port}`);
        } catch (err) {
          console.error(`[STARTUP_FAIL] failed to kill pid ${pid}: ${(err as Error).message}`);
        }
      }
    } else {
      console.error(`[STARTUP_FAIL] no other process found holding port ${port} via /proc — port may be in TIME_WAIT; retrying anyway in 750ms`);
    }
    setTimeout(startListening, 750);
  });

  startListening();

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

  // ── Task #124 — daily HR Radar ledger invariant guard ──────────────────
  // Runs the canonical ladder validator (mirrors `scripts/validateHrRadarLadder.ts`)
  // against today and yesterday's session date and emits LOUD logs when any
  // violation appears, with extra emphasis on the late-vs-cashed grading bug
  // class (I22, I23, I25). Cron-based so a regression in the matcher cannot
  // sit in the ledger silently until someone runs the script by hand.
  cron.schedule(
    "15 4 * * *",
    async () => {
      try {
        const { validateHrRadarLadder } = await import("./validation/hrRadar/ladderInvariants");
        const { todayET, daysAgoET } = await import("./utils/dateUtils");
        const dates = [todayET(), daysAgoET(1)];
        const LATE_VS_CASHED_CODES = new Set([
          "I22_SIGNAL_NOT_BEFORE_HR",
          "I23_DETECTION_AFTER_HR",
          "I25_LATE_SIGNAL_ACTUALLY_PRE_HR",
        ]);
        for (const sessionDate of dates) {
          const ladder = await storage.getHrRadarLadder(sessionDate);
          const report = validateHrRadarLadder(ladder);
          const violationCounts = report.violations.reduce<Record<string, number>>((acc, v) => {
            acc[v.code] = (acc[v.code] ?? 0) + 1;
            return acc;
          }, {});
          if (report.violations.length === 0) {
            console.log(`[hr-radar-ladder-cron] ok sessionDate=${sessionDate} totalRows=${report.totalRows}`);
            continue;
          }
          console.warn(`[hr-radar-ladder-cron] VIOLATIONS sessionDate=${sessionDate} totalRows=${report.totalRows} count=${report.violations.length} codes=${JSON.stringify(violationCounts)}`);
          // Surface the late-vs-cashed grading-bug class with an explicit
          // ALERT line so it is easy to grep for in production logs.
          const lateVsCashed = report.violations.filter(v => LATE_VS_CASHED_CODES.has(v.code));
          if (lateVsCashed.length > 0) {
            console.error(`[hr-radar-ladder-cron] ALERT late-vs-cashed grading-bug regression detected sessionDate=${sessionDate} count=${lateVsCashed.length}`);
            for (const v of lateVsCashed.slice(0, 10)) {
              console.error(`[hr-radar-ladder-cron] ALERT ${v.code} player=${v.playerId} game=${v.gameId} section=${v.section} :: ${v.message}`);
            }
          }
        }
      } catch (err: any) {
        console.error("[hr-radar-ladder-cron] failed:", err.message, err.stack);
      }
    },
    { timezone: "America/New_York" }
  );
  console.log("[hr-radar-ladder-cron] Daily HR Radar ladder invariant check scheduled (04:15 ET)");

  // ── Task #129 — nightly batter rolling stat snapshot ───────────────────
  // Persists (player_id, session_date, seasonHRRate, hrRateLast30,
  // barrelRate, isHotHitter) for every batter who appeared today, so the
  // presence-floor backtest harness can replay history with point-in-time
  // values instead of whatever the season-to-date number happens to be at
  // script run time. Runs at 03:30 ET, after the slate is closed but before
  // the ladder invariant check at 04:15 ET.
  cron.schedule(
    "30 3 * * *",
    async () => {
      try {
        const { snapshotBatterRollingStatsForDate } = await import("../scripts/snapshotBatterRollingStats");
        const { todayET, daysAgoET } = await import("./utils/dateUtils");
        // Snapshot yesterday (slate just ended in ET) — sessionDate matches
        // game_player_stats.game_date for that day's appearances.
        const sessionDate = daysAgoET(1);
        const result = await snapshotBatterRollingStatsForDate(sessionDate);
        console.log(`[snapshot-rolling-cron] ok sessionDate=${result.sessionDate} written=${result.written}`);
        // Best-effort backstop in case yesterday's run was skipped: also
        // snapshot today if there are early-slate appearances already.
        const todayResult = await snapshotBatterRollingStatsForDate(todayET());
        if (todayResult.written > 0) {
          console.log(`[snapshot-rolling-cron] also-snapshotted sessionDate=${todayResult.sessionDate} written=${todayResult.written}`);
        }
      } catch (err: any) {
        console.error("[snapshot-rolling-cron] failed:", err.message, err.stack);
      }
    },
    { timezone: "America/New_York" }
  );
  console.log("[snapshot-rolling-cron] Nightly batter rolling stat snapshot scheduled (03:30 ET)");

  // ── Phase 3 — daily HR Radar recap tweet ───────────────────────────────
  // Posts a summary tweet of the day's cashed HR Radar signals at 11:45 PM ET.
  // No-ops gracefully when TWITTER_APP_KEY is not configured.
  cron.schedule(
    "45 23 * * *",
    async () => {
      try {
        const { postDailySummaryTweet } = await import("./services/twitterService");
        const { todayET } = await import("./utils/dateUtils");
        const date = todayET();
        const ladder = await storage.getHrRadarLadder(date);
        const cashed = ladder.sections?.cashed ?? [];
        const cashedHits = cashed
          .filter((e: any) => e.outcome === "hit" || e.outcomeStatus === "hit")
          .map((e: any) => ({
            playerName: e.playerName as string,
            team: e.team as string,
            inning: (e.hitInning ?? e.detectedInning ?? 0) as number,
          }));
        await postDailySummaryTweet({
          date,
          cashHits: cashedHits,
          totalCalled:
            (ladder.sections?.attackNow?.length ?? 0) +
            (ladder.sections?.building?.length ?? 0) +
            (ladder.sections?.ready?.length ?? 0) +
            cashed.length,
          totalHit: cashedHits.length,
        });
      } catch (err: any) {
        console.error("[twitter-daily-cron] failed:", err.message);
      }
    },
    { timezone: "America/New_York" }
  );
  console.log("[twitter-daily-cron] Daily HR Radar recap tweet scheduled (23:45 ET)");

  // ── Daily MLB slate-reset (recurring "must reset every day" bug fix) ─────
  // Sweeps every gameId-keyed in-memory cache in the MLB pipeline whose game
  // is no longer in the live registry. Cures the residue left when a game's
  // `final` transition is missed (server restart, API hiccup, game removed
  // from registry before final poll), which was poisoning the next slate and
  // forcing a manual reset of MLB signals + HR Radar every morning.
  //
  // Runs at 04:30 ET — after the existing ladder validator (04:15) and well
  // before any morning slate begins. Late-night Pacific games still in the
  // registry at 04:30 ET are intentionally NOT pruned.
  cron.schedule(
    "30 4 * * *",
    async () => {
      try {
        const { pruneStaleSlateMemory } = await import("./mlb/liveGameOrchestrator");
        const result = await pruneStaleSlateMemory("daily_cron_0430_ET");
        const totalRemoved = Object.values(result.removed).reduce((a, b) => a + b, 0);
        console.log(`[mlb-slate-reset-cron] ok activeGames=${result.activeGames} totalRemoved=${totalRemoved}`);
      } catch (err: any) {
        console.error("[mlb-slate-reset-cron] failed:", err.message, err.stack);
      }
    },
    { timezone: "America/New_York" }
  );
  console.log("[mlb-slate-reset-cron] Daily MLB slate memory reset scheduled (04:30 ET)");

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
