import { useState } from "react";
import { Activity, TrendingUp, TrendingDown, Zap } from "lucide-react";
import { Card } from "@/components/ui/card";

type Tab = "nba-live" | "2h-plays" | "ncaab";

const PLAYER_CARDS = [
  {
    name: "Bilal Coulibaly",
    team: "WAS",
    matchup: "WAS @ HOU",
    stat: "Pts+Reb",
    direction: "Over" as const,
    line: 19.5,
    h1: 15,
    proj2H: 13.1,
    probability: 84.4,
    edge: "strong" as const,
  },
  {
    name: "Dennis Schroder",
    team: "CLE",
    matchup: "CLE vs DET",
    stat: "Points",
    direction: "Under" as const,
    line: 13.5,
    h1: 6,
    proj2H: 9.6,
    probability: 86.7,
    edge: "under" as const,
  },
  {
    name: "Jalen Duren",
    team: "DET",
    matchup: "DET vs CLE",
    stat: "Pts+Reb",
    direction: "Over" as const,
    line: 34.5,
    h1: 19,
    proj2H: 14.1,
    probability: 44.5,
    edge: "over" as const,
  },
];

export function DashboardPreview() {
  const [activeTab, setActiveTab] = useState<Tab>("nba-live");

  const tabs: { id: Tab; label: string }[] = [
    { id: "nba-live", label: "NBA Live" },
    { id: "2h-plays", label: "2H Plays" },
    { id: "ncaab", label: "NCAAB" },
  ];

  return (
    <div data-testid="dashboard-preview" className="w-full bg-[#080808] text-white font-sans select-none overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 bg-[#0f0f0f] border-b border-white/[0.08]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
            <Activity size={14} className="text-white" />
          </div>
          <div>
            <div className="font-extrabold text-[13px] tracking-tight leading-none text-white">LiveLocks</div>
            <div className="text-[9px] text-white/30 tracking-[0.15em] mt-0.5">BY PROPPULSE · NBA</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-emerald-400 text-[11px] font-semibold bg-emerald-400/10 border border-emerald-400/20 px-2.5 py-1 rounded-md">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
          </span>
          2 live games
        </div>
      </div>

      <div className="flex items-center gap-1 px-5 py-2.5 bg-[#0c0c0c] border-b border-white/[0.06]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`text-[12px] font-bold px-4 py-2 rounded-lg border transition-all ${
              activeTab === tab.id
                ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-600/30"
                : "bg-white/[0.04] border-white/[0.10] text-white/50 hover:bg-white/[0.09] hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="p-5 grid grid-cols-3 gap-3">
        {PLAYER_CARDS.map((card) => (
          <PropCard key={card.name + card.stat} {...card} />
        ))}
      </div>
    </div>
  );
}

function PropCard({
  name,
  team,
  matchup,
  stat,
  direction,
  line,
  h1,
  proj2H,
  probability,
  edge,
}: {
  name: string;
  team: string;
  matchup: string;
  stat: string;
  direction: "Over" | "Under";
  line: number;
  h1: number;
  proj2H: number;
  probability: number;
  edge: "over" | "under" | "strong";
}) {
  const edgeConfig = {
    over: { color: "bg-emerald-500", borderColor: "border-emerald-500/30", label: "Over Edge", textColor: "text-emerald-400" },
    under: { color: "bg-red-500", borderColor: "border-red-500/30", label: "Under Edge", textColor: "text-red-400" },
    strong: { color: "bg-teal-500", borderColor: "border-teal-500/30", label: "Strong", textColor: "text-teal-400" },
  }[edge];

  const probColor = probability >= 70 ? "text-emerald-400" : probability <= 45 ? "text-red-400" : "text-blue-400";

  return (
    <Card className="bg-[#0f0f0f] border-white/[0.08] rounded-xl p-0 overflow-hidden relative">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${edgeConfig.color}`} />
      <div className="p-4 pl-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-[13px] font-bold text-white leading-tight">{name}</p>
            <p className="text-[10px] text-white/35 mt-0.5">{team} · {matchup}</p>
          </div>
          <span className={`text-[9px] font-bold border px-2 py-0.5 rounded-full ${edgeConfig.borderColor} ${edgeConfig.textColor} bg-white/[0.03]`}>
            {edgeConfig.label}
          </span>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className={`text-[10px] font-bold border px-2 py-0.5 rounded ${
            direction === "Over"
              ? "bg-emerald-500/15 border-emerald-500/25 text-emerald-400"
              : "bg-red-500/15 border-red-500/25 text-red-400"
          }`}>
            {direction === "Over" ? <TrendingUp size={9} className="inline mr-1" /> : <TrendingDown size={9} className="inline mr-1" />}
            {stat} {direction[0]}{line}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono text-white/40 mb-3">
          <div>
            <span className="block text-[8px] text-white/25 uppercase tracking-wider mb-0.5">H1 pts</span>
            <span className="text-white/70 font-semibold">{h1}</span>
          </div>
          <div>
            <span className="block text-[8px] text-white/25 uppercase tracking-wider mb-0.5">Proj 2H</span>
            <span className="text-white/70 font-semibold">{proj2H}</span>
          </div>
          <div>
            <span className="block text-[8px] text-white/25 uppercase tracking-wider mb-0.5">Line</span>
            <span className="text-blue-400 font-semibold">{line}</span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Zap size={10} className="text-yellow-400" />
            <span className="text-[10px] text-white/30">Hit Prob</span>
          </div>
          <span className={`text-[18px] font-extrabold font-mono ${probColor}`}>{probability}%</span>
        </div>
      </div>
    </Card>
  );
}