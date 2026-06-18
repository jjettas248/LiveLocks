import { type ReactNode } from "react";

// Branded empty-state pattern: icon in a tinted badge + heading + subtext.
// `icon` accepts a lucide node (preferred) or an emoji/string (back-compat).
export function EmptyState({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
}) {
  return (
    <div data-testid="empty-state" className="rounded-xl border border-border/40 bg-card/60 p-6 text-center space-y-2">
      {icon && (
        <div className="mx-auto mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-muted/40 text-xl text-muted-foreground [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
    </div>
  );
}
