import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CardActionsProps {
  /** Stage-matched action label, e.g. "Take It" / "Add to Slip" / "View Details". */
  primaryLabel: string;
  onPrimary?: () => void;
  primaryTestId?: string;
  /** True for the highest-urgency stage (e.g. FIRE) — gets the strongest visual treatment. */
  isUrgent?: boolean;
  /** Share/copy/secondary buttons, left-aligned — composed in by the caller (reuses ShareSignalButton/CopyBetButton). */
  children?: ReactNode;
  /** Rendered immediately before the primary button, e.g. a "+N related" footer slot. */
  trailingSlot?: ReactNode;
}

/**
 * The "what to do" close. One stage-matched primary action plus room for the
 * existing share/copy affordances — never invents a new action vocabulary,
 * just renders what the caller already wires up (onAddToSlip / onPrimaryAction / primaryCta).
 */
export function CardActions({ primaryLabel, onPrimary, primaryTestId, isUrgent, children, trailingSlot }: CardActionsProps) {
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <div className="flex items-center gap-1.5">{children}</div>
      <div className="flex items-center gap-1.5">
      {trailingSlot}
      {onPrimary && (
        <button
          type="button"
          data-testid={primaryTestId ?? "button-card-primary-action"}
          onClick={onPrimary}
          className={cn(
            "text-micro font-bold px-3.5 py-2 rounded-lg transition-colors",
            isUrgent
              ? "bg-tier-strong/20 border border-tier-strong/50 text-tier-strong hover:bg-tier-strong/30"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {primaryLabel}
        </button>
      )}
      </div>
    </div>
  );
}
