import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import { insertUserEmailPasswordSchema } from "@shared/schema";
import type { User } from "@shared/schema";

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

const FREE_PLAY_LIMIT = 10;
const SALT_ROUNDS = 10;

function safeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    subscriptionTier: user.subscriptionTier,
    playsUsed: user.playsUsed,
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

    const user = await storage.createUser({
      email,
      passwordHash,
      isAdmin,
      subscriptionTier: null,
      playsUsed: 0,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });

    req.session.userId = user.id;
    return res.status(201).json(safeUser(user));
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const parsed = insertUserEmailPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    }
    const { email, password } = parsed.data;

    const user = await storage.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    req.session.userId = user.id;
    return res.json(safeUser(user));
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const user = await storage.getUserById(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.json(safeUser(user));
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const user = await storage.getUserById(req.session.userId);
  if (!user || !user.isAdmin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

export async function requirePlayAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const user = await storage.getUserById(req.session.userId);
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
