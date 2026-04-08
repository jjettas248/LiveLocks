import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { insertUserEmailPasswordSchema } from "@shared/schema";
import type { User } from "@shared/schema";
import { sendWallEmail, sendVerificationEmail, sendPasswordResetEmail } from "./email";
import { resolveAccess } from "./utils/access";
import { todayET } from "./utils/dateUtils";

// ── Stripe tier-check TTL cache ────────────────────────────────────────────────
// Limits Stripe API calls to once per 5 minutes per user.
const STRIPE_CHECK_TTL_MS = 5 * 60 * 1000;
const stripeCheckCache = new Map<number, number>(); // userId → lastCheckTs

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

const FREE_PLAY_LIMIT = 3;
const SALT_ROUNDS = 10;

const JWT_SECRET = process.env.SESSION_SECRET || "livelocks-dev-secret";
const JWT_EXPIRES = "30d";

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com",
  "yopmail.com", "throwaway.email", "guerrillamail.net", "guerrillamail.org",
  "sharklasers.com", "grr.la", "guerrillamailblock.com", "pokemail.net",
  "spam4.me", "trashmail.com", "trashmail.net", "trashmail.org",
  "mailnesia.com", "maildrop.cc", "dispostable.com", "temp-mail.org",
  "fakeinbox.com", "tempinbox.com", "mintadomin.com", "mohmal.com",
]);

function normalizeEmail(rawEmail: string): { original: string; normalized: string } {
  const original = rawEmail.trim();
  let email = original.toLowerCase().trim();
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) {
    return { original, normalized: email };
  }
  if (domain === "gmail.com" || domain === "googlemail.com") {
    let normalized = localPart.replace(/\./g, "");
    const plusIndex = normalized.indexOf("+");
    if (plusIndex !== -1) {
      normalized = normalized.substring(0, plusIndex);
    }
    return { original, normalized: `${normalized}@gmail.com` };
  }
  return { original, normalized: email };
}

function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain ? DISPOSABLE_DOMAINS.has(domain) : false;
}

function computeFingerprint(ip: string, userAgent: string): string {
  return crypto.createHash("sha256").update(`${ip}${userAgent}`).digest("hex");
}

function signToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function getUserIdFromRequest(req: Request): number | null {
  if (req.session?.userId) {
    return req.session.userId;
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: number };
      return payload.userId;
    } catch {
      return null;
    }
  }
  return null;
}

function safeUser(user: User) {
  const access = resolveAccess(user.subscriptionTier, user.isAdmin ?? false);
  return {
    id: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    subscriptionTier: user.subscriptionTier,
    playsUsed: user.playsUsed,
    playsUsedToday: user.playsUsedToday ?? 0,
    playsResetDate: user.playsResetDate ?? null,
    isNewProUser: user.isNewProUser ?? false,
    upgradedAt: user.upgradedAt ?? null,
    emailVerified: user.emailVerified,
    hasNBA: access.hasNBA,
    hasNCAAB: access.hasNCAAB,
    hasMLB: access.hasMLB,
    hasUnlimited: access.hasUnlimited,
    hasCompletedOnboarding: user.hasCompletedOnboarding ?? false,
    sportFocus: user.sportFocus ?? null,
  };
}

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many signup attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

export async function registerAuthRoutes(app: import("express").Express) {
  app.post("/api/auth/register", signupLimiter, async (req: Request, res: Response) => {
    if (req.body.website) {
      return res.status(400).json({ error: "Registration failed." });
    }

    const parsed = insertUserEmailPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    }
    const { email, password } = parsed.data;

    const { original, normalized } = normalizeEmail(email);

    if (isDisposableEmail(normalized)) {
      return res.status(400).json({ error: "Disposable email addresses are not allowed." });
    }

    const existingByNormalized = await storage.getUserByNormalizedEmail(normalized);
    if (existingByNormalized) {
      return res.status(400).json({ error: "Account already exists." });
    }

    const existing = await storage.getUserByEmail(email.toLowerCase().trim());
    if (existing) {
      return res.status(400).json({ error: "Account already exists." });
    }

    if (req.body.captchaToken) {
      const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
      if (!turnstileSecret) {
        console.error("[captcha] TURNSTILE_SECRET_KEY not configured but captchaToken was submitted — rejecting.");
        return res.status(400).json({ error: "CAPTCHA verification failed." });
      }
      try {
        const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `secret=${encodeURIComponent(turnstileSecret)}&response=${encodeURIComponent(req.body.captchaToken)}`,
        });
        const result = await verifyRes.json() as { success: boolean };
        if (!result.success) {
          return res.status(400).json({ error: "CAPTCHA verification failed." });
        }
      } catch (captchaErr) {
        console.error("[captcha] Turnstile verification error:", captchaErr);
        return res.status(400).json({ error: "CAPTCHA verification failed." });
      }
    }

    const ip = req.ip || "unknown";
    const ua = req.headers["user-agent"] || "unknown";
    const fingerprint = computeFingerprint(ip, ua);

    const unverifiedCount = await storage.countUnverifiedByFingerprint(fingerprint);
    if (unverifiedCount >= 3) {
      return res.status(403).json({ error: "Too many accounts from this device." });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase().trim();
    const isAdmin = adminEmail ? email.toLowerCase().trim() === adminEmail : false;
    const smsConsent = req.body.smsConsent === true || req.body.smsConsent === "true";
    const rawPhone: string | undefined = req.body.phoneNumber;
    const phoneNumber = rawPhone && rawPhone.trim() ? rawPhone.trim() : null;

    const verificationToken = crypto.randomUUID();

    const user = await storage.createUser({
      email: email.toLowerCase().trim(),
      passwordHash,
      isAdmin,
      subscriptionTier: null,
      playsUsed: 0,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      smsConsent,
      smsAlerts: smsConsent,
      emailVerified: false,
      emailVerificationToken: verificationToken,
      originalEmail: original,
      normalizedEmail: normalized,
      signupFingerprint: fingerprint,
      verificationLastSentAt: new Date(),
      ...(phoneNumber ? { phoneNumber } : {}),
    });

    try {
      await sendVerificationEmail(user.email, verificationToken);
    } catch (emailErr: any) {
      console.error("[email] Failed to send verification email:", emailErr.message);
    }

    // Welcome email is now handled by the lifecycle cron after email verification.
    // Sending it here caused duplicates when cron also fired for the same user.

    req.session.userId = user.id;
    const token = signToken(user.id);
    return res.status(201).json({ ...safeUser(user), token });
  });

  app.get("/api/auth/verify-email", async (req: Request, res: Response) => {
    const token = req.query.token as string;
    if (!token) {
      return res.status(400).json({ error: "Missing verification token." });
    }

    const user = await storage.getUserByVerificationToken(token);
    if (!user) {
      return res.status(400).json({ error: "Invalid or expired verification token." });
    }

    await storage.updateUser(user.id, {
      emailVerified: true,
      emailVerificationToken: null,
    });

    console.log("EMAIL VERIFIED:", user.email);

    req.session.userId = user.id;

    return res.redirect("/dashboard?verified=1");
  });

  app.post("/api/auth/resend-verification", async (req: Request, res: Response) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUserById(userId);
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: "Email already verified." });
    }

    if (user.verificationLastSentAt) {
      const elapsed = Date.now() - new Date(user.verificationLastSentAt).getTime();
      if (elapsed < 60_000) {
        return res.status(429).json({ error: "Please wait before requesting another email." });
      }
    }

    const newToken = crypto.randomUUID();
    await storage.updateUser(user.id, {
      emailVerificationToken: newToken,
      verificationLastSentAt: new Date(),
    });

    try {
      await sendVerificationEmail(user.email, newToken);
    } catch (emailErr: any) {
      console.error("[email] Failed to resend verification email:", emailErr.message);
    }

    return res.json({ success: true });
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { email, phone, password } = req.body ?? {};
    if (!password || (!email && !phone)) {
      return res.status(400).json({ error: "Email or phone number and password are required." });
    }

    let user: import("@shared/schema").User | undefined;
    if (phone) {
      user = await storage.getUserByPhoneNumber(phone) ?? undefined;
    } else {
      user = await storage.getUserByEmail(email) ?? undefined;
    }

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    req.session.userId = user.id;
    const token = signToken(user.id);
    return res.json({ ...safeUser(user), token });
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    let rawUser = await storage.getUserById(userId);
    if (!rawUser) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // ── Stripe backstop: verify active subscription against DB tier (TTL: 5min) ─
    // Catches cases where webhook failed or DB has a stale/wrong tier.
    const lastStripeCheck = stripeCheckCache.get(userId) ?? 0;
    const stripeCheckDue = Date.now() - lastStripeCheck > STRIPE_CHECK_TTL_MS;
    if (rawUser.stripeCustomerId && stripeCheckDue) {
      try {
        const { getUncachableStripeClient } = await import("./stripeClient");
        const { resolveTierFromSubscription } = await import("./utils/resolveTier");
        const stripe = await getUncachableStripeClient();
        const activeSubs = await stripe.subscriptions.list({ customer: rawUser.stripeCustomerId, status: "active", limit: 1 });
        const trialingSubs = activeSubs.data.length === 0
          ? await stripe.subscriptions.list({ customer: rawUser.stripeCustomerId, status: "trialing", limit: 1 })
          : { data: [] };
        const allSubs = [...activeSubs.data, ...trialingSubs.data];
        if (allSubs.length > 0) {
          const matchedSub = allSubs[0];
          const stripeTier = resolveTierFromSubscription(matchedSub);
          if (stripeTier && stripeTier !== rawUser.subscriptionTier) {
            await storage.updateUserSubscription(userId, stripeTier, rawUser.stripeCustomerId, matchedSub.id);
            console.log(`[STRIPE REPAIR]`, { userId, dbTier: rawUser.subscriptionTier, stripeTier });
            rawUser = await storage.getUserById(userId) ?? rawUser;
          }
        } else if (allSubs.length === 0 && rawUser.subscriptionTier) {
          console.warn(`[STRIPE REPAIR] No active/trialing sub for user ${userId} but DB tier=${rawUser.subscriptionTier} — revoking`);
          await storage.setUserSubscriptionTier(userId, null);
          rawUser = await storage.getUserById(userId) ?? rawUser;
        }
        stripeCheckCache.set(userId, Date.now());
      } catch (stripeErr: any) {
        console.warn(`[stripe-fallback] Stripe lookup failed for user ${userId}:`, stripeErr.message);
      }
    }

    console.log("[ACCESS DEBUG]", {
      email: rawUser.email,
      tier: rawUser.subscriptionTier,
      isAdmin: rawUser.isAdmin,
      access: resolveAccess(rawUser.subscriptionTier, rawUser.isAdmin ?? false),
    });

    const user = (!rawUser.subscriptionTier && !rawUser.isAdmin)
      ? (await storage.resetDailyPlaysIfNeeded(userId) ?? rawUser)
      : rawUser;
    return res.json(safeUser(user));
  });

  const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: "Too many password reset requests. Please try again later." },
  });

  function hashToken(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  app.post("/api/auth/forgot-password", forgotPasswordLimiter, async (req: Request, res: Response) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    const normalizedInput = email.toLowerCase().trim();
    const user = await storage.getUserByEmail(normalizedInput)
      ?? await storage.getUserByNormalizedEmail(normalizedInput);
    res.json({ message: "If an account with that email exists, a password reset link has been sent." });

    if (!user) return;

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiry = new Date(Date.now() + 60 * 60 * 1000);

    try {
      await storage.updateUser(user.id, {
        resetPasswordToken: tokenHash,
        resetPasswordExpiry: expiry,
      });
      await sendPasswordResetEmail(user.email, rawToken);
      console.log(`[auth] Password reset email sent to ${user.email}`);
    } catch (err: any) {
      console.error("[auth] Failed to send password reset email:", err.message);
    }
  });

  const resetPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many reset attempts. Please try again later." },
  });

  app.post("/api/auth/reset-password", resetPasswordLimiter, async (req: Request, res: Response) => {
    const { token, password } = req.body;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Reset token is required" });
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const tokenHash = hashToken(token);
    const fullUser = await storage.getUserByResetToken(tokenHash);
    if (!fullUser) {
      return res.status(400).json({ error: "Invalid or expired reset link" });
    }
    if (!fullUser.resetPasswordExpiry || new Date(fullUser.resetPasswordExpiry) < new Date()) {
      return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await storage.updateUser(fullUser.id, {
      passwordHash,
      resetPasswordToken: null,
      resetPasswordExpiry: null,
    });

    console.log(`[auth] Password reset complete for user ${fullUser.id}`);
    return res.json({ message: "Password has been reset successfully. You can now sign in." });
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  (req as any).resolvedUserId = userId;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const user = await storage.getUserById(userId);
  if (!user || !user.isAdmin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  (req as any).resolvedUserId = userId;
  next();
}

export function requireTier(...tiers: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const user = await storage.getUserById(userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    (req as any).resolvedUserId = userId;
    (req as any).resolvedUser = user;
    if (user.isAdmin) return next();
    if (user.subscriptionTier && tiers.includes(user.subscriptionTier)) return next();
    return res.status(403).json({
      error: "tier_required",
      requiredTiers: tiers,
      message: `This feature requires one of: ${tiers.join(", ")} subscription.`,
    });
  };
}

const MLB_PREVIEW_LIMIT = 2;

export async function requireMLBAccess(req: Request, res: Response, next: NextFunction) {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const user = await storage.getUserById(userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  (req as any).resolvedUserId = userId;
  (req as any).resolvedUser = user;

  if (user.isAdmin || user.subscriptionTier === "elite") return next();

  await storage.resetDailyPlaysIfNeeded(userId);

  const gameId = (req.params as any)?.gameId ?? (req.body as any)?.gameId;
  if (!gameId) {
    return res.status(400).json({ error: "Missing gameId for MLB preview access" });
  }
  const consumeKey = `mlb-${gameId}`;

  const alreadyUnlocked = await storage.isGameUnlockedToday(userId, consumeKey);
  if (alreadyUnlocked) return next();

  const consumeResult = await storage.tryConsumeGamePlayToday(userId, consumeKey, MLB_PREVIEW_LIMIT);
  if (!consumeResult.allowed && !consumeResult.alreadyUnlocked) {
    return res.status(402).json({
      error: "MLB_UPGRADE_REQUIRED",
      message: "Upgrade to All Sports ($65/mo) for unlimited MLB access.",
      playsUsedToday: consumeResult.playsUsedToday,
      limit: MLB_PREVIEW_LIMIT,
    });
  }

  if (consumeResult.allowed) {
    storage.incrementPlaysUsed(userId).catch(console.error);
  }

  return next();
}

export async function requirePlayAccess(req: Request, res: Response, next: NextFunction) {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const rawUser = await storage.getUserById(userId);
  if (!rawUser) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (rawUser.isAdmin) {
    (req as any).resolvedUserId = userId;
    return next();
  }

  if (!rawUser.emailVerified) {
    return res.status(403).json({ error: "Please verify your email to use LiveLocks." });
  }

  if (rawUser.createdAt) {
    const ageMs = Date.now() - new Date(rawUser.createdAt).getTime();
    if (ageMs < 30_000) {
      return res.status(403).json({ error: "Account too new. Please wait a moment." });
    }
  }

  if (rawUser.subscriptionTier) {
    (req as any).resolvedUserId = userId;
    return next();
  }

  await storage.resetDailyPlaysIfNeeded(userId);

  const { gameId } = (req.body ?? {}) as { gameId?: string };
  const bodyHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(req.body ?? {}))
    .digest("hex")
    .slice(0, 16);
  const consumeKey = gameId ?? `calc-${bodyHash}`;

  const alreadyConsumed = await storage.isGameUnlockedToday(userId, consumeKey);
  if (alreadyConsumed) {
    (req as any).resolvedUserId = userId;
    return next();
  }

  const consumeResult = await storage.tryConsumeGamePlayToday(userId, consumeKey);
  if (!consumeResult.allowed && !consumeResult.alreadyUnlocked) {
    const today = todayET();
    return res.status(402).json({
      error: "PAYWALL_TRIGGER",
      playsUsedToday: consumeResult.playsUsedToday,
      playsResetDate: today,
      limit: FREE_PLAY_LIMIT,
    });
  }

  if (consumeResult.allowed) {
    storage.incrementPlaysUsed(userId).catch(console.error);
    if (!rawUser.sentWall && consumeResult.playsUsedToday >= FREE_PLAY_LIMIT) {
      sendWallEmail(rawUser.email)
        .then(() => storage.updateUserEmailFlags(rawUser.id, { sentWall: true }).catch(console.error))
        .catch((e: any) => console.error("[email] wall:", e.message));
    }
  }

  (req as any).resolvedUserId = userId;
  return next();
}
