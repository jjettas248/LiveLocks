import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation, useSearch } from "wouter";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

const resetSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(8, "Please confirm your password"),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type ResetForm = z.infer<typeof resetSchema>;

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const token = new URLSearchParams(search).get("token");

  const [status, setStatus] = useState<"form" | "success" | "error">("form");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const form = useForm<ResetForm>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = async (data: ResetForm) => {
    if (!token) {
      setErrorMessage("Invalid reset link. Please request a new one.");
      setStatus("error");
      return;
    }
    setIsPending(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: data.password }),
      });
      const result = await res.json();
      if (!res.ok) {
        setErrorMessage(result.error || "Something went wrong.");
        setStatus("error");
      } else {
        setStatus("success");
      }
    } catch {
      setErrorMessage("Network error. Please try again.");
      setStatus("error");
    } finally {
      setIsPending(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-4">
          <div className="flex flex-col items-center gap-2 mb-2">
            <img src={propPulseLogo} alt="PropPulse" className="w-16 h-16 rounded-2xl object-cover shadow-lg shadow-primary/20 ring-2 ring-primary/30" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">LiveLocks</h1>
          </div>
          <div className="bg-card border border-border rounded-xl p-6 shadow-sm text-center space-y-3">
            <h2 className="text-lg font-bold text-foreground">Invalid Reset Link</h2>
            <p className="text-sm text-muted-foreground">This password reset link is invalid or has expired.</p>
            <button
              data-testid="button-back-to-login"
              onClick={() => navigate("/auth")}
              className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
            >
              Back to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex flex-col items-center gap-2 mb-2">
          <img src={propPulseLogo} alt="PropPulse" className="w-16 h-16 rounded-2xl object-cover shadow-lg shadow-primary/20 ring-2 ring-primary/30" />
          <div className="text-center leading-tight">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">LiveLocks</h1>
            <p className="text-xs text-muted-foreground font-medium tracking-widest uppercase mt-0.5">by PropPulse</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          {status === "success" ? (
            <div className="text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-green-500/15 flex items-center justify-center mx-auto">
                <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-foreground">Password Reset</h2>
              <p className="text-sm text-muted-foreground">Your password has been updated. You can now sign in with your new password.</p>
              <button
                data-testid="button-go-to-login"
                onClick={() => navigate("/auth")}
                className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold"
              >
                Sign In
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-bold text-foreground text-center mb-1">Reset Password</h2>
              <p className="text-xs text-muted-foreground text-center mb-5">Enter your new password below.</p>

              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground block mb-1.5">New Password</label>
                  <input
                    data-testid="input-new-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    {...form.register("password")}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  />
                  {form.formState.errors.password && (
                    <p className="text-xs text-destructive mt-1">{form.formState.errors.password.message}</p>
                  )}
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground block mb-1.5">Confirm Password</label>
                  <input
                    data-testid="input-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    {...form.register("confirmPassword")}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  />
                  {form.formState.errors.confirmPassword && (
                    <p className="text-xs text-destructive mt-1">{form.formState.errors.confirmPassword.message}</p>
                  )}
                </div>

                {errorMessage && (
                  <div data-testid="reset-error" className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                    {errorMessage}
                  </div>
                )}

                <button
                  data-testid="button-reset-password"
                  type="submit"
                  disabled={isPending}
                  className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isPending ? (
                    <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  ) : "Reset Password"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
