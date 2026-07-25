// The Plate — CHAMPION policy: the July-20 decision policy, restored.
//
// This policy has production authority. It is hard-coded: no environment
// variable, flag, or config can promote the challenger in its place.
//
// Restored to July 20 (749c148):
//   • no batted-ball-event sample shrinkage on Batter Power
//   • Batter Power returns 0 (not 5) when no core input is present
//   • Pitcher Vulnerability scores on handedness HR/9 + ERA only
//   • Attack Environment gates nothing (tier labels, suppression, score)
//   • qualification is positiveDriverCount >= 2, over the July-20 driver universe
//   • loose availability semantics (park factor present; component availability)
//
// Deliberately NOT restored (kept from post-July-20 work — see §2 of the plan):
//   • BvP sample discipline (ec8ae2d) — shared with the challenger
//   • Open-Meteo weather fallback — a real new data source, not a redefinition
//   • removal of the pitcher-handedness "R" default — factual correctness, and
//     rosterService.ts is shared with the Mound engine
//   • all grading, persistence, lifecycle, and UI work

import type { PlateModelPolicy } from "./plateModelTypes";
import { PLATE_CHAMPION_VERSION } from "./plateModelTypes";

export const PLATE_CHAMPION_POLICY: PlateModelPolicy = {
  version: PLATE_CHAMPION_VERSION,
  batter: {
    applySampleShrinkage: false,
    unavailableScore: 0,
  },
  pitcher: {
    useContactAllowed: false,
    useRecentForm: false,
    useRestDays: false,
  },
  gates: {
    attackEnvironmentGates: false,
    evidenceFamilyGate: false,
  },
  availability: {
    strictBatterQuality: false,
    strictVenueResolution: false,
  },
  drivers: { universe: "jul20_restored" },
};
