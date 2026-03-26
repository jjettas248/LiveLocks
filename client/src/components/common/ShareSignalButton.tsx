import { useState } from "react";

type ShareSignalData = {
  sport: "NBA" | "NCAAB" | "MLB";
  playerOrTeam: string;
  marketLabel: string;
  side: string;
  line?: number | string;
  probability: number;
  edge: number;
};

function formatShareText(data: ShareSignalData): string {
  const lineStr = data.line != null ? ` ${data.line}` : "";
  return [
    `${data.playerOrTeam} — ${data.side} ${data.marketLabel}${lineStr}`,
    `Prob: ${Math.round(data.probability)}% | Edge: +${data.edge.toFixed(1)}%`,
    ``,
    `Powered by LiveLocks`,
  ].join("\n");
}

export function ShareSignalButton({ data, className }: { data: ShareSignalData; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    const text = formatShareText(data);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  };

  return (
    <button
      data-testid="button-share-signal"
      onClick={handleShare}
      className={`text-[11px] font-medium px-3 py-1.5 rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors ${className ?? ""}`}
    >
      {copied ? "Copied!" : "Share"}
    </button>
  );
}
