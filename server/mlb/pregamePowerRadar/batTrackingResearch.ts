// Pre-Game Power Radar — pure Statcast bat-tracking research aggregator.
//
// Operates on already-fetched Statcast CSV rows. No I/O. The production Savant
// adapter can reuse this without inventing metrics or changing the scorer.
//
// Official Statcast definitions used here:
//   average bat speed  = average of the hitter's top 90% swing speeds
//   fast swing         = bat_speed >= 75 mph
//   ideal attack angle = 5° <= attack_angle <= 20°
//
// We do NOT synthesize Squared-Up or Blast rates. Those are distinct official
// Statcast metrics and remain null until their real source columns are ingested.

export interface BatTrackingResearchSnapshot {
  avgBatSpeed: number | null;
  fastSwingRatePct: number | null;
  avgSwingLength: number | null;
  avgAttackAngle: number | null;
  idealAttackAngleRatePct: number | null;
  attackAngleStdDev: number | null;
  avgSwingPathTilt: number | null;
  squaredUpPerSwingPct: null;
  blastPerSwingPct: null;
  swingSample: number | null;
  attackAngleSample: number;
  pathTiltSample: number;
}

const MIN_SWING_SAMPLE = 20;
const MIN_ATTACK_SAMPLE = 20;
const MIN_PATH_SAMPLE = 20;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round1(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}

function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const variance = xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function statcastAverageBatSpeed(xs: number[]): number | null {
  if (xs.length === 0) return null;
  // Statcast excludes the slowest 10% of a hitter's tracked swings from Average
  // Bat Speed. Sort high-to-low and retain the top 90%; ceil avoids discarding
  // more than 10% on small valid samples.
  const sorted = xs.slice().sort((a, b) => b - a);
  const keep = Math.max(1, Math.ceil(sorted.length * 0.9));
  return mean(sorted.slice(0, keep));
}

export function aggregateBatTrackingResearch(
  rows: Array<Record<string, string>>,
): BatTrackingResearchSnapshot {
  const batSpeeds: number[] = [];
  const swingLengths: number[] = [];
  const attackAngles: number[] = [];
  const pathTilts: number[] = [];

  for (const row of rows) {
    const speed = num(row["bat_speed"]);
    if (speed != null && speed >= 35 && speed <= 100) batSpeeds.push(speed);

    const length = num(row["swing_length"]);
    if (length != null && length >= 3 && length <= 12) swingLengths.push(length);

    const attack = num(row["attack_angle"]);
    if (attack != null && attack >= -45 && attack <= 60) attackAngles.push(attack);

    const tilt = num(row["swing_path_tilt"]);
    if (tilt != null && tilt >= -45 && tilt <= 75) pathTilts.push(tilt);
  }

  const enoughSwings = batSpeeds.length >= MIN_SWING_SAMPLE;
  const enoughAttack = attackAngles.length >= MIN_ATTACK_SAMPLE;
  const enoughPath = pathTilts.length >= MIN_PATH_SAMPLE;

  const avgBatSpeed = enoughSwings ? round1(statcastAverageBatSpeed(batSpeeds)) : null;
  const fastSwingRatePct = enoughSwings
    ? round1((batSpeeds.filter((v) => v >= 75).length / batSpeeds.length) * 100)
    : null;
  const avgSwingLength = swingLengths.length >= MIN_SWING_SAMPLE ? round1(mean(swingLengths)) : null;
  const avgAttackAngle = enoughAttack ? round1(mean(attackAngles)) : null;
  const idealAttackAngleRatePct = enoughAttack
    ? round1((attackAngles.filter((v) => v >= 5 && v <= 20).length / attackAngles.length) * 100)
    : null;
  const attackAngleStdDev = enoughAttack ? round1(stddev(attackAngles)) : null;
  const avgSwingPathTilt = enoughPath ? round1(mean(pathTilts)) : null;

  return {
    avgBatSpeed,
    fastSwingRatePct,
    avgSwingLength,
    avgAttackAngle,
    idealAttackAngleRatePct,
    attackAngleStdDev,
    avgSwingPathTilt,
    squaredUpPerSwingPct: null,
    blastPerSwingPct: null,
    swingSample: enoughSwings ? batSpeeds.length : null,
    attackAngleSample: attackAngles.length,
    pathTiltSample: pathTilts.length,
  };
}
