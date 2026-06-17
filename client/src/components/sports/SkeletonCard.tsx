// Structured loading skeleton that mirrors a real signal card's layout
// (badge row, title, 3-up stat grid, action buttons) so content doesn't pop /
// shift when data arrives. Previously a single blank h-24 box.
export function SkeletonCard({ count = 1 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          data-testid={`skeleton-card-${i}`}
          className="animate-pulse rounded-xl border border-border/30 bg-card/50 p-4 space-y-3"
        >
          <div className="flex items-center gap-2">
            <div className="h-4 w-12 rounded bg-muted/60" />
            <div className="h-4 w-16 rounded bg-muted/40" />
            <div className="ml-auto h-4 w-10 rounded bg-muted/30" />
          </div>
          <div className="h-5 w-2/3 rounded bg-muted/50" />
          <div className="grid grid-cols-3 gap-3">
            <div className="h-8 rounded bg-muted/40" />
            <div className="h-8 rounded bg-muted/30" />
            <div className="h-8 rounded bg-muted/30" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 w-20 rounded-lg bg-muted/40" />
            <div className="h-7 w-16 rounded-lg bg-muted/30" />
          </div>
        </div>
      ))}
    </>
  );
}
