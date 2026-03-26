export function SignalSkeletonCard() {
  return (
    <div
      data-testid="skeleton-signal-card"
      className="rounded-xl border border-border/30 bg-card p-4 space-y-3 animate-pulse"
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className="w-10 h-4 bg-muted rounded" />
          <div className="w-16 h-4 bg-muted rounded-full" />
        </div>
        <div className="w-14 h-4 bg-muted rounded-full" />
      </div>
      <div className="space-y-2">
        <div className="w-3/4 h-5 bg-muted rounded" />
        <div className="w-1/2 h-4 bg-muted rounded" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="h-12 bg-muted rounded-lg" />
        <div className="h-12 bg-muted rounded-lg" />
        <div className="h-12 bg-muted rounded-lg" />
      </div>
      <div className="flex gap-2 pt-1">
        <div className="w-20 h-7 bg-muted rounded-lg" />
        <div className="w-20 h-7 bg-muted rounded-lg" />
      </div>
    </div>
  );
}
