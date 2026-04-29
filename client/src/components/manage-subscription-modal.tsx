import { useEffect, useRef, useState } from "react";
import {
  X,
  Loader2,
  ArrowRightLeft,
  CreditCard,
  XCircle,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ManageSubscriptionModalProps {
  tier: string | null;
  status: string | null;
  cancelAtPeriodEnd?: boolean | null;
  onClose: () => void;
}

type PortalIntent = "cancel" | "switch" | "payment" | "resume";

const TIER_LABEL: Record<string, string> = {
  all: "Pro",
  elite: "All Sports",
};

const TIER_PRICE: Record<string, string> = {
  all: "$40 / month",
  elite: "$65 / month",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  trialing: "Free trial",
  past_due: "Payment overdue",
  canceled: "Cancelled",
};

export function ManageSubscriptionModal({
  tier,
  status,
  cancelAtPeriodEnd,
  onClose,
}: ManageSubscriptionModalProps) {
  const [loadingIntent, setLoadingIntent] = useState<PortalIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const inFlightRef = useRef(false);

  const planLabel = tier ? TIER_LABEL[tier] ?? tier : "—";
  const planPrice = tier ? TIER_PRICE[tier] ?? "" : "";
  const statusLabel = status ? STATUS_LABEL[status] ?? status : "—";
  const isPendingCancel = !!cancelAtPeriodEnd;
  const isTrialing = status === "trialing";

  // Capture the element that opened the modal so we can restore focus on close.
  // Move focus into the modal (close button) so keyboard users land here.
  useEffect(() => {
    previousFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    closeButtonRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Escape key closes the modal.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openPortal = async (intent: PortalIntent) => {
    // Re-entrancy guard — hard-block any second click before state commits.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoadingIntent(intent);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/stripe/portal");
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data.error || "Could not open billing portal");
      }
    } catch (err: any) {
      const msg = err?.message || "Something went wrong. Please try again.";
      setError(msg);
      setLoadingIntent(null);
      inFlightRef.current = false;
      toast({
        title: "Could not open billing portal",
        description: msg,
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
      data-testid="modal-manage-subscription"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-subscription-title"
    >
      <div
        className="bg-card border border-border w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-card border-b border-border/60 px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <div className="leading-tight">
              <div
                id="manage-subscription-title"
                className="text-base font-bold text-foreground"
              >
                Manage Subscription
              </div>
              <div className="text-[11px] text-muted-foreground">
                Cancel, downgrade, or update payment
              </div>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            data-testid="button-close-manage-modal"
            aria-label="Close"
            className="w-9 h-9 rounded-lg hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Current plan summary */}
          <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                  Current Plan
                </div>
                <div
                  data-testid="text-current-plan"
                  className="text-lg font-bold text-foreground mt-0.5"
                >
                  {planLabel}
                </div>
                {planPrice && (
                  <div className="text-xs text-muted-foreground mt-0.5">{planPrice}</div>
                )}
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                  Status
                </div>
                <div
                  data-testid="text-current-status"
                  className="text-sm font-semibold text-foreground mt-0.5 capitalize"
                >
                  {statusLabel}
                </div>
              </div>
            </div>
          </div>

          {/* Cancellation pending banner */}
          {isPendingCancel && (
            <div
              data-testid="banner-cancellation-pending"
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-amber-200">
                    Cancellation scheduled
                  </div>
                  <div className="text-xs text-amber-100/80 mt-0.5">
                    Your subscription will end at the close of the current billing period. You'll
                    still have access until then.
                  </div>
                  <button
                    type="button"
                    data-testid="button-resume-subscription"
                    onClick={() => openPortal("resume")}
                    disabled={loadingIntent !== null}
                    className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-amber-950 text-xs font-bold hover:bg-amber-400 transition-colors disabled:opacity-60"
                  >
                    {loadingIntent === "resume" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="w-3.5 h-3.5" />
                    )}
                    Open billing portal to resume</button>
                </div>
              </div>
            </div>
          )}

          {/* Trial-specific note */}
          {isTrialing && !isPendingCancel && (
            <div
              data-testid="banner-trial-info"
              className="rounded-xl border border-border bg-secondary/30 px-4 py-3 text-xs text-muted-foreground"
            >
              You're on the free trial. Cancelling before it ends prevents any charge.
            </div>
          )}

          {/* Action list */}
          <div className="space-y-2.5">
            {/* Cancel — primary destructive action, listed first because that's why people open this */}
            <button
              type="button"
              data-testid="button-cancel-subscription"
              onClick={() => openPortal("cancel")}
              disabled={loadingIntent !== null || isPendingCancel}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 rounded-xl border border-red-500/40 bg-red-500/10 hover:bg-red-500/15 active:bg-red-500/20 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-red-500/20 flex items-center justify-center flex-shrink-0">
                  <XCircle className="w-5 h-5 text-red-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-red-300">
                    {isPendingCancel ? "Cancellation already scheduled" : "Cancel my subscription"}
                  </div>
                  <div className="text-[11px] text-red-200/70 mt-0.5">
                    {isPendingCancel
                      ? "Use 'Resume' above if you changed your mind"
                      : "Stop renewing. Keep access until your current period ends."}
                  </div>
                </div>
              </div>
              {loadingIntent === "cancel" ? (
                <Loader2 className="w-4 h-4 animate-spin text-red-300 flex-shrink-0" />
              ) : (
                <ExternalLink className="w-4 h-4 text-red-300/70 flex-shrink-0" />
              )}
            </button>

            {/* Switch / downgrade */}
            <button
              type="button"
              data-testid="button-switch-plan"
              onClick={() => openPortal("switch")}
              disabled={loadingIntent !== null}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 rounded-xl border border-border bg-secondary/40 hover:bg-secondary active:bg-secondary/80 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center flex-shrink-0">
                  <ArrowRightLeft className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-foreground">Switch or downgrade plan</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Move between Pro and All Sports, or pick a different tier
                  </div>
                </div>
              </div>
              {loadingIntent === "switch" ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground flex-shrink-0" />
              ) : (
                <ExternalLink className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              )}
            </button>

            {/* Update payment method */}
            <button
              type="button"
              data-testid="button-update-payment"
              onClick={() => openPortal("payment")}
              disabled={loadingIntent !== null}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 rounded-xl border border-border bg-secondary/40 hover:bg-secondary active:bg-secondary/80 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center flex-shrink-0">
                  <CreditCard className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-foreground">Update payment method</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Change card, billing address, or download invoices
                  </div>
                </div>
              </div>
              {loadingIntent === "payment" ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground flex-shrink-0" />
              ) : (
                <ExternalLink className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              )}
            </button>
          </div>

          {error && (
            <div
              data-testid="text-portal-error"
              className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2"
            >
              {error}
            </div>
          )}

          {/* Footer help text */}
          <div className="text-[11px] text-muted-foreground leading-relaxed pt-1 pb-1">
            All changes are processed by our billing partner Stripe and take effect immediately.
            You'll be redirected to a secure Stripe page to confirm.
          </div>
        </div>
      </div>
    </div>
  );
}
