import { useState } from "react";

type CopyBetData = {
  playerOrTeam: string;
  side: string;
  marketLabel: string;
  line?: number | string;
  probability: number;
  edge: number;
};

function formatBetText(data: CopyBetData): string {
  const lineStr = data.line != null ? ` ${data.line}` : "";
  return [
    `${data.playerOrTeam} — ${data.side} ${data.marketLabel}${lineStr}`,
    `Prob: ${Math.round(data.probability)}%`,
    `Edge: +${data.edge.toFixed(1)}%`,
    `Powered by LiveLocks`,
  ].join("\n");
}

export function CopyBetButton({ data, className }: { data: CopyBetData; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = formatBetText(data);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  };

  return (
    <button
      data-testid="button-copy-bet"
      onClick={handleCopy}
      className={`text-[11px] font-medium px-3 py-1.5 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 transition-colors ${className ?? ""}`}
    >
      {copied ? "Copied!" : "Copy Bet"}
    </button>
  );
}
