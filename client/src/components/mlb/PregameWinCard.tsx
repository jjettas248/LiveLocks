// MLB Pre-Game Power Radar — Win Attribution surfaces (public, wins-only).
//
// Direction 2 product rule: a pre-game target that homers is a public Pregame
// Radar Win; a target that misses is calibration-only and is NEVER rendered
// here. The server stamps label / cardCopy / drivers; the UI renders verbatim
// and never derives win/loss or shows "Loss / Missed / -units".

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Trophy, Flame, Target } from "lucide-react";
import type {
  PregameRadarWinItem,
  PregameRadarPublicStats,
  DailyCashedLogResponse,
} from "@shared/pregameRadarWin";

/**
 * Current ET slate day, e.g. "2026-07-01" — mirrors the server's slateDateET()
 * (day rolls over at 6am ET, not midnight, so late games stay on the slate
 * that started the evening before). Included in query keys below so a slate
 * rollover always produces a fresh cache entry instead of showing yesterday's
 * placeholder data (the endpoints themselves already scope their response to
 * the slate day server-side).
 */
function slateDateET(): string {
  const now = new Date();
  const hourET = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  ) % 24;
  const d = new Date(now);
  if (hourET < 6) d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Pregame Radar Record banner — "{wins} Wins Today · {firstAb} First-AB Cashes
 * · {flagged} Flagged Before First Pitch". Wins-only; hidden until there is
 * something to show (no zero-state shouting "0 wins").
 */
export function PregameRadarRecord() {
  const { data } = useQuery<PregameRadarPublicStats>({
    queryKey: ["/api/mlb/pregame-radar/record", slateDateET()],
    queryFn: () => apiRequest("GET", "/api/mlb/pregame-radar/record").then((r) => r.json()),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  if (!data || data.flaggedBeforeFirstPitchToday === 0) return null;

  return (
    <Card
      className="p-3 bg-emerald-500/10 border-emerald-400/30"
      data-testid="pregame-radar-record"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Trophy className="w-4 h-4 text-emerald-300" />
        <span className="text-sm font-bold text-emerald-200">Pregame Radar Record</span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <Stat value={data.pregameWinsToday} label="Wins Today" testid="pregame-record-wins-today" />
        <Stat
          value={data.firstAbPregameWinsToday}
          label="First-AB Cashes"
          testid="pregame-record-firstab-today"
        />
        <Stat
          value={data.flaggedBeforeFirstPitchToday}
          label="Flagged Before First Pitch"
          testid="pregame-record-flagged-today"
        />
        <Stat
          value={data.pregameWinsLast7Days}
          label="Wins (7d)"
          testid="pregame-record-wins-7d"
          muted
        />
      </div>
    </Card>
  );
}

function Stat({
  value,
  label,
  testid,
  muted = false,
}: {
  value: number;
  label: string;
  testid: string;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "opacity-70" : undefined}>
      <span className="font-bold text-emerald-100" data-testid={testid}>
        {value}
      </span>{" "}
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Pregame Radar Wins section — today's public wins from the daily cashed log.
 * Hidden when empty. Misses never appear (server already excludes them).
 */
export function PregameWinsSection() {
  const { data } = useQuery<DailyCashedLogResponse>({
    queryKey: ["/api/mlb/daily-cashed-log", slateDateET()],
    queryFn: () => apiRequest("GET", "/api/mlb/daily-cashed-log").then((r) => r.json()),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const wins = data?.pregameRadarWins ?? [];
  if (wins.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="section-pregame-radar-wins">
      <h3 className="text-sm font-bold flex items-center gap-1.5">
        <Trophy className="w-4 h-4 text-emerald-300" />
        Pregame Radar Wins
        <span className="text-[11px] font-normal text-muted-foreground">
          flagged before first pitch · later homered
        </span>
      </h3>
      <div className="grid gap-2">
        {wins.map((w) => (
          <PregameWinCard key={w.signalId} win={w} />
        ))}
      </div>
    </div>
  );
}

function inningText(win: PregameRadarWinItem): string | null {
  if (win.hrInning == null) return null;
  const half = win.hrHalf === "top" ? "Top" : win.hrHalf === "bottom" ? "Bot" : "";
  return `${half} ${win.hrInning}`.trim();
}

/** One public Pregame Radar Win row. Renders server-stamped label/copy verbatim. */
export function PregameWinCard({ win }: { win: PregameRadarWinItem }) {
  const firstAb = win.firstAbPregameWin;
  const inning = inningText(win);
  return (
    <Card
      className={`p-3 ${
        firstAb ? "bg-amber-500/10 border-amber-400/40" : "bg-emerald-500/10 border-emerald-400/30"
      }`}
      data-testid={`pregame-win-${win.signalId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {firstAb ? (
              <Flame className="w-3.5 h-3.5 text-amber-300 shrink-0" />
            ) : (
              <Target className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
            )}
            <span
              className={`text-[10px] font-bold tracking-wide ${
                firstAb ? "text-amber-200" : "text-emerald-200"
              }`}
              data-testid={`pregame-win-label-${win.signalId}`}
            >
              {win.label}
            </span>
          </div>
          <div className="text-sm font-semibold mt-0.5 truncate">
            {win.playerName}
            <span className="text-muted-foreground font-normal">
              {" "}
              · {win.team} vs {win.opponent}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{win.cardCopy}</div>
          {win.pregameDrivers.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {win.pregameDrivers.slice(0, 3).map((d) => (
                <span
                  key={d.key}
                  className="px-1.5 py-0.5 rounded bg-secondary/50 text-[10px] text-muted-foreground"
                >
                  {d.label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          {inning && (
            <div className="text-[11px] font-medium text-emerald-200" data-testid={`pregame-win-inning-${win.signalId}`}>
              HR {inning}
            </div>
          )}
          {win.pregameRank != null && (
            <div className="text-[10px] text-muted-foreground">Pregame #{win.pregameRank}</div>
          )}
          {win.becameLiveFire && (
            <div className="text-[10px] text-orange-300 mt-0.5">→ live FIRE</div>
          )}
        </div>
      </div>
    </Card>
  );
}
