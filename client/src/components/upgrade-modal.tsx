import { useState } from "react";
import { X, Zap, Trophy, CheckCircle2, ShieldAlert, TrendingUp, Bell } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface UpgradeModalProps {
  playsUsed: number;
  limit: number;
  onClose: () => void;
}

export function UpgradeModal({ playsUsed, limit, onClose }: UpgradeModalProps) {
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async (tier: string) => {
    setLoadingTier(tier);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/stripe/checkout", { tier });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
      setLoadingTier(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        data-testid="upgrade-modal"
        className="relative w-full max-w-lg bg-[#0a0a0a] border border-[#27272a] rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto"
      >
        <button
          data-testid="button-close-upgrade"
          onClick={onClose}
          className="absolute top-4 right-4 text-[#71717a] hover:text-white transition-colors z-10"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="p-6 pb-4">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="w-5 h-5 text-[#00d4aa]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-[#00d4aa]">LiveLocks</span>
          </div>
          <h2
            data-testid="text-upgrade-header"
            className="text-2xl font-black text-white leading-tight"
          >
            You're seeing real edges.
          </h2>
          <p
            data-testid="text-upgrade-hook"
            className="text-sm font-medium text-[#f59e0b] mt-2"
          >
            This is exactly what sportsbooks don't want you seeing.
          </p>
          <p
            data-testid="text-upgrade-subtext"
            className="text-sm text-[#a1a1aa] mt-1"
          >
            You've unlocked {limit} live edges using the model.
          </p>
        </div>

        <div className="px-6 pb-4">
          <div className="space-y-2">
            <div className="flex items-start gap-2.5">
              <TrendingUp className="w-4 h-4 text-[#00d4aa] mt-0.5 shrink-0" />
              <span className="text-sm text-[#d4d4d8]">Live halftime edges — model fires when lines are soft</span>
            </div>
            <div className="flex items-start gap-2.5">
              <Zap className="w-4 h-4 text-[#00d4aa] mt-0.5 shrink-0" />
              <span className="text-sm text-[#d4d4d8]">Real-time probability engine across NBA, NCAAB & MLB</span>
            </div>
            <div className="flex items-start gap-2.5">
              <Bell className="w-4 h-4 text-[#00d4aa] mt-0.5 shrink-0" />
              <span className="text-sm text-[#d4d4d8]">SMS alerts for high-confidence plays (All Sports tier)</span>
            </div>
          </div>
        </div>

        <div className="px-6 pb-4 grid grid-cols-2 gap-3">
          <button
            data-testid="button-upgrade-all"
            onClick={() => handleUpgrade("all")}
            disabled={!!loadingTier}
            className="relative text-left p-4 rounded-xl border border-[#27272a] bg-[#111] hover:border-[#00d4aa]/50 hover:bg-[#00d4aa]/5 transition-all disabled:opacity-60 group"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Trophy className="w-4 h-4 text-[#00d4aa]" />
              <span className="text-sm font-bold text-white">Pro</span>
            </div>
            <div className="text-2xl font-black text-white">
              $40<span className="text-xs font-normal text-[#71717a]">/mo</span>
            </div>
            <p className="text-[11px] text-[#71717a] mt-1">NBA + NCAAB + 2H plays</p>
            {loadingTier === "all" && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#111]/80 rounded-xl">
                <div className="w-5 h-5 border-2 border-[#00d4aa] border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </button>

          <button
            data-testid="button-upgrade-elite"
            onClick={() => handleUpgrade("elite")}
            disabled={!!loadingTier}
            className="relative text-left p-4 rounded-xl border border-[#f59e0b]/30 bg-[#111] hover:border-[#f59e0b]/60 hover:bg-[#f59e0b]/5 transition-all disabled:opacity-60 group"
          >
            <div className="absolute -top-2 right-3">
              <span className="text-[10px] font-bold uppercase tracking-wider bg-[#f59e0b] text-black px-2 py-0.5 rounded-full">Popular</span>
            </div>
            <div className="flex items-center gap-1.5 mb-1">
              <Zap className="w-4 h-4 text-[#f59e0b]" />
              <span className="text-sm font-bold text-white">All Sports</span>
            </div>
            <div className="text-2xl font-black text-white">
              $65<span className="text-xs font-normal text-[#71717a]">/mo</span>
            </div>
            <p className="text-[11px] text-[#71717a] mt-1">All sports + SMS alerts</p>
            {loadingTier === "elite" && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#111]/80 rounded-xl">
                <div className="w-5 h-5 border-2 border-[#f59e0b] border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </button>
        </div>

        <div className="px-6 pb-4">
          <button
            data-testid="button-unlock-full-access"
            onClick={() => handleUpgrade("all")}
            disabled={!!loadingTier}
            className="w-full py-3 rounded-xl text-sm font-bold transition-all disabled:opacity-60"
            style={{ background: "#00d4aa", color: "#000" }}
          >
            {loadingTier ? "Redirecting to checkout..." : "Unlock Full Access"}
          </button>
        </div>

        {error && (
          <div className="px-6 pb-4">
            <p data-testid="upgrade-error" className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
              {error}
            </p>
          </div>
        )}

        <div className="px-6 pb-6">
          <button
            data-testid="button-dismiss-upgrade"
            onClick={onClose}
            className="w-full py-2.5 text-sm text-[#71717a] hover:text-[#a1a1aa] transition-colors"
          >
            Keep guessing without LiveLocks
          </button>
        </div>
      </div>
    </div>
  );
}
