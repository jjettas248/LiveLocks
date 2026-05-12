import { Lock, Sparkles, Check, ArrowRight, Activity, Bell, Trophy } from "lucide-react";

interface SignalPreviewConversionCardProps {
  onUpgradeClick?: () => void;
}

const VALUE_BULLETS: { icon: React.ComponentType<{ className?: string }>; text: string }[] = [
  { icon: Activity, text: "Live NBA, MLB, and NCAAB signal detection" },
  { icon: Trophy, text: "Confidence-ranked plays with timing context" },
  { icon: Bell, text: "Push/SMS alerts for high-conviction spots" },
  { icon: Sparkles, text: "All Sports unlocks MLB + full signal access" },
];

const REASON_TAGS = ["Live movement", "Model edge", "Timing window"];

export function SignalPreviewConversionCard({ onUpgradeClick }: SignalPreviewConversionCardProps) {
  return (
    <div
      data-testid="panel-signal-preview-conversion"
      className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent overflow-hidden"
    >
      <div className="px-5 py-3 border-b border-border/60 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-primary" />
        <h3
          data-testid="text-signal-preview-headline"
          className="text-xs font-bold text-foreground uppercase tracking-wider"
        >
          Premium Signals Are Firing Live
        </h3>
      </div>

      <div className="p-5 space-y-4">
        <p
          data-testid="text-signal-preview-subcopy"
          className="text-sm text-muted-foreground leading-relaxed"
        >
          Unlock full access to live player prop signals, confidence tiers, alerts, and market timing.
        </p>

        <div
          data-testid="card-locked-signal-teaser"
          className="rounded-xl border border-border/60 bg-card/80 p-4 relative overflow-hidden"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">
                MLB
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Home Runs
              </span>
            </div>
            <span
              data-testid="badge-confidence-tier"
              className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-primary/20 text-primary border border-primary/40 uppercase tracking-wider"
            >
              Elite
            </span>
          </div>

          <div className="flex items-center gap-2 mb-2">
            <Lock className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
            <span
              data-testid="text-blurred-player"
              className="text-sm font-bold text-foreground/40 blur-[3px] select-none"
            >
              Premium Player
            </span>
          </div>
          <div
            data-testid="text-blurred-line"
            className="text-xs text-muted-foreground/70 mb-3"
          >
            Over <span className="blur-[3px] select-none">0.5</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {REASON_TAGS.map((tag) => (
              <span
                key={tag}
                data-testid={`badge-reason-${tag.toLowerCase().replace(/\s+/g, "-")}`}
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-secondary text-foreground/80 border border-border/60"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <ul className="space-y-2" data-testid="list-value-bullets">
          {VALUE_BULLETS.map(({ icon: Icon, text }) => (
            <li
              key={text}
              data-testid={`bullet-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`}
              className="flex items-start gap-2.5 text-sm text-foreground/90"
            >
              <span className="mt-0.5 w-4 h-4 rounded-full bg-primary/20 ring-1 ring-primary/40 flex items-center justify-center shrink-0">
                <Check className="w-2.5 h-2.5 text-primary" />
              </span>
              <span className="leading-snug">{text}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          data-testid="button-unlock-full-access"
          onClick={onUpgradeClick}
          className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 active:translate-y-px transition"
        >
          Unlock Full Access
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
