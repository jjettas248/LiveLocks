import { FlaskConical } from "lucide-react";

export function SimulationBanner({ enabled, scenario }: { enabled: boolean; scenario?: string }) {
  if (!enabled) return null;
  return (
    <div data-testid="simulation-banner" className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex items-center gap-2">
      <FlaskConical className="w-4 h-4 text-yellow-400" />
      <div className="text-xs font-medium text-yellow-300">
        Simulation Mode Active{scenario ? ` \u00B7 ${scenario}` : ""}
      </div>
    </div>
  );
}
