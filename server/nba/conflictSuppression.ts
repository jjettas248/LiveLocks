// NBA conflict suppression — pure function extracted from routes.ts so the
// regression audit can exercise the real route behavior without booting
// Express.
//
// Two alt-lines collide when their numeric values sit within ±0.5 of each
// other. Within a player|game|family group we evaluate EVERY OVER vs EVERY
// UNDER candidate (not just best-vs-best). The single highest-probability
// signal that participates in any colliding pair becomes the survivor:
// capped at 68%, every conflicting opposite-side signal dropped, plus any
// same-side near-duplicates of the survivor's line.

export const NBA_CONFLICT_LINE_TOLERANCE = 0.5;

export function areNearbyLines(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" &&
    Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= NBA_CONFLICT_LINE_TOLERANCE;
}

// Typed extension carried on every signal that survives the conflict
// suppressor. Renamed alias `conflictingSignalSuppressed` is exposed
// alongside the historical `conflictingSideSuppressed` flag so downstream
// admin/audit consumers expecting either name continue to work.
export interface ConflictDiagnostics {
  confidenceCeilingApplied?: boolean;
  ceilingReason?: string | null;
  finalizerCapReason?: string | null;
  conflictingSideSuppressed?: boolean;
  conflictingSignalSuppressed?: boolean;
  calibrationVersion?: string;
  finalizerFinalPct?: number;
  [key: string]: unknown;
}

export interface ConflictSignal {
  playerId: number;
  playerName: string;
  statType: string;
  probability: number;
  betDirection: string;
  edge: number;
  line: number;
  gameId?: string;
  engineDiagnostics?: ConflictDiagnostics;
}

export function applyNbaConflictSuppression<T extends ConflictSignal>(
  signals: T[],
  marketFamilyKey: (statType: string | undefined) => string,
): T[] {
  const groups = new Map<string, T[]>();
  for (const s of signals) {
    const fam = marketFamilyKey(s.statType);
    const key = `${s.playerId}|${s.gameId ?? "unknown"}|${fam}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const suppressed = new Set<T>();
  for (const [, members] of Array.from(groups.entries())) {
    if (members.length <= 1) continue;
    const overs = members.filter(m => String(m.betDirection).toLowerCase() === "over");
    const unders = members.filter(m => String(m.betDirection).toLowerCase() === "under");
    if (overs.length === 0 || unders.length === 0) continue;

    type Pair = { over: T; under: T; lineDelta: number };
    const pairs: Pair[] = [];
    for (const o of overs) {
      for (const u of unders) {
        if (!areNearbyLines(o.line, u.line)) continue;
        pairs.push({ over: o, under: u, lineDelta: Math.abs((o.line as number) - (u.line as number)) });
      }
    }
    if (pairs.length === 0) continue;

    let survivor: T = pairs[0].over;
    let survivorPair: Pair = pairs[0];
    for (const p of pairs) {
      if (p.over.probability > survivor.probability) {
        survivor = p.over;
        survivorPair = p;
      }
      if (p.under.probability > survivor.probability) {
        survivor = p.under;
        survivorPair = p;
      }
    }

    const survivorIsOver = String(survivor.betDirection).toLowerCase() === "over";
    const opposite = survivorIsOver ? unders : overs;
    let droppedCount = 0;
    let droppedExample: T | null = null;
    for (const m of opposite) {
      if (areNearbyLines(m.line, survivor.line)) {
        suppressed.add(m);
        droppedCount += 1;
        if (droppedExample === null) droppedExample = m;
      }
    }
    const sameSide = survivorIsOver ? overs : unders;
    for (const m of sameSide) {
      if (m !== survivor && areNearbyLines(m.line, survivor.line)) {
        suppressed.add(m);
      }
    }

    if (droppedCount === 0) continue;

    const cappedProb = Math.min(survivor.probability, 68);
    const edge = Math.max(0, cappedProb - 50);
    const diag: ConflictDiagnostics = survivor.engineDiagnostics ?? {};
    survivor.engineDiagnostics = {
      ...diag,
      confidenceCeilingApplied: true,
      ceilingReason: "conflict_survivor_cap_68",
      finalizerCapReason: "conflict_survivor_cap_68",
      conflictingSideSuppressed: true,
      conflictingSignalSuppressed: true,
      calibrationVersion: "nba-calibration-v2",
      finalizerFinalPct: Math.round(cappedProb * 10) / 10,
    };
    survivor.probability = cappedProb;
    survivor.edge = edge;
    const exampleProb = droppedExample ? droppedExample.probability : Number.NaN;
    const exampleSide = droppedExample ? droppedExample.betDirection : "?";
    console.log(`[NBA_CONFLICT_SUPPRESS] player=${survivor.playerName} market=${survivor.statType} game=${survivor.gameId} keptSide=${survivor.betDirection} keptProb=${cappedProb.toFixed(1)} droppedCount=${droppedCount} exampleSide=${exampleSide} exampleProb=${Number.isFinite(exampleProb) ? exampleProb.toFixed(1) : "n/a"} survivorPairDelta=${survivorPair.lineDelta.toFixed(2)}`);
  }
  return signals.filter(s => !suppressed.has(s));
}
