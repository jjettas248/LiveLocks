import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Mail, RefreshCw, CheckCircle } from "lucide-react";

const RESEND_COOLDOWN_SECONDS = 60;

export default function VerifyPendingPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    try {
      await apiRequest("POST", "/api/auth/resend-verification");
      setResent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      toast({ title: "Email sent", description: "Check your inbox for the verification link." });
    } catch (err: any) {
      const msg = err?.message || "Could not resend. Try again shortly.";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setResending(false);
    }
  };

  const email = user?.email ?? "your inbox";

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center space-y-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center ring-2 ring-primary/20">
            <Mail className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Check your inbox</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We sent a verification link to{" "}
            <span className="font-medium text-foreground" data-testid="text-verify-email">
              {email}
            </span>
            . Click it to activate your account and get your{" "}
            <span className="font-medium text-foreground">3 free plays</span>.
          </p>
        </div>

        <div className="space-y-3">
          <button
            data-testid="button-resend-verification"
            onClick={handleResend}
            disabled={cooldown > 0 || resending}
            className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2 transition-opacity"
          >
            {resending ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : resent ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {cooldown > 0
              ? `Resend in ${cooldown}s`
              : resending
              ? "Sending…"
              : resent
              ? "Resend email"
              : "Resend email"}
          </button>

          <p className="text-xs text-muted-foreground">
            Already verified?{" "}
            <Link
              href="/auth"
              className="text-primary hover:underline"
              data-testid="link-signin-from-verify"
            >
              Sign in
            </Link>
          </p>
        </div>

        <p className="text-xs text-muted-foreground/60">
          Didn&apos;t receive it? Check your spam folder or resend above.
        </p>
      </div>
    </div>
  );
}
