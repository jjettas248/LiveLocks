import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The repeated "big number + tiny label" unit (tier rail, signal metrics).
 * Replaces hand-rolled `<div className="text-xs font-bold">…</div>` + label
 * stacks so number/label rhythm is consistent. Uses the premium type scale.
 */
type StatTone = "default" | "success" | "warning" | "danger" | "premium";

const TONE_CLASS: Record<StatTone, string> = {
  default: "text-foreground",
  success: "text-tier-strong",
  warning: "text-warning",
  danger: "text-destructive",
  premium: "text-primary",
};

const ALIGN_CLASS = {
  left: "items-start text-left",
  center: "items-center text-center",
  right: "items-end text-right",
} as const;

export interface StatBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  value: React.ReactNode;
  label: React.ReactNode;
  subtext?: React.ReactNode;
  icon?: React.ReactNode;
  align?: keyof typeof ALIGN_CLASS;
  tone?: StatTone;
  /** Tailwind size class for the value (defaults to text-lg). */
  valueClassName?: string;
}

export const StatBlock = React.forwardRef<HTMLDivElement, StatBlockProps>(
  (
    { value, label, subtext, icon, align = "left", tone = "default", valueClassName, className, ...props },
    ref,
  ) => {
    return (
      <div ref={ref} className={cn("flex flex-col", ALIGN_CLASS[align], className)} {...props}>
        <div className={cn("flex items-center gap-1.5", icon && "mb-0.5")}>
          {icon && <span className="text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>}
          <span className={cn("text-hero-num text-lg tabular-nums", TONE_CLASS[tone], valueClassName)}>
            {value}
          </span>
        </div>
        <span className="text-label mt-0.5">{label}</span>
        {subtext && <span className="text-micro text-muted-foreground mt-0.5">{subtext}</span>}
      </div>
    );
  },
);
StatBlock.displayName = "StatBlock";
