import { useState } from "react";
import { X, Zap, Trophy, CheckCircle2, ShieldAlert, TrendingUp, Bell, Lock, XCircle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface TopLockedEdge {
  playerName?: string;
  statType?: string;
  probability?: number;
  edge?: number;
  betDirection?: string;
  line?: number;
}

interface UpgradeModalProps {
  playsUsed: number;
  limit: number;
  onClose: () => void;
  lockedEdgesCount?: number;
  topLockedEdge?: TopLockedEdge;
  currentTier?: string | null;
  onUpgradeSuccess?: (tier: string) => void;
}

export function UpgradeModal({ playsUsed, limit, onClose, lockedEdgesCount, topLockedEdge, currentTier, onUpgradeSuccess }: UpgradeModalProps) {
  const [loadingTier, setLoadingTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleUpgrade = async (tier: string) => {
    setLoadingTier(tier);
    setError(null);
    try {
      if (currentTier === "all" && tier === "elite") {
        const res = await apiRequest("POST", "/api/stripe/upgrade", { tier });
        const data = await res.json();
        if (data.success) {
          const confirmedTier = data.tier ?? tier;
          onUpgradeSuccess?.(confirmedTier);
          queryClient.refetchQueries({ queryKey: ["/api/auth/me"] });
          toast({ title: "Upgraded!", description: "You now have All Sports access." });
          onClose();
        } else if (data.url) {
          window.location.href = data.url;
        } else {
          throw new Error(data.error || "Upgrade failed");
        }
      } else {
        const res = await apiRequest("POST", "/api/stripe/checkout", { tier });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        }
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
      setLoadingTier(null);
    }
  };

  const isLockedOut = playsUsed >= limit;
  const hasLockedEdges = (lockedEdgesCount ?? 0) > 0;

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
            {isLockedOut ? "You've used all 3 free plays today." : "You're seeing real edges."}
          </h2>
          <p
            data-testid="text-upgrade-hook"
            className="text-sm font-medium text-[#f59e0b] mt-2"
          >
            {isLockedOut
              ? hasLockedEdges
                ? `You're now locked out of ${lockedEdgesCount} live edge${lockedEdgesCount !== 1 ? "s" : ""}. Several high-confidence plays are active right now.`
                : "Pro users get full access to all live edges."
              : "This is exactly what sportsbooks don't want you seeing."}
          </p>
          <p
            data-testid="text-upgrade-subtext"
            className="text-sm text-[#a1a1aa] mt-1"
          >
            {isLockedOut
              ? "Your free plays reset tomorrow. Upgrade for unlimited access every day."
              : `Free users get 3 plays per day · Pro users unlock all live edges.`}
          </p>
        </div>

        {/* Locked edge preview — shows first hidden play when available */}
        {isLockedOut && topLockedEdge && topLockedEdge.playerName && (
          <div className="px-6 pb-4">
            <div
              data-testid="locked-edge-preview"
              className="rounded-xl border border-[#f59e0b]/20 bg-[#f59e0b]/5 p-3 flex items-center justify-between gap-3 relative overflow-hidden"
            >
              <div className="absolute inset-0 backdrop-blur-[2px] bg-[#0a0a0a]/40 flex items-center justify-center z-10 rounded-xl">
                <div className="flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-[#f59e0b]" />
                  <span className="text-[11px] font-bold text-[#f59e0b] uppercase tracking-wide">Locked Edge</span>
                </div>
              </div>
              <div className="z-0">
                <p className="text-sm font-bold text-white">{topLockedEdge.playerName}</p>
                <p className="text-[11px] text-[#a1a1aa]">
                  {topLockedEdge.statType} · {topLockedEdge.betDirection?.toUpperCase()} {topLockedEdge.line}
                </p>
              </div>
              <div className="text-right z-0">
                <p className="text-lg font-black text-[#00d4aa]">{Math.round(topLockedEdge.probability ?? 0)}%</p>
                {(topLockedEdge.edge ?? 0) > 0 && (
                  <p className="text-[10px] text-[#a1a1aa]">+{(topLockedEdge.edge ?? 0).toFixed(1)}% edge</p>
                )}
              </div>
            </div>
          </div>
        )}

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
              <span className="text-sm font-bold text-white">PRO</span>
            </div>
            <div className="text-2xl font-black text-white">
              $40<span className="text-xs font-normal text-[#71717a]">/mo</span>
            </div>
            <ul className="mt-1.5 space-y-0.5">
              <li className="text-[11px] text-[#a1a1aa] flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-[#00d4aa] shrink-0" />Live halftime edges</li>
              <li className="text-[11px] text-[#a1a1aa] flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-[#00d4aa] shrink-0" />NBA & NCAAB 2H plays</li>
              <li className="text-[11px] text-[#a1a1aa] flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-[#00d4aa] shrink-0" />Real-time probability engine</li>
              <li className="text-[11px] text-[#71717a] flex items-center gap-1"><XCircle className="w-3 h-3 text-[#52525b] shrink-0" />MLB props (not included)</li>
            </ul>
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
              <span className="text-sm font-bold text-white">ALL SPORTS</span>
            </div>
            <div className="text-2xl font-black text-white">
              $65<span className="text-xs font-normal text-[#71717a]">/mo</span>
            </div>
            <ul className="mt-1.5 space-y-0.5">
              <li className="text-[11px] text-[#a1a1aa] flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-[#f59e0b] shrink-0" />NBA, NCAAB, MLB</li>
              <li className="text-[11px] text-[#a1a1aa] flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-[#f59e0b] shrink-0" />SMS alerts for every play</li>
              <li className="text-[11px] text-[#a1a1aa] flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-[#f59e0b] shrink-0" />All Pro features included</li>
            </ul>
            <p className="text-[10px] text-[#f59e0b]/70 mt-1.5 italic leading-tight">By the time the line moves — you're already on it.</p>
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
