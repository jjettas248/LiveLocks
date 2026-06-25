import sharp from "sharp";

export interface HrShareCardData {
  playerName: string;
  team: string;
  stage: string;
  score10: number | null;
  readinessPct: number | null;
  hrProbPct: number | null;
  headline: string | null;
  buildScore: number | null;
  pitcherVuln: number | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function trunc(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "fire":  return "ATTACK NOW";
    case "ready": return "READY";
    case "build": return "BUILDING";
    case "track": return "TRACKING";
    default:      return stage.toUpperCase();
  }
}

function stageColor(stage: string): string {
  switch (stage) {
    case "fire":  return "#ef4444";
    case "ready": return "#f59e0b";
    case "build": return "#3b82f6";
    default:      return "#64748b";
  }
}

function scoreColor(v: number | null): string {
  if (v == null) return "#64748b";
  if (v >= 8)  return "#22c55e";
  if (v >= 6)  return "#3b82f6";
  if (v >= 4)  return "#f59e0b";
  return "#94a3b8";
}

function barColor(pct: number, isHrProb = false): string {
  if (isHrProb) {
    if (pct >= 35) return "#22c55e";
    if (pct >= 20) return "#a3e635";
    if (pct >= 12) return "#94a3b8";
    if (pct >= 6)  return "#f59e0b";
    return "#ef4444";
  }
  if (pct >= 70) return "#22c55e";
  if (pct >= 55) return "#a3e635";
  if (pct >= 45) return "#94a3b8";
  if (pct >= 35) return "#f59e0b";
  return "#ef4444";
}

// `unit` controls the value label only: "pct" renders "NN%" (reserved for the
// calibrated HR-probability bar), "score10" renders "N.N" on the /10 scale so a
// raw 0-100 readiness/score/index can never be shown as a percent.
function renderBar(
  label: string,
  pct: number | null,
  y: number,
  isHrProb = false,
  unit: "pct" | "score10" = "pct",
): string {
  if (pct == null) return "";
  const clampedPct = Math.min(100, Math.max(0, Math.round(pct)));
  const color = barColor(clampedPct, isHrProb);
  const trackX = 190;
  const trackW = 500;
  const fillW = Math.round(trackW * clampedPct / 100);
  const valueLabel = unit === "score10" ? (clampedPct / 10).toFixed(1) : `${clampedPct}%`;
  const font = "DejaVu Sans, Liberation Sans, Arial, sans-serif";
  return `
  <text x="28" y="${y + 10}" font-family="${font}" font-size="10" fill="#475569">${esc(label)}</text>
  <rect x="${trackX}" y="${y}" width="${trackW}" height="10" rx="5" fill="#1e293b"/>
  <rect x="${trackX}" y="${y}" width="${fillW}" height="10" rx="5" fill="${color}"/>
  <text x="702" y="${y + 10}" font-family="${font}" font-size="10" fill="${color}" font-weight="bold" text-anchor="end">${valueLabel}</text>`;
}

export async function generateHrShareCardPng(data: HrShareCardData): Promise<Buffer> {
  const { playerName, team, stage, score10, readinessPct, hrProbPct, headline, buildScore, pitcherVuln } = data;

  const stageLbl  = esc(stageLabel(stage));
  const stageClr  = stageColor(stage);
  const scoreClr  = scoreColor(score10);
  const scoreStr  = score10 != null ? score10.toFixed(1) : "--";
  // Readiness is a conviction score, NOT a calibrated HR probability — render it
  // on the /10 scale, never as a "%". Only HR Probability earns a percent.
  const readStr   = readinessPct != null ? (Math.min(100, Math.max(0, readinessPct)) / 10).toFixed(1) : "--";
  const probStr   = hrProbPct != null ? `${Math.round(hrProbPct)}%` : "--";
  const playerStr = esc(trunc(playerName, 26));
  const teamStr   = esc(trunc(team, 32));
  const hdStr     = headline ? esc(trunc(headline, 72)) : "";

  const formationPct = buildScore != null ? Math.min(100, Math.round(buildScore * 10)) : null;

  const breakdownBars = [
    renderBar("Formation",    formationPct,                                    358, false, "score10"),
    renderBar("Readiness",    readinessPct,                                    382, false, "score10"),
    renderBar("HR Probability", hrProbPct,                                     406, true),
    renderBar("Pitcher Vuln", pitcherVuln != null ? Math.round(pitcherVuln) : null, 430, false, "score10"),
  ].join("");

  const font = "DejaVu Sans, Liberation Sans, Arial, sans-serif";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="800" height="520" viewBox="0 0 800 520" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="800" y2="520" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#090d1a"/>
      <stop offset="100%" stop-color="#0c1425"/>
    </linearGradient>
  </defs>

  <rect width="800" height="520" fill="url(#bg)"/>
  <rect x="0" y="0" width="5" height="520" fill="${stageClr}"/>
  <rect x="0" y="0" width="800" height="1" fill="${stageClr}" opacity="0.3"/>
  <rect x="0" y="519" width="800" height="1" fill="${stageClr}" opacity="0.15"/>

  <!-- Header -->
  <text x="28" y="46" font-family="${font}" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2.5">HR RADAR ALERT</text>

  <!-- Stage badge -->
  <rect x="594" y="24" width="178" height="30" rx="4" fill="${stageClr}" opacity="0.12"/>
  <rect x="594" y="24" width="178" height="30" rx="4" fill="none" stroke="${stageClr}" stroke-width="1.2"/>
  <text x="683" y="45" font-family="${font}" font-size="11" fill="${stageClr}" font-weight="bold" letter-spacing="1.5" text-anchor="middle">${stageLbl}</text>

  <!-- Player name -->
  <text x="28" y="112" font-family="${font}" font-size="48" fill="#f1f5f9" font-weight="bold">${playerStr}</text>

  <!-- Team -->
  <text x="30" y="144" font-family="${font}" font-size="17" fill="#64748b">${teamStr}</text>

  <!-- Divider -->
  <line x1="28" y1="164" x2="772" y2="164" stroke="#1e293b" stroke-width="1.5"/>

  <!-- Stat labels -->
  <text x="100" y="196" font-family="${font}" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2" text-anchor="middle">SCORE</text>
  <text x="310" y="196" font-family="${font}" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2" text-anchor="middle">READINESS</text>
  <text x="520" y="196" font-family="${font}" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2" text-anchor="middle">HR PROB</text>

  <!-- Stat values -->
  <text x="100" y="248" font-family="${font}" font-size="44" fill="${scoreClr}" font-weight="bold" text-anchor="middle">${scoreStr}</text>
  <text x="100" y="268" font-family="${font}" font-size="12" fill="#334155" text-anchor="middle">/ 10</text>
  <text x="310" y="248" font-family="${font}" font-size="44" fill="#22c55e" font-weight="bold" text-anchor="middle">${readStr}</text>
  <text x="310" y="268" font-family="${font}" font-size="12" fill="#334155" text-anchor="middle">/ 10</text>
  <text x="520" y="248" font-family="${font}" font-size="44" fill="#f59e0b" font-weight="bold" text-anchor="middle">${probStr}</text>

  <!-- Stat dividers -->
  <line x1="200" y1="180" x2="200" y2="282" stroke="#1e293b" stroke-width="1"/>
  <line x1="410" y1="180" x2="410" y2="282" stroke="#1e293b" stroke-width="1"/>

  <!-- Divider -->
  <line x1="28" y1="294" x2="772" y2="294" stroke="#1e293b" stroke-width="1.5"/>

  <!-- Headline -->
  <text x="28" y="326" font-family="${font}" font-size="15" fill="#94a3b8" font-style="italic">${hdStr ? `"${hdStr}"` : ""}</text>

  <!-- HR Breakdown section -->
  <line x1="28" y1="342" x2="772" y2="342" stroke="#1e293b" stroke-width="1"/>
  <text x="28" y="357" font-family="${font}" font-size="9" fill="#334155" font-weight="bold" letter-spacing="2">HR BREAKDOWN</text>
  ${breakdownBars}

  <!-- Bottom bar -->
  <line x1="28" y1="460" x2="772" y2="460" stroke="#1e293b" stroke-width="1"/>
  <text x="28" y="487" font-family="${font}" font-size="13" fill="#3b82f6" font-weight="bold">LiveLocks</text>
  <text x="101" y="487" font-family="${font}" font-size="13" fill="#334155"> by PropPulse</text>
  <text x="772" y="487" font-family="${font}" font-size="11" fill="#334155" text-anchor="end">@LiveLocksApp</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
