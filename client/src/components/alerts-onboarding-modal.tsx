import { useState } from "react";
import { X, Bell, MessageSquare, CheckCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface AlertsOnboardingModalProps {
  onClose: () => void;
  onOpenAlertsPanel: () => void;
  hasSmsAccess: boolean;
  hasPhone: boolean;
}

export function AlertsOnboardingModal({ onClose, onOpenAlertsPanel, hasSmsAccess, hasPhone }: AlertsOnboardingModalProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<"intro" | "phone" | "done">("intro");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  function normalizePhone(val: string): string {
    const digits = val.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return val.trim();
  }

  async function handleSavePhone() {
    const normalized = normalizePhone(phone);
    if (!/^\+\d{10,15}$/.test(normalized)) {
      toast({ title: "Invalid phone number", description: "Please enter a valid US phone number.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiRequest("POST", "/api/user/alerts/sms", { phoneNumber: normalized, smsAlerts: true });
      toast({ title: "Phone number saved!", description: "You'll receive SMS alerts for high-confidence plays." });
      setStep("done");
    } catch {
      toast({ title: "Could not save phone number", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <button
          data-testid="button-close-alerts-modal"
          onClick={onClose}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground z-10"
        >
          <X className="w-4 h-4" />
        </button>

        {step === "intro" && (
          <div className="p-6 space-y-5">
            <div className="text-center space-y-2">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
                <Bell className="w-7 h-7 text-primary" />
              </div>
              <h2 className="text-lg font-bold text-foreground">Set Up Your Alerts</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Get notified the moment a play hits ≥90% confidence or 2H lines go live — so you never miss a bet.
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-start gap-3 p-3 bg-secondary/40 rounded-xl border border-border/50">
                <Bell className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Push Notifications</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Works on any device. Install the app to your home screen for alerts even when it's closed.</p>
                </div>
              </div>
              {hasSmsAccess && (
                <div className="flex items-start gap-3 p-3 bg-secondary/40 rounded-xl border border-border/50">
                  <MessageSquare className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">SMS Alerts</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {hasPhone ? "Your phone number is saved — SMS alerts are ready to enable." : "Add your phone number to get texts for every high-confidence play."}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {hasSmsAccess && !hasPhone && (
                <button
                  data-testid="button-alerts-add-phone"
                  onClick={() => setStep("phone")}
                  className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                >
                  Add Phone Number for SMS
                </button>
              )}
              <button
                data-testid="button-alerts-setup-push"
                onClick={() => { onClose(); onOpenAlertsPanel(); }}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  hasSmsAccess && !hasPhone
                    ? "bg-secondary border border-border text-foreground hover:bg-secondary/80"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }`}
              >
                {hasSmsAccess && !hasPhone ? "Set Up Push Alerts Instead" : "Set Up Alerts Now"}
              </button>
              <button
                onClick={onClose}
                className="text-xs text-muted-foreground hover:text-foreground text-center py-1"
              >
                Remind me later
              </button>
            </div>
          </div>
        )}

        {step === "phone" && (
          <div className="p-6 space-y-5">
            <div className="text-center space-y-2">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <MessageSquare className="w-7 h-7 text-emerald-400" />
              </div>
              <h2 className="text-lg font-bold text-foreground">Add Your Phone Number</h2>
              <p className="text-sm text-muted-foreground">
                We'll text you when high-confidence plays hit or 2H goes live. Reply STOP anytime to opt out.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground block">US Phone Number</label>
              <input
                data-testid="input-onboarding-phone"
                type="tel"
                placeholder="555-000-0000"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              />
              <p className="text-[10px] text-muted-foreground">Msg & data rates may apply. Reply STOP to cancel.</p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setStep("intro")}
                className="flex-1 py-2.5 rounded-xl bg-secondary border border-border text-sm font-semibold text-foreground hover:bg-secondary/80 transition-colors"
              >
                Back
              </button>
              <button
                data-testid="button-save-onboarding-phone"
                onClick={handleSavePhone}
                disabled={saving || !phone.trim()}
                className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save & Enable"}
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="p-6 space-y-5 text-center">
            <div className="w-14 h-14 rounded-2xl bg-green-500/10 border border-green-500/20 flex items-center justify-center mx-auto">
              <CheckCircle className="w-7 h-7 text-green-400" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground">Alerts Active!</h2>
              <p className="text-sm text-muted-foreground">SMS alerts are on. You can manage all your alert settings from the bell icon in the header anytime.</p>
            </div>
            <button
              data-testid="button-alerts-done"
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              Get Started
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
