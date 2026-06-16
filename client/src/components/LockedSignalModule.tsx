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
      id="locked-signal-preview"
      data-testid="locked-signal-module"
      className="flex flex-col gap-3 p-4 rounded-2xl border border-[#27272a] bg-[#0a0a0a] scroll-mt-24"
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

      {/*
        Prominent missed-value band — large, hard to miss, mobile-friendly.
        Shown above the proof rows / CTA so the user sees the value
        proposition without scrolling. Falls back gracefully when only
        live signal count is available (no fabricated profit values).
      */}
      {(totalLive > 0 || (analytics?.last7Days && analytics.last7Days.plays >= 5)) && (
        <div
          data-testid="band-missed-value"
          className="rounded-2xl border border-brand/35 bg-gradient-to-br from-brand/12 to-[#0a0a0a] p-4 sm:p-5 space-y-3"
        >
          {totalLive > 0 && (
            <p
              data-testid="text-locked-out-headline"
              className="text-sm sm:text-base font-semibold text-white text-center leading-snug"
            >
              You are locked out of{" "}
              <span className="text-brand font-black text-lg sm:text-xl">
                {totalLive}
              </span>{" "}
              live player prop signal{totalLive !== 1 ? "s" : ""} right now
            </p>
          )}

          {analytics?.last7Days && analytics.last7Days.plays >= 5 && (
            <div className="grid grid-cols-3 gap-2 sm:gap-3 pt-1">
              <div
                data-testid="metric-win-rate"
                className="text-center rounded-lg bg-[#0f0f0f] border border-[#27272a] py-2"
              >
                <div className="text-xl sm:text-2xl font-black text-white leading-none">
                  {analytics.last7Days.winRate.toFixed(0)}%
                </div>
                <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-[#71717a] mt-1">
                  7d Win Rate
                </div>
              </div>
              <div
                data-testid="metric-signal-count"
                className="text-center rounded-lg bg-[#0f0f0f] border border-[#27272a] py-2"
              >
                <div className="text-xl sm:text-2xl font-black text-white leading-none">
                  {analytics.last7Days.plays}
                </div>
                <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-[#71717a] mt-1">
                  Signals
                </div>
              </div>
              <div
                data-testid="metric-profit"
                className="text-center rounded-lg bg-[#0f0f0f] border border-emerald-500/25 py-2"
              >
                <div
                  className={`text-xl sm:text-2xl font-black leading-none ${
                    analytics.last7Days.roi > 0 ? "text-emerald-400" : "text-[#71717a]"
                  }`}
                >
                  {analytics.last7Days.roi > 0
                    ? `+$${Math.round(analytics.last7Days.roi * 25)}`
                    : "—"}
                </div>
                <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-[#71717a] mt-1">
                  At $25/unit
                </div>
              </div>
            </div>
          )}

          <button
            data-testid="button-unlock-signals-cta"
            onClick={onUpgradeClick}
            className="w-full py-3 sm:py-3.5 rounded-xl text-sm sm:text-base font-black tracking-wide transition-all active:scale-95 shadow-lg shadow-brand/20"
            style={{ background: "hsl(var(--brand-accent))", color: "#000" }}
          >
            Unlock Live Signals → $1 for 3 Days
          </button>
          <p className="text-[10px] sm:text-[11px] text-[#52525b] text-center">
            Then $40/mo (Pro) or $65/mo (All Sports) · Cancel anytime
          </p>
        </div>
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

      {/* Fallback CTA — only renders if we never showed the prominent band
          (e.g. no live signal count yet AND no 7-day analytics). Keeps the
          module from ever rendering without a way to upgrade. */}
      {totalLive === 0 && (!analytics?.last7Days || analytics.last7Days.plays < 5) && (
        <div className="space-y-2">
          <button
            data-testid="button-unlock-signals-cta-fallback"
            onClick={onUpgradeClick}
            className="w-full py-3 rounded-xl text-sm font-black tracking-wide transition-all active:scale-95"
            style={{ background: "hsl(var(--brand-accent))", color: "#000" }}
          >
            Unlock Live Signals → $1 for 3 Days
          </button>
          <p className="text-[11px] text-[#52525b] text-center">
            Then $40/mo (Pro) or $65/mo (All Sports) · Cancel anytime
          </p>
        </div>
      )}
    </div>
  );
}
