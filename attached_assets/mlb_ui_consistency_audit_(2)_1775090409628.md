# LiveLocks MLB UI Consistency Audit + Refactor Plan

## Scope audited
- `client/src/pages/mlb-live.tsx`
- `client/src/components/mlb/MLBScheduleList.tsx`
- `client/src/components/mlb/LiveBoard.tsx`
- `client/src/components/mlb/TopPlays.tsx`
- `client/src/components/mlb-admin-tab.tsx`
- `client/src/pages/admin.tsx`
- `server/simulationState.ts`

## 1) Codebase audit: what is inconsistent now

### A. `client/src/pages/mlb-live.tsx`
1. The page is oversized and acting as a page, controller, state machine, validator, and component library all in one file.
2. MLB owns its own tab system (`Games`, `Live Feed`, `HR Radar`) instead of reusing a shared sport shell.
3. Live feed uses inline sub-tab chips and page-local state instead of a reusable filter/header pattern.
4. Empty state, loading state, upgrade state, and refresh state are all handwritten in-page.
5. Validation is split across helper functions in the page rather than centralized into shared guards.
6. The page mixes game-level cards, player-level cards, HR radar cards, pitcher cards, and slip UI with separate visual rules.
7. Orange styling for HR radar is hardcoded instead of using a shared sport accent token.
8. `useState` for `liveFeedSub` is declared after early returns, which is a hook-order bug risk.

### B. `client/src/components/mlb/MLBScheduleList.tsx`
1. Schedule rows use a different card grammar than MLB signal cards and a different grammar than NBA/NCAAB strips.
2. Compact and expanded schedule variants are both defined here, but not abstracted into a common list/card system.
3. Tag rendering is local to this file and not shared with other MLB cards.
4. Weather/park factor/pitcher metadata are schedule-specific and do not share the same metric-chip UI used elsewhere.

### C. `client/src/components/mlb/LiveBoard.tsx`
1. Duplicates market label mapping, odds formatting, live stat formatting, signal state badges, and tier styling.
2. Uses a unique tier-bucket presentation that does not match `TopPlays` or the schedule card grammar.
3. Card component is custom and not reused outside the feed.

### D. `client/src/components/mlb/TopPlays.tsx`
1. Duplicates `MARKET_LABELS`, `formatOdds`, `getCurrentStatForMarket`, and state badge logic already present in `LiveBoard.tsx` / `mlb-live.tsx`.
2. Uses a separate visual system from `LiveBoard` despite representing the same signal object.
3. Makes MLB feel like multiple products bolted together rather than one coherent sport surface.

### E. `client/src/components/mlb-admin-tab.tsx`
1. Admin testing is still a raw form, not a guided test harness.
2. No autocomplete, no inline validation messages, no field grouping by conceptual model.
3. The result card is fine structurally, but the input side does not match the rest of the app.
4. Roster sync, prop tester, and diagnostics are stacked as unrelated blocks instead of a coherent admin workflow.

### F. `client/src/pages/admin.tsx`
1. Simulation mode lives on the admin page as a generic block but is described as NBA-only.
2. MLB testing appears below the simulation area, but the simulation state is not surfaced inside MLB testing context.
3. There is no persistent global simulation banner anywhere outside admin.

### G. `server/simulationState.ts`
1. Simulation state is global and simple, which is good.
2. The UI does not consume it consistently outside admin.
3. The naming and mock-board payload are NBA-oriented, so the MLB admin/testing UX does not feel first-class.

## 2) Root causes
- No shared `SportPageShell`
- No shared `SportCard`
- No shared `MetricChip` / `SignalBadge` / `EmptyState` / `SkeletonCard`
- No shared MLB formatter layer
- No shared admin form primitives for sports testing tools
- Too much MLB presentation logic kept inside `mlb-live.tsx`

## 3) Line-by-line diff plan

### File: `client/src/pages/mlb-live.tsx`

#### Replace
- Inline tab header block around lines ~1271-1321
- Inline loading / empty / refresh UI
- Inline HR section header styling
- Inline validation filtering done ad hoc in render branches

#### Add
- `SportPageShell`
- `SportTabBar`
- `SportSectionHeader`
- shared `EmptyState`
- shared `SkeletonCard`
- shared `SimulationBanner`
- shared `filterValidMlbSignals()` helper

#### Remove from page
- custom tab chrome
- duplicate visual wrappers
- tab accent logic
- duplicated empty/loading blocks

### File: `client/src/components/mlb/MLBScheduleList.tsx`

#### Replace
- bespoke row shell with shared `SportCard`
- bespoke tag pills with shared `SignalBadge`
- weather/park/pitcher labels with shared `MetricChip`

#### Keep
- schedule-specific data mapping
- compact vs expanded mode behavior

### File: `client/src/components/mlb/LiveBoard.tsx`

#### Replace
- local `MARKET_LABELS`
- local `formatOdds`
- local `getCurrentStatForMarket`
- local board card shell

#### Extract to shared utils
- `formatMlbMarketLabel`
- `formatAmericanOdds`
- `getMlbLiveStatValue`
- `getSignalStateMeta`

### File: `client/src/components/mlb/TopPlays.tsx`

#### Replace
- local duplicates of MLB label/odds/stat helpers
- local card shell

#### Reuse
- `MlbSignalCard`
- `SignalBadge`
- `MetricChip`

### File: `client/src/components/mlb-admin-tab.tsx`

#### Replace
- flat form with grouped sections:
  - General Info
  - Player Inputs
  - Projection Inputs
  - Simulation Settings
- raw text inputs for player/team/opponent with autocomplete/select patterns
- silent invalid numeric coercion with explicit validation messages

### File: `client/src/pages/admin.tsx`

#### Replace
- current simulation block copy from NBA-only framing to cross-sport simulation framing
- add simulation status pill to MLB Testing tab trigger

## 4) Drop-in component system to add

### New shared files
- `client/src/components/sports/SportPageShell.tsx`
- `client/src/components/sports/SportTabBar.tsx`
- `client/src/components/sports/SportSectionHeader.tsx`
- `client/src/components/sports/SportCard.tsx`
- `client/src/components/sports/MetricChip.tsx`
- `client/src/components/sports/SignalBadge.tsx`
- `client/src/components/sports/EmptyState.tsx`
- `client/src/components/sports/SkeletonCard.tsx`
- `client/src/components/sports/SimulationBanner.tsx`
- `client/src/components/forms/AutocompleteField.tsx`
- `client/src/components/forms/NumberField.tsx`

### New MLB shared files
- `client/src/components/mlb/MlbSignalCard.tsx`
- `client/src/components/mlb/MlbGameCard.tsx`
- `client/src/components/mlb/MlbSectionEmptyState.tsx`
- `client/src/lib/mlbFormatters.ts`
- `client/src/lib/mlbValidation.ts`

## 5) Exact implementation order
1. Add shared shell + primitive components.
2. Add MLB formatter + validation utilities.
3. Refactor `TopPlays` onto `MlbSignalCard`.
4. Refactor `LiveBoard` onto `MlbSignalCard`.
5. Refactor `MLBScheduleList` onto `SportCard` + shared chips/badges.
6. Refactor `mlb-live.tsx` to use shared shell/header/empty/loading/banner.
7. Refactor `mlb-admin-tab.tsx` to grouped form + autocomplete + validation.
8. Surface simulation status in admin and MLB views.

## 6) High-confidence exact diffs

### A. New shared formatter util
```ts
// client/src/lib/mlbFormatters.ts
export const MLB_MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  hrr: "H+R+RBI",
  home_runs: "Home Runs",
  rbi: "RBIs",
  runs: "Runs",
  stolen_bases: "Stolen Bases",
  pitcher_strikeouts: "K (Pitcher)",
  pitcher_k: "K (Pitcher)",
  pitcher_outs: "Outs",
  walks_allowed: "BB Allowed",
  hits_allowed: "Hits Allowed",
  earned_runs: "Earned Runs",
  batter_strikeouts: "Strikeouts",
  hr_allowed: "HR Allowed",
};

export function formatMlbMarketLabel(market: string): string {
  return MLB_MARKET_LABELS[market] ?? market;
}

export function formatAmericanOdds(odds: number | null | undefined): string {
  if (odds == null || !Number.isFinite(odds)) return "";
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export function getMlbLiveStatValue(sig: any): { label: string; value: number } | null {
  const cs = sig?.currentStats;
  if (!cs) return null;
  switch (sig.market) {
    case "hits": return { label: "H", value: cs.h };
    case "home_runs":
    case "hr": return { label: "HR", value: cs.hr };
    case "total_bases": return { label: "TB", value: cs.tb };
    case "rbi": return { label: "RBI", value: cs.rbi };
    case "runs": return { label: "R", value: cs.r ?? 0 };
    case "stolen_bases": return { label: "SB", value: cs.sb };
    case "batter_strikeouts": return { label: "K", value: cs.k };
    case "hrr": return { label: "H+R+RBI", value: cs.h + (cs.r ?? 0) + cs.rbi };
    default: return { label: "H", value: cs.h };
  }
}
```

### B. New validation util
```ts
// client/src/lib/mlbValidation.ts
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidMlbSignal(sig: any): boolean {
  if (!sig) return false;
  if (!sig.playerId || !sig.playerName || !sig.market) return false;
  if (!isFiniteNumber(sig.enginePct)) return false;
  if (!isFiniteNumber(sig.projection)) return false;
  if (!isFiniteNumber(sig.bookLine)) return false;
  if (!isFiniteNumber(sig.edge)) return false;
  if (!sig.recommendedSide || sig.recommendedSide === "NO_EDGE") return false;
  return true;
}

export function filterValidMlbSignals<T extends Record<string, any>>(signals: T[]): T[] {
  return (signals ?? []).filter(isValidMlbSignal);
}
```

### C. New reusable shell
```tsx
// client/src/components/sports/SportPageShell.tsx
import { ReactNode } from "react";

export function SportPageShell({
  title,
  accentClass,
  actions,
  children,
}: {
  title: string;
  accentClass?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <h1 className={`text-lg font-bold text-foreground ${accentClass ?? ""}`}>{title}</h1>
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
```

### D. New reusable empty state
```tsx
// client/src/components/sports/EmptyState.tsx
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-card/60 p-6 text-center space-y-2">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
    </div>
  );
}
```

### E. New reusable skeleton
```tsx
// client/src/components/sports/SkeletonCard.tsx
export function SkeletonCard() {
  return <div className="animate-pulse rounded-xl border border-border/30 bg-card/50 h-24" />;
}
```

### F. New simulation banner
```tsx
// client/src/components/sports/SimulationBanner.tsx
import { FlaskConical } from "lucide-react";

export function SimulationBanner({ enabled, scenario }: { enabled: boolean; scenario?: string }) {
  if (!enabled) return null;
  return (
    <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex items-center gap-2">
      <FlaskConical className="w-4 h-4 text-yellow-400" />
      <div className="text-xs font-medium text-yellow-300">
        Simulation Mode Active{scenario ? ` · ${scenario}` : ""}
      </div>
    </div>
  );
}
```

### G. `TopPlays.tsx` diff direction
- delete local `MARKET_LABELS`
- delete local `formatOdds`
- delete local `getCurrentStatForMarket`
- import shared formatter helpers
- replace local `SignalCard` internals with `MlbSignalCard`

### H. `LiveBoard.tsx` diff direction
- delete local `MARKET_LABELS`
- delete local `formatOdds`
- delete local `getCurrentStatForMarket`
- keep tier grouping logic only
- render grouped signals via shared `MlbSignalCard`

### I. `mlb-live.tsx` diff direction
- move `const [liveFeedSub, setLiveFeedSub]` above all returns
- replace current page wrapper with `SportPageShell`
- replace custom empty/loading blocks with `EmptyState` / `SkeletonCard`
- add `SimulationBanner`
- centralize `const filteredSignals = filterValidMlbSignals(validatedSignals)`
- pass `filteredSignals` to live feed, top plays, player/game detail consumers
- replace orange inline title styling in `HRRadarSection` with section header component

### J. `mlb-admin-tab.tsx` diff direction
- split form into grouped sections
- add inline field errors object
- add `AutocompleteField` for player/team/opponent
- add helper text/tooltips for `seasonAvg`, `remainingAB`, `completedAB`, `inning`
- move result card below form but keep same engine payload

## 7) Recommended exact file touch list
- `client/src/pages/mlb-live.tsx`
- `client/src/components/mlb/MLBScheduleList.tsx`
- `client/src/components/mlb/LiveBoard.tsx`
- `client/src/components/mlb/TopPlays.tsx`
- `client/src/components/mlb-admin-tab.tsx`
- `client/src/pages/admin.tsx`
- `client/src/components/sports/SportPageShell.tsx`
- `client/src/components/sports/EmptyState.tsx`
- `client/src/components/sports/SkeletonCard.tsx`
- `client/src/components/sports/SimulationBanner.tsx`
- `client/src/components/mlb/MlbSignalCard.tsx`
- `client/src/lib/mlbFormatters.ts`
- `client/src/lib/mlbValidation.ts`

## 8) What to do first in Replit
1. Create shared primitives and utilities.
2. Refactor duplicate formatter logic out of `TopPlays` and `LiveBoard` first.
3. Then refactor `mlb-live.tsx`.
4. Then refactor `mlb-admin-tab.tsx`.
5. Then add simulation visibility improvements in `admin.tsx` and the MLB page.
