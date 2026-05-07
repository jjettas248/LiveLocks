# LiveLocks by PropPulse

LiveLocks is a full-stack PWA for NBA, MLB, and NCAAB betting analytics, providing real-time probabilities, correlation-adjusted parlays, and data-driven insights.

## Run & Operate

- **Run Dev Server**: `npm run dev`
- **Build**: `npm run build`
- **Typecheck**: `npm run typecheck`
- **Codegen**: `npm run codegen`
- **DB Push**: `drizzle-kit push:pg`
- **Required Env Vars**: `ODDS_API_KEY`, `ODDS_API_KEY_2` (for API key rotation)

## Stack

- **Frontend**: React (Vite), Tailwind CSS, shadcn/ui, TanStack Query, wouter
- **Backend**: Express.js (TypeScript, tsx)
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM
- **Authentication**: JWT-based with role-based access control
- **Notifications**: Twilio (SMS), Resend (email)
- **Build Tool**: Vite

## Where things live

- **Shared Schemas**: `shared/schema.ts`
- **API Contracts**: `shared/routes.ts`
- **NBA Engine Validation Harness**: `server/validation/nba/`
- **MLB Phase 3B Regression Harness**: `server/mlb/phase3bRegression.test.ts` (run: `npx tsx server/mlb/phase3bRegression.test.ts` — locks 21 invariants across Phase 1/1.5/2/2.5/3B including HRR compression, hits_allowed wrapper shift, self-learn tiers)
- **MLB Phase 3B Real Wrappers**: HRR soft-compression in `probabilityEngine.ts` (`[MLB_HRR_COMPRESSION]`); hits_allowed pitch-count + TTO + contact-allowed shift wrapper (`[MLB_HITS_ALLOWED_WRAPPER]`, purityTag `mlb-hits_allowed-wrapper-v1`); self-learning sample-size tiers in `selfLearning.ts` (`[SELF_LEARN_TIER]` none/<30, partial/<100, full); HR Watch additive `signalScore` bump (+3 watch / +6 lean) in `liveGameOrchestrator.ts` that NEVER mutates engineProbability or calibrated*Probability (`[MLB_HR_WATCH_SCORE_BUMP]`).
- **MLB Gold Master Lock (LiveLocks Phase 1, Batch A)**: Locked spec docs in `docs/agents/mlb-lock-standard.md`, `mlb-guardrail-agent.md`, `mlb-reset-skill.md`, `mlb-goldmaster-prd.md`. Runtime guard `server/mlb/goldmasterGuard.ts` self-emits `[MLB_GOLDMASTER_LOCK]` once at boot with `MLB_GOLDMASTER_VERSION`; orchestrator calls `recordDriftSnapshot()` per-cycle after qualification, emitting `[MLB_SIGNAL_PARITY]` every cycle and `[MLB_DRIFT_WARNING]` when guardrails breach (qualified collapse >40%, reject spike +15pp, prob shift >5pp, payload shape change). Passive observation only — never mutates engine math.
- **MLB Signal Explainability (LiveLocks Phase 1, Batch A — P5)**: Canonical driver envelope `shared/signalDrivers.ts` (`SignalDriver`, `SignalExplainability`); cross-sport builder `server/services/driverBuilder.ts` (`buildMlbDrivers`) reads engine-recorded evidence only (displayDrivers, hrAlert.positiveDrivers, smartTags/signalTags, scoreBreakdown subscores) — NEVER fabricates. Stamped onto `MLBSignal.canonicalDrivers[]` + `triggerSummary` inside `applyDisplayContract`. Tags: `[LL_DRIVER_BUILD]`, `[LL_EXPLAINABILITY_OK]`, `[LL_EXPLAINABILITY_EMPTY]`.
- **PWA Stabilization (LiveLocks Phase 1, Batch A — P7)**: `client/public/sw.js` broadcasts `[LL_PWA_REFRESH]` on activate, `[LL_PWA_CACHE_INVALIDATE]` when stale caches removed, `[LL_NOTIFICATION_ROUTE]` on notificationclick. `client/src/main.tsx` listens for SW broadcasts and surfaces them in the page console alongside the existing updatefound / controllerchange / 5-min update poll / visibilitychange refresh.
- **NBA Playoff Rotation Truth Layer**: `server/services/nbaRotationHistoryService.ts`
- **MLB Signal Engine**: `server/mlb/signalScore.ts`, `server/mlb/markets.ts`
- **MLB HR Radar Engine**: `server/mlb/hrAlertEngine.ts`, `server/mlb/hrRadarUserStage.ts`
- **Unified Admin Analytics**: `client/src/components/unified-analytics.tsx`
- **Database Schema**: Refer to Drizzle ORM migrations
- **NBA Agent Spec**: `docs/agents/nba-agent.md`
- **MLB Agent Spec**: `docs/agents/mlb-agent.md`
- **Signal Engine Reference**: `docs/SIGNAL_ENGINE_REFERENCE.md`

## Architecture decisions

- **Engine Isolation**: NBA and MLB engines are fully isolated (`server/engines/`), each with distinct validation rules, confidence tiers, and fallback modes. No shared calculation logic.
- **Eastern Time Dominance**: All server-side date computations use `todayET()` (America/New_York) to prevent off-by-one-day bugs with late-night games.
- **MLB Signal Pipeline**: Employs a clean ENGINE → NORMALIZER → API → UI CARD pipeline with `MLBSignal` as the single source of truth, including signal-to-projection linking and live event modifiers.
- **HR Radar Unified Scoring**: The `HR Radar Goldmaster Phase 5` collapses parallel scoring systems into a single pipeline (`computeUnifiedCanonicalStage`) for consistent state management.
- **MLB Engine Layering (Phase 1 → 1.5 → 2 → 2.5 → 3B)**: Phase 1 produces canonical sided probability; Phase 1.5 caps bind ABOVE wrappers (e.g. `hits_allowed` UNDER cap=74 still clamps even when the Phase 3B wrapper would push higher); Phase 2 derives `signalTier` from `confidenceTier`; Phase 2.5 fires HR Watch context; Phase 3B wrappers are math nudges (HRR compression, hits_allowed shift) and signal-composition nudges (HR Watch +3/+6 to signalScore only). Engine probability is NEVER mutated by signal-composition layers.
- **MLB Canonical Display Contract**: The server stamps `displaySide`, `displayProbability`, `overProbability`, `underProbability`, `displayGrade` (A+/A/B+/B/B-/Watch derived from signalTier × signalScore — NEVER from liveScore), `isBettable` (≥50% AND tier!="watch"), `isWatchOnly`, and `displayDrivers` in `applyDisplayContract` (`server/mlb/normalizeSignal.ts`). Clients are PROHIBITED from re-deriving these. Mismatches log `[MLB_DISPLAY_CONTRACT_MISMATCH]`.
- **NBA Playoff Rotation Truth Layer**: Confidence for NBA playoff props is earned from real playoff role evidence (game logs, minutes) rather than season averages.

## Product

- **Real-time Player Prop Probabilities**: NBA, MLB, NCAAB live lines and player prop analytics.
- **NCAAB Live Spread/Total/Team-Total**: Dynamic probabilities and pick directions.
- **Correlation-Adjusted Parlays**: Tools for constructing advanced parlays.
- **Subscription-based Access**: Free trial, Pro, and All Sports tiers with role-based access.
- **Notifications**: Twilio for SMS alerts, Resend for transactional emails.
- **Admin Panel**: User management, subscription tier control, daily slate resets, and unified analytics.
- **PWA Features**: Offline access, push notifications, and mobile-optimized UI.

## User preferences

I prefer clear and concise explanations. When implementing new features or making significant changes, please propose the high-level plan first and wait for my approval before proceeding with detailed implementation. For UI/UX, I prefer modern, clean designs with intuitive navigation. I am open to iterative development and feedback loops.

## Gotchas

- **Stripe Price IDs**: Ensure correct `price_1TJJ4M2ceUNmv10tYSsYXA6T` (Pro) and `price_1TJJ4M2ceUNmv10tB8JCzPYe` (All Sports) are used for new subscriptions. Legacy IDs are mapped in `server/billing/planMap.ts`.
- **MLB Grading Accuracy**: Auto-graded hits (HRs without prior alerts) are excluded from the W/L record and marked as "Uncalled HR".
- **NBA 2H Plays**: Overly strict eligibility and odds gating previously caused empty payloads. Repaired with `isNbaHalftimeWindow` and derived 2H lines.
- **HR Radar Ready Section**: Historically empty due to parallel scoring tracks; fixed by mapping engine's `alertPath` and `signal_state` to the user stage.

## Pointers

- **Relevant Skills**: `docs/agents/nba-agent.md`, `docs/agents/mlb-agent.md`, `docs/SIGNAL_ENGINE_REFERENCE.md`, `.local/skills/signal-engine/SKILL.md`
- **External Docs**:
    - [Stripe Documentation](https://stripe.com/docs)
    - [Twilio Documentation](https://www.twilio.com/docs)
    - [Resend Documentation](https://resend.com/docs)
    - [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview/postgres)
    - [TanStack Query Documentation](https://tanstack.com/query/latest)
    - [Tailwind CSS Documentation](https://tailwindcss.com/docs)