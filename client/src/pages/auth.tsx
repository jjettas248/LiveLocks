import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const registerSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  smsConsent: z.literal(true, {
    errorMap: () => ({ message: "You must agree to the terms to continue." }),
  }),
});

type LoginForm = z.infer<typeof loginSchema>;
type RegisterForm = z.infer<typeof registerSchema>;

export default function AuthPage() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { login, loginPending, register, registerPending } = useAuth();
  const [, navigate] = useLocation();

  const loginForm = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const registerForm = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: "", password: "", smsConsent: undefined as any },
  });

  const isPending = loginPending || registerPending;

  const onLoginSubmit = async (data: LoginForm) => {
    setErrorMessage(null);
    try {
      await login(data);
      navigate("/");
    } catch (err: any) {
      setErrorMessage(err.message || "Something went wrong. Please try again.");
    }
  };

  const onRegisterSubmit = async (data: RegisterForm) => {
    setErrorMessage(null);
    try {
      await register({ email: data.email, password: data.password, smsConsent: data.smsConsent });
      navigate("/");
    } catch (err: any) {
      setErrorMessage(err.message || "Something went wrong. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
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

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <div className="flex rounded-lg bg-muted p-1 mb-6">
            <button
              data-testid="tab-login"
              type="button"
              onClick={() => { setTab("login"); setErrorMessage(null); }}
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
              onClick={() => { setTab("register"); setErrorMessage(null); }}
              className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors ${
                tab === "register"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Create Account
            </button>
          </div>

          {tab === "login" && (
            <form onSubmit={loginForm.handleSubmit(onLoginSubmit)} className="space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">Email</label>
                <input
                  data-testid="input-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  {...loginForm.register("email")}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
                {loginForm.formState.errors.email && (
                  <p className="text-xs text-destructive mt-1">{loginForm.formState.errors.email.message}</p>
                )}
              </div>

              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">Password</label>
                <input
                  data-testid="input-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  {...loginForm.register("password")}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
                {loginForm.formState.errors.password && (
                  <p className="text-xs text-destructive mt-1">{loginForm.formState.errors.password.message}</p>
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
                ) : "Sign In"}
              </button>
            </form>
          )}

          {tab === "register" && (
            <form onSubmit={registerForm.handleSubmit(onRegisterSubmit)} className="space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">Email</label>
                <input
                  data-testid="input-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  {...registerForm.register("email")}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
                {registerForm.formState.errors.email && (
                  <p className="text-xs text-destructive mt-1">{registerForm.formState.errors.email.message}</p>
                )}
              </div>

              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">Password</label>
                <input
                  data-testid="input-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  {...registerForm.register("password")}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
                {registerForm.formState.errors.password && (
                  <p className="text-xs text-destructive mt-1">{registerForm.formState.errors.password.message}</p>
                )}
              </div>

              <div className="flex items-start gap-2.5">
                <input
                  data-testid="input-sms-consent"
                  type="checkbox"
                  id="smsConsent"
                  {...registerForm.register("smsConsent")}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-primary flex-shrink-0 cursor-pointer"
                />
                <label htmlFor="smsConsent" className="text-[11px] text-muted-foreground leading-relaxed cursor-pointer">
                  I agree to the{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-primary/80 hover:text-primary underline">Terms of Service</a>
                  {" "}and{" "}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary/80 hover:text-primary underline">Privacy Policy</a>
                  , and I explicitly consent to receive SMS text alerts and account notifications from LiveLocks AI. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.
                </label>
              </div>
              {registerForm.formState.errors.smsConsent && (
                <p className="text-xs text-destructive -mt-2">{registerForm.formState.errors.smsConsent.message}</p>
              )}

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
                ) : "Create Account"}
              </button>

              <p className="text-xs text-muted-foreground text-center">
                New accounts get {15} free plays. Upgrade anytime to unlock unlimited access.
              </p>
            </form>
          )}
        </div>

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
