import sharp from "sharp";

export interface HrShareCardData {
  playerName: string;
  team: string;
  stage: string;
  score10: number | null;
  readinessPct: number | null;
  hrProbPct: number | null;
  headline: string | null;
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

export async function generateHrShareCardPng(data: HrShareCardData): Promise<Buffer> {
  const { playerName, team, stage, score10, readinessPct, hrProbPct, headline } = data;

  const stageLbl  = esc(stageLabel(stage));
  const stageClr  = stageColor(stage);
  const scoreClr  = scoreColor(score10);
  const scoreStr  = score10 != null ? score10.toFixed(1) : "--";
  const readStr   = readinessPct != null ? `${Math.round(readinessPct)}%` : "--";
  const probStr   = hrProbPct != null ? `${Math.round(hrProbPct)}%` : "--";
  const playerStr = esc(trunc(playerName, 26));
  const teamStr   = esc(trunc(team, 32));
  const hdStr     = headline ? esc(trunc(headline, 68)) : "";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="800" height="418" viewBox="0 0 800 418" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="800" y2="418" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#090d1a"/>
      <stop offset="100%" stop-color="#0c1425"/>
    </linearGradient>
  </defs>

  <rect width="800" height="418" fill="url(#bg)"/>
  <rect x="0" y="0" width="5" height="418" fill="${stageClr}"/>
  <rect x="0" y="0" width="800" height="1" fill="${stageClr}" opacity="0.3"/>
  <rect x="0" y="417" width="800" height="1" fill="${stageClr}" opacity="0.15"/>

  <!-- Header row -->
  <text x="28" y="48" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2.5">HR RADAR ALERT</text>

  <!-- Stage badge (right-aligned) -->
  <rect x="594" y="26" width="178" height="30" rx="4" fill="${stageClr}" opacity="0.12"/>
  <rect x="594" y="26" width="178" height="30" rx="4" fill="none" stroke="${stageClr}" stroke-width="1.2"/>
  <text x="683" y="47" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="11" fill="${stageClr}" font-weight="bold" letter-spacing="1.5" text-anchor="middle">${stageLbl}</text>

  <!-- Player name -->
  <text x="28" y="116" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="48" fill="#f1f5f9" font-weight="bold">${playerStr}</text>

  <!-- Team -->
  <text x="30" y="148" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="17" fill="#64748b">${teamStr}</text>

  <!-- Divider -->
  <line x1="28" y1="170" x2="772" y2="170" stroke="#1e293b" stroke-width="1.5"/>

  <!-- Stat labels -->
  <text x="100" y="203" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2" text-anchor="middle">SCORE</text>
  <text x="310" y="203" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2" text-anchor="middle">READINESS</text>
  <text x="520" y="203" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="10" fill="#475569" font-weight="bold" letter-spacing="2" text-anchor="middle">HR PROB</text>

  <!-- Stat values -->
  <text x="100" y="258" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="44" fill="${scoreClr}" font-weight="bold" text-anchor="middle">${scoreStr}</text>
  <text x="100" y="278" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="12" fill="#334155" text-anchor="middle">/ 10</text>

  <text x="310" y="258" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="44" fill="#22c55e" font-weight="bold" text-anchor="middle">${readStr}</text>

  <text x="520" y="258" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="44" fill="#f59e0b" font-weight="bold" text-anchor="middle">${probStr}</text>

  <!-- Stat dividers -->
  <line x1="200" y1="188" x2="200" y2="290" stroke="#1e293b" stroke-width="1"/>
  <line x1="410" y1="188" x2="410" y2="290" stroke="#1e293b" stroke-width="1"/>

  <!-- Divider -->
  <line x1="28" y1="302" x2="772" y2="302" stroke="#1e293b" stroke-width="1.5"/>

  <!-- Headline -->
  <text x="28" y="338" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="16" fill="#94a3b8" font-style="italic">${hdStr ? `"${hdStr}"` : ""}</text>

  <!-- Bottom bar -->
  <line x1="28" y1="372" x2="772" y2="372" stroke="#1e293b" stroke-width="1"/>
  <text x="28" y="398" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="13" fill="#3b82f6" font-weight="bold">LiveLocks</text>
  <text x="101" y="398" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="13" fill="#334155"> by PropPulse</text>
  <text x="772" y="398" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="13" fill="#334155" text-anchor="end">livelocks.com</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
