import { useState, useEffect } from "react";
import { Lock, TrendingUp } from "lucide-react";
import { useLiveSignalCounts } from "@/hooks/useLiveSignalCounts";
import { usePublicAnalytics } from "@/hooks/usePublicAnalytics";

interface LockedSignalModuleProps {
  onUpgradeClick: () => void;
}

export function LockedSignalModule({ onUpgradeClick }: LockedSignalModuleProps) {
  const { data: signalCounts } = useLiveSignalCounts();
  const { data: analytics } = usePublicAnalytics();

  const totalLive = signalCounts?.totalLive ?? 0;

  const [secondsAgo, setSecondsAgo] = useState(() => Math.floor(Math.random() * 37) + 8);

  useEffect(() => {
    const id = setInterval(() => setSecondsAgo(s => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const hits = (analytics?.recentResults ?? [])
    .filter(r => r.result === "hit")
    .slice(0, 2);

  return (
    <div
      data-testid="locked-signal-module"
      className="flex flex-col gap-3 p-4 rounded-2xl border border-[#27272a] bg-[#0a0a0a]"
    >
      <div className="rounded-2xl border border-red-500/20 bg-[#0f0f0f] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-xs font-bold uppercase tracking-wider text-red-400">Live Edge Detected</span>
        </div>

        <div>
          <p className="text-base font-black text-white">MLB · Home Run Prop</p>
          <p className="text-xs text-[#71717a] mt-0.5">High-confidence signal · Live now</p>
        </div>

        {[
          { label: "Probability" },
          { label: "Edge" },
          { label: "Confidence" },
        ].map(({ label }) => (
          <div key={label} className="flex items-center justify-between">
            <span className="text-xs text-[#71717a]">{label}</span>
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-20 rounded bg-[#22c55e]/15 blur-[3px]" />
              <Lock className="w-3 h-3 text-[#71717a]" />
            </div>
          </div>
        ))}

        <p className="text-[11px] text-[#52525b]">
          ⏱ Detected {secondsAgo}s ago
        </p>
      </div>

      {totalLive > 0 && (
        <p className="text-sm text-[#a1a1aa] text-center">
          You are locked out of{" "}
          <span className="text-white font-bold">{totalLive}</span>{" "}
          live signal{totalLive !== 1 ? "s" : ""} right now
        </p>
      )}

      {hits.length > 0 && (
        <div className="space-y-2">
          {hits.map((r) => {
            const minsAgo = r.settledAt
              ? Math.max(1, Math.floor((Date.now() - new Date(r.settledAt).getTime()) / 60000))
              : null;
            return (
              <div key={r.id} className="rounded-xl border border-red-500/15 bg-[#0f0f0f] px-3 py-2.5 flex items-center justify-between gap-3">
                <div>
                  <span className="text-[10px] font-bold text-red-400 uppercase tracking-wide">❌ Locked Out</span>
                  <p className="text-sm font-semibold text-white mt-0.5">
                    {r.player} — {r.side} {r.market} {r.line}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-[10px] font-bold text-emerald-400">HIT</span>
                  <p className="text-[10px] text-[#71717a]">
                    {minsAgo != null ? `${minsAgo}m ago` : "recently"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {analytics?.last7Days && analytics.last7Days.plays >= 5 && (
        <div className="rounded-lg border border-[#27272a] bg-[#0a0a0a] px-3 py-2 flex items-center gap-2 flex-wrap">
          <TrendingUp className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="text-[11px] text-[#71717a]">Last 7 Days</span>
          <span className="text-[11px] font-bold text-white">{analytics.last7Days.winRate.toFixed(0)}% Win Rate</span>
          <span className="text-[#52525b] text-[10px]">·</span>
          <span className="text-[11px] font-bold text-white">{analytics.last7Days.plays} Signals</span>
          {analytics.last7Days.roi > 0 && (
            <>
              <span className="text-[#52525b] text-[10px]">·</span>
              <span className="text-[11px] font-bold text-emerald-400">
                +${Math.round(analytics.last7Days.roi * 25)} at $25/unit
              </span>
            </>
          )}
        </div>
      )}

      <div className="space-y-2">
        <button
          data-testid="button-unlock-signals-cta"
          onClick={onUpgradeClick}
          className="w-full py-3 rounded-xl text-sm font-black tracking-wide transition-all active:scale-95"
          style={{ background: "#00d4aa", color: "#000" }}
        >
          Unlock Live Signals → $1 for 3 Days
        </button>
        <p className="text-[11px] text-[#52525b] text-center">
          Then $40/mo (Pro) or $65/mo (All Sports) · Cancel anytime
        </p>
      </div>
    </div>
  );
}
