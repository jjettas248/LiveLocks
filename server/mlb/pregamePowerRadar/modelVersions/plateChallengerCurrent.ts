// The Plate — CHALLENGER policy: current-HEAD behavior, shadow only.
//
// This policy has NO production authority and never will via configuration. It
// exists so every post-July-20 modeling hypothesis keeps being measured against
// the same frozen input the champion saw, and must beat it on recorded outcomes
// before anyone promotes it in a deliberate, reviewed change.
//
// Reproduces HEAD (dcde2e7) exactly:
//   • batted-ball-event shrinkage on Batter Power (7482c91)
//   • Batter Power returns 5 when no core input is present (7482c91)
//   • Pitcher Vulnerability includes contact-allowed + last-3 ERA + rest (7482c91)
//   • Attack Environment gates elite/nuclear labels + borderline suppression (0b66384)
//   • qualification requires >= 2 independent evidence families (c76379d/0730a9d)
//     with the legacy driver-count veto retained (41c8978)
//   • strict availability semantics (7482c91)
//   • driver universe = the keys HEAD counts BEFORE the freeze — atkenv_* keys
//     are appended after positiveDriverCount is taken, so HEAD has never counted
//     them and neither does this policy

import type { PlateModelPolicy } from "./plateModelTypes";
import { PLATE_CHALLENGER_VERSION } from "./plateModelTypes";

export const PLATE_CHALLENGER_POLICY: PlateModelPolicy = {
  version: PLATE_CHALLENGER_VERSION,
  batter: {
    applySampleShrinkage: true,
    unavailableScore: 5,
  },
  pitcher: {
    useContactAllowed: true,
    useRecentForm: true,
    useRestDays: true,
  },
  gates: {
    attackEnvironmentGates: true,
    evidenceFamilyGate: true,
  },
  availability: {
    strictBatterQuality: true,
    strictVenueResolution: true,
  },
  drivers: { universe: "current_head" },
};
