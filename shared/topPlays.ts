// Live Edge access/preview transport contract — shared between server response
// builders (server/services/liveEdgeAccess.ts) and client consumers
// (useTopPlays.ts, mlb-live.tsx). `LiveEdgePreview` is the exact, minimal shape
// returned to non-entitled users on every Live Edge surface — see
// server/services/liveEdgeAccess.ts for the fields it deliberately excludes.

export type LiveEdgeAccess = "full" | "preview";

export type LiveEdgePreviewCard = {
  sport: string;
  confidenceTier: string;
  timingContext: string | null;
};

export type LiveEdgePreview = {
  activeCount: number;
  sports: string[];
  updatedAt: string | null;
  cards: LiveEdgePreviewCard[];
};
