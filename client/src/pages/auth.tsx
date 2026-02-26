import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

const authSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
type AuthForm = z.infer<typeof authSchema>;

export default function AuthPage() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { login, loginPending, register, registerPending } = useAuth();
  const [, navigate] = useLocation();

  const form = useForm<AuthForm>({
    resolver: zodResolver(authSchema),
    defaultValues: { email: "", password: "" },
  });

  const isPending = loginPending || registerPending;

  const onSubmit = async (data: AuthForm) => {
    setErrorMessage(null);
    try {
      if (tab === "login") {
        await login(data);
      } else {
        await register(data);
      }
      navigate("/");
    } catch (err: any) {
      setErrorMessage(err.message || "Something went wrong. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        {/* Logo + Branding */}
        <div className="flex flex-col items-center gap-2 mb-2">
          <img
            src={propPulseLogo}
            alt="PropPulse"
            className="w-16 h-16 rounded-2xl object-cover shadow-lg shadow-primary/20 ring-2 ring-primary/30"
          />
          <div className="text-center leading-tight">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">LiveLocks</h1>
            <p className="text-xs text-muted-foreground font-medium tracking-widest uppercase mt-0.5">by PropPulse</p>
          </div>
        </div>

        {/* Auth Card */}
        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <div className="flex rounded-lg bg-muted p-1 mb-6">
            <button
              data-testid="tab-login"
              type="button"
              onClick={() => { setTab("login"); setErrorMessage(null); form.clearErrors(); }}
              className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors ${
                tab === "login"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Sign In
            </button>
            <button
              data-testid="tab-register"
              type="button"
              onClick={() => { setTab("register"); setErrorMessage(null); form.clearErrors(); }}
              className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors ${
                tab === "register"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">Email</label>
              <input
                data-testid="input-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                {...form.register("email")}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive mt-1">{form.formState.errors.email.message}</p>
              )}
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">Password</label>
              <input
                data-testid="input-password"
                type="password"
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                placeholder="••••••••"
                {...form.register("password")}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              />
              {form.formState.errors.password && (
                <p className="text-xs text-destructive mt-1">{form.formState.errors.password.message}</p>
              )}
            </div>

            {errorMessage && (
              <div data-testid="auth-error" className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                {errorMessage}
              </div>
            )}

            <button
              data-testid="button-submit-auth"
              type="submit"
              disabled={isPending}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isPending ? (
                <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
              ) : tab === "login" ? "Sign In" : "Create Account"}
            </button>
          </form>

          {tab === "register" && (
            <p className="text-xs text-muted-foreground text-center mt-4">
              New accounts get 10 free plays. Upgrade anytime to unlock unlimited access.
            </p>
          )}
        </div>

        {/* MLB Coming Soon Teaser */}
        <div
          data-testid="mlb-teaser"
          className="relative rounded-xl border border-primary/30 bg-gradient-to-br from-primary/5 via-card to-card p-4 shadow-sm overflow-hidden"
          style={{ boxShadow: "0 0 24px -4px hsl(var(--primary) / 0.15)" }}
        >
          <div className="absolute inset-0 pointer-events-none rounded-xl ring-1 ring-inset ring-primary/20" />
          <div className="flex items-start gap-3">
            <span className="text-2xl leading-none mt-0.5" role="img" aria-label="baseball">⚾</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-foreground">MLB Coming Soon</span>
                <span className="text-[10px] font-bold uppercase tracking-wider bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">Beta</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Live MLB prop predictions are launching next month. Create an account now to lock in early access — beta testers get priority.
              </p>
              <button
                data-testid="button-mlb-beta"
                type="button"
                onClick={() => { setTab("register"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                className="mt-2.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
              >
                Create account for early access →
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
