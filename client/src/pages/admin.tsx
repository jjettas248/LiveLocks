import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Users, MessageSquare, RotateCcw, Shield, LogOut, ChevronDown } from "lucide-react";
import propPulseLogo from "@assets/kuXz_snw_400x400_1772143708894.jpg";

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
  nba: "NBA ($25/mo)",
  all: "All Sports ($50/mo)",
};

function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">Free</span>;
  if (tier === "nba") return <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 font-medium">NBA</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 font-medium">All Sports</span>;
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
            onClick={() => navigate("/")}
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

export default function AdminPage() {
  const { user, isLoading: authLoading, logout } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"users" | "feedback">("users");

  const { data: allUsers, isLoading: usersLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users"],
    enabled: !!user?.isAdmin,
  });

  const { data: allFeedback, isLoading: feedbackLoading } = useQuery<FeedbackRow[]>({
    queryKey: ["/api/admin/feedback"],
    enabled: !!user?.isAdmin && activeTab === "feedback",
  });

  const tierMutation = useMutation({
    mutationFn: ({ userId, tier }: { userId: number; tier: string | null }) =>
      apiRequest("PATCH", `/api/admin/users/${userId}/tier`, { tier }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
  });

  const resetPlaysMutation = useMutation({
    mutationFn: (userId: number) =>
      apiRequest("PATCH", `/api/admin/users/${userId}/reset-plays`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
  });

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
    navigate("/");
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
        </div>

        {/* Users table */}
        {activeTab === "users" && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/60">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" /> All Users
              </h2>
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
                            <span className={u.playsUsed >= 10 ? "text-destructive font-semibold" : ""}>{u.playsUsed} / 10</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {/* Tier selector */}
                            <div className="relative">
                              <select
                                data-testid={`select-tier-${u.id}`}
                                value={u.subscriptionTier ?? ""}
                                disabled={u.isAdmin || tierMutation.isPending}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  tierMutation.mutate({ userId: u.id, tier: val === "" ? null : val });
                                }}
                                className="text-xs px-2 py-1.5 pr-6 rounded-lg bg-background border border-border text-foreground appearance-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-primary/50"
                              >
                                <option value="">Free</option>
                                <option value="nba">NBA ($25)</option>
                                <option value="all">All Sports ($50)</option>
                              </select>
                              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
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
                          </div>
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
      </div>
    </div>
  );
}
