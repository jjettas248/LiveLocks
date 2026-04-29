import { Zap, BarChart3, Target, ArrowRight, TrendingUp, Shield, Activity, MessageSquare, Bell, Check } from "lucide-react";
import { DashboardPreview } from "@/components/DashboardPreview";
import { Link } from "wouter";
import mlbWinsImg from "@assets/image_1775499429532.png";
import mlbSignalsImg from "@assets/image_1775499450591.png";

const PRICING_TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "Get started with the live prediction engine.",
    cta: "Sign Up Free",
    features: [
      "3 probability calculations",
      "NBA Live dashboard access",
      "Live box score auto-fill",
      "Community access",
    ],
    highlight: false,
    badge: null,
  },
  {
    name: "Pro",
    price: "$40",
    period: "/mo",
    description: "Full access to NBA + NCAAB predictions and SMS alerts.",
    cta: "Start 3-Day Trial \u2013 $1",
    features: [
      "Unlimited calculations",
      "NBA + NCAAB live predictions",
      "Top 2H Plays ranked list",
      "SMS halftime alerts",
      "Smart Parlay Builder",
      "Priority support",
    ],
    highlight: true,
    badge: null,
  },
  {
    name: "All Sports",
    price: "$65",
    period: "/mo",
    description: "Everything in Pro plus the full MLB Live Engine.",
    cta: "Start 3-Day Trial \u2013 $1",
    features: [
      "Everything in Pro",
      "MLB Live Edge Engine",
      "Inning-based live signals",
      "HR probability engine",
      "Pitcher fatigue modeling",
      "Cross-sport parlay builder",
    ],
    highlight: false,
    badge: "Includes MLB Live Signals (NEW)",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased selection:bg-blue-500/20">

      <div className="bg-white text-gray-950">

        <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur-md">
          <div className="container mx-auto px-6 h-14 flex items-center justify-between max-w-6xl">
            <div className="flex items-center gap-2">
              <img
                src="/favicon.jpg"
                alt="LiveLocks logo"
                width={28}
                height={28}
                className="rounded-md"
              />
              <span className="font-bold text-gray-950 tracking-tight">
                livelocksai<span className="text-blue-600">.app</span>
              </span>
            </div>
            <div className="hidden md:flex items-center gap-8 text-sm text-gray-500">
              <a href="#features" className="hover:text-gray-900 transition-colors" data-testid="link-features">Features</a>
              <a href="#mlb-engine" className="hover:text-gray-900 transition-colors" data-testid="link-mlb">MLB Engine</a>
              <a href="#preview" className="hover:text-gray-900 transition-colors" data-testid="link-preview">Dashboard</a>
              <a href="#alerts" className="hover:text-gray-900 transition-colors" data-testid="link-alerts">Alerts</a>
              <a href="#pricing" className="hover:text-gray-900 transition-colors" data-testid="link-pricing">Pricing</a>
            </div>
            <Link
              href="/auth"
              className="flex items-center gap-1.5 bg-gray-950 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors"
              data-testid="link-get-access-nav"
            >
              Start 3-Day Trial &ndash; $1 <ArrowRight size={14} />
            </Link>
          </div>
        </nav>

        <header className="container mx-auto px-6 pt-24 pb-20 text-center max-w-5xl flex flex-col items-center">
          <div className="inline-flex items-center gap-2 bg-gray-100 border border-gray-200 text-gray-500 px-3 py-1.5 rounded-full text-xs font-medium mb-10 tracking-wide">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
            </span>
            Detection engine is live — NBA + MLB season active
          </div>

          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tighter mb-6 leading-none text-balance text-gray-950" data-testid="text-hero-heading">
            NBA + MLB<br />Live Betting Signals
          </h1>

          <p className="text-lg text-gray-500 mb-4 max-w-xl mx-auto leading-relaxed text-pretty">
            Real-time edges driven by live math, not predictions. LiveLocks scans every game simultaneously and surfaces the highest-edge plays the moment they appear.
          </p>

          <p className="text-sm text-gray-400 mb-10 max-w-md mx-auto">
            Most users are winning using MLB 3rd-7th inning signals
          </p>

          <div className="w-full max-w-md mx-auto mb-5">
            <Link
              href="/auth"
              className="inline-flex items-center gap-2 bg-gray-950 text-white text-sm font-semibold px-8 py-3.5 rounded-xl hover:bg-gray-800 transition-colors shadow-md shadow-black/5"
              data-testid="button-signup-hero"
            >
              Start 3-Day Trial &ndash; $1 <ArrowRight size={15} />
            </Link>
          </div>

          <p className="text-xs text-gray-400">
            $1 today &middot; Then $40/mo after 3 days &middot; Cancel anytime
          </p>
        </header>

      </div>

      <section id="preview" className="container mx-auto px-6 pb-32 max-w-6xl">
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-3 text-xs font-mono uppercase tracking-widest text-muted-foreground/50">
            <div className="h-px w-16 bg-border" />
            Live Dashboard
            <div className="h-px w-16 bg-border" />
          </div>
        </div>
        <div className="relative">
          <div className="absolute -inset-4 bg-blue-600/5 blur-3xl rounded-3xl pointer-events-none" />
          <div className="relative rounded-2xl border border-border overflow-hidden shadow-2xl shadow-black/60">
            <div className="flex items-center gap-2 px-4 py-3 bg-secondary border-b border-border">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-border" />
                <div className="w-3 h-3 rounded-full bg-border" />
                <div className="w-3 h-3 rounded-full bg-border" />
              </div>
              <div className="flex-1 flex justify-center">
                <div className="bg-card border border-border rounded-md px-4 py-1 text-xs text-muted-foreground/50 font-mono w-52 text-center">
                  livelocksai.app
                </div>
              </div>
            </div>
            <DashboardPreview />
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background to-transparent rounded-b-2xl pointer-events-none" />
        </div>
      </section>

      <section id="features" className="container mx-auto px-6 py-24 max-w-6xl border-t border-border">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-4 text-balance">
            Built for in-game edge.
          </h2>
          <p className="text-muted-foreground text-base max-w-md mx-auto leading-relaxed">
            Every feature is designed around one goal: giving you a sharper read on live props faster than anyone else.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <FeatureCard
            icon={<Zap size={20} className="text-blue-400" />}
            iconBg="bg-blue-500/10"
            title="Proprietary Live Prediction Engine"
            body="Our detection software combines live box score data, pace, opponent defense, and foul trouble into a single hit probability — updated every play."
          />
          <FeatureCard
            icon={<BarChart3 size={20} className="text-emerald-400" />}
            iconBg="bg-emerald-500/10"
            title="Live Box Auto-Fill"
            body="Stop toggling screens. Clickable live box scores instantly load player data into the calculator — minutes played, fouls, and halftime score auto-populated."
          />
          <FeatureCard
            icon={<Target size={20} className="text-blue-400" />}
            iconBg="bg-blue-500/10"
            title="Smart Parlay Builder"
            body="Add any detected play directly to your parlay slip without leaving the view. Built-in correlation awareness and live sportsbook line integration."
          />
        </div>
      </section>

      <section id="mlb-engine" className="container mx-auto px-6 py-24 max-w-6xl border-t border-border">
        <div className="grid md:grid-cols-2 gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-widest mb-6">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
              NEW
            </div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-5 text-balance" data-testid="text-mlb-engine-heading">
              MLB Live Edge Engine
            </h2>
            <p className="text-muted-foreground leading-relaxed mb-8 text-pretty">
              Purpose-built for baseball. The MLB engine tracks every pitch, every at-bat, and every bullpen change — surfacing high-edge signals as the game unfolds inning by inning.
            </p>
            <ul className="space-y-4">
              {[
                {
                  icon: <Activity size={15} className="text-emerald-400" />,
                  bg: "bg-emerald-500/10",
                  title: "Inning-based signals (3rd, 5th, 7th inning)",
                  body: "Signals strengthen as the game progresses. Mid-game innings are where the strongest edges appear as pitcher fatigue sets in.",
                },
                {
                  icon: <TrendingUp size={15} className="text-blue-400" />,
                  bg: "bg-blue-500/10",
                  title: "Pitcher fatigue + bullpen exposure modeling",
                  body: "Real-time velocity tracking, pitch count monitoring, and bullpen ERA analysis detect when pitchers are breaking down before the market adjusts.",
                },
                {
                  icon: <Target size={15} className="text-amber-400" />,
                  bg: "bg-amber-500/10",
                  title: "Contact quality (EV, launch angle, hard-hit)",
                  body: "Exit velocity, launch angle, and barrel rate data from every at-bat feed directly into live probability calculations.",
                },
                {
                  icon: <Zap size={15} className="text-red-400" />,
                  bg: "bg-red-500/10",
                  title: "Home Run probability engine",
                  body: "Calibrated HR conversion model combining Statcast contact data, park factors, weather, and pitcher deterioration context.",
                },
              ].map(({ icon, bg, title, body }) => (
                <li key={title} className="flex items-start gap-3">
                  <div className={`${bg} w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5`}>
                    {icon}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-6">
            <div className="relative rounded-xl overflow-hidden border border-border shadow-2xl shadow-black/60">
              <img
                src={mlbSignalsImg}
                alt="MLB Live Signals Interface showing inning-based edge detection with confidence scores"
                className="w-full h-auto"
                loading="lazy"
                data-testid="img-mlb-signals"
              />
            </div>
          </div>
        </div>
      </section>

      <section id="mlb-proof" className="container mx-auto px-6 py-24 max-w-6xl border-t border-border">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-4 text-balance" data-testid="text-mlb-proof-heading">
            Recent MLB Wins
          </h2>
          <p className="text-muted-foreground text-base max-w-lg mx-auto leading-relaxed">
            Real results from our MLB live engine — every signal tracked, every outcome verified.
          </p>
        </div>
        <div className="relative max-w-4xl mx-auto rounded-xl overflow-hidden border border-border shadow-2xl shadow-black/60">
          <img
            src={mlbWinsImg}
            alt="MLB wins proof showing verified winning signals with dates, players, markets and results"
            className="w-full h-auto"
            loading="lazy"
            data-testid="img-mlb-wins"
          />
        </div>
      </section>

      <section className="container mx-auto px-6 py-24 max-w-6xl border-t border-border">
        <div className="grid md:grid-cols-2 gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 text-blue-400 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-widest mb-6">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" />
              </span>
              Live Detection Engine
            </div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-5 text-balance">
              Top 2H plays, ranked the moment halftime hits.
            </h2>
            <p className="text-muted-foreground leading-relaxed mb-8 text-pretty">
              The detection engine is live and running every NBA game night. At halftime it scans the full slate simultaneously — comparing H1 observed stats against projected 2H baselines to surface the highest-edge props before lines move.
            </p>
            <ul className="space-y-4">
              {[
                {
                  icon: <TrendingUp size={15} className="text-emerald-400" />,
                  bg: "bg-emerald-500/10",
                  title: "Probability edge scoring",
                  body: "Each play is ranked by the gap between the model's hit probability and the book-implied odds — the wider the gap, the higher the rank.",
                },
                {
                  icon: <Shield size={15} className="text-blue-400" />,
                  bg: "bg-blue-500/10",
                  title: "Live Line vs Season Avg transparency",
                  body: "Every card clearly labels whether the line is live-adjusted or a season-average baseline so you always know the data source behind the call.",
                },
                {
                  icon: <Zap size={15} className="text-amber-400" />,
                  bg: "bg-amber-500/10",
                  title: "One-click parlay building",
                  body: "Add any ranked play directly to your parlay slip without leaving the view. Lines stay live so your slip reflects current market prices.",
                },
              ].map(({ icon, bg, title, body }) => (
                <li key={title} className="flex items-start gap-3">
                  <div className={`${bg} w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5`}>
                    {icon}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="relative rounded-xl overflow-hidden border border-border shadow-2xl shadow-black/60">
            <img
              src="/top-2h-plays.png"
              alt="Top 2H Plays — Full Slate dashboard showing ranked play cards with probability edges"
              className="w-full h-auto"
            />
            <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-background/80 to-transparent pointer-events-none" />
          </div>
        </div>
      </section>

      <section id="alerts" className="container mx-auto px-6 py-24 max-w-6xl border-t border-border">
        <div className="grid md:grid-cols-2 gap-16 items-center">

          <div className="flex flex-col items-center gap-4">
            <img
              src="/sms-alerts.png"
              alt="SMS alerts showing real-time halftime prop predictions sent directly to your phone"
              className="w-full max-w-md mx-auto rounded-xl border border-neutral-800 shadow-xl"
              loading="lazy"
              data-testid="img-sms-alerts"
            />
            <p className="text-xs text-muted-foreground/50 text-center max-w-xs">
              Alerts fire the moment halftime data is confirmed. No refresh needed.
            </p>
          </div>

          <div>
            <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-widest mb-6">
              <MessageSquare size={11} />
              Real-Time SMS Alerts
            </div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-5 text-balance">
              The best plays, texted to you at halftime.
            </h2>
            <p className="text-muted-foreground leading-relaxed mb-8 text-pretty">
              You do not need to have the dashboard open. The moment the engine detects a top-ranked play across any live game, it fires an SMS alert straight to your phone — player, prop, edge percentage, and hit probability included.
            </p>
            <ul className="space-y-4">
              {[
                {
                  icon: <Bell size={15} className="text-emerald-400" />,
                  bg: "bg-emerald-500/10",
                  title: "Fires at halftime automatically",
                  body: "No polling, no manual refresh. The engine pushes alerts the second halftime data is confirmed — before most bettors even open the app.",
                },
                {
                  icon: <Activity size={15} className="text-blue-400" />,
                  bg: "bg-blue-500/10",
                  title: "Full context in every message",
                  body: "Each alert includes the player name, prop line, H1 observed stats, projected 2H pace, edge percentage, and model hit probability.",
                },
                {
                  icon: <Shield size={15} className="text-amber-400" />,
                  bg: "bg-amber-500/10",
                  title: "Only the highest-edge plays",
                  body: "Alerts are throttled to the top-ranked plays by probability edge. You get signal, not noise.",
                },
              ].map(({ icon, bg, title, body }) => (
                <li key={title} className="flex items-start gap-3">
                  <div className={`${bg} w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5`}>
                    {icon}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

        </div>
      </section>

      <section id="pricing" className="container mx-auto px-6 py-24 max-w-6xl border-t border-border">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-foreground mb-4 text-balance" data-testid="text-pricing-heading">
            Simple, transparent pricing.
          </h2>
          <p className="text-muted-foreground text-base max-w-md mx-auto leading-relaxed">
            Try any plan for $1 for 3 days. Auto-converts after trial. Cancel anytime.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4 max-w-4xl mx-auto">
          {PRICING_TIERS.map((tier) => (
            <div
              key={tier.name}
              data-testid={`pricing-card-${tier.name.toLowerCase().replace(/\s/g, "-")}`}
              className={`rounded-2xl p-7 flex flex-col gap-5 ${
                tier.highlight
                  ? "bg-blue-600/5 border-2 border-blue-500/40 shadow-lg shadow-blue-600/10 relative"
                  : "bg-secondary border border-border"
              }`}
            >
              {tier.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full">
                  Most Popular
                </span>
              )}
              <div>
                <h3 className="text-base font-bold text-foreground mb-1">{tier.name}</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-extrabold text-foreground">{tier.price}</span>
                  <span className="text-sm text-muted-foreground">{tier.period}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-2">{tier.description}</p>
              </div>
              <ul className="space-y-2.5 flex-1">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
              {tier.badge && (
                <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold px-3 py-1.5 rounded-lg text-center" data-testid="badge-mlb-new">
                  {tier.badge}
                </div>
              )}
              <Link
                href="/auth"
                className={`w-full text-center text-sm font-semibold py-2.5 rounded-lg transition-colors ${
                  tier.highlight
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "bg-foreground/10 text-foreground hover:bg-foreground/20"
                }`}
              >
                {tier.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section className="container mx-auto px-6 pb-24 max-w-6xl">
        <div className="bg-secondary border border-border rounded-2xl p-12 text-center">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-widest mb-6">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
            </span>
            Live Now — NBA + MLB Season Active
          </div>
          <h3 className="text-2xl md:text-3xl font-extrabold tracking-tight text-foreground mb-3 text-balance">
            Ready to find your edge?
          </h3>
          <p className="text-muted-foreground mb-8 max-w-sm mx-auto leading-relaxed">
            Get full access to NBA + MLB live detection engines, SMS alerts, and the prop calculator. Try for $1 &mdash; 3 days.
          </p>
          <Link
            href="/auth"
            className="inline-flex items-center gap-2 bg-foreground text-background font-semibold px-6 py-3 rounded-lg hover:bg-foreground/90 transition-colors"
            data-testid="button-signup-cta"
          >
            Start 3-Day Trial &ndash; $1 <ArrowRight size={15} />
          </Link>
          <p className="text-xs text-muted-foreground/50 mt-4">$1 now &middot; Then $40/mo or $65/mo &middot; Cancel anytime</p>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="container mx-auto px-6 py-8 max-w-6xl flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-muted-foreground/50">
          <div className="flex items-center gap-2">
            <img src="/favicon.jpg" alt="LiveLocks" width={18} height={18} className="rounded" />
            <span className="font-semibold text-muted-foreground">livelocksai.app</span>
          </div>
          <span>livelocksai.app &nbsp;&middot;&nbsp; &copy; {new Date().getFullYear()} LiveLocks AI. All rights reserved.</span>
          <div className="flex gap-6">
            <Link href="/privacy" className="hover:text-muted-foreground transition-colors" data-testid="link-privacy">Privacy</Link>
            <Link href="/terms" className="hover:text-muted-foreground transition-colors" data-testid="link-terms">Terms</Link>
          </div>
        </div>
      </footer>

    </div>
  );
}

function FeatureCard({
  icon,
  iconBg,
  title,
  body,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-secondary border border-border rounded-2xl p-7 flex flex-col gap-5 hover:border-border/80 hover:bg-card transition-colors group">
      <div className={`${iconBg} w-10 h-10 rounded-xl flex items-center justify-center`}>
        {icon}
      </div>
      <div>
        <h3 className="text-base font-bold text-foreground mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
