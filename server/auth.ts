import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { storage } from "./storage";
import { insertUserEmailPasswordSchema } from "@shared/schema";
import type { User } from "@shared/schema";

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

const FREE_PLAY_LIMIT = 15;
const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.SESSION_SECRET || "livelocks-dev-secret";
const JWT_EXPIRES = "30d";

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
  };
}

export async function registerAuthRoutes(app: import("express").Express) {
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const parsed = insertUserEmailPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    }
    const { email, password } = parsed.data;

    const existing = await storage.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase().trim();
    const isAdmin = adminEmail ? email.toLowerCase().trim() === adminEmail : false;
    const smsConsent = req.body.smsConsent === true || req.body.smsConsent === "true";
    const rawPhone: string | undefined = req.body.phoneNumber;
    const phoneNumber = rawPhone && rawPhone.trim() ? rawPhone.trim() : null;

    const user = await storage.createUser({
      email,
      passwordHash,
      isAdmin,
      subscriptionTier: null,
      playsUsed: 0,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      smsConsent,
      smsAlerts: smsConsent,
      ...(phoneNumber ? { phoneNumber } : {}),
    });

    req.session.userId = user.id;
    const token = signToken(user.id);
    return res.status(201).json({ ...safeUser(user), token });
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

  if (user.subscriptionTier) {
    return next();
  }

  if (user.playsUsed < FREE_PLAY_LIMIT) {
    await storage.incrementPlaysUsed(user.id);
    return next();
  }

  return res.status(402).json({
    error: "play_limit_reached",
    playsUsed: user.playsUsed,
    limit: FREE_PLAY_LIMIT,
  });
}
