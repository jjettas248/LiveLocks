export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: string }) {
  return (
    <div data-testid="empty-state" className="rounded-xl border border-border/40 bg-card/60 p-6 text-center space-y-2">
      {icon && <div className="text-2xl">{icon}</div>}
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
    </div>
  );
}
