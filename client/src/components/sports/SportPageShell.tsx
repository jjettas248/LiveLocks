import { type ReactNode } from "react";

export function SportPageShell({
  title,
  accentClass,
  actions,
  children,
}: {
  title: string;
  accentClass?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-testid="sport-page-shell" className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <h1 className={`text-lg font-bold text-foreground ${accentClass ?? ""}`}>{title}</h1>
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
