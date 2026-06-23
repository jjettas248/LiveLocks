import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import AuthPage from "@/pages/auth";
import AdminPage from "@/pages/admin";
import MlbSignalIntelligencePage from "@/pages/admin/mlb-signal-intelligence";
import NcaabLivePage from "@/pages/ncaab-live";
import PrivacyPage from "@/pages/privacy";
import TermsPage from "@/pages/terms";
import LandingPage from "@/pages/landing";
import TwitterLandingPage from "@/pages/twitter-landing";
import VerifyPendingPage from "@/pages/verify-pending";
import ResetPasswordPage from "@/pages/reset-password";
import { useAuth } from "@/hooks/use-auth";
import { useAttributionCapture } from "@/hooks/useAttributionCapture";
import { safeReturnTo } from "@/lib/returnTo";
import { useEffect } from "react";

function AdminRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/admin"); }, [navigate]);
  return null;
}

function ProtectedRouter() {
  const { user, isLoading } = useAuth();
  const [location, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !user && location !== "/auth") {
      // Preserve the attempted destination so SMS/push/bookmark deep links
      // survive the auth round-trip instead of always dumping on /dashboard.
      // wouter's location is path-only, so append the query string — that's
      // where deep-link state (tab/gameId/cardType) and Stripe-return params
      // (payment/tier/session_id) live.
      const attempted = `${location}${window.location.search}`;
      const returnTo = attempted && attempted !== "/" ? `?returnTo=${encodeURIComponent(attempted)}` : "";
      navigate(`/auth${returnTo}`);
    }
    if (!isLoading && user && location === "/auth") {
      navigate(safeReturnTo() || "/dashboard");
    }
    if (!isLoading && user && !user.isAdmin && (location === "/admin" || location === "/analytics" || location === "/performance")) {
      navigate("/dashboard");
    }
  }, [user, isLoading, location, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <Switch>
      <Route path="/auth" component={AuthPage} />
      <Route path="/admin" component={AdminPage} />
      <Route path="/admin/mlb-signal-intelligence" component={MlbSignalIntelligencePage} />
      <Route path="/analytics" component={AdminRedirect} />
      <Route path="/performance" component={AdminRedirect} />
      <Route path="/ncaab" component={NcaabLivePage} />
      <Route path="/dashboard" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function RootRedirect() {
  const { user, isLoading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && user) {
      // Preserve any query string (e.g. PWA shortcuts / notification deep-links
      // like `/?tab=mlb`) so the dashboard can read `tab` from location.search.
      navigate("/dashboard" + window.location.search);
    }
  }, [user, isLoading, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <LandingPage />;
}

function AppShell() {
  // Global attribution capture — fires once per page mount on every public
  // route (idempotent: localStorage first-touch + server-side dedupe). Routes
  // that need a forced utm_source (e.g. organic Twitter visits with no UTM
  // params) are detected here so individual page components don't have to
  // also mount the hook and double-fire the POST.
  const [location] = useLocation();
  const forceSource = location === "/twitter" ? "twitter" : undefined;
  useAttributionCapture(forceSource ? { forceSource } : undefined);
  return (
    <Switch>
      <Route path="/" component={RootRedirect} />
      <Route path="/landing" component={LandingPage} />
      <Route path="/twitter" component={TwitterLandingPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
      <Route path="/verify-pending" component={VerifyPendingPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route component={ProtectedRouter} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppShell />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
