import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Users, MessageSquare, RotateCcw, Shield, LogOut, ChevronDown, CreditCard, CheckCircle, AlertCircle, Trash2, Loader2, Settings, Bell, ChevronUp, Send, Target } from "lucide-react";
import { MLBAdminTab } from "@/components/mlb-admin-tab";
import { CalibrationDashboard } from "@/components/calibration-dashboard";
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
  const [activeTab, setActiveTab] = useState<"users" | "feedback" | "mlb" | "calibration">("users");
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
    <div className="min-h-screen bg-background">
      <AdminLink />
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6 space-y-4">

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
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Creates the Pro ($40/mo) and All Sports ($65/mo) products in your Stripe account if they don't already exist. Run this once after switching to live Stripe keys.
          </p>
        </div>

        {/* Tab nav */}
        <div className="flex rounded-lg bg-muted p-1 w-fit">
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
            data-testid="tab-mlb-testing"
            onClick={() => setActiveTab("mlb")}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "mlb" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            MLB Testing
          </button>
          <button
            data-testid="tab-calibration"
            onClick={() => setActiveTab("calibration")}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === "calibration" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Target className="w-3.5 h-3.5" />
            Calibration
          </button>
        </div>

        {/* Users table */}
        {activeTab === "users" && (
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
                                    <span className="text-[10px] px-2 py-0.5 rounded border font-mono" style={{ background: r.dbTier ? "rgba(0,212,170,0.1)" : "rgba(82,82,91,0.2)", borderColor: r.dbTier ? "rgba(0,212,170,0.3)" : "#3f3f46", color: r.dbTier ? "#00d4aa" : "#71717a" }}>
                                      DB: {r.dbTier ?? "free"}
                                    </span>
                                    <span className="text-[10px] px-2 py-0.5 rounded border font-mono" style={{ background: r.hasNcaabAccess ? "rgba(0,212,170,0.1)" : "rgba(239,68,68,0.1)", borderColor: r.hasNcaabAccess ? "rgba(0,212,170,0.3)" : "rgba(239,68,68,0.3)", color: r.hasNcaabAccess ? "#00d4aa" : "#ef4444" }}>
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
                    background: "rgba(0,212,170,0.15)",
                    border: "1px solid rgba(0,212,170,0.3)",
                    color: "#00d4aa",
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

        {/* MLB Testing Tab */}
        {activeTab === "mlb" && (
          <div data-testid="panel-mlb-testing">
            <MLBAdminTab />
          </div>
        )}

        {/* Calibration Tab */}
        {activeTab === "calibration" && (
          <div data-testid="panel-calibration">
            <CalibrationDashboard />
          </div>
        )}

      </div>
    </div>
  );
}
