# MLB RESET SKILL

## WHEN TO USE
- `[MLB_DRIFT_WARNING]` is firing repeatedly in production
- A merge introduced a regression in surfaced count, probability
  distribution, or HR Radar surfacing
- The Phase 3B regression harness fails (`server/mlb/phase3bRegression.test.ts`)
- The MLB display contract `[MLB_DISPLAY_CONTRACT_MISMATCH]` rate spikes

## RESET PROCEDURE

### 1. Identify baseline
The current locked baseline version lives in
`server/mlb/goldmasterGuard.ts`:
```
export const MLB_GOLDMASTER_VERSION = "mlb-goldmaster-vN-YYYY-MM-DD";
```
Inspect the `[MLB_GOLDMASTER_LOCK]` boot log to confirm what is
currently running.

### 2. Identify the drift window
```
rg "MLB_DRIFT_WARNING|MLB_SIGNAL_PARITY" /tmp/logs/Start_application_*.log
```
Find the first warning line and identify the merge commit immediately
prior.

### 3. Restore engine behavior
Revert these files to their state at the locked baseline:

- `server/mlb/probabilityEngine.ts` (Phase 1 + Phase 3B wrappers)
- `server/mlb/markets.ts` (qualification + plumbing)
- `server/mlb/signalScore.ts` (Phase 2 tier mapping + scoring)
- `server/mlb/normalizeSignal.ts` (Display Contract)
- `server/mlb/liveGameOrchestrator.ts` (HR Watch bump + drift snapshot)
- `server/mlb/hrAlertEngine.ts` (HR Radar lifecycle)
- `server/mlb/selfLearning.ts` (sample-size tiers)

### 4. Verify parity
Run the locked validation gates:
```
npx tsc --noEmit
npx tsx server/mlb/phase3bRegression.test.ts   # must report 21/21
node server/validation/nba/run.ts              # NBA must remain green
```

### 5. Verify on a live slate
- Restart the workflow
- Watch for `[MLB_GOLDMASTER_LOCK]` to confirm boot
- Watch for absence of `[MLB_DRIFT_WARNING]` over 5 consecutive cycles
- Compare admin debug "Pipeline" tab counts to pre-merge snapshot

### 6. Bump baseline if changes are intentional
If the drift was justified, bump `MLB_GOLDMASTER_VERSION` to a new
date-stamped value and update this doc + `mlb-lock-standard.md` to
reflect the new locked behavior.

## DO NOT
- Reset NBA or NCAAB — they have separate lock documents
- Touch `shared/schema.ts` migrations during reset (data layer changes
  require a separate migration plan)
- Skip the validation gates — drift can be subtle
