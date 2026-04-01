export function SkeletonCard({ count = 1 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} data-testid={`skeleton-card-${i}`} className="animate-pulse rounded-xl border border-border/30 bg-card/50 h-24" />
      ))}
    </>
  );
}
