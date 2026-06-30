import { motion } from "framer-motion";
import { numberReveal, useMotionSafe } from "@/lib/motionPresets";

export interface EdgeMeterProps {
  /** Server model probability for the recommended side, 0-100. */
  modelPct: number;
  /** Server edge (model - market-implied), already computed — never re-derive. */
  edgePct?: number | null;
  /** Formatted odds for the recommended side, e.g. "-110". Purely a display format of a server odds value. */
  oddsLabel?: string | null;
}

const edgeColor = (edge: number): string => {
  if (edge >= 8) return "text-green-400";
  if (edge >= 5) return "text-yellow-400";
  if (edge >= 0) return "text-muted-foreground";
  return "text-red-400";
};

/**
 * The mispricing argument: the model's probability is the headline number,
 * edge (already server-computed) is the value prop. This is the section that
 * answers "why does this matter" — the engine thinks this is more likely than
 * the market is pricing it.
 */
export function EdgeMeter({ modelPct, edgePct, oddsLabel }: EdgeMeterProps) {
  const motionSafe = useMotionSafe();
  const pct = Math.max(0, Math.min(100, modelPct));
  const hasEdge = edgePct != null && Number.isFinite(edgePct);

  return (
    <div className="space-y-1.5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <motion.div
            key={Math.round(modelPct)}
            variants={motionSafe ? numberReveal : undefined}
            initial={motionSafe ? "hidden" : false}
            animate={motionSafe ? "visible" : false}
            className={`text-hero-num text-3xl ${hasEdge ? edgeColor(edgePct!) : "text-foreground"}`}
            data-testid="text-edge-model-pct"
          >
            {Math.round(modelPct)}%
          </motion.div>
          <div className="text-label mt-0.5">Model probability{oddsLabel ? ` · ${oddsLabel}` : ""}</div>
        </div>
        {hasEdge && (
          <div className="text-right">
            <div className={`text-lg font-bold tabular-nums ${edgeColor(edgePct!)}`} data-testid="text-edge-value">
              {edgePct! > 0 ? "+" : ""}
              {edgePct!.toFixed(1)}%
            </div>
            <div className="text-label mt-0.5">Edge</div>
          </div>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden" aria-hidden="true">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out bg-gradient-to-r from-primary/70 to-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
