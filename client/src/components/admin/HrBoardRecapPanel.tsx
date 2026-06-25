import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClipboardList, Loader2 } from "lucide-react";
import { HrBoardAssetCard } from "./HrBoardAssetCard";
import type { HrBoardAsset, HrRecapResponse } from "@shared/hrBoardStudio";

interface Props {
  recap: HrRecapResponse | null;
  date: string;
  onDateChange: (date: string) => void;
  onGenerate: () => void;
  generating: boolean;
  onCopy: (asset: HrBoardAsset) => void;
  onDownloadImage: (asset: HrBoardAsset) => void;
}

/**
 * Postgame recap / proof panel. The admin selects a date, generates recap
 * assets, and copies/downloads them. All copy is server-built (compliance
 * applied) — nothing is recomputed here.
 */
export function HrBoardRecapPanel({
  recap,
  date,
  onDateChange,
  onGenerate,
  generating,
  onCopy,
  onDownloadImage,
}: Props) {
  return (
    <Card data-testid="recap-panel-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-primary" /> Postgame Recap
        </CardTitle>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <input
            type="date"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-md border border-border bg-card"
            data-testid="input-recap-date"
          />
          <button
            onClick={onGenerate}
            disabled={generating}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-60"
            data-testid="button-generate-recap"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardList className="h-3.5 w-3.5" />}
            Generate Recap
          </button>
          {recap && (
            <div className="text-[11px] text-muted-foreground" data-testid="recap-summary">
              Cashed {recap.summary.cashed} · Near {recap.summary.nearMiss} · Missed {recap.summary.missed}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!recap ? (
          <div className="text-xs text-muted-foreground py-6 text-center">
            Select a date and generate recap / proof assets.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {recap.assets.map((a) => (
              <HrBoardAssetCard
                key={a.assetType}
                asset={a}
                onCopy={onCopy}
                onDownloadImage={onDownloadImage}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
