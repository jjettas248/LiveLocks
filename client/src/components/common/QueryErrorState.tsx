import { AlertTriangle, RefreshCw } from "lucide-react";

interface QueryErrorStateProps {
  /** User-facing message. Keep it plain and actionable. */
  message?: string;
  /** Retry handler — typically a TanStack Query `refetch`. */
  onRetry?: () => void;
  /** Show a spinning icon + disable the button while a refetch is in flight. */
  isRetrying?: boolean;
  /** Tighter padding for inline placement inside a card/strip. */
  compact?: boolean;
  className?: string;
}

/**
 * Inline error state with a retry affordance for failed data fetches. Use this
 * instead of collapsing a fetch failure into an empty state so an outage reads
 * as "couldn't load — retry" rather than "nothing here". role="alert" so the
 * failure is announced to screen readers.
 */
export function QueryErrorState({
  message = "Couldn't load live data.",
  onRetry,
  isRetrying,
  compact,
  className,
}: QueryErrorStateProps) {
  return (
    <div
      role="alert"
      data-testid="query-error-state"
      className={`rounded-xl border border-amber-500/30 bg-amber-500/5 text-center ${
        compact ? "px-3 py-2.5" : "p-6"
      } ${className ?? ""}`}
    >
      <div className="flex items-center justify-center gap-2 text-sm text-amber-400">
        <AlertTriangle className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} aria-hidden="true" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          data-testid="button-query-retry"
          className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-60"
        >
          <RefreshCw className={`w-3 h-3 ${isRetrying ? "animate-spin" : ""}`} aria-hidden="true" />
          {isRetrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
