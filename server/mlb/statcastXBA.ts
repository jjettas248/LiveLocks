const XBA_GRID: Array<{ evMin: number; evMax: number; laMin: number; laMax: number; xba: number }> = [
  { evMin: 0,   evMax: 60,  laMin: -90, laMax: 90,  xba: 0.030 },

  { evMin: 60,  evMax: 70,  laMin: -90, laMax: -10, xba: 0.020 },
  { evMin: 60,  evMax: 70,  laMin: -10, laMax: 10,  xba: 0.180 },
  { evMin: 60,  evMax: 70,  laMin: 10,  laMax: 25,  xba: 0.090 },
  { evMin: 60,  evMax: 70,  laMin: 25,  laMax: 50,  xba: 0.030 },
  { evMin: 60,  evMax: 70,  laMin: 50,  laMax: 90,  xba: 0.010 },

  { evMin: 70,  evMax: 80,  laMin: -90, laMax: -10, xba: 0.030 },
  { evMin: 70,  evMax: 80,  laMin: -10, laMax: 10,  xba: 0.280 },
  { evMin: 70,  evMax: 80,  laMin: 10,  laMax: 20,  xba: 0.200 },
  { evMin: 70,  evMax: 80,  laMin: 20,  laMax: 35,  xba: 0.100 },
  { evMin: 70,  evMax: 80,  laMin: 35,  laMax: 50,  xba: 0.040 },
  { evMin: 70,  evMax: 80,  laMin: 50,  laMax: 90,  xba: 0.010 },

  { evMin: 80,  evMax: 85,  laMin: -90, laMax: -10, xba: 0.040 },
  { evMin: 80,  evMax: 85,  laMin: -10, laMax: 5,   xba: 0.380 },
  { evMin: 80,  evMax: 85,  laMin: 5,   laMax: 15,  xba: 0.450 },
  { evMin: 80,  evMax: 85,  laMin: 15,  laMax: 25,  xba: 0.350 },
  { evMin: 80,  evMax: 85,  laMin: 25,  laMax: 35,  xba: 0.200 },
  { evMin: 80,  evMax: 85,  laMin: 35,  laMax: 50,  xba: 0.060 },
  { evMin: 80,  evMax: 85,  laMin: 50,  laMax: 90,  xba: 0.010 },

  { evMin: 85,  evMax: 90,  laMin: -90, laMax: -10, xba: 0.050 },
  { evMin: 85,  evMax: 90,  laMin: -10, laMax: 5,   xba: 0.440 },
  { evMin: 85,  evMax: 90,  laMin: 5,   laMax: 15,  xba: 0.550 },
  { evMin: 85,  evMax: 90,  laMin: 15,  laMax: 25,  xba: 0.480 },
  { evMin: 85,  evMax: 90,  laMin: 25,  laMax: 35,  xba: 0.320 },
  { evMin: 85,  evMax: 90,  laMin: 35,  laMax: 50,  xba: 0.100 },
  { evMin: 85,  evMax: 90,  laMin: 50,  laMax: 90,  xba: 0.020 },

  { evMin: 90,  evMax: 95,  laMin: -90, laMax: -10, xba: 0.060 },
  { evMin: 90,  evMax: 95,  laMin: -10, laMax: 5,   xba: 0.520 },
  { evMin: 90,  evMax: 95,  laMin: 5,   laMax: 12,  xba: 0.640 },
  { evMin: 90,  evMax: 95,  laMin: 12,  laMax: 20,  xba: 0.580 },
  { evMin: 90,  evMax: 95,  laMin: 20,  laMax: 30,  xba: 0.500 },
  { evMin: 90,  evMax: 95,  laMin: 30,  laMax: 40,  xba: 0.280 },
  { evMin: 90,  evMax: 95,  laMin: 40,  laMax: 55,  xba: 0.080 },
  { evMin: 90,  evMax: 95,  laMin: 55,  laMax: 90,  xba: 0.020 },

  { evMin: 95,  evMax: 98,  laMin: -90, laMax: -10, xba: 0.080 },
  { evMin: 95,  evMax: 98,  laMin: -10, laMax: 5,   xba: 0.580 },
  { evMin: 95,  evMax: 98,  laMin: 5,   laMax: 12,  xba: 0.720 },
  { evMin: 95,  evMax: 98,  laMin: 12,  laMax: 20,  xba: 0.680 },
  { evMin: 95,  evMax: 98,  laMin: 20,  laMax: 30,  xba: 0.620 },
  { evMin: 95,  evMax: 98,  laMin: 30,  laMax: 40,  xba: 0.400 },
  { evMin: 95,  evMax: 98,  laMin: 40,  laMax: 55,  xba: 0.120 },
  { evMin: 95,  evMax: 98,  laMin: 55,  laMax: 90,  xba: 0.030 },

  { evMin: 98,  evMax: 102, laMin: -90, laMax: -10, xba: 0.100 },
  { evMin: 98,  evMax: 102, laMin: -10, laMax: 5,   xba: 0.640 },
  { evMin: 98,  evMax: 102, laMin: 5,   laMax: 12,  xba: 0.780 },
  { evMin: 98,  evMax: 102, laMin: 12,  laMax: 20,  xba: 0.760 },
  { evMin: 98,  evMax: 102, laMin: 20,  laMax: 30,  xba: 0.750 },
  { evMin: 98,  evMax: 102, laMin: 30,  laMax: 40,  xba: 0.550 },
  { evMin: 98,  evMax: 102, laMin: 40,  laMax: 55,  xba: 0.200 },
  { evMin: 98,  evMax: 102, laMin: 55,  laMax: 90,  xba: 0.040 },

  { evMin: 102, evMax: 106, laMin: -90, laMax: -10, xba: 0.130 },
  { evMin: 102, evMax: 106, laMin: -10, laMax: 5,   xba: 0.700 },
  { evMin: 102, evMax: 106, laMin: 5,   laMax: 12,  xba: 0.830 },
  { evMin: 102, evMax: 106, laMin: 12,  laMax: 20,  xba: 0.820 },
  { evMin: 102, evMax: 106, laMin: 20,  laMax: 30,  xba: 0.830 },
  { evMin: 102, evMax: 106, laMin: 30,  laMax: 40,  xba: 0.680 },
  { evMin: 102, evMax: 106, laMin: 40,  laMax: 55,  xba: 0.300 },
  { evMin: 102, evMax: 106, laMin: 55,  laMax: 90,  xba: 0.060 },

  { evMin: 106, evMax: 120, laMin: -90, laMax: -10, xba: 0.160 },
  { evMin: 106, evMax: 120, laMin: -10, laMax: 5,   xba: 0.750 },
  { evMin: 106, evMax: 120, laMin: 5,   laMax: 12,  xba: 0.880 },
  { evMin: 106, evMax: 120, laMin: 12,  laMax: 20,  xba: 0.870 },
  { evMin: 106, evMax: 120, laMin: 20,  laMax: 30,  xba: 0.900 },
  { evMin: 106, evMax: 120, laMin: 30,  laMax: 40,  xba: 0.780 },
  { evMin: 106, evMax: 120, laMin: 40,  laMax: 55,  xba: 0.400 },
  { evMin: 106, evMax: 120, laMin: 55,  laMax: 90,  xba: 0.080 },
];

export interface StatcastContactClass {
  xBA: number;
  xSLG: number;
  isBarrel: boolean;
  isHardHit: boolean;
  isSweetSpot: boolean;
  isFlare: boolean;
  contactGrade: "barrel" | "solid" | "flare" | "under" | "topped" | "weak" | "popup";
  hrProbability: number;
}

export function computeXBA(exitVelocity: number, launchAngle: number): number {
  for (const cell of XBA_GRID) {
    if (exitVelocity >= cell.evMin && exitVelocity < cell.evMax &&
        launchAngle >= cell.laMin && launchAngle < cell.laMax) {
      return cell.xba;
    }
  }
  if (exitVelocity >= 120) {
    const topCell = XBA_GRID.find(c => c.evMin === 106 && launchAngle >= c.laMin && launchAngle < c.laMax);
    return topCell?.xba ?? 0.050;
  }
  return 0.030;
}

export function computeXSLG(exitVelocity: number, launchAngle: number): number {
  const xba = computeXBA(exitVelocity, launchAngle);
  if (exitVelocity >= 98 && launchAngle >= 20 && launchAngle <= 35) return Math.min(xba * 3.5, 4.0);
  if (exitVelocity >= 95 && launchAngle >= 15 && launchAngle <= 40) return Math.min(xba * 2.8, 3.5);
  if (exitVelocity >= 90 && launchAngle >= 10 && launchAngle <= 30) return Math.min(xba * 2.2, 3.0);
  if (launchAngle >= 25 && launchAngle <= 40 && exitVelocity >= 85) return Math.min(xba * 2.0, 2.5);
  return Math.min(xba * 1.3, 1.5);
}

function estimateHRProbability(ev: number, la: number): number {
  if (ev < 95 || la < 15 || la > 45) return 0;
  if (ev >= 106 && la >= 20 && la <= 35) return 0.85;
  if (ev >= 103 && la >= 22 && la <= 33) return 0.75;
  if (ev >= 100 && la >= 24 && la <= 32) return 0.55;
  if (ev >= 98  && la >= 25 && la <= 35) return 0.40;
  if (ev >= 95  && la >= 20 && la <= 40) return 0.15;
  return 0.05;
}

export function classifyContact(exitVelocity: number | null, launchAngle: number | null): StatcastContactClass {
  if (exitVelocity == null || launchAngle == null) {
    return {
      xBA: 0, xSLG: 0,
      isBarrel: false, isHardHit: false, isSweetSpot: false, isFlare: false,
      contactGrade: "weak", hrProbability: 0,
    };
  }

  const ev = exitVelocity;
  const la = launchAngle;
  const xBA = computeXBA(ev, la);
  const xSLG = computeXSLG(ev, la);
  const isBarrel = ev >= 98 && la >= 20 && la <= 35;
  const isHardHit = ev >= 95;
  const isSweetSpot = la >= 8 && la <= 32;
  const isFlare = ev < 90 && la >= 15 && la <= 28 && xBA >= 0.300;
  const hrProb = estimateHRProbability(ev, la);

  let contactGrade: StatcastContactClass["contactGrade"];
  if (isBarrel) contactGrade = "barrel";
  else if (isHardHit && isSweetSpot && xBA >= 0.500) contactGrade = "solid";
  else if (isFlare) contactGrade = "flare";
  else if (la > 50) contactGrade = "popup";
  else if (la < -5) contactGrade = "topped";
  else if (ev < 80 && la >= 20) contactGrade = "under";
  else contactGrade = "weak";

  return { xBA, xSLG, isBarrel, isHardHit, isSweetSpot, isFlare, contactGrade, hrProbability: hrProb };
}

export function computeGameContactProfile(contacts: Array<{ exitVelocity: number | null; launchAngle: number | null }>): {
  avgXBA: number;
  maxXBA: number;
  barrelCount: number;
  solidCount: number;
  weakCount: number;
  avgHRProb: number;
  contactQualityScore: number;
} {
  if (contacts.length === 0) return { avgXBA: 0, maxXBA: 0, barrelCount: 0, solidCount: 0, weakCount: 0, avgHRProb: 0, contactQualityScore: 0 };

  let totalXBA = 0;
  let maxXBA = 0;
  let totalHRProb = 0;
  let barrelCount = 0;
  let solidCount = 0;
  let weakCount = 0;
  let validCount = 0;

  for (const c of contacts) {
    const cls = classifyContact(c.exitVelocity, c.launchAngle);
    if (c.exitVelocity != null) {
      totalXBA += cls.xBA;
      totalHRProb += cls.hrProbability;
      if (cls.xBA > maxXBA) maxXBA = cls.xBA;
      validCount++;
    }
    if (cls.contactGrade === "barrel") barrelCount++;
    else if (cls.contactGrade === "solid") solidCount++;
    else if (cls.contactGrade === "weak" || cls.contactGrade === "topped" || cls.contactGrade === "popup") weakCount++;
  }

  const avgXBA = validCount > 0 ? Math.round((totalXBA / validCount) * 1000) / 1000 : 0;
  const avgHRProb = validCount > 0 ? Math.round((totalHRProb / validCount) * 1000) / 1000 : 0;
  const qualityScore = Math.min(100, Math.round(
    (avgXBA * 100) +
    (barrelCount * 15) +
    (solidCount * 8) -
    (weakCount * 5) +
    (maxXBA >= 0.700 ? 10 : 0)
  ));

  return { avgXBA, maxXBA, barrelCount, solidCount, weakCount, avgHRProb, contactQualityScore: Math.max(0, qualityScore) };
}
