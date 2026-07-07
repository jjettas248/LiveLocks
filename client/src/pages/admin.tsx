import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Users, MessageSquare, RotateCcw, Shield, LogOut, ChevronDown, CreditCard, CheckCircle, AlertCircle, Trash2, Loader2, Settings, Bell, ChevronUp, Send, Target, BarChart3 } from "lucide-react";
import { CalibrationDashboard } from "@/components/calibration-dashboard";
import { UnifiedAnalyticsPanel } from "@/components/unified-analytics";
import { DiagnosticsFooter } from "@/components/admin/DiagnosticsFooter";
import { TwitterAttributionPanel } from "@/components/admin/TwitterAttributionPanel";

import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

const TEST_EMAIL_PATTERNS = [
  /@test\.com$/i,
  /@example\.com$/i,
  /^stripetest_/i,
  /^e2etest_/i,
  /^mobiletest/i,
  /^playlimit/i,
  /^test\+/i,
];

type AdminUser = {
  id: number;
  email: string;
  isAdmin: boolean;
  subscriptionTier: string | null;
  playsUsed: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

type FeedbackRow = {
  id: number;
  userId: number | null;
  message: string;
  createdAt: string;
  userEmail: string | null;
};

const TIER_LABELS: Record<string, string> = {
  "": "Free",
  all: "Pro ($40/mo)",
  elite: "All Sports ($65/mo)",
};

function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">Free</span>;
  if (tier === "elite") return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 font-medium">All Sports</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 font-medium">Pro</span>;
}

function AdminLink() {
  const [, navigate] = useLocation();
  const { logout } = useAuth();
  return (
    <header className="border-b border-border/40 bg-background/80 backdrop-blur-xl sticky top-0 z-50">
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src={propPulseLogo} alt="PropPulse" className="w-9 h-9 rounded-xl object-cover shadow-lg ring-1 ring-primary/20" />
          <div className="flex flex-col leading-none">
            <h1 className="text-xl font-bold tracking-tight text-foreground">LiveLocks</h1>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mt-0.5">Admin Panel</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            data-testid="link-track-record"
            onClick={() => navigate("/admin/track-record")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg border border-border hover:bg-muted"
          >
            Track Record
          </button>
          <button
            data-testid="link-hr-board-studio"
            onClick={() => navigate("/admin/hr-board-studio")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg border border-border hover:bg-muted"
          >
            HR Board Studio
          </button>
          <button
            data-testid="link-dashboard"
            onClick={() => navigate("/dashboard")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg border border-border hover:bg-muted"
          >
            Dashboard
          </button>
          <button
            data-testid="button-admin-logout"
            onClick={() => logout()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg border border-border hover:bg-muted"
          >
            <LogOut className="w-3 h-3" /> Sign Out
          </button>
        </div>
      </div>
    </header>
  );
}

const CLIENT_TIER_PRICES: Record<string, { label: string; pricePerMonth: number }> = {
  "":      { label: "Free",                pricePerMonth: 0 },
  "all":   { label: "Pro ($40/mo)",        pricePerMonth: 40 },
  "elite": { label: "All Sports ($65/mo)", pricePerMonth: 65 },
};

function getNextResetDisplay(timeStr: string): string {
  const [h, m] = timeStr.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "";
  const resetHourUTC = h + 5;
  const next = new Date();
  next.setUTCHours(resetHourUTC, m, 0, 0);
  if (new Date() >= next) next.setUTCDate(next.getUTCDate() + 1);
  const dayName = next.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  const timeLabel = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return `Next reset: ${dayName} at ${timeLabel} EST`;
}

export default function AdminPage() {
  const { user, isLoading: authLoading, logout } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"users" | "feedback" | "calibration" | "churn" | "roi" | "analytics">("users");
  const [tierLoadingId, setTierLoadingId] = useState<number | null>(null);
  const { toast } = useToast();
  const [resetTime, setResetTime] = useState("06:00");
  const [resetTimeSaving, setResetTimeSaving] = useState(false);
  const [verifyResults, setVerifyResults] = useState<Record<number, { dbTier: string | null; hasNcaabAccess: boolean; requiresRefresh: boolean } | "error">>({});
  const [verifyLoadingId, setVerifyLoadingId] = useState<number | null>(null);

  // Alert Tester state
  const [alertTesterOpen, setAlertTesterOpen] = useState(false);
  const [alertForm, setAlertForm] = useState({
    playerName: "", team: "", market: "PTS", direction: "over" as "over" | "under",
    line: "", confidence: "", gameContext: "", sendTo: "self" as "self" | "all",
  });
  const [alertSending, setAlertSending] = useState(false);
  const [alertSentResult, setAlertSentResult] = useState<{ title: string; body: string; deliveredTo: number | string; time: string } | null>(null);
  const [alertTestLog, setAlertTestLog] = useState<Array<{ time: string; playerName: string; direction: string; line: string; market: string; confidence: string; sentTo: string }>>([]);
  const [alertConfirmModal, setAlertConfirmModal] = useState<{ title: string; body: string } | null>(null);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/admin/settings", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.slateResetHour != null) {
          const h = String(data.slateResetHour).padStart(2, "0");
          const m = String(data.slateResetMinute ?? 0).padStart(2, "0");
          setResetTime(`${h}:${m}`);
        }
      })
      .catch(() => {});
  }, []);

  const saveResetTime = async (timeStr: string) => {
    const [hours, minutes] = timeStr.split(":").map(Number);
    if (isNaN(hours) || isNaN(minutes)) return;
    setResetTimeSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ slateResetHour: hours, slateResetMinute: minutes }),
      });
      if (!res.ok) throw new Error("Failed");
      localStorage.setItem("slateResetTime", JSON.stringify({ hours, minutes }));
      toast({ title: `Reset time saved — ${timeStr} EST daily` });
    } catch {
      toast({ title: "Failed to save reset time", variant: "destructive" });
    } finally {
      setResetTimeSaving(false);
    }
  };

  const { data: allUsers, isLoading: usersLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users"],
    enabled: !!user?.isAdmin,
  });

  const { data: allFeedback, isLoading: feedbackLoading } = useQuery<FeedbackRow[]>({
    queryKey: ["/api/admin/feedback"],
    enabled: !!user?.isAdmin && activeTab === "feedback",
  });

  type ChurnUser = { id: number; email: string; churnedAt: string; churnedFromTier: string | null; createdAt: string | null };
  const { data: churnedUsers, isLoading: churnLoading } = useQuery<ChurnUser[]>({
    queryKey: ["/api/admin/churn"],
    enabled: !!user?.isAdmin && activeTab === "churn",
  });

  const handleTierChange = async (userId: number, newTierKey: string) => {
    const u = allUsers?.find(u => u.id === userId);
    if (!u) return;
    setTierLoadingId(userId);
    try {
      const res = await fetch("/api/admin/change-tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, newTierKey }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "Request failed");
      }
      const result = await res.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      const wasDowngrade =
        newTierKey === "" ||
        (CLIENT_TIER_PRICES[newTierKey]?.pricePerMonth ?? 0) <
        (CLIENT_TIER_PRICES[u.subscriptionTier ?? ""]?.pricePerMonth ?? 0);
      toast({
        title: wasDowngrade ? "Tier Downgraded" : "Tier Updated",
        description: result.message,
      });
    } catch (err: any) {
      toast({ title: "Tier Change Failed", description: err.message, variant: "destructive" });
    } finally {
      setTierLoadingId(null);
    }
  };

  const resetPlaysMutation = useMutation({
    mutationFn: (userId: number) =>
      apiRequest("PATCH", `/api/admin/users/${userId}/reset-plays`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (userId: number) =>
      apiRequest("DELETE", `/api/admin/users/${userId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
  });

  const [clearingTestAccounts, setClearingTestAccounts] = useState(false);
  const handleClearTestAccounts = async () => {
    const testUsers = (allUsers ?? []).filter(
      (u) => !u.isAdmin && TEST_EMAIL_PATTERNS.some((p) => p.test(u.email))
    );
    if (testUsers.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${testUsers.length} test account(s)?\n\n${testUsers.map((u) => u.email).join("\n")}`
    );
    if (!confirmed) return;
    setClearingTestAccounts(true);
    for (const u of testUsers) {
      try {
        await apiRequest("DELETE", `/api/admin/users/${u.id}`);
      } catch (_) {}
    }
    await queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    setClearingTestAccounts(false);
  };

  const setupProductsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/stripe/setup-products"),
  });

  const stripeConfigMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/admin/stripe/config-status");
      return res.json();
    },
  });

  function getNotificationTitle(confidence: number): string | null {
    if (confidence < 80) return null;
    if (confidence >= 85) return "🔒 LiveLocks · High Confidence";
    return "🔔 LiveLocks · Confidence Play";
  }

  const buildAlertPayload = () => {
    const conf = parseFloat(alertForm.confidence);
    const line = parseFloat(alertForm.line);
    const title = getNotificationTitle(conf);
    const dirLabel = alertForm.direction === "over" ? "Over" : "Under";
    const body = `${alertForm.playerName} — ${dirLabel} ${line} ${alertForm.market} — ${conf}% confidence${alertForm.gameContext ? ` · ${alertForm.gameContext}` : ""}`;
    return { title, body, conf };
  };

  const handleSendTestAlert = async (confirmed = false) => {
    const { title, body, conf } = buildAlertPayload();
    if (!title) {
      toast({ title: "Confidence below 80% threshold", description: "Alert would not fire in production", variant: "destructive" });
      return;
    }
    if (!alertForm.playerName || !alertForm.line) {
      toast({ title: "Missing fields", description: "Player name and line are required", variant: "destructive" });
      return;
    }
    setAlertSending(true);
    try {
      const res = await fetch("/api/admin/test-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title, body, target: alertForm.sendTo, confirmed }),
      });
      const data = await res.json();
      if (data.requiresConfirmation) {
        setSubscriberCount(data.subscriberCount ?? null);
        setAlertConfirmModal({ title, body });
        return;
      }
      if (!res.ok) {
        toast({ title: "Failed", description: data.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      const time = new Date().toLocaleTimeString();
      toast({ title: "✓ Test alert sent", description: `Delivered to: ${alertForm.sendTo === "self" ? "you" : `${data.deliveredTo} subscribers`}` });
      setAlertSentResult({ title, body, deliveredTo: data.deliveredTo, time });
      setAlertTestLog(prev => [{
        time, playerName: alertForm.playerName, direction: alertForm.direction,
        line: alertForm.line, market: alertForm.market, confidence: alertForm.confidence,
        sentTo: alertForm.sendTo === "self" ? "self" : `all (${data.deliveredTo})`,
      }, ...prev].slice(0, 10));
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setAlertSending(false);
      setAlertConfirmModal(null);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    navigate("/auth");
    return null;
  }

  if (!user.isAdmin) {
    navigate("/dashboard");
    return null;
  }

  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      <AdminLink />
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6 space-y-4 min-w-0">
        {/* Summary pills */}
        <div className="flex gap-3 flex-wrap">
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card border border-border text-sm">
            <Users className="w-4 h-4 text-primary" />
            <span className="text-muted-foreground">Total users:</span>
            <span className="font-bold text-foreground">{allUsers?.length ?? "—"}</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card border border-border text-sm">
            <Shield className="w-4 h-4 text-blue-400" />
            <span className="text-muted-foreground">Subscribers:</span>
            <span className="font-bold text-foreground">{allUsers?.filter(u => u.subscriptionTier).length ?? "—"}</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card border border-border text-sm">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            <span className="text-muted-foreground">Free users:</span>
            <span className="font-bold text-foreground">{allUsers?.filter(u => !u.subscriptionTier && !u.isAdmin).length ?? "—"}</span>
          </div>
        </div>

        {/* Stripe Tools */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <CreditCard className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Stripe Tools</h3>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              data-testid="button-setup-products"
              onClick={() => setupProductsMutation.mutate()}
              disabled={setupProductsMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 hover:bg-primary/90 transition-colors"
            >
              {setupProductsMutation.isPending ? (
                <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
              ) : (
                <CreditCard className="w-4 h-4" />
              )}
              Setup Stripe Products
            </button>
            <button
              data-testid="button-check-stripe-config"
              onClick={() => stripeConfigMutation.mutate()}
              disabled={stripeConfigMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-muted text-foreground text-sm font-semibold disabled:opacity-50 hover:bg-muted/80 transition-colors border border-border"
            >
              {stripeConfigMutation.isPending ? (
                <div className="w-4 h-4 border-2 border-foreground border-t-transparent rounded-full animate-spin" />
              ) : (
                <Settings className="w-4 h-4" />
              )}
              Check Stripe Config
            </button>
            {setupProductsMutation.isSuccess && (
              <div className="flex items-center gap-2 text-sm text-green-400" data-testid="text-setup-success">
                <CheckCircle className="w-4 h-4" />
                <span>
                  Products ready — Pro: <code className="text-xs bg-muted px-1 rounded">{(setupProductsMutation.data as any)?.priceIds?.all ?? "existing"}</code>
                  {" "}All Sports: <code className="text-xs bg-muted px-1 rounded">{(setupProductsMutation.data as any)?.priceIds?.elite ?? "existing"}</code>
                </span>
              </div>
            )}
            {setupProductsMutation.isError && (
              <div className="flex items-center gap-2 text-sm text-destructive" data-testid="text-setup-error">
                <AlertCircle className="w-4 h-4" />
                <span>Failed: {(setupProductsMutation.error as any)?.message ?? "Unknown error"}</span>
              </div>
            )}
            {stripeConfigMutation.isError && (
              <div className="flex items-center gap-2 text-sm text-destructive" data-testid="text-stripe-config-error">
                <AlertCircle className="w-4 h-4" />
                <span>Failed: {(stripeConfigMutation.error as any)?.message ?? "Unknown error"}</span>
              </div>
            )}
          </div>
          {stripeConfigMutation.isSuccess && (
            <div
              className={`w-full text-sm mt-3 p-3 rounded-lg bg-muted/50 border ${(stripeConfigMutation.data as any)?.configured ? "border-green-400/40" : "border-destructive/40"}`}
              data-testid="text-stripe-config-result"
            >
              <div className={`flex items-center gap-2 font-semibold ${(stripeConfigMutation.data as any)?.configured ? "text-green-400" : "text-destructive"}`}>
                {(stripeConfigMutation.data as any)?.configured ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                <span>{(stripeConfigMutation.data as any)?.configured ? "Stripe is configured" : "Stripe is NOT fully configured"}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Secret key: <span className="text-foreground">{(stripeConfigMutation.data as any)?.secretKeyMode}</span></span>
                <span>Webhook secret: <span className="text-foreground">{(stripeConfigMutation.data as any)?.hasWebhookSecret ? "present" : "missing"}</span></span>
                <span>Pro price ID: <span className="text-foreground">{(stripeConfigMutation.data as any)?.hasProPrice ? "present" : "missing"}</span></span>
                <span>All Sports price ID: <span className="text-foreground">{(stripeConfigMutation.data as any)?.hasAllSportsPrice ? "present" : "missing"}</span></span>
              </div>
              {(stripeConfigMutation.data as any)?.missing?.length > 0 && (
                <div className="mt-2 text-xs text-destructive">
                  Missing env vars: {(stripeConfigMutation.data as any).missing.join(", ")}
                </div>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            Creates the Pro ($40/mo) and All Sports ($65/mo) products in your Stripe account if they don't already exist. Run this once after switching to live Stripe keys.
          </p>
        </div>

        {/* Tab nav */}
        <div className="flex rounded-lg bg-muted p-1 w-fit max-w-full overflow-x-auto">
          <button
            data-testid="tab-users"
            onClick={() => setActiveTab("users")}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "users" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            Users
          </button>
          <button
            data-testid="tab-feedback"
            onClick={() => setActiveTab("feedback")}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "feedback" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            Feedback
          </button>
          <button
            data-testid="tab-churn"
            onClick={() => setActiveTab("churn")}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "churn" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
            Churn
          </button>
          <button
            data-testid="tab-analytics"
            onClick={() => setActiveTab("analytics")}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "analytics" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            Analytics
          </button>
          <button
            data-testid="tab-calibration"
            onClick={() => setActiveTab("calibration")}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "calibration" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Target className="w-3.5 h-3.5" />
            Calibration
          </button>
          <button
            data-testid="tab-roi"
            onClick={() => setActiveTab("roi")}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "roi" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Shield className="w-3.5 h-3.5" />
            ROI
          </button>
        </div>

        {/* Users table */}
        {activeTab === "users" && (
          <>
          {/* Activity summary */}
          {!usersLoading && (allUsers ?? []).length > 0 && (() => {
            const now = Date.now();
            const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
            const realUsers = (allUsers ?? []).filter((u) => !u.isAdmin && !TEST_EMAIL_PATTERNS.some((p) => p.test(u.email)));
            const active = realUsers.filter((u) => u.lastLoginAt && now - new Date(u.lastLoginAt).getTime() < THIRTY_DAYS);
            const inactive = realUsers.filter((u) => u.lastLoginAt && now - new Date(u.lastLoginAt).getTime() >= THIRTY_DAYS);
            const neverLogged = realUsers.filter((u) => !u.lastLoginAt);
            return (
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-card border border-border rounded-xl px-4 py-3">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Active (30d)</div>
                  <div className="text-2xl font-bold text-emerald-400">{active.length}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">logged in last 30 days</div>
                </div>
                <div className="bg-card border border-border rounded-xl px-4 py-3">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Inactive (30d+)</div>
                  <div className="text-2xl font-bold text-yellow-400">{inactive.length}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">no login in 30+ days</div>
                </div>
                <div className="bg-card border border-border rounded-xl px-4 py-3">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Never Logged In</div>
                  <div className="text-2xl font-bold text-muted-foreground">{neverLogged.length}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">signed up, never returned</div>
                </div>
              </div>
            );
          })()}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" /> All Users
              </h2>
              {(allUsers ?? []).some((u) => !u.isAdmin && TEST_EMAIL_PATTERNS.some((p) => p.test(u.email))) && (
                <button
                  data-testid="button-clear-test-accounts"
                  onClick={handleClearTestAccounts}
                  disabled={clearingTestAccounts}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                >
                  {clearingTestAccounts ? (
                    <div className="w-3 h-3 border border-destructive border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                  Clear Test Accounts
                </button>
              )}
            </div>
            {usersLoading ? (
              <div className="p-8 flex justify-center">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/30">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Joined</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last Seen</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tier</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plays Used</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(allUsers ?? []).map((u) => (
                      <tr key={u.id} data-testid={`row-user-${u.id}`} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span data-testid={`text-email-${u.id}`} className="text-foreground font-medium truncate max-w-xs">{u.email}</span>
                            {u.isAdmin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-bold">Admin</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {u.lastLoginAt ? (() => {
                            const diffDays = Math.floor((Date.now() - new Date(u.lastLoginAt).getTime()) / (1000 * 60 * 60 * 24));
                            return (
                              <span className={diffDays <= 7 ? "text-emerald-400" : diffDays <= 30 ? "text-yellow-400" : "text-muted-foreground"}>
                                {diffDays === 0 ? "Today" : diffDays === 1 ? "Yesterday" : `${diffDays}d ago`}
                              </span>
                            );
                          })() : <span className="text-muted-foreground/40">Never</span>}
                        </td>
                        <td className="px-4 py-3">
                          <TierBadge tier={u.subscriptionTier} />
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {u.subscriptionTier || u.isAdmin ? (
                            <span className="text-xs text-muted-foreground/50">unlimited</span>
                          ) : (
                            <span className={u.playsUsed >= 3 ? "text-destructive font-semibold" : ""}>{u.playsUsed} / 3</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {/* Tier selector */}
                            <div className="relative flex items-center gap-1.5">
                              <div className="relative">
                                <select
                                  data-testid={`select-tier-${u.id}`}
                                  value={u.subscriptionTier ?? ""}
                                  disabled={u.isAdmin || tierLoadingId === u.id}
                                  onChange={(e) => handleTierChange(u.id, e.target.value)}
                                  className="text-xs px-2 py-1.5 pr-6 rounded-lg bg-background border border-border text-foreground appearance-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-primary/50"
                                >
                                  <option value="">Free</option>
                                  <option value="all">Pro ($40/mo)</option>
                                  <option value="elite">All Sports ($65/mo)</option>
                                </select>
                                <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                              </div>
                              {tierLoadingId === u.id && (
                                <Loader2 className="animate-spin w-3 h-3 text-muted-foreground" />
                              )}
                            </div>
                            {/* Reset plays */}
                            {!u.isAdmin && !u.subscriptionTier && (
                              <button
                                data-testid={`button-reset-plays-${u.id}`}
                                onClick={() => resetPlaysMutation.mutate(u.id)}
                                disabled={resetPlaysMutation.isPending}
                                title="Reset play count to 0"
                                className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                              >
                                <RotateCcw className="w-3 h-3" /> Reset
                              </button>
                            )}
                            {/* Delete */}
                            {!u.isAdmin && (
                              <button
                                data-testid={`button-delete-user-${u.id}`}
                                onClick={() => {
                                  if (window.confirm(`Permanently delete ${u.email}?`)) {
                                    deleteUserMutation.mutate(u.id);
                                  }
                                }}
                                disabled={deleteUserMutation.isPending}
                                title="Permanently delete this account"
                                className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border border-destructive/30 text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                            {/* Verify Access */}
                            {!u.isAdmin && (
                              <button
                                data-testid={`button-verify-access-${u.id}`}
                                disabled={verifyLoadingId === u.id}
                                title="Check live DB tier vs session tier"
                                onClick={async () => {
                                  setVerifyLoadingId(u.id);
                                  try {
                                    const token = getAuthToken();
                                    const headers: Record<string, string> = {};
                                    if (token) headers["Authorization"] = `Bearer ${token}`;
                                    const res = await fetch(`/api/admin/verify-access?userId=${u.id}`, { credentials: "include", headers });
                                    if (!res.ok) throw new Error("Failed");
                                    const data = await res.json();
                                    setVerifyResults(prev => ({ ...prev, [u.id]: data }));
                                  } catch {
                                    setVerifyResults(prev => ({ ...prev, [u.id]: "error" }));
                                  } finally {
                                    setVerifyLoadingId(null);
                                  }
                                }}
                                className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border border-blue-500/30 text-blue-400/70 hover:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40"
                              >
                                {verifyLoadingId === u.id
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Shield className="w-3 h-3" />}
                                Verify
                              </button>
                            )}
                          </div>
                          {/* Verify result row */}
                          {verifyResults[u.id] && (
                            <div data-testid={`text-verify-result-${u.id}`} className="mt-1.5 flex flex-wrap gap-2 items-center">
                              {verifyResults[u.id] === "error" ? (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/20">Fetch error</span>
                              ) : (() => {
                                const r = verifyResults[u.id] as { dbTier: string | null; hasNcaabAccess: boolean; requiresRefresh: boolean };
                                return (
                                  <>
                                    <span className="text-[10px] px-2 py-0.5 rounded border font-mono" style={{ background: r.dbTier ? "hsl(var(--brand-accent) / 0.1)" : "rgba(82,82,91,0.2)", borderColor: r.dbTier ? "hsl(var(--brand-accent) / 0.3)" : "#3f3f46", color: r.dbTier ? "hsl(var(--brand-accent))" : "#71717a" }}>
                                      DB: {r.dbTier ?? "free"}
                                    </span>
                                    <span className="text-[10px] px-2 py-0.5 rounded border font-mono" style={{ background: r.hasNcaabAccess ? "hsl(var(--brand-accent) / 0.1)" : "rgba(239,68,68,0.1)", borderColor: r.hasNcaabAccess ? "hsl(var(--brand-accent) / 0.3)" : "rgba(239,68,68,0.3)", color: r.hasNcaabAccess ? "hsl(var(--brand-accent))" : "#ef4444" }}>
                                      NCAAB: {r.hasNcaabAccess ? "✓" : "✗"}
                                    </span>
                                    <span className="text-[10px] px-2 py-0.5 rounded border font-mono" style={{ background: r.requiresRefresh ? "rgba(245,158,11,0.1)" : "rgba(82,82,91,0.1)", borderColor: r.requiresRefresh ? "rgba(245,158,11,0.3)" : "#3f3f46", color: r.requiresRefresh ? "#f59e0b" : "#71717a" }}>
                                      refresh: {r.requiresRefresh ? "pending" : "clear"}
                                    </span>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(allUsers ?? []).length === 0 && (
                  <div className="p-8 text-center text-muted-foreground text-sm">No users yet.</div>
                )}
              </div>
            )}
          </div>
          </>
        )}

        {/* Feedback inbox */}
        {activeTab === "feedback" && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/60">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-amber-400" /> User Feedback
              </h2>
            </div>
            {feedbackLoading ? (
              <div className="p-8 flex justify-center">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {(allFeedback ?? []).map((f) => (
                  <div key={f.id} data-testid={`feedback-row-${f.id}`} className="px-4 py-4 hover:bg-muted/20 transition-colors">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{f.userEmail ?? "Anonymous"}</span>
                      <span className="text-xs text-muted-foreground/50">
                        {f.createdAt ? new Date(f.createdAt).toLocaleString() : ""}
                      </span>
                    </div>
                    <p className="text-sm text-foreground leading-relaxed">{f.message}</p>
                  </div>
                ))}
                {(allFeedback ?? []).length === 0 && (
                  <div className="p-8 text-center text-muted-foreground text-sm">No feedback yet.</div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Slate Settings */}
        <div className="bg-card border border-border rounded-xl p-5" data-testid="slate-settings-section">
          <div className="flex items-center gap-2 mb-1" style={{ borderTop: "none" }}>
            <Settings className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Slate Settings</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-4">Configure when the daily game slate resets.</p>

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-foreground mb-0.5">Daily Slate Reset Time</p>
              <p className="text-xs text-muted-foreground mb-3">Games and plays reset at this time (EST)</p>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <input
                    data-testid="input-reset-time"
                    type="time"
                    value={resetTime}
                    onChange={e => setResetTime(e.target.value)}
                    style={{
                      background: "#181818",
                      border: "1px solid #27272a",
                      color: "#ffffff",
                      borderRadius: "8px",
                      padding: "8px 12px",
                      fontSize: "14px",
                      fontFamily: "monospace",
                      width: "120px",
                    }}
                  />
                  <span className="text-sm text-muted-foreground">EST</span>
                </div>
                <button
                  data-testid="button-save-reset-time"
                  onClick={() => saveResetTime(resetTime)}
                  disabled={resetTimeSaving}
                  style={{
                    background: "hsl(var(--brand-accent) / 0.15)",
                    border: "1px solid hsl(var(--brand-accent) / 0.3)",
                    color: "hsl(var(--brand-accent))",
                    fontSize: "13px",
                    fontWeight: 600,
                    borderRadius: "8px",
                    padding: "8px 16px",
                    cursor: resetTimeSaving ? "not-allowed" : "pointer",
                    opacity: resetTimeSaving ? 0.6 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {resetTimeSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                  Save Reset Time
                </button>
              </div>
              <p
                data-testid="text-next-reset"
                className="text-xs mt-2"
                style={{ color: "#71717a" }}
              >
                {getNextResetDisplay(resetTime)}
              </p>
            </div>
          </div>
        </div>

        {/* Churn Tab */}
        {activeTab === "churn" && (
          <div data-testid="panel-churn" className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/60">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive" /> Churned Users
              </h2>
              <p className="text-xs text-muted-foreground mt-1">Users who cancelled their paid subscription</p>
            </div>
            {churnLoading ? (
              <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : !churnedUsers?.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No churned users yet</div>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-border/40 flex items-center gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-destructive" />
                    <span className="font-medium">{churnedUsers.length} total churned</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span className="font-medium">{churnedUsers.filter(u => u.churnedFromTier === "elite").length} from All Sports</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-primary" />
                    <span className="font-medium">{churnedUsers.filter(u => u.churnedFromTier === "all").length} from Pro</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/40 bg-muted/30">
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Email</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Previous Tier</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Churned</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Signed Up</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Lifetime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {churnedUsers.map((u) => {
                        const churnDate = new Date(u.churnedAt);
                        const signupDate = u.createdAt ? new Date(u.createdAt) : null;
                        const lifetimeDays = signupDate ? Math.round((churnDate.getTime() - signupDate.getTime()) / 86400000) : null;
                        return (
                          <tr key={u.id} data-testid={`churn-row-${u.id}`} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                            <td className="px-4 py-2.5 font-medium text-foreground">{u.email}</td>
                            <td className="px-4 py-2.5">
                              <TierBadge tier={u.churnedFromTier} />
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                              {churnDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                              {signupDate ? signupDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                              {lifetimeDays != null ? `${lifetimeDays}d` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* Analytics Tab */}
        {activeTab === "analytics" && (
          <div data-testid="panel-analytics" className="space-y-6">
            <RailAnalyticsTile />
            <TwitterAttributionPanel />
            <UnifiedAnalyticsPanel />
          </div>
        )}

        {/* Calibration Tab */}
        {activeTab === "calibration" && (
          <div data-testid="panel-calibration">
            <CalibrationDashboard />
          </div>
        )}

        {/* ROI Tab */}
        {activeTab === "roi" && <AdminROIPanel />}

        {/* Build / cache diagnostics — always visible at bottom of admin */}
        <DiagnosticsFooter />

      </div>
    </div>
  );
}

interface ROIMetrics {
  totalBets: number;
  totalProfit: number;
  totalStake: number;
  roi: number;
  hitRate: number;
  hits: number;
  misses: number;
  pushes: number;
  pending: number;
}

interface SegmentedROI {
  segment: string;
  metrics: ROIMetrics;
}

interface FullROIReport {
  global: ROIMetrics;
  bySport: SegmentedROI[];
  byMarket: SegmentedROI[];
  byProbBucket: SegmentedROI[];
  bySignalScore: SegmentedROI[];
  byDirection: SegmentedROI[];
  byTiming: SegmentedROI[];
}

type RailAnalyticsResponse = {
  rangeDays: number;
  impressions: number;
  primaryCtaClicks: number;
  alertsCtaClicks: number;
  upgradeModalOpens: number;
  primaryCtrPct: number;
  alertsCtrPct: number;
  upgradeConversionPct: number;
  exhaustedPrimaryClicks: number;
  perDay: Array<{
    date: string;
    impressions: number;
    primaryCtaClicks: number;
    alertsCtaClicks: number;
    upgradeModalOpens: number;
  }>;
};

function RailAnalyticsTile() {
  const [range, setRange] = useState<number>(7);
  const { data, isLoading, error } = useQuery<RailAnalyticsResponse>({
    queryKey: ["/api/admin/rail-analytics", range],
    queryFn: async () => {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/admin/rail-analytics?range=${range}`, {
        credentials: "include",
        headers,
      });
      if (!res.ok) throw new Error("Failed to load rail analytics");
      return res.json();
    },
  });

  return (
    <div
      data-testid="panel-rail-analytics"
      className="bg-card border border-border rounded-xl overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Free Activation Rail</h2>
          <span className="text-[10px] text-muted-foreground">
            FreeActivationRail + PublicProofStrip · plays-to-upgrade conversion
          </span>
        </div>
        <select
          data-testid="select-rail-range"
          value={range}
          onChange={(e) => setRange(parseInt(e.target.value, 10))}
          className="text-xs bg-muted border border-border rounded-lg px-3 py-1.5 text-foreground"
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {isLoading ? (
        <div className="p-8 flex justify-center" data-testid="rail-loading">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="p-6 text-center text-sm text-destructive" data-testid="text-rail-error">
          Failed to load rail analytics
        </div>
      ) : !data ? null : (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <MetricCard
              label="Impressions"
              value={String(data.impressions)}
            />
            <MetricCard
              label="Primary CTA"
              value={String(data.primaryCtaClicks)}
              sub={`${data.primaryCtrPct}% CTR`}
            />
            <MetricCard
              label="Alerts CTA"
              value={String(data.alertsCtaClicks)}
              sub={`${data.alertsCtrPct}% CTR`}
            />
            <MetricCard
              label="Upgrade Opens"
              value={String(data.upgradeModalOpens)}
              sub={`${data.exhaustedPrimaryClicks} from exhausted`}
            />
            <MetricCard
              label="Conversion"
              value={`${data.upgradeConversionPct}%`}
              color={
                data.upgradeConversionPct >= 5
                  ? "text-green-400"
                  : data.upgradeConversionPct >= 1
                  ? "text-yellow-400"
                  : "text-muted-foreground"
              }
              sub="opens / impression"
            />
          </div>

          {data.perDay.length > 0 && (
            <div className="overflow-x-auto" data-testid="table-rail-per-day">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Date (ET)</th>
                    <th className="px-3 py-2 text-right font-medium">Impressions</th>
                    <th className="px-3 py-2 text-right font-medium">Primary</th>
                    <th className="px-3 py-2 text-right font-medium">Alerts</th>
                    <th className="px-3 py-2 text-right font-medium">Upgrade Opens</th>
                    <th className="px-3 py-2 text-right font-medium">Conv %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perDay.map((d) => {
                    const conv = d.impressions > 0
                      ? Math.round((d.upgradeModalOpens / d.impressions) * 1000) / 10
                      : 0;
                    return (
                      <tr
                        key={d.date}
                        data-testid={`row-rail-day-${d.date}`}
                        className="border-b border-border/20 hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-3 py-2 font-medium text-foreground">{d.date}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{d.impressions}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{d.primaryCtaClicks}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{d.alertsCtaClicks}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{d.upgradeModalOpens}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className={conv >= 5 ? "text-green-400" : conv >= 1 ? "text-yellow-400" : "text-muted-foreground"}>
                            {conv}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {data.impressions === 0 && (
            <div
              data-testid="text-rail-empty"
              className="text-center text-xs text-muted-foreground py-4"
            >
              No rail events recorded in this window yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4" data-testid={`metric-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function SegmentTable({ title, segments, showTiming }: { title: string; segments: SegmentedROI[]; showTiming?: boolean }) {
  if (segments.length === 0) return null;
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden" data-testid={`segment-table-${title.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="px-4 py-3 border-b border-border/60">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Segment</th>
              <th className="px-4 py-2 text-right font-medium">Bets</th>
              <th className="px-4 py-2 text-right font-medium">Hit Rate</th>
              <th className="px-4 py-2 text-right font-medium">ROI</th>
              <th className="px-4 py-2 text-right font-medium">Profit</th>
              <th className="px-4 py-2 text-right font-medium">W-L</th>
            </tr>
          </thead>
          <tbody>
            {segments.map(s => (
              <tr key={s.segment} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                <td className="px-4 py-2.5 font-medium text-foreground">{s.segment}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{s.metrics.totalBets}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  <span className={s.metrics.hitRate >= 55 ? "text-green-400" : s.metrics.hitRate >= 45 ? "text-yellow-400" : "text-red-400"}>
                    {s.metrics.hitRate}%
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  <span className={s.metrics.roi >= 0 ? "text-green-400" : "text-red-400"}>
                    {s.metrics.roi >= 0 ? "+" : ""}{s.metrics.roi}%
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  <span className={s.metrics.totalProfit >= 0 ? "text-green-400" : "text-red-400"}>
                    {s.metrics.totalProfit >= 0 ? "+" : ""}{s.metrics.totalProfit.toFixed(2)}u
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {s.metrics.hits}-{s.metrics.misses}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdminROIPanel() {
  const [sportFilter, setSportFilter] = useState<string>("");
  const [dateRange, setDateRange] = useState<string>("all");

  const queryParams = new URLSearchParams();
  if (sportFilter) queryParams.set("sport", sportFilter);
  if (dateRange !== "all") {
    const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (dateRange === "today") {
      queryParams.set("startDate", todayET);
      queryParams.set("endDate", todayET);
    } else {
      const d = new Date();
      if (dateRange === "7d") d.setDate(d.getDate() - 7);
      else if (dateRange === "30d") d.setDate(d.getDate() - 30);
      queryParams.set("startDate", d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
    }
  }

  const { data: report, isLoading } = useQuery<FullROIReport>({
    queryKey: ["/api/admin/roi", sportFilter, dateRange],
    queryFn: async () => {
      const url = `/api/admin/roi${queryParams.toString() ? "?" + queryParams.toString() : ""}`;
      const token = getAuthToken();
      const res = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Failed to load ROI");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="roi-loading">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!report) return <div className="text-center text-muted-foreground py-10" data-testid="roi-empty">No ROI data available</div>;

  const g = report.global;

  return (
    <div className="space-y-6" data-testid="panel-roi">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          data-testid="select-sport-filter"
          value={sportFilter}
          onChange={e => setSportFilter(e.target.value)}
          className="text-xs bg-muted border border-border rounded-lg px-3 py-1.5 text-foreground"
        >
          <option value="">All Sports</option>
          <option value="mlb">MLB</option>
          <option value="nba">NBA</option>
          <option value="ncaab">NCAAB</option>
        </select>
        <select
          data-testid="select-date-range"
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}
          className="text-xs bg-muted border border-border rounded-lg px-3 py-1.5 text-foreground"
        >
          <option value="all">All Time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 Days</option>
          <option value="30d">Last 30 Days</option>
        </select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard
          label="ROI"
          value={`${g.roi >= 0 ? "+" : ""}${g.roi}%`}
          color={g.roi >= 0 ? "text-green-400" : "text-red-400"}
          sub={`${g.totalStake.toFixed(1)}u staked`}
        />
        <MetricCard
          label="Hit Rate"
          value={`${g.hitRate}%`}
          color={g.hitRate >= 55 ? "text-green-400" : g.hitRate >= 45 ? "text-yellow-400" : "text-red-400"}
          sub={`${g.hits}-${g.misses} (${g.pushes} push)`}
        />
        <MetricCard
          label="Total Bets"
          value={String(g.totalBets)}
          sub={`${g.pending} pending`}
        />
        <MetricCard
          label="Profit"
          value={`${g.totalProfit >= 0 ? "+" : ""}${g.totalProfit.toFixed(2)}u`}
          color={g.totalProfit >= 0 ? "text-green-400" : "text-red-400"}
        />
      </div>

      <SegmentTable title="By Sport" segments={report.bySport} />
      <SegmentTable title="By Market" segments={report.byMarket} />
      <SegmentTable title="By Probability Bucket" segments={report.byProbBucket} />
      <SegmentTable title="By Signal Score" segments={report.bySignalScore} />
      <SegmentTable title="By Direction" segments={report.byDirection} />
      {report.byTiming.length > 0 && <SegmentTable title="By Timing (MLB Innings)" segments={report.byTiming} />}
    </div>
  );
}
