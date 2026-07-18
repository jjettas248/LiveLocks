// Canonical letter-grade helper for Pre-Game Radar surfaces (The Mound / The Plate).
//
// Extracted verbatim from MoundPowerRadar.tsx — thresholds, return values, and
// grade names are unchanged. Display-only: never re-derives score10 or tier,
// just formats the existing server-stamped score10 as a letter grade.

export function getSetupGrade(score10: number): string {
  if (score10 >= 8.5) return "A+";
  if (score10 >= 7.5) return "A";
  if (score10 >= 6.5) return "B+";
  if (score10 >= 5.5) return "B";
  if (score10 >= 4.5) return "C";
  return "D";
}
