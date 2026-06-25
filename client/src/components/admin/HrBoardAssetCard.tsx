import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Copy, Check, Download, ShieldCheck, ShieldAlert, Clock, Link2 } from "lucide-react";
import {
  HR_BOARD_ASSET_LABELS,
  type HrBoardAsset,
} from "@shared/hrBoardStudio";

interface Props {
  asset: HrBoardAsset;
  onCopy: (asset: HrBoardAsset) => void;
  onDownloadImage: (asset: HrBoardAsset) => void;
}

/**
 * Presentational card for a single generated content asset. Renders the
 * server-built copy verbatim (compliance already applied) plus the structured
 * image payload preview. No copy is invented or transformed on the client.
 */
export function HrBoardAssetCard({ asset, onCopy, onDownloadImage }: Props) {
  const [copied, setCopied] = useState(false);
  const label = HR_BOARD_ASSET_LABELS[asset.assetType];
  const flagged = asset.complianceStatus === "flagged";

  const handleCopy = () => {
    onCopy(asset);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(asset.body).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Card data-testid={`asset-card-${asset.assetType}`} className="border-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/15 text-primary">
              {label}
            </span>
            <span className="text-muted-foreground font-normal">{asset.title}</span>
          </CardTitle>
          <div className="flex items-center gap-1">
            {flagged ? (
              <span
                className="text-[10px] flex items-center gap-1 text-amber-500"
                title={`Blocked terms: ${asset.blockedTerms.join(", ")}`}
                data-testid={`asset-compliance-flagged-${asset.assetType}`}
              >
                <ShieldAlert className="h-3 w-3" /> Flagged
              </span>
            ) : (
              <span
                className="text-[10px] flex items-center gap-1 text-emerald-500"
                data-testid={`asset-compliance-clean-${asset.assetType}`}
              >
                <ShieldCheck className="h-3 w-3" /> Clean
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre
          className="whitespace-pre-wrap break-words text-xs bg-muted/40 rounded-md p-3 font-sans leading-relaxed"
          data-testid={`asset-body-${asset.assetType}`}
        >
          {asset.body}
        </pre>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> {asset.recommendedTiming}
          </span>
          {asset.includeLink && asset.link && (
            <span className="flex items-center gap-1 text-primary" title={asset.link}>
              <Link2 className="h-3 w-3" /> link attached
            </span>
          )}
          {asset.cta && (
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              CTA: {asset.cta}
            </span>
          )}
        </div>

        {/* Structured image payload preview (styled card, screenshot-ready). */}
        <ImagePayloadPreview asset={asset} />

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
            data-testid={`button-copy-asset-${asset.assetType}`}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy text"}
          </button>
          <button
            onClick={() => onDownloadImage(asset)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border hover:bg-accent transition-colors"
            data-testid={`button-download-asset-${asset.assetType}`}
          >
            <Download className="h-3.5 w-3.5" /> Image payload
          </button>
          {asset.sourcePlayerIds.length > 0 && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              {asset.sourcePlayerIds.length} source{asset.sourcePlayerIds.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ImagePayloadPreview({ asset }: { asset: HrBoardAsset }) {
  const p = asset.imagePayload;
  return (
    <div
      className="rounded-lg border border-border bg-gradient-to-b from-card to-muted/30 p-3"
      data-testid={`image-payload-${asset.assetType}`}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold">{p.title}</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{p.template}</div>
      </div>
      {p.subtitle && <div className="text-[11px] text-muted-foreground">{p.subtitle}</div>}
      {p.rows && p.rows.length > 0 && (
        <div className="mt-2 space-y-1">
          {p.rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px]" data-testid={`image-row-${asset.assetType}-${i}`}>
              {r.rank != null && <span className="text-muted-foreground w-4">{r.rank}.</span>}
              <span className="font-medium">{r.player}</span>
              {r.team && <span className="text-muted-foreground">({r.team})</span>}
              {r.stage && <span className="ml-auto text-primary">{r.stage}</span>}
              {r.score != null && <span className="text-muted-foreground tabular-nums">{r.score.toFixed(1)}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{p.footer}</span>
        <span className="font-semibold">{p.brand}</span>
      </div>
    </div>
  );
}
