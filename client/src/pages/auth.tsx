import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Activity } from "lucide-react";

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
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <Activity className="w-6 h-6 text-primary" />
          <span className="text-xl font-bold text-foreground tracking-tight">LiveLocks</span>
        </div>

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
      </div>
    </div>
  );
}
