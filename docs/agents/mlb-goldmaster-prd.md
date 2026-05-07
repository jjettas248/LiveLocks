# MLB GOLD MASTER PRD

## PROBLEM
The MLB engine has shipped Phase 1 → 3B and a Canonical Display Contract.
Without an explicit lock, every subsequent change risks silent drift in:
- surfaced signal count
- probability distribution
- HR Radar lifecycle
- API payload shape

NBA and NCAAB already have locked specs (`docs/agents/nba-agent.md`,
NCAAB diagnostics harness). MLB needs equal protection.

## GOAL
Treat MLB engine output as a **versioned contract**. Every deploy either:
1. matches the locked behavior (parity), or
2. explicitly bumps the version with documented rationale.

## SUCCESS CRITERIA
- A boot log line `[MLB_GOLDMASTER_LOCK]` is emitted at every server start
  with the current version + commit summary
- A drift warning `[MLB_DRIFT_WARNING]` fires automatically when guardrail
  thresholds are crossed (see `mlb-guardrail-agent.md`)
- A periodic parity log `[MLB_SIGNAL_PARITY]` carries the snapshot for
  external monitoring
- A documented reset procedure (`mlb-reset-skill.md`) restores baseline
- Phase 3B regression harness (21 invariants) gates every merge
- Zero behavior change at version bump time — the lock is observation-only

## SCOPE

In scope:
- New docs under `docs/agents/mlb-*.md`
- New module `server/mlb/goldmasterGuard.ts`
- Per-cycle drift snapshot integration in `liveGameOrchestrator.ts`
- New ring buffers in `diagnosticsBuffer.ts`
- Surface drift snapshots in admin debug (subsequent task)

Out of scope:
- Engine math changes
- Cross-sport changes (NBA / NCAAB / NFL)
- New user-facing UI
- Auto-rollback or auto-suppression behavior

## RISKS
- False-positive drift warnings if baseline thresholds are too tight
  → Mitigation: thresholds are advisory and admin-only; tuned in `goldmasterGuard.ts`
- Memory growth from drift ring buffer
  → Mitigation: capped at 50 entries (matches existing diagnostics buffers)
- Drift warnings get ignored
  → Mitigation: surface counts in MLB DevTools "Overview" tab in a follow-up
