import { db } from "../db";
import { contactEvents, gamePlayerStats, hrOutcomes, hrRadarAnalytics } from "@shared/schema";
import { sql, desc, gte, and } from "drizzle-orm";
import type { MLBMarket } from "./types";

export interface ContactProfile {
  hitEvThreshold: number;
  hitLaThresholdLow: number;
  hitLaThresholdHigh: number;
  xbhEvThreshold: number;
  hrEvThreshold: number;
  hrLaThresholdLow: number;
  hrLaThresholdHigh: number;
  hrDistThreshold: number;
  barrelHitRate: number;
  hardHitHitRate: number;
  avgHitRate: number;
  avgTbPerAb: number;
  sampleSize: number;
}

export interface PitchVulnerabilityProfile {
  pitchType: string;
  hrCount: number;
  avgEv: number;
  avgDist: number;
  pctOfTotal: number;
}

export interface MarketCalibrationData {
  market: string;
  actualRate: number;
  engineExpectedRate: number;
  shrinkFactor: number;
  rateAdjustment: number;
  sampleSize: number;
  lastUpdated: number;
}

const DEFAULT_CONTACT_PROFILE: ContactProfile = {
  hitEvThreshold: 95,
  hitLaThresholdLow: 5,
  hitLaThresholdHigh: 30,
  xbhEvThreshold: 98,
  hrEvThreshold: 100,
  hrLaThresholdLow: 20,
  hrLaThresholdHigh: 38,
  hrDistThreshold: 370,
  barrelHitRate: 0.60,
  hardHitHitRate: 0.35,
  avgHitRate: 0.250,
  avgTbPerAb: 0.400,
  sampleSize: 0,
};

let learnedContactProfile: ContactProfile = { ...DEFAULT_CONTACT_PROFILE };
let learnedPitchVulnerability: PitchVulnerabilityProfile[] = [];
let marketCalibrations: Record<string, MarketCalibrationData> = {};
let lastFullRefresh = 0;
const FULL_REFRESH_MS = 30 * 60_000;

export function getLearnedContactProfile(): ContactProfile {
  return learnedContactProfile;
}

export function getLearnedPitchVulnerability(): PitchVulnerabilityProfile[] {
  return learnedPitchVulnerability;
}

export function getMarketCalibration(market: MLBMarket): MarketCalibrationData | null {
  return marketCalibrations[market] ?? null;
}

export function getAllCalibrationData(): {
  contactProfile: ContactProfile;
  pitchVulnerability: PitchVulnerabilityProfile[];
  marketCalibrations: Record<string, MarketCalibrationData>;
  lastRefresh: number;
  sampleCounts: { contact: number; pitchTypes: number; markets: number };
} {
  return {
    contactProfile: learnedContactProfile,
    pitchVulnerability: learnedPitchVulnerability,
    marketCalibrations,
    lastRefresh: lastFullRefresh,
    sampleCounts: {
      contact: learnedContactProfile.sampleSize,
      pitchTypes: learnedPitchVulnerability.length,
      markets: Object.keys(marketCalibrations).length,
    },
  };
}

export function getLearnedRateAdjustment(market: MLBMarket): number {
  const cal = marketCalibrations[market];
  if (!cal || cal.sampleSize < 30) return 1.0;
  return cal.rateAdjustment;
}

async function learnContactProfile(): Promise<ContactProfile> {
  try {
    const rows = await db.select({
      ev: contactEvents.exitVelocity,
      la: contactEvents.launchAngle,
      dist: contactEvents.distance,
      result: contactEvents.result,
      isBarrel: contactEvents.isBarrel,
    }).from(contactEvents).where(
      sql`${contactEvents.exitVelocity} IS NOT NULL`
    ).limit(5000);

    if (rows.length < 50) {
      console.log(`[SELF_LEARN] contact profile: insufficient data (${rows.length} rows)`);
      return { ...DEFAULT_CONTACT_PROFILE, sampleSize: rows.length };
    }

    const hits = rows.filter(r => r.result === "hit");
    const outs = rows.filter(r => r.result === "out" || r.result === "other");
    const barrels = rows.filter(r => r.isBarrel === true);
    const hardHits = rows.filter(r => parseFloat(String(r.ev ?? "0")) >= 95);

    const hitEvs = hits.map(r => parseFloat(String(r.ev ?? "0")));
    const hitLas = hits.map(r => parseFloat(String(r.la ?? "0")));
    const barrelHits = barrels.filter(r => r.result === "hit");
    const hardHitHits = hardHits.filter(r => r.result === "hit");

    const sortedEvs = hitEvs.sort((a, b) => a - b);
    const hitEvP25 = sortedEvs[Math.floor(sortedEvs.length * 0.25)] ?? 90;

    const sortedLas = hitLas.filter(l => l > 0).sort((a, b) => a - b);
    const hitLaP10 = sortedLas[Math.floor(sortedLas.length * 0.10)] ?? 5;
    const hitLaP90 = sortedLas[Math.floor(sortedLas.length * 0.90)] ?? 30;

    const hrLikeHits = hits.filter(r => {
      const ev = parseFloat(String(r.ev ?? "0"));
      const la = parseFloat(String(r.la ?? "0"));
      const dist = parseFloat(String(r.dist ?? "0"));
      return dist >= 330 || (ev >= 98 && la >= 20 && la <= 40);
    });

    const hrEvs = hrLikeHits.map(r => parseFloat(String(r.ev ?? "0")));
    const hrLas = hrLikeHits.map(r => parseFloat(String(r.la ?? "0")));
    const hrDists = hrLikeHits.map(r => parseFloat(String(r.dist ?? "0"))).filter(d => d > 0);

    const xbhHits = hits.filter(r => {
      const ev = parseFloat(String(r.ev ?? "0"));
      const la = parseFloat(String(r.la ?? "0"));
      return ev >= 95 && la >= 10 && la <= 30;
    });

    const xbhEvs = xbhHits.map(r => parseFloat(String(r.ev ?? "0")));

    const profile: ContactProfile = {
      hitEvThreshold: Math.round(hitEvP25 * 10) / 10,
      hitLaThresholdLow: Math.round(hitLaP10 * 10) / 10,
      hitLaThresholdHigh: Math.round(hitLaP90 * 10) / 10,
      xbhEvThreshold: xbhEvs.length > 0 ? Math.round((xbhEvs.reduce((a, b) => a + b, 0) / xbhEvs.length) * 10) / 10 : 98,
      hrEvThreshold: hrEvs.length > 0 ? Math.round((hrEvs.reduce((a, b) => a + b, 0) / hrEvs.length) * 10) / 10 : 100,
      hrLaThresholdLow: hrLas.length > 3 ? Math.round(hrLas.sort((a, b) => a - b)[Math.floor(hrLas.length * 0.15)] * 10) / 10 : 20,
      hrLaThresholdHigh: hrLas.length > 3 ? Math.round(hrLas.sort((a, b) => a - b)[Math.floor(hrLas.length * 0.85)] * 10) / 10 : 38,
      hrDistThreshold: hrDists.length > 3 ? Math.round(hrDists.sort((a, b) => a - b)[Math.floor(hrDists.length * 0.25)]) : 370,
      barrelHitRate: barrels.length > 5 ? Math.round((barrelHits.length / barrels.length) * 1000) / 1000 : 0.60,
      hardHitHitRate: hardHits.length > 10 ? Math.round((hardHitHits.length / hardHits.length) * 1000) / 1000 : 0.35,
      avgHitRate: rows.length > 0 ? Math.round((hits.length / rows.length) * 1000) / 1000 : 0.250,
      avgTbPerAb: 0.400,
      sampleSize: rows.length,
    };

    console.log(`[SELF_LEARN] Contact profile learned from ${rows.length} events: hitEV≥${profile.hitEvThreshold} hitLA=${profile.hitLaThresholdLow}-${profile.hitLaThresholdHigh}° barrelHitRate=${(profile.barrelHitRate * 100).toFixed(1)}% hardHitRate=${(profile.hardHitHitRate * 100).toFixed(1)}% avgHitRate=${(profile.avgHitRate * 100).toFixed(1)}%`);

    return profile;
  } catch (e: any) {
    console.warn(`[SELF_LEARN] Contact profile failed: ${e.message}`);
    return { ...DEFAULT_CONTACT_PROFILE };
  }
}

async function learnPitchVulnerability(): Promise<PitchVulnerabilityProfile[]> {
  try {
    const rows = await db.execute(sql`
      SELECT pitch_type, COUNT(*) as cnt,
        AVG(CAST(exit_velocity AS FLOAT)) as avg_ev,
        AVG(CAST(distance AS FLOAT)) as avg_dist
      FROM hr_outcomes
      WHERE pitch_type IS NOT NULL
      GROUP BY pitch_type
      ORDER BY cnt DESC
      LIMIT 15
    `);

    const total = (rows.rows as any[]).reduce((sum: number, r: any) => sum + parseInt(r.cnt), 0);
    if (total < 10) {
      console.log(`[SELF_LEARN] Pitch vulnerability: insufficient data (${total} HRs)`);
      return [];
    }

    const profiles: PitchVulnerabilityProfile[] = (rows.rows as any[]).map((r: any) => ({
      pitchType: r.pitch_type,
      hrCount: parseInt(r.cnt),
      avgEv: r.avg_ev ? Math.round(parseFloat(r.avg_ev) * 10) / 10 : 0,
      avgDist: r.avg_dist ? Math.round(parseFloat(r.avg_dist)) : 0,
      pctOfTotal: Math.round((parseInt(r.cnt) / total) * 1000) / 1000,
    }));

    console.log(`[SELF_LEARN] Pitch vulnerability learned from ${total} HRs: ${profiles.slice(0, 5).map(p => `${p.pitchType}=${p.hrCount}(${(p.pctOfTotal * 100).toFixed(0)}%)`).join(", ")}`);

    return profiles;
  } catch (e: any) {
    console.warn(`[SELF_LEARN] Pitch vulnerability failed: ${e.message}`);
    return [];
  }
}

async function learnMarketRates(): Promise<Record<string, MarketCalibrationData>> {
  try {
    const rows = await db.execute(sql`
      SELECT 
        COUNT(*) as total_players,
        SUM(ab) as total_ab,
        SUM(h) as total_h,
        SUM(tb) as total_tb,
        SUM(k) as total_k,
        SUM(bb) as total_bb,
        SUM(r) as total_r,
        SUM(rbi) as total_rbi
      FROM game_player_stats 
      WHERE ab > 0
    `);

    const stats = rows.rows[0] as any;
    const totalAB = parseInt(stats.total_ab ?? "0");
    const totalH = parseInt(stats.total_h ?? "0");
    const totalTB = parseInt(stats.total_tb ?? "0");
    const totalK = parseInt(stats.total_k ?? "0");
    const totalR = parseInt(stats.total_r ?? "0");
    const totalRBI = parseInt(stats.total_rbi ?? "0");

    if (totalAB < 50) {
      console.log(`[SELF_LEARN] Market rates: insufficient AB data (${totalAB})`);
      return {};
    }

    const actualHitRate = totalH / totalAB;
    const actualTbRate = totalTB / totalAB;
    const actualKRate = totalK / totalAB;

    const defaultHitRate = 0.250;
    const defaultTbRate = 0.400;
    const defaultKRate = 0.220;

    const result: Record<string, MarketCalibrationData> = {};

    const buildCal = (market: string, actual: number, expected: number): MarketCalibrationData => {
      const error = actual - expected;
      let rateAdj = 1.0;
      if (Math.abs(error) > 0.02 && totalAB >= 100) {
        rateAdj = actual / expected;
        rateAdj = Math.max(0.80, Math.min(1.25, rateAdj));
      }
      const shrink = Math.max(0.85, Math.min(1.02, 0.96 * (error > 0.05 ? 1.02 : error < -0.05 ? 0.94 : 1.0)));
      return {
        market,
        actualRate: Math.round(actual * 1000) / 1000,
        engineExpectedRate: Math.round(expected * 1000) / 1000,
        shrinkFactor: shrink,
        rateAdjustment: Math.round(rateAdj * 1000) / 1000,
        sampleSize: totalAB,
        lastUpdated: Date.now(),
      };
    };

    result["hits"] = buildCal("hits", actualHitRate, defaultHitRate);
    result["total_bases"] = buildCal("total_bases", actualTbRate, defaultTbRate);
    result["batter_strikeouts"] = buildCal("batter_strikeouts", actualKRate, defaultKRate);

    const hrRows = await db.execute(sql`
      SELECT COUNT(*) as hr_count FROM hr_outcomes
    `);
    const hrTotalFromOH = parseInt((hrRows.rows[0] as any).hr_count ?? "0");

    const gpsHrRows = await db.execute(sql`
      SELECT SUM(ab) as total_ab FROM game_player_stats WHERE ab > 0
    `);
    const gpsAb = parseInt((gpsHrRows.rows[0] as any).total_ab ?? "0");

    const radarRows = await db.execute(sql`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN result = 'hit' THEN 1 ELSE 0 END) as hits
      FROM hr_radar_analytics
    `);
    const radarTotal = parseInt((radarRows.rows[0] as any).total ?? "0");
    const radarHits = parseInt((radarRows.rows[0] as any).hits ?? "0");

    if (radarTotal >= 20) {
      const radarHitRate = radarHits / radarTotal;
      const expectedHrRate = 0.035;
      result["home_runs"] = buildCal("home_runs", radarHitRate, expectedHrRate);
    }

    const hrrRate = gpsAb > 0 ? (totalH + totalR + totalRBI) / gpsAb : 0;
    if (gpsAb >= 100) {
      const expectedHrrRate = 0.24;
      result["hrr"] = buildCal("hrr", hrrRate, expectedHrrRate);
    }

    for (const [market, cal] of Object.entries(result)) {
      console.log(`[SELF_LEARN] Market ${market}: actual=${(cal.actualRate * 100).toFixed(1)}% expected=${(cal.engineExpectedRate * 100).toFixed(1)}% rateAdj=${cal.rateAdjustment.toFixed(3)} shrink=${cal.shrinkFactor.toFixed(4)} samples=${cal.sampleSize}`);
    }

    return result;
  } catch (e: any) {
    console.warn(`[SELF_LEARN] Market rates failed: ${e.message}`);
    return {};
  }
}

export async function refreshFullSelfLearning(): Promise<void> {
  if (Date.now() - lastFullRefresh < FULL_REFRESH_MS) return;
  try {
    console.log(`[SELF_LEARN] Starting full self-learning refresh...`);

    const [contactProfile, pitchVuln, marketRates] = await Promise.all([
      learnContactProfile(),
      learnPitchVulnerability(),
      learnMarketRates(),
    ]);

    learnedContactProfile = contactProfile;
    learnedPitchVulnerability = pitchVuln;
    marketCalibrations = marketRates;
    lastFullRefresh = Date.now();

    console.log(`[SELF_LEARN] Full refresh complete — contact=${contactProfile.sampleSize} events, pitchTypes=${pitchVuln.length}, markets=${Object.keys(marketRates).length}`);
  } catch (e: any) {
    console.warn(`[SELF_LEARN] Full refresh failed: ${e.message}`);
    lastFullRefresh = Date.now();
  }
}

export function getContactQualityScore(exitVelocity: number | null, launchAngle: number | null, distance: number | null): {
  hitLikelihood: number;
  xbhLikelihood: number;
  hrLikelihood: number;
} {
  const cp = learnedContactProfile;
  const ev = exitVelocity ?? 0;
  const la = launchAngle ?? 0;
  const dist = distance ?? 0;

  let hitLikelihood = cp.avgHitRate;
  if (ev >= cp.hitEvThreshold && la >= cp.hitLaThresholdLow && la <= cp.hitLaThresholdHigh) {
    hitLikelihood = Math.min(0.85, cp.hardHitHitRate + (ev - cp.hitEvThreshold) * 0.01);
  }
  if (ev >= 98 && la >= 20 && la <= 35) {
    hitLikelihood = cp.barrelHitRate;
  }

  let xbhLikelihood = 0.08;
  if (ev >= cp.xbhEvThreshold && la >= 10 && la <= 30) {
    xbhLikelihood = Math.min(0.60, 0.20 + (ev - cp.xbhEvThreshold) * 0.02);
  }

  let hrLikelihood = 0.035;
  if (ev >= cp.hrEvThreshold && la >= cp.hrLaThresholdLow && la <= cp.hrLaThresholdHigh) {
    hrLikelihood = Math.min(0.50, 0.15 + (ev - cp.hrEvThreshold) * 0.02);
  }
  if (dist >= cp.hrDistThreshold) {
    hrLikelihood = Math.min(0.80, hrLikelihood + 0.20);
  }

  return {
    hitLikelihood: Math.round(hitLikelihood * 1000) / 1000,
    xbhLikelihood: Math.round(xbhLikelihood * 1000) / 1000,
    hrLikelihood: Math.round(hrLikelihood * 1000) / 1000,
  };
}

export function getPitchTypeHrRisk(pitchType: string | null): number {
  if (!pitchType || learnedPitchVulnerability.length === 0) return 0.5;

  const normalized = pitchType.toLowerCase().trim();
  const match = learnedPitchVulnerability.find(p =>
    p.pitchType.toLowerCase().includes(normalized) ||
    normalized.includes(p.pitchType.toLowerCase())
  );

  if (!match) return 0.5;

  const avgPct = 1 / learnedPitchVulnerability.length;
  if (match.pctOfTotal > avgPct * 1.5) return 0.7;
  if (match.pctOfTotal < avgPct * 0.5) return 0.3;
  return 0.5;
}
