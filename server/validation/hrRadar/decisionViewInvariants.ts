/**
 * HR Radar consumer decision view — validation harness.
 *
 * Sibling to ladderInvariants.ts (which validates the legacy `sections`
 * shape). This validates `server/mlb/hrRadarDecisionView.ts`'s output: the
 * `entries`/`groups`/`counts` referential integrity and the CTA-gating
 * invariants the consumer contract depends on. Pure function so it can run
 * from a script, an admin endpoint, or a test.
 */

import type { HrRadarDecisionView } from "../../../shared/hrRadarDecisionView";

export interface DecisionViewInvariantViolation {
  code: string;
  message: string;
  entryId?: string;
}

export interface DecisionViewInvariantReport {
  totalEntries: number;
  violations: DecisionViewInvariantViolation[];
}

const LIVE_GROUPS = ["takeNow", "watchNextAb", "build", "watch", "waitingForFirstAb"] as const;
const RESULT_GROUPS = ["signalHits", "officialMisses", "modelReview"] as const;

/**
 * Validate a decision view against its own contract.
 *
 * Invariants enforced:
 *  D1  Every `groups.*` entryId resolves to a key in `entries`.
 *  D2  No entryId appears in more than one of the mutually-exclusive live
 *      groups (takeNow/watchNextAb/build/watchNextAb/waitingForFirstAb).
 *  D3  No entryId appears in more than one of the mutually-exclusive result
 *      groups (signalHits/officialMisses/modelReview).
 *  D4  `canAddToSlip === true` implies `liveStage === "fire"`.
 *  D5  `canWatchNextAb === true` implies `liveStage === "ready"`.
 *  D6  Every `counts.*` equals its corresponding array's length (except
 *      `forming` = build+watch and `liveTracked` = sum of the four live
 *      groups, which are derived sums, not 1:1 array lengths).
 *  D7  `modelReview` entries never appear in `signalHits`/`officialMisses`.
 *  D8  A resolved entry (`isResolved === true`) never appears in a live
 *      group, and a live entry never appears in a result group.
 */
export function validateHrRadarDecisionView(
  view: HrRadarDecisionView<unknown>,
): DecisionViewInvariantReport {
  const violations: DecisionViewInvariantViolation[] = [];
  const push = (code: string, message: string, entryId?: string) => {
    violations.push({ code, message, entryId });
  };

  const entryIds = new Set(Object.keys(view.entries));
  const groupMembership: Record<string, string[]> = {};
  const recordMembership = (groupName: string, ids: string[]) => {
    for (const id of ids) {
      groupMembership[id] = [...(groupMembership[id] ?? []), groupName];
    }
  };

  const allGroupNames = [...LIVE_GROUPS, ...RESULT_GROUPS] as const;
  for (const groupName of allGroupNames) {
    const ids = view.groups[groupName] ?? [];
    recordMembership(groupName, ids);
    for (const id of ids) {
      // D1
      if (!entryIds.has(id)) {
        push("D1_ORPHAN_GROUP_ID", `groups.${groupName} references unknown entryId`, id);
      }
    }
  }

  for (const [id, groups] of Object.entries(groupMembership)) {
    const liveHits = groups.filter((g) => (LIVE_GROUPS as readonly string[]).includes(g));
    if (liveHits.length > 1) {
      push("D2_DUPLICATE_LIVE_GROUP", `entryId is in more than one live group: ${liveHits.join(",")}`, id);
    }
    const resultHits = groups.filter((g) => (RESULT_GROUPS as readonly string[]).includes(g));
    if (resultHits.length > 1) {
      push("D3_DUPLICATE_RESULT_GROUP", `entryId is in more than one result group: ${resultHits.join(",")}`, id);
    }
    // D7 — modelReview mutual exclusivity with the two public result buckets
    // is already covered by D3 (they're all in RESULT_GROUPS), but assert it
    // explicitly since it's the specific consumer-safety guarantee this
    // module exists to protect.
    if (groups.includes("modelReview") && (groups.includes("signalHits") || groups.includes("officialMisses"))) {
      push("D7_MODEL_REVIEW_LEAK", "modelReview entry also appears in a public result bucket", id);
    }
  }

  for (const [id, entry] of Object.entries(view.entries)) {
    // D4
    if (entry.canAddToSlip && entry.liveStage !== "fire") {
      push("D4_CAN_ADD_TO_SLIP_NOT_FIRE", `canAddToSlip=true but liveStage=${entry.liveStage}`, id);
    }
    // D5
    if (entry.canWatchNextAb && entry.liveStage !== "ready") {
      push("D5_CAN_WATCH_NOT_READY", `canWatchNextAb=true but liveStage=${entry.liveStage}`, id);
    }
    // D8
    const groups = groupMembership[id] ?? [];
    const inLiveGroup = groups.some((g) => (LIVE_GROUPS as readonly string[]).includes(g));
    const inResultGroup = groups.some((g) => (RESULT_GROUPS as readonly string[]).includes(g));
    if (entry.isResolved && inLiveGroup) {
      push("D8_RESOLVED_IN_LIVE_GROUP", "resolved entry appears in a live group", id);
    }
    if (!entry.isResolved && inResultGroup) {
      push("D8_LIVE_IN_RESULT_GROUP", "live entry appears in a result group", id);
    }
  }

  // D6
  const c = view.counts;
  const g = view.groups;
  const expectCount = (label: string, actual: number, expected: number) => {
    if (actual !== expected) {
      push("D6_COUNT_MISMATCH", `counts.${label}=${actual} but expected ${expected}`);
    }
  };
  expectCount("takeNow", c.takeNow, g.takeNow.length);
  expectCount("watchNextAb", c.watchNextAb, g.watchNextAb.length);
  expectCount("build", c.build, g.build.length);
  expectCount("watch", c.watch, g.watch.length);
  expectCount("waitingForFirstAb", c.waitingForFirstAb, g.waitingForFirstAb.length);
  expectCount("forming", c.forming, g.build.length + g.watch.length);
  expectCount(
    "liveTracked",
    c.liveTracked,
    g.takeNow.length + g.watchNextAb.length + g.build.length + g.watch.length,
  );
  expectCount("fireHitsToday", c.fireHitsToday, g.signalHits.length);
  expectCount("fireMissesToday", c.fireMissesToday, g.officialMisses.length);
  expectCount("modelReview", c.modelReview, g.modelReview.length);

  return { totalEntries: entryIds.size, violations };
}
