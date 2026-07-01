import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { surfaceVariantClasses, type SurfaceVariant } from "@/lib/uiTokens";

/**
 * The single premium card shell for the app. Replaces hand-rolled
 * `rounded-xl border bg-card` blocks so elevation, radius, hover, and glow are
 * consistent and tunable from the token layer (`--surface-*`, `boxShadow.surface-*`).
 *
 * - `variant`     visual treatment (token-driven, see uiTokens.surfaceVariantClasses)
 * - `interactive` adds the shared lift-on-hover / press-down feel (reduced-motion safe
 *                 via the global prefers-reduced-motion block in index.css)
 * - `glow`        soft primary-tinted halo for hero / active cards (use sparingly)
 * - `asChild`     render onto a child element (e.g. <button>) via Radix Slot
 *
 * No raw hex — colors come from tokens only.
 */
export interface SurfaceCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant;
  interactive?: boolean;
  glow?: boolean;
  asChild?: boolean;
}

export const SurfaceCard = React.forwardRef<HTMLDivElement, SurfaceCardProps>(
  ({ className, variant = "default", interactive = false, glow = false, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref}
        data-testid="surface-card"
        className={cn(
          "rounded-2xl border",
          surfaceVariantClasses(variant),
          interactive && "hover-elevate active-elevate-2 cursor-pointer",
          glow && "shadow-surface-glow",
          className,
        )}
        {...props}
      />
    );
  },
);
SurfaceCard.displayName = "SurfaceCard";
