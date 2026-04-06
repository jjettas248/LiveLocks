import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface SportPickerProps {
  onComplete: (focus: string) => void;
}

const OPTIONS = [
  { key: "nba", emoji: "🏀", label: "NBA", desc: "Basketball live props" },
  { key: "mlb", emoji: "⚾", label: "MLB", desc: "Baseball inning signals" },
  { key: "both", emoji: "🏆", label: "Both", desc: "Full multi-sport access" },
];

export function SportPicker({ onComplete }: SportPickerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/user/sport-focus", { sportFocus: selected });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      onComplete(selected);
    } catch {
      setError("Could not save preference. Tap to retry.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative w-full max-w-sm bg-[#0a0a0a] border border-[#27272a] rounded-2xl shadow-2xl p-6" data-testid="sport-picker-modal">
        <h2 className="text-xl font-bold text-white text-center mb-2">What are you here for?</h2>
        <p className="text-sm text-[#a1a1aa] text-center mb-6">We'll set your default view accordingly.</p>

        <div className="space-y-3">
          {OPTIONS.map((opt) => (
            <button
              key={opt.key}
              data-testid={`sport-pick-${opt.key}`}
              onClick={() => setSelected(opt.key)}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all text-left ${
                selected === opt.key
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-[#27272a] bg-[#111] hover:border-[#3f3f46]"
              }`}
            >
              <span className="text-2xl">{opt.emoji}</span>
              <div>
                <p className="text-sm font-bold text-white">{opt.label}</p>
                <p className="text-xs text-[#71717a]">{opt.desc}</p>
              </div>
            </button>
          ))}
        </div>

        {error && (
          <p className="text-xs text-red-400 text-center mt-3" data-testid="sport-picker-error">{error}</p>
        )}

        <button
          data-testid="button-confirm-sport"
          onClick={handleConfirm}
          disabled={!selected || saving}
          className="w-full mt-6 py-3 rounded-xl text-sm font-bold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? "Saving..." : "Continue"}
        </button>
      </div>
    </div>
  );
}
