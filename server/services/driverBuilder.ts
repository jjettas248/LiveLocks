// Cross-sport driver builder.
//
// Converts engine-internal score breakdowns / drivers / tags into the
// canonical `SignalDriver[]` + `triggerSummary` shape defined in
// `shared/signalDrivers.ts`.
//
// The builder NEVER invents drivers. Every output entry is sourced from
// engine-recorded data (scoreBreakdown subscores, displayDrivers labels,
// signalTags, hrAlert positiveDrivers, etc.). When no engine evidence is
// available, an empty array is returned and `[LL_EXPLAINABILITY_EMPTY]`
// is logged for admin attention.
//
// Sport-agnostic by design — MLB calls `buildMlbDrivers`, future NBA /
// NCAAB integrations will add their own builders here.

import type { SignalDriver, SignalExplainability, DriverCategory } from "../../shared/signalDrivers";

const MLB_DRIVER_CATEGORY_HINTS: Array<{ pattern: RegExp; category: DriverCategory; detail?: string }> = [
  { pattern: /contact|exit velo|barrel|hard hit/i,        category: "form",    detail: "recent contact quality trend" },
  { pattern: /near.?hr|hr watch|home run pattern/i,        category: "form",    detail: "near-HR contact pattern" },
  { pattern: /pitcher fatigue|pitch count|times through/i, category: "live",    detail: "pitcher decay window" },
  { pattern: /velocity drop|stuff loss/i,                  category: "live",    detail: "live velocity decline" },
  { pattern: /matchup|bvp|handedness|platoon/i,            category: "matchup", detail: "batter-vs-pitcher exposure" },
  { pattern: /park|weather|wind/i,                          category: "context", detail: "park / weather context" },
  { pattern: /odds|line|edge|book/i,                        category: "market",  detail: "market price vs projection" },
  { pattern: /hot|streak|rolling form/i,                    category: "form",    detail: "rolling form indicator" },
  { pattern: /usage|pace|rotation|minutes/i,                category: "matchup", detail: "role / usage exposure" },
];

function classifyDriver(label: string): { category: DriverCategory; detail?: string } {
  for (const hint of MLB_DRIVER_CATEGORY_HINTS) {
    if (hint.pattern.test(label)) return { category: hint.category, detail: hint.detail };
  }
  return { category: "context" };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Build the canonical driver envelope from an MLB normalized signal-shape
 * input. Reads ONLY engine-recorded fields:
 *   - displayDrivers (server-built short labels)
 *   - hrAlert.positiveDrivers
 *   - smartTags / signalTags / badges (engine-set)
 *   - scoreBreakdown subscores (when available)
 *   - reasons (engine textual rationale)
 *
 * Returns `{ drivers: [], triggerSummary: null }` and logs
 * [LL_EXPLAINABILITY_EMPTY] when no driver evidence is present.
 */
export function buildMlbDrivers(qs: Record<string, any>): SignalExplainability {
  const collected = new Map<string, SignalDriver>();

  const addDriver = (label: string, weight: number) => {
    if (!label || typeof label !== "string") return;
    const trimmed = label.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = collected.get(key);
    const w = clamp(Math.round(weight), 0, 100);
    if (existing) {
      existing.weight = Math.max(existing.weight, w);
      return;
    }
    const { category, detail } = classifyDriver(trimmed);
    collected.set(key, { label: trimmed, weight: w, category, detail });
  };

  // Source 1: server-built display drivers (short badge-row labels).
  if (Array.isArray(qs.displayDrivers)) {
    for (const d of qs.displayDrivers) addDriver(String(d), 75);
  }

  // Source 2: HR alert positive drivers.
  const hrPositives = qs.hrAlert?.positiveDrivers;
  if (Array.isArray(hrPositives)) {
    for (const d of hrPositives) addDriver(String(d), 70);
  }

  // Source 3: smart / signal tags, when they look like driver phrases
  // (uppercase tags like "STRONG CONTACT TREND" → "Strong Contact Trend").
  const tagSources = [qs.smartTags, qs.signalTags];
  for (const arr of tagSources) {
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      const raw = String(t);
      if (!raw || raw.length > 60) continue;
      // Normalize SNAKE_CASE / SHOUT CASE → Title Case
      const label = raw
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
      addDriver(label, 60);
    }
  }

  // Source 4: scoreBreakdown subscores, when present and high-signal.
  // Subscore names are technical — we map them to readable labels.
  const SUBSCORE_META: Record<string, { label: string; detail: string; category: DriverCategory }> = {
    matchup:           { label: "Matchup Edge",         detail: "favorable batter vs pitcher exposure",     category: "matchup" },
    form:              { label: "Hot Form",             detail: "elevated rolling form indicator",          category: "form" },
    liveContext:       { label: "Live Context Edge",    detail: "in-game inning / fatigue context",         category: "live" },
    opportunity:       { label: "Opportunity Window",   detail: "remaining PA / pitcher decay window",      category: "context" },
    priceValidation:   { label: "Market Pricing Edge",  detail: "book line lags engine projection",         category: "market" },
    marketReliability: { label: "Reliable Book Pricing", detail: "consensus pricing across books",          category: "market" },
  };
  const breakdown = qs.scoreBreakdown;
  if (breakdown && typeof breakdown === "object") {
    for (const [k, v] of Object.entries(breakdown)) {
      const meta = SUBSCORE_META[k];
      if (!meta) continue;
      const num = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(num) || num < 60) continue;
      // Direct add bypasses classifyDriver so the meta-curated category +
      // detail are preserved.
      const key = meta.label.toLowerCase();
      if (!collected.has(key)) {
        collected.set(key, {
          label: meta.label,
          weight: clamp(Math.round(num), 0, 100),
          category: meta.category,
          detail: meta.detail,
        });
      } else {
        const existing = collected.get(key)!;
        existing.weight = Math.max(existing.weight, clamp(Math.round(num), 0, 100));
        if (!existing.detail) existing.detail = meta.detail;
      }
    }
  }

  // Sort highest-weight first, cap at 6 to keep payloads compact.
  const drivers = Array.from(collected.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6);

  // Build a one-line trigger summary from the top 1-2 drivers.
  let triggerSummary: string | null = null;
  if (drivers.length > 0) {
    const top = drivers.slice(0, 2).map((d) => d.label);
    const player = qs.playerName ?? qs.player ?? "Player";
    const market = String(qs.market ?? "this market").replace(/_/g, " ");
    triggerSummary = `${player} signal on ${market} — ${top.join(" + ")}.`;
  }

  // Diagnostic logging.
  try {
    if (drivers.length === 0) {
      console.warn("[LL_EXPLAINABILITY_EMPTY]", JSON.stringify({
        player: qs.playerName ?? null,
        market: qs.market ?? null,
        sport: "mlb",
      }));
    } else {
      console.log("[LL_DRIVER_BUILD]", JSON.stringify({
        player: qs.playerName ?? null,
        market: qs.market ?? null,
        sport: "mlb",
        driverCount: drivers.length,
        topDriver: drivers[0]?.label ?? null,
      }));
      console.log("[LL_EXPLAINABILITY_OK]", JSON.stringify({
        player: qs.playerName ?? null,
        market: qs.market ?? null,
        sport: "mlb",
      }));
    }
  } catch {}

  return {
    drivers,
    triggerSummary,
    suppressionReason: typeof qs.suppressionReason === "string" ? qs.suppressionReason : null,
  };
}
