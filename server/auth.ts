import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { insertUserEmailPasswordSchema } from "@shared/schema";
import type { User } from "@shared/schema";
import { sendWelcomeEmail, sendHowToEmail, sendWallEmail, sendVerificationEmail } from "./email";

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

const FREE_PLAY_LIMIT = 15;
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
  return {
    id: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    subscriptionTier: user.subscriptionTier,
    playsUsed: user.playsUsed,
    isNewProUser: user.isNewProUser ?? false,
    upgradedAt: user.upgradedAt ?? null,
    emailVerified: user.emailVerified,
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

    sendWelcomeEmail(user.email).catch(console.error);
    sendHowToEmail(user.email).catch(console.error);

    return res.redirect("/login");
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
    const user = await storage.getUserById(userId);
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.json(safeUser(user));
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
    if (user.isAdmin) return next();
    if (user.subscriptionTier && tiers.includes(user.subscriptionTier)) return next();
    return res.status(403).json({
      error: "tier_required",
      requiredTiers: tiers,
      message: `This feature requires one of: ${tiers.join(", ")} subscription.`,
    });
  };
}

export async function requirePlayAccess(req: Request, res: Response, next: NextFunction) {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const user = await storage.getUserById(userId);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (user.isAdmin) {
    return next();
  }

  if (!user.emailVerified) {
    return res.status(403).json({ error: "Please verify your email to use LiveLocks." });
  }

  if (user.createdAt) {
    const ageMs = Date.now() - new Date(user.createdAt).getTime();
    if (ageMs < 30_000) {
      return res.status(403).json({ error: "Account too new. Please wait a moment." });
    }
  }

  if (user.subscriptionTier) {
    return next();
  }

  if (user.playsUsed < FREE_PLAY_LIMIT) {
    await storage.incrementPlaysUsed(user.id);
    if (user.playsUsed + 1 === 15) {
      sendWallEmail(user.email).catch((emailErr: any) => {
        console.error("[email] Failed to send wall email:", emailErr.message);
      });
    }
    return next();
  }

  return res.status(402).json({
    error: "play_limit_reached",
    playsUsed: user.playsUsed,
    limit: FREE_PLAY_LIMIT,
  });
}
