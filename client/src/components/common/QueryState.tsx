import { type ReactNode } from "react";
import { QueryErrorState } from "./QueryErrorState";
import { EmptyState } from "@/components/sports/EmptyState";
import { SkeletonCard } from "@/components/sports/SkeletonCard";

/**
 * One wrapper for the loading → error → empty → content decision that was
 * hand-rolled ~13 times across pages. Compose the existing primitives
 * (SkeletonCard / QueryErrorState / EmptyState) so every surface renders the
 * same three states consistently.
 *
 * Usage:
 *   <QueryState
 *     isLoading={q.isLoading}
 *     isError={q.isError}
 *     onRetry={q.refetch}
 *     isEmpty={(data ?? []).length === 0}
 *     emptyTitle="No live games"
 *   >
 *     {rows.map(...)}
 *   </QueryState>
 */
export function QueryState({
  isLoading,
  isError,
  onRetry,
  isRetrying,
  isEmpty,
  errorMessage,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyIcon,
  skeletonCount = 3,
  compact,
  children,
}: {
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
  isEmpty?: boolean;
  errorMessage?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: ReactNode;
  skeletonCount?: number;
  compact?: boolean;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="query-state-loading">
        <SkeletonCard count={skeletonCount} />
      </div>
    );
  }
  if (isError) {
    return <QueryErrorState message={errorMessage} onRetry={onRetry} isRetrying={isRetrying} compact={compact} />;
  }
  if (isEmpty) {
    return <EmptyState title={emptyTitle} description={emptyDescription} icon={emptyIcon} />;
  }
  return <>{children}</>;
}
