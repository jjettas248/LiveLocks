import { useEffect, useRef } from "react";
import { useLocation } from "wouter";

const STORAGE_KEY = "lv_attribution_v1";
const FIELD_MAX = 120;

export type AttributionPayload = {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  ref: string | null;
  landingPath: string | null;
};

function clamp(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, FIELD_MAX);
}

export function readStoredAttribution(): AttributionPayload | null {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      utmSource: clamp(parsed.utmSource),
      utmMedium: clamp(parsed.utmMedium),
      utmCampaign: clamp(parsed.utmCampaign),
      ref: clamp(parsed.ref),
      landingPath: clamp(parsed.landingPath),
    };
  } catch {
    return null;
  }
}

function writeStoredAttribution(p: AttributionPayload) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // ignore storage failures (private mode etc.)
  }
}

type Options = {
  /**
   * If the URL has no utm_source, force this value before storing/recording.
   * Used by the /twitter page to tag organic Twitter visits.
   */
  forceSource?: string;
};

/**
 * Reads UTM params from the URL, applies first-touch-wins to localStorage,
 * and POSTs the visit to the backend. Safe to call on any page.
 *
 * Re-fires on SPA route/search-string changes (wouter `useLocation`) so
 * client-side navigations into a tagged URL (e.g. user lands on `/`, then
 * navigates to `/twitter?utm_campaign=launch` without a full reload) are
 * captured. Idempotency is enforced by:
 *   1. lastSigRef — skips if the (path + search + forceSource) tuple has
 *      not changed since the last fire,
 *   2. localStorage first-touch rule — only writes once per visitor,
 *   3. server-side dedupe inside `recordVisit` — same visitor + UTM combo
 *      inside the dedupe window collapses to a single row.
 */
export function useAttributionCapture(opts: Options = {}) {
  const [location] = useLocation();
  const lastSigRef = useRef<string | null>(null);
  const { forceSource } = opts;

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Build a stable signature for THIS attribution attempt. wouter's
    // `location` is the path only, so we include `window.location.search`
    // to detect query-string changes (the part attribution actually cares
    // about) and `forceSource` so a route that forces a source still fires
    // the first time we land on it.
    const sig = `${location}?${window.location.search}|${forceSource ?? ""}`;
    if (lastSigRef.current === sig) return;
    lastSigRef.current = sig;

    const url = new URL(window.location.href);
    const params = url.searchParams;

    let utmSource = clamp(params.get("utm_source"));
    if (!utmSource && opts.forceSource) utmSource = clamp(opts.forceSource);
    const utmMedium = clamp(params.get("utm_medium"));
    const utmCampaign = clamp(params.get("utm_campaign"));
    const ref = clamp(params.get("ref"));
    const landingPath = clamp(window.location.pathname);

    // First-touch wins: if we already have stored attribution AND the current URL
    // has no UTM signal, do not overwrite. If the URL DOES carry a new tag, we
    // still keep the stored first-touch (organic conversion attribution rule).
    const stored = readStoredAttribution();
    const hasUrlSignal = !!(utmSource || utmMedium || utmCampaign || ref);
    if (!stored && hasUrlSignal) {
      writeStoredAttribution({
        utmSource: utmSource ?? null,
        utmMedium: utmMedium ?? null,
        utmCampaign: utmCampaign ?? null,
        ref: ref ?? null,
        landingPath: landingPath ?? null,
      });
    }

    // Always record the raw visit (server dedupes within a window). We use the
    // current-URL values for the visit row so we capture multi-campaign reach
    // even though the user-attribution row stays first-touch.
    const body = {
      utmSource: utmSource ?? null,
      utmMedium: utmMedium ?? null,
      utmCampaign: utmCampaign ?? null,
      ref: ref ?? null,
      landingPath: landingPath ?? null,
    };

    const t = window.setTimeout(() => {
      try {
        fetch("/api/attribution/visit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
          keepalive: true,
        }).catch(() => {
          // swallow — attribution must never affect UX
        });
      } catch {
        // swallow
      }
    }, 150);

    return () => window.clearTimeout(t);
  }, [location, forceSource]);
}
