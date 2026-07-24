// Pre-Game Power Radar — 2026 Statcast outfield geometry.
//
// Source: Baseball Savant Statcast Park Factors → Dimensions, 2026.
// Snapshot deliberately lives in code so a mid-day upstream page change cannot
// alter a frozen pregame read. Refresh this table explicitly when a park changes.
//
// Distances/heights are the five standard Savant points. `avgHrDistanceFt` is
// Savant's average HR distance requirement (fence distance + height sampled
// through the outfield), not a model output from LiveLocks.

export interface ParkDimensions2026 {
  venueName: string;
  lfLineFt: number;
  lfGapFt: number;
  cfFt: number;
  rfGapFt: number;
  rfLineFt: number;
  lfLineHeightFt: number;
  lfGapHeightFt: number;
  cfHeightFt: number;
  rfGapHeightFt: number;
  rfLineHeightFt: number;
  avgFenceDistanceFt: number;
  avgFenceHeightFt: number;
  avgHrDistanceFt: number;
}

export interface PullSideParkGeometry {
  pullFenceDistanceFt: number;
  pullFenceHeightFt: number;
  avgFenceDistanceFt: number;
  avgFenceHeightFt: number;
  avgHrDistanceFt: number;
  effectiveBatSide: "L" | "R" | null;
}

const ROWS: ParkDimensions2026[] = [
  { venueName: "Coors Field", lfLineFt:347, lfGapFt:408, cfFt:415, rfGapFt:385, rfLineFt:351, lfLineHeightFt:12, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:16, rfLineHeightFt:16, avgFenceDistanceFt:386, avgFenceHeightFt:11.6, avgHrDistanceFt:397 },
  { venueName: "Chase Field", lfLineFt:329, lfGapFt:389, cfFt:406, rfGapFt:389, rfLineFt:334, lfLineHeightFt:8, lfGapHeightFt:7, cfHeightFt:24, rfGapHeightFt:7, rfLineHeightFt:8, avgFenceDistanceFt:380, avgFenceHeightFt:11.7, avgHrDistanceFt:392 },
  { venueName: "Kauffman Stadium", lfLineFt:324, lfGapFt:384, cfFt:410, rfGapFt:385, rfLineFt:324, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:8, avgFenceDistanceFt:378, avgFenceHeightFt:8.0, avgHrDistanceFt:386 },
  { venueName: "Busch Stadium", lfLineFt:335, lfGapFt:390, cfFt:400, rfGapFt:391, rfLineFt:335, lfLineHeightFt:7, lfGapHeightFt:7, cfHeightFt:7, rfGapHeightFt:7, rfLineHeightFt:7, avgFenceDistanceFt:377, avgFenceHeightFt:7.4, avgHrDistanceFt:385 },
  { venueName: "Comerica Park", lfLineFt:343, lfGapFt:384, cfFt:412, rfGapFt:391, rfLineFt:327, lfLineHeightFt:8, lfGapHeightFt:7, cfHeightFt:7, rfGapHeightFt:7, rfLineHeightFt:9, avgFenceDistanceFt:377, avgFenceHeightFt:6.7, avgHrDistanceFt:383 },
  { venueName: "Globe Life Field", lfLineFt:328, lfGapFt:381, cfFt:406, rfGapFt:373, rfLineFt:321, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:6, rfLineHeightFt:8, avgFenceDistanceFt:377, avgFenceHeightFt:7.8, avgHrDistanceFt:384 },
  { venueName: "Angel Stadium", lfLineFt:330, lfGapFt:386, cfFt:398, rfGapFt:369, rfLineFt:330, lfLineHeightFt:3, lfGapHeightFt:7, cfHeightFt:7, rfGapHeightFt:7, rfLineHeightFt:3, avgFenceDistanceFt:375, avgFenceHeightFt:6.1, avgHrDistanceFt:381 },
  { venueName: "loanDepot park", lfLineFt:344, lfGapFt:387, cfFt:396, rfGapFt:384, rfLineFt:335, lfLineHeightFt:11, lfGapHeightFt:11, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:11, avgFenceDistanceFt:374, avgFenceHeightFt:8.6, avgHrDistanceFt:383 },
  { venueName: "Tropicana Field", lfLineFt:313, lfGapFt:383, cfFt:404, rfGapFt:384, rfLineFt:320, lfLineHeightFt:5, lfGapHeightFt:11, cfHeightFt:9, rfGapHeightFt:11, rfLineHeightFt:9, avgFenceDistanceFt:374, avgFenceHeightFt:10.3, avgHrDistanceFt:384 },
  { venueName: "Truist Park", lfLineFt:335, lfGapFt:386, cfFt:400, rfGapFt:379, rfLineFt:326, lfLineHeightFt:5, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:15, rfLineHeightFt:15, avgFenceDistanceFt:374, avgFenceHeightFt:10.1, avgHrDistanceFt:384 },
  { venueName: "PNC Park", lfLineFt:324, lfGapFt:400, cfFt:398, rfGapFt:378, rfLineFt:319, lfLineHeightFt:5, lfGapHeightFt:5, cfHeightFt:10, rfGapHeightFt:10, rfLineHeightFt:22, avgFenceDistanceFt:373, avgFenceHeightFt:11.1, avgHrDistanceFt:384 },
  { venueName: "Sutter Health Park", lfLineFt:330, lfGapFt:386, cfFt:401, rfGapFt:375, rfLineFt:324, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:5, rfLineHeightFt:13, avgFenceDistanceFt:373, avgFenceHeightFt:7.1, avgHrDistanceFt:380 },
  { venueName: "American Family Field", lfLineFt:341, lfGapFt:371, cfFt:399, rfGapFt:377, rfLineFt:345, lfLineHeightFt:15, lfGapHeightFt:7, cfHeightFt:7, rfGapHeightFt:7, rfLineHeightFt:7, avgFenceDistanceFt:372, avgFenceHeightFt:6.9, avgHrDistanceFt:379 },
  { venueName: "Oracle Park", lfLineFt:340, lfGapFt:377, cfFt:391, rfGapFt:411, rfLineFt:304, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:9, rfGapHeightFt:7, rfLineHeightFt:24, avgFenceDistanceFt:371, avgFenceHeightFt:12.1, avgHrDistanceFt:383 },
  { venueName: "Nationals Park", lfLineFt:336, lfGapFt:377, cfFt:402, rfGapFt:370, rfLineFt:335, lfLineHeightFt:9, lfGapHeightFt:8, cfHeightFt:7, rfGapHeightFt:14, rfLineHeightFt:16, avgFenceDistanceFt:371, avgFenceHeightFt:9.8, avgHrDistanceFt:381 },
  { venueName: "Petco Park", lfLineFt:335, lfGapFt:381, cfFt:396, rfGapFt:389, rfLineFt:322, lfLineHeightFt:4, lfGapHeightFt:6, cfHeightFt:7, rfGapHeightFt:7, rfLineHeightFt:10, avgFenceDistanceFt:371, avgFenceHeightFt:6.7, avgHrDistanceFt:377 },
  { venueName: "Oriole Park at Camden Yards", lfLineFt:333, lfGapFt:371, cfFt:400, rfGapFt:386, rfLineFt:318, lfLineHeightFt:6, lfGapHeightFt:6, cfHeightFt:6, rfGapHeightFt:6, rfLineHeightFt:20, avgFenceDistanceFt:371, avgFenceHeightFt:9.0, avgHrDistanceFt:380 },
  { venueName: "Target Field", lfLineFt:338, lfGapFt:382, cfFt:404, rfGapFt:373, rfLineFt:328, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:23, rfLineHeightFt:20, avgFenceDistanceFt:370, avgFenceHeightFt:13.9, avgHrDistanceFt:384 },
  { venueName: "Citi Field", lfLineFt:334, lfGapFt:368, cfFt:407, rfGapFt:372, rfLineFt:330, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:10, avgFenceDistanceFt:370, avgFenceHeightFt:8.2, avgHrDistanceFt:378 },
  { venueName: "Dodger Stadium", lfLineFt:327, lfGapFt:372, cfFt:395, rfGapFt:372, rfLineFt:326, lfLineHeightFt:4, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:3, avgFenceDistanceFt:369, avgFenceHeightFt:7.0, avgHrDistanceFt:376 },
  { venueName: "Yankee Stadium", lfLineFt:318, lfGapFt:392, cfFt:408, rfGapFt:364, rfLineFt:313, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:8, avgFenceDistanceFt:369, avgFenceHeightFt:8.1, avgHrDistanceFt:377 },
  { venueName: "Rate Field", lfLineFt:328, lfGapFt:379, cfFt:400, rfGapFt:380, rfLineFt:335, lfLineHeightFt:7, lfGapHeightFt:7, cfHeightFt:7, rfGapHeightFt:7, rfLineHeightFt:7, avgFenceDistanceFt:369, avgFenceHeightFt:6.6, avgHrDistanceFt:375 },
  { venueName: "Wrigley Field", lfLineFt:354, lfGapFt:356, cfFt:397, rfGapFt:379, rfLineFt:349, lfLineHeightFt:11, lfGapHeightFt:11, cfHeightFt:11, rfGapHeightFt:11, rfLineHeightFt:11, avgFenceDistanceFt:368, avgFenceHeightFt:11.2, avgHrDistanceFt:379 },
  { venueName: "T-Mobile Park", lfLineFt:331, lfGapFt:379, cfFt:401, rfGapFt:382, rfLineFt:327, lfLineHeightFt:8, lfGapHeightFt:8, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:8, avgFenceDistanceFt:367, avgFenceHeightFt:7.6, avgHrDistanceFt:375 },
  { venueName: "Progressive Field", lfLineFt:325, lfGapFt:368, cfFt:400, rfGapFt:375, rfLineFt:325, lfLineHeightFt:20, lfGapHeightFt:20, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:12, avgFenceDistanceFt:366, avgFenceHeightFt:13.4, avgHrDistanceFt:379 },
  { venueName: "Rogers Centre", lfLineFt:328, lfGapFt:381, cfFt:400, rfGapFt:373, rfLineFt:328, lfLineHeightFt:14, lfGapHeightFt:10, cfHeightFt:8, rfGapHeightFt:11, rfLineHeightFt:12, avgFenceDistanceFt:365, avgFenceHeightFt:11.9, avgHrDistanceFt:377 },
  { venueName: "Citizens Bank Park", lfLineFt:328, lfGapFt:375, cfFt:402, rfGapFt:370, rfLineFt:330, lfLineHeightFt:11, lfGapHeightFt:10, cfHeightFt:6, rfGapHeightFt:12, rfLineHeightFt:12, avgFenceDistanceFt:365, avgFenceHeightFt:10.3, avgHrDistanceFt:375 },
  { venueName: "Great American Ball Park", lfLineFt:328, lfGapFt:376, cfFt:404, rfGapFt:368, rfLineFt:324, lfLineHeightFt:11, lfGapHeightFt:11, cfHeightFt:8, rfGapHeightFt:8, rfLineHeightFt:12, avgFenceDistanceFt:364, avgFenceHeightFt:8.9, avgHrDistanceFt:373 },
  { venueName: "Daikin Park", lfLineFt:315, lfGapFt:367, cfFt:409, rfGapFt:378, rfLineFt:325, lfLineHeightFt:18, lfGapHeightFt:24, cfHeightFt:9, rfGapHeightFt:10, rfLineHeightFt:6, avgFenceDistanceFt:364, avgFenceHeightFt:12.6, avgHrDistanceFt:377 },
  { venueName: "Fenway Park", lfLineFt:309, lfGapFt:345, cfFt:388, rfGapFt:378, rfLineFt:299, lfLineHeightFt:37, lfGapHeightFt:37, cfHeightFt:17, rfGapHeightFt:4, rfLineHeightFt:4, avgFenceDistanceFt:362, avgFenceHeightFt:20.3, avgHrDistanceFt:382 },
];

const ALIASES: Record<string, string> = {
  "guaranteed rate field": "rate field",
  "minute maid park": "daikin park",
  "oakland coliseum": "sutter health park",
  "coliseum": "sutter health park",
  "oriole park": "oriole park at camden yards",
  "camden yards": "oriole park at camden yards",
  "great american": "great american ball park",
  "rogers center": "rogers centre",
  "loandepot park": "loandepot park",
  "loandepot": "loandepot park",
};

function norm(v: string | null | undefined): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const BY_NAME = new Map(ROWS.map((r) => [norm(r.venueName), r]));

export function getParkDimensions2026(venueName: string | null | undefined): ParkDimensions2026 | null {
  const key = norm(venueName);
  if (!key) return null;
  const alias = ALIASES[key] ?? key;
  return BY_NAME.get(alias) ?? null;
}

function effectiveBatSide(
  batterHand: "L" | "R" | "S" | null,
  pitcherThrows: "L" | "R" | null,
): "L" | "R" | null {
  if (batterHand === "L" || batterHand === "R") return batterHand;
  if (batterHand === "S") {
    if (pitcherThrows === "L") return "R";
    if (pitcherThrows === "R") return "L";
  }
  return null;
}

/**
 * Resolve the geometry a pulled HR is most likely to challenge. A pull ball is
 * not aimed exclusively at the foul pole, so the distance/height uses a 45/55
 * line-to-gap blend. This is a documented shadow prior to be fitted/ablated,
 * not a claimed physical law.
 */
export function getPullSideParkGeometry(
  venueName: string | null | undefined,
  batterHand: "L" | "R" | "S" | null,
  pitcherThrows: "L" | "R" | null,
): PullSideParkGeometry | null {
  const park = getParkDimensions2026(venueName);
  if (!park) return null;
  const side = effectiveBatSide(batterHand, pitcherThrows);

  const leftDistance = park.lfLineFt * 0.45 + park.lfGapFt * 0.55;
  const rightDistance = park.rfLineFt * 0.45 + park.rfGapFt * 0.55;
  const leftHeight = park.lfLineHeightFt * 0.45 + park.lfGapHeightFt * 0.55;
  const rightHeight = park.rfLineHeightFt * 0.45 + park.rfGapHeightFt * 0.55;

  // RHH pulls to LF; LHH pulls to RF. If switch-side cannot be resolved because
  // pitcher hand is unknown, use the mean of both corners rather than guessing.
  const pullFenceDistanceFt = side === "R" ? leftDistance : side === "L" ? rightDistance : (leftDistance + rightDistance) / 2;
  const pullFenceHeightFt = side === "R" ? leftHeight : side === "L" ? rightHeight : (leftHeight + rightHeight) / 2;

  return {
    pullFenceDistanceFt,
    pullFenceHeightFt,
    avgFenceDistanceFt: park.avgFenceDistanceFt,
    avgFenceHeightFt: park.avgFenceHeightFt,
    avgHrDistanceFt: park.avgHrDistanceFt,
    effectiveBatSide: side,
  };
}

export const PARK_DIMENSIONS_2026_COUNT = ROWS.length;
