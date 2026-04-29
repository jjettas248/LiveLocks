import { useEffect } from "react";
import { Link } from "wouter";
import { ArrowRight, Lock, TrendingUp, Zap } from "lucide-react";
import { useAttributionCapture } from "@/hooks/useAttributionCapture";
import { usePublicAnalytics } from "@/hooks/usePublicAnalytics";
import { PublicProofStrip } from "@/components/dashboard/public-proof-strip";

const PROFIT_PER_UNIT = 25;

export default function TwitterLandingPage() {
  // Force utm_source=twitter when no source is in the URL (organic Twitter visits).
  useAttributionCapture({ forceSource: "twitter" });

  useEffect(() => {
    document.title = "LiveLocks for Twitter — Live Player Prop Signals (MLB + NBA)";
    const meta = document.querySelector('meta[name="description"]');
    const desc = "Live MLB and NBA player prop signals built on real-time engine math. Cold tweet? Tap in for free — 3 signals on the house, no credit card.";
    if (meta) {
      meta.setAttribute("content", desc);
    } else {
      const m = document.createElement("meta");
      m.setAttribute("name", "description");
      m.setAttribute("content", desc);
      document.head.appendChild(m);
    }
  }, []);

  const { data: analytics } = usePublicAnalytics(true);
  const last7 = analytics?.last7Days;
  const totalPlays = last7?.plays ?? 0;
  const winRate = last7?.winRate ?? 0;
  const roi = last7?.roi ?? 0;
  const profit = roi > 0 && totalPlays > 0
    ? Math.round((roi / 100) * totalPlays * PROFIT_PER_UNIT)
    : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/40 bg-background/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-screen-md mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/15 ring-1 ring-primary/30 flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-bold tracking-tight">LiveLocks</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest">by PropPulse</div>
            </div>
          </div>
          <Link
            href="/auth?tab=login"
            data-testid="link-login"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="max-w-screen-md mx-auto px-4 py-6 sm:py-10 space-y-8">
        {/* Hero */}
        <section className="space-y-4 text-center">
          <div
            data-testid="badge-twitter-source"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 border border-primary/30 text-xs font-medium text-primary uppercase tracking-wider"
          >
            <TrendingUp className="w-3 h-3" /> From Twitter
          </div>
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight" data-testid="text-hero-headline">
            Stop guessing player props.
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-prose mx-auto" data-testid="text-hero-subheadline">
            LiveLocks runs the same live engine math the sharps use — for MLB and NBA player props. Cold from Twitter? Tap in free. Three signals on the house, no card.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <Link
              href="/auth?tab=register"
              data-testid="button-primary-cta"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-bold text-sm hover:bg-primary/90 active:translate-y-px transition shadow-lg shadow-primary/30"
            >
              See Today's Best Free Play
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/auth?tab=register"
              data-testid="button-secondary-cta"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-card border border-border text-foreground font-medium text-sm hover:bg-muted active:translate-y-px transition"
            >
              Unlock Live Signals — $1 for 3 Days
            </Link>
          </div>
          <p className="text-[11px] text-muted-foreground" data-testid="text-no-card">
            No credit card for free signals · Cancel trial anytime
          </p>
        </section>

        {/* Recent player prop wins */}
        <section className="space-y-3" data-testid="section-recent-wins">
          <PublicProofStrip />
        </section>

        {/* Missed-value teaser block (locked-out framing using public data) */}
        <section
          data-testid="section-missed-value"
          className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/20 ring-1 ring-primary/40 flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5 text-primary" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg sm:text-xl font-bold leading-snug" data-testid="text-missed-value-headline">
                You're locked out of every live signal we ship today
              </h2>
              <p className="text-sm text-muted-foreground">
                Free accounts get 3 plays per day. Trial unlocks the full live engine — every MLB & NBA player prop signal, every alert, real-time.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-3 pt-1">
            <div className="rounded-lg bg-card/60 border border-border p-2.5 sm:p-3 text-center">
              <div className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider">7d Win Rate</div>
              <div className="text-lg sm:text-2xl font-bold text-primary mt-1" data-testid="stat-win-rate">
                {totalPlays > 0 ? `${winRate}%` : "—"}
              </div>
            </div>
            <div className="rounded-lg bg-card/60 border border-border p-2.5 sm:p-3 text-center">
              <div className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider">Signals (7d)</div>
              <div className="text-lg sm:text-2xl font-bold text-foreground mt-1" data-testid="stat-signals">
                {totalPlays || "—"}
              </div>
            </div>
            <div className="rounded-lg bg-card/60 border border-border p-2.5 sm:p-3 text-center">
              <div className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider">Profit @ ${PROFIT_PER_UNIT}/u</div>
              <div className="text-lg sm:text-2xl font-bold text-green-400 mt-1" data-testid="stat-profit">
                {profit != null ? `+$${profit}` : "—"}
              </div>
            </div>
          </div>

          <Link
            href="/auth?tab=register"
            data-testid="button-missed-value-cta"
            className="block w-full text-center px-5 py-3 rounded-lg bg-primary text-primary-foreground font-bold text-sm sm:text-base hover:bg-primary/90 active:translate-y-px transition shadow-lg shadow-primary/30"
          >
            Unlock Live Signals → $1 for 3 Days
          </Link>
          <p className="text-[11px] text-center text-muted-foreground">
            Then $40/mo (Pro) or $65/mo (All Sports) · Cancel anytime
          </p>
        </section>

        {/* Free activation rail copy (marketing variant — sends to signup) */}
        <section
          data-testid="section-free-activation"
          className="rounded-xl border border-border bg-card p-5 sm:p-6 space-y-3"
        >
          <h2 className="text-lg sm:text-xl font-bold" data-testid="text-free-headline">
            Get your 3 free player prop signals today
          </h2>
          <p className="text-sm text-muted-foreground">
            Live game movement creates player prop opportunities. LiveLocks surfaces the strongest MLB and NBA setups before the market fully adjusts.
          </p>
          <p className="text-xs uppercase tracking-widest text-primary font-medium">
            Only 3 free plays reset daily.
          </p>
          <Link
            href="/auth?tab=register"
            data-testid="button-free-activation-cta"
            className="block w-full text-center px-5 py-3 rounded-lg bg-primary text-primary-foreground font-bold text-sm hover:bg-primary/90 active:translate-y-px transition"
          >
            See Today's Best Free Play
          </Link>
        </section>

        <footer className="pt-6 pb-10 text-center text-xs text-muted-foreground">
          <p>
            <Link href="/landing" className="hover:text-foreground" data-testid="link-full-landing">
              See full features →
            </Link>
          </p>
          <p className="mt-2">
            © {new Date().getFullYear()} PropPulse · LiveLocks
          </p>
        </footer>
      </main>
    </div>
  );
}
