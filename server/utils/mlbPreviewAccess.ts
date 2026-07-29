// Pure helper for requireMLBAccess's free-preview fallback (server/auth.ts).
// Deliberately dependency-free (no storage/db import) so it stays
// unit-testable without a live database, unlike auth.ts itself.
//
// Not every gated MLB route is scoped to a single game (HR Radar board/
// ladder, OnlyHomers aggregates, player-history, live odds lookups, ...) —
// those still need the same free-preview-then-upgrade gate, just tracked
// against a shared daily budget instead of a per-game one. Previously,
// requireMLBAccess returned a raw 400 for any such route instead of falling
// through to the preview gate.
export function resolveMlbPreviewConsumeKey(gameId: string | null | undefined): string {
  return gameId ? `mlb-${gameId}` : "mlb-general";
}
