import { db } from "../db";
import { attributionVisits, userAttribution } from "@shared/schema";
import { sql, eq, and, gte, desc, count } from "drizzle-orm";
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

const COOKIE_NAME = "lv_visitor";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;
const FIELD_MAX = 120;
const VISIT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const TWITTER_HOSTS = new Set(["twitter.com", "www.twitter.com", "x.com", "www.x.com", "t.co", "mobile.twitter.com"]);

export function clamp(input: unknown): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  return s.slice(0, FIELD_MAX);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [rawK, ...rest] = part.split("=");
    const k = rawK?.trim();
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=").trim());
  }
  return out;
}

function setVisitorCookie(res: Response, visitorId: string) {
  const isProd = process.env.NODE_ENV === "production";
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(visitorId)}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProd) parts.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, parts.join("; ")]);
  } else if (typeof existing === "string") {
    res.setHeader("Set-Cookie", [existing, parts.join("; ")]);
  } else {
    res.setHeader("Set-Cookie", parts.join("; "));
  }
}

export function ensureVisitorCookie(req: Request, res: Response, next: NextFunction) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    let vid = cookies[COOKIE_NAME];
    if (!vid || vid.length < 8 || vid.length > 64) {
      vid = crypto.randomUUID();
      setVisitorCookie(res, vid);
    }
    (req as any).visitorId = vid;
  } catch (e) {
    // never block request on cookie failure
  }
  next();
}

function refererHost(refererHeader: string | undefined): string | null {
  if (!refererHeader) return null;
  try {
    const u = new URL(refererHeader);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hashUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  return crypto.createHash("sha256").update(ua).digest("hex").slice(0, 32);
}

export type VisitInput = {
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  ref?: unknown;
  landingPath?: unknown;
};

export async function recordVisit(req: Request, body: VisitInput): Promise<{ ok: true; deduped: boolean } | { ok: false; error: string }> {
  const visitorId = (req as any).visitorId as string | undefined;
  if (!visitorId) return { ok: false, error: "no_visitor" };

  const refHost = refererHost(req.headers.referer || req.headers.referrer as string | undefined);

  let utmSource = clamp(body.utmSource);
  if (!utmSource && refHost && TWITTER_HOSTS.has(refHost)) {
    utmSource = "twitter";
  }
  if (utmSource) utmSource = utmSource.toLowerCase();

  const utmMedium = clamp(body.utmMedium)?.toLowerCase() ?? null;
  const utmCampaign = clamp(body.utmCampaign);
  const ref = clamp(body.ref);
  const landingPath = clamp(body.landingPath);

  // Skip pure no-ops (no source, no medium, no campaign, no ref, no referer host)
  if (!utmSource && !utmMedium && !utmCampaign && !ref && !refHost) {
    return { ok: true, deduped: true };
  }

  // Dedupe: same visitor + same source + same campaign within the window.
  try {
    const recent = await db
      .select({ id: attributionVisits.id })
      .from(attributionVisits)
      .where(
        and(
          eq(attributionVisits.visitorId, visitorId),
          gte(attributionVisits.createdAt, new Date(Date.now() - VISIT_DEDUPE_WINDOW_MS)),
          utmSource ? eq(attributionVisits.utmSource, utmSource) : sql`${attributionVisits.utmSource} IS NULL`,
          utmCampaign ? eq(attributionVisits.utmCampaign, utmCampaign) : sql`${attributionVisits.utmCampaign} IS NULL`,
        )
      )
      .limit(1);
    if (recent.length > 0) {
      return { ok: true, deduped: true };
    }
  } catch (e: any) {
    // dedupe lookup is best-effort
    console.warn("[attribution] dedupe lookup failed:", e.message);
  }

  try {
    await db.insert(attributionVisits).values({
      visitorId,
      utmSource,
      utmMedium,
      utmCampaign,
      ref,
      landingPath,
      refererHost: refHost,
      userAgentHash: hashUserAgent(req.headers["user-agent"] as string | undefined),
    });
    return { ok: true, deduped: false };
  } catch (e: any) {
    console.error("[attribution] insert visit failed:", e.message);
    return { ok: false, error: "insert_failed" };
  }
}

export type SignupAttributionInput = {
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  ref?: unknown;
  landingPath?: unknown;
};

// First-touch wins: only inserts if no row exists for this user.
// Best-effort — never throws.
export async function recordSignupAttribution(
  userId: number,
  visitorId: string | null,
  input: SignupAttributionInput,
): Promise<void> {
  try {
    const existing = await db
      .select({ id: userAttribution.id })
      .from(userAttribution)
      .where(eq(userAttribution.userId, userId))
      .limit(1);
    if (existing.length > 0) return;

    let utmSource = clamp(input.utmSource);
    if (utmSource) utmSource = utmSource.toLowerCase();
    const utmMedium = clamp(input.utmMedium)?.toLowerCase() ?? null;
    const utmCampaign = clamp(input.utmCampaign);
    const ref = clamp(input.ref);
    const landingPath = clamp(input.landingPath);

    // Skip if completely empty (no signal worth recording).
    if (!utmSource && !utmMedium && !utmCampaign && !ref && !landingPath) return;

    await db.insert(userAttribution).values({
      userId,
      visitorId,
      utmSource,
      utmMedium,
      utmCampaign,
      ref,
      landingPath,
    });
  } catch (e: any) {
    console.error("[attribution] signup attribution write failed:", e.message);
  }
}

export type AttributionWindowDays = 7 | 30 | 90;

export type CampaignBreakdown = {
  campaign: string;
  visits: number;
  signups: number;
  trialStarts: number;
  paidConversions: number;
  signupRate: number;
  paidRate: number;
};

export type AttributionSummary = {
  source: string;
  windowDays: number;
  totals: {
    visits: number;
    signups: number;
    trialStarts: number;
    paidConversions: number;
    signupRate: number;
    paidRate: number;
  };
  byCampaign: CampaignBreakdown[];
};

export async function getAttributionSummary(
  source: string,
  windowDays: AttributionWindowDays,
): Promise<AttributionSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Visits in window for this source.
  const visitRows = await db.execute(sql`
    SELECT COALESCE(NULLIF(utm_campaign, ''), '(none)') AS campaign,
           COUNT(*) AS visits
      FROM attribution_visits
     WHERE utm_source = ${source}
       AND created_at >= ${since}
     GROUP BY 1
  `);

  // Signups + downstream conversions: join user_attribution -> users.
  const userRows = await db.execute(sql`
    SELECT COALESCE(NULLIF(ua.utm_campaign, ''), '(none)') AS campaign,
           COUNT(*) AS signups,
           COUNT(*) FILTER (WHERE u.trial_started_at IS NOT NULL) AS trial_starts,
           COUNT(*) FILTER (
             WHERE u.converted_to_paid_at IS NOT NULL
                OR (u.subscription_tier IS NOT NULL AND u.subscription_status = 'active')
           ) AS paid_conversions
      FROM user_attribution ua
      JOIN users u ON u.id = ua.user_id
     WHERE ua.utm_source = ${source}
       AND ua.created_at >= ${since}
     GROUP BY 1
  `);

  const visitMap = new Map<string, number>();
  for (const r of (visitRows as any).rows ?? visitRows) {
    visitMap.set(String(r.campaign), Number(r.visits) || 0);
  }
  const userMap = new Map<string, { signups: number; trialStarts: number; paidConversions: number }>();
  for (const r of (userRows as any).rows ?? userRows) {
    userMap.set(String(r.campaign), {
      signups: Number(r.signups) || 0,
      trialStarts: Number(r.trial_starts) || 0,
      paidConversions: Number(r.paid_conversions) || 0,
    });
  }

  const allCampaigns = new Set<string>([
    ...Array.from(visitMap.keys()),
    ...Array.from(userMap.keys()),
  ]);
  const byCampaign: CampaignBreakdown[] = Array.from(allCampaigns).map((campaign) => {
    const v = visitMap.get(campaign) ?? 0;
    const u = userMap.get(campaign) ?? { signups: 0, trialStarts: 0, paidConversions: 0 };
    return {
      campaign,
      visits: v,
      signups: u.signups,
      trialStarts: u.trialStarts,
      paidConversions: u.paidConversions,
      signupRate: v > 0 ? Math.round((u.signups / v) * 1000) / 10 : 0,
      paidRate: u.signups > 0 ? Math.round((u.paidConversions / u.signups) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.visits - a.visits || b.signups - a.signups);

  let visits = 0, signups = 0, trialStarts = 0, paidConversions = 0;
  for (const v of Array.from(visitMap.values())) visits += v;
  for (const u of Array.from(userMap.values())) {
    signups += u.signups;
    trialStarts += u.trialStarts;
    paidConversions += u.paidConversions;
  }

  return {
    source,
    windowDays,
    totals: {
      visits,
      signups,
      trialStarts,
      paidConversions,
      signupRate: visits > 0 ? Math.round((signups / visits) * 1000) / 10 : 0,
      paidRate: signups > 0 ? Math.round((paidConversions / signups) * 1000) / 10 : 0,
    },
    byCampaign,
  };
}

export const ATTRIBUTION_COOKIE_NAME = COOKIE_NAME;
