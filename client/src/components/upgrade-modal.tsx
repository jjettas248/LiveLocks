import { useState } from "react";
import { X, Zap, Trophy, Clock, CheckCircle2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface UpgradeModalProps {
  playsUsed: number;
  limit: number;
  onClose: () => void;
}

const PLANS = [
  {
    id: "all",
    name: "🏀 Pro",
    price: "$40",
    period: "/month",
    badge: "Best Value",
    icon: Trophy,
    features: [
      "Unlimited NBA prop calculations",
      "NCAAB Live analytics",
      "2H Plays — top halftime slate",
      "Parlay builder with correlation scoring",
      "Push notifications for high-confidence plays",
      "SMS alerts for 2H plays & 90%+ confidence",
    ],
  },
  {
    id: "elite",
    name: "🏀⚾ All Sports",
    price: "$65",
    period: "/month",
    badge: "Includes MLB",
    icon: Zap,
    features: [
      "Everything in Pro",
      "MLB Live prop predictions",
      "Priority SMS — fastest alerts",
      "Early access to every new sport & feature",
    ],
  },
];

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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        data-testid="upgrade-modal"
        className="relative w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto"
      >
        <button
          data-testid="button-close-upgrade"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors z-10"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="p-6 border-b border-border bg-gradient-to-br from-primary/10 to-background">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium text-primary">Free plays used up</span>
          </div>
          <h2 className="text-xl font-bold text-foreground">You've used all {limit} free plays</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Unlock unlimited access and stay ahead of every line.
          </p>
        </div>

        <div className="p-4 space-y-3">
          {PLANS.map((plan) => {
            const Icon = plan.icon;
            const isLoading = loadingTier === plan.id;
            return (
              <button
                key={plan.id}
                data-testid={`button-upgrade-${plan.id}`}
                onClick={() => handleUpgrade(plan.id)}
                disabled={!!loadingTier}
                className="w-full text-left p-4 rounded-xl border border-border bg-background hover:border-primary hover:bg-primary/5 transition-all disabled:opacity-60 group relative"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className="w-4 h-4 text-primary shrink-0" />
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground">{plan.name}</span>
                      {plan.badge && (
                        <span className="text-xs font-semibold text-primary mt-0.5">
                          {plan.badge}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="font-bold text-foreground shrink-0">
                    {plan.price}
                    <span className="text-xs font-normal text-muted-foreground">{plan.period}</span>
                  </span>
                </div>
                <ul className="space-y-1 pl-0">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <CheckCircle2 className="w-3 h-3 text-primary/60 shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-card/80 rounded-xl">
                    <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
              </button>
            );
          })}

          {error && (
            <p data-testid="upgrade-error" className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
