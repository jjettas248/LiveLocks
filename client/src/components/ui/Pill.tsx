import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The single badge/pill primitive. Consolidates the many ad-hoc
 * `text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ...` chips
 * (tier, health, live, confidence, upgrade) into one tokenized component.
 *
 * Tones map to design tokens — no raw hex. For signal-tier or per-sport pills,
 * pass the class from uiTokens (tierBadgeClasses / sportAccentClasses) via
 * `className` with tone="custom".
 */
const pillVariants = cva(
  "inline-flex items-center gap-1 rounded-full border font-semibold uppercase tracking-wider whitespace-nowrap [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        default: "bg-secondary text-secondary-foreground border-border",
        premium: "bg-primary/15 text-primary border-primary/40",
        success: "bg-tier-strong/15 text-tier-strong border-tier-strong/40",
        warning: "bg-warning/15 text-warning border-warning/40",
        danger: "bg-destructive/15 text-destructive border-destructive/40",
        info: "bg-sport-ncaab/15 text-sport-ncaab border-sport-ncaab/40",
        muted: "bg-muted/40 text-muted-foreground border-border/50",
        custom: "",
      },
      size: {
        sm: "text-micro px-2 py-0.5 [&_svg]:h-3 [&_svg]:w-3",
        md: "text-[0.75rem] px-2.5 py-1 [&_svg]:h-3.5 [&_svg]:w-3.5",
      },
    },
    defaultVariants: {
      tone: "default",
      size: "sm",
    },
  },
);

export interface PillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {
  icon?: React.ReactNode;
}

export const Pill = React.forwardRef<HTMLSpanElement, PillProps>(
  ({ className, tone, size, icon, children, ...props }, ref) => {
    return (
      <span ref={ref} className={cn(pillVariants({ tone, size }), className)} {...props}>
        {icon}
        {children}
      </span>
    );
  },
);
Pill.displayName = "Pill";

export { pillVariants };
