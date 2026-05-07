// ── LiveLocks Batch B — Mutation Guard ────────────────────────────────
// Detects post-bus mutation of immutable CanonicalSignal fields. Never
// throws — always diagnostic — so a misbehaving consumer cannot crash a
// live cycle. The guard is the trip wire that keeps engine math, side,
// market, drivers, and signalTier honest after they leave the engine.

import type { CanonicalSignal } from "../../shared/canonicalSignal";
import { IMMUTABLE_FIELDS } from "../../shared/canonicalSignal";

const _hashes = new Map<string, string>();

function shallowHash(sig: CanonicalSignal): string {
  // Stable JSON of just the immutable subset. Order matters → use the
  // canonical IMMUTABLE_FIELDS order.
  const obj: Record<string, unknown> = {};
  for (const k of IMMUTABLE_FIELDS) obj[k as string] = (sig as any)[k];
  return JSON.stringify(obj);
}

/**
 * Deep-freeze the immutable subset on a canonical signal. Lifecycle
 * fields stay mutable so the lifecycle engine can still progress state.
 * Returns the same reference (frozen in place where possible).
 */
export function freezeCanonical(sig: CanonicalSignal): CanonicalSignal {
  // Freeze nested driver array elements so consumers cannot reach in
  // and edit a driver label or weight after the bus.
  if (Array.isArray(sig.drivers)) {
    for (const d of sig.drivers) Object.freeze(d);
    Object.freeze(sig.drivers);
  }
  // We can't Object.freeze the whole signal because the lifecycle
  // engine intentionally produces new objects with mutated lifecycle
  // fields. Instead we freeze just the immutable scalar references that
  // can be sub-mutated.
  return sig;
}

/**
 * First call for a signalId records the immutable-field hash. Every
 * subsequent call recomputes and compares. Mismatch → diagnostic log
 * with the offending fields. Never throws.
 *
 * Call sites:
 *   - Routes that surface canonical signals (after fetching from store)
 *   - SignalBus boundary (Batch C)
 */
export function assertNoSignalMutationAfterBus(sig: CanonicalSignal): boolean {
  const cur = shallowHash(sig);
  const prev = _hashes.get(sig.signalId);
  if (prev === undefined) {
    _hashes.set(sig.signalId, cur);
    return true;
  }
  if (prev === cur) return true;

  // Find which immutable field actually changed for a useful log line.
  const prevObj = JSON.parse(prev);
  const curObj = JSON.parse(cur);
  const diffs: string[] = [];
  for (const k of IMMUTABLE_FIELDS) {
    if (JSON.stringify(prevObj[k as string]) !== JSON.stringify(curObj[k as string])) {
      diffs.push(k as string);
    }
  }
  console.warn(
    `[LL_SIGNAL_MUTATION_DETECTED] signalId=${sig.signalId} fields=[${diffs.join(",")}]`
  );
  // Update hash to current so we don't spam the same diff every cycle.
  _hashes.set(sig.signalId, cur);
  return false;
}

export function _resetMutationGuardForTests() {
  _hashes.clear();
}
