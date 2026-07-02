# CLAUDE.md

Guidance for Claude (and other AI coding assistants) working in this repo.

> **LiveLocks by PropPulse** — full-stack PWA for NBA, MLB, and NCAAB betting analytics. Real-time probabilities, correlation-adjusted parlays, HR Radar, and a canonical signal pipeline backed by a strict engine→bus→UI contract.

---

## 1. Run, Build, Validate

| Task | Command |
| --- | --- |
| Dev server (Express + Vite, single port) | `npm run dev` |
| Production build | `npm run build` |
| Typecheck (must be clean before commit) | `npx tsc --noEmit` |
| API codegen | `npm run codegen` |
| DB migrate (Drizzle) | `drizzle-kit push:pg` |

**Required env vars:** `ODDS_API_KEY`, `ODDS_API_KEY_2`, `ODDS_API_KEY_3` (rotation), `DATABASE_URL`, plus Stripe / Resend / Twilio credentials managed through Railway environment variables (Railway Variables) — **never** hardcode or echo their values.

**Regression suites (run before merging engine-adjacent changes):**
```
npx tsx server/mlb/phase3bRegression.test.ts        # 21 invariants
npx tsx server/mlb/shadowOutcomeWiring.test.ts      # 41 invariants
npx tsx server/mlb/hrRadarLifecycleRepair.test.ts   # 34 invariants
npx tsx server/mlb/hrRadarStateMachine.test.ts      # 5 invariants
npx tsx server/mlb/hrRadarReadyToFire.test.ts       # Ready→Fire promotion incl. peak-currency gate
npx tsx server/mlb/hrRadarFireOnlyGrading.test.ts   # FIRE-only official grading (reachedFireCommitment)
npx tsx server/mlb/nearHrContact.test.ts            # near-HR + "almost HR" detection
npx tsx server/mlb/pullAndPregame.test.ts           # pull rate + pregame HR-form prior
npx tsx server/mlb/ibbAndRecentForm.test.ts         # recent form streak + IBB feared-slugger prior
npx tsx server/mlb/hrReviewClassifier.test.ts       # 30 invariants — pre-HR review bucket taxonomy
npx tsx server/mlb/hrMissDiagnostics.test.ts        # 78 invariants — HR miss diagnostic LLM-payload builders
npx tsx server/mlb/hrRadarFireOnlyGrading.test.ts   # FIRE-only official grading, both ledger sides
npx tsx server/mlb/hrRadarFreshnessOverlay.test.ts  # canonical-store freshness overlay (re-bucket/surface/terminal-safety)
npx tsx server/mlb/hrRadarRuntimeSmoke.test.ts      # read-only contract smoke (freshness + FIRE-only record)
npx tsx server/analytics/hrRadarOfficialSplit.test.ts # analytics official(FIRE) vs shadow(watch) split
npx tsx server/growth/hrBoardStudio.test.ts          # HR Board Studio: no-link copy, compliance, movement purity, recap, admin-auth gate
npx tsx server/mlb/pregamePowerRadar/winAttribution.test.ts  # Pregame Radar Win Attribution (pregame_win public vs calibration_miss internal; first-AB label; daily-log grouping)
npx tsx server/mlb/pregamePowerRadar/calibrationStats.test.ts # Pregame Radar public stats (wins-only) vs admin calibration (full denominator: byTier/byScoreBand/byDriver + conversion rates)
npx tsx server/mlb/pregamePowerRadar/gradedStatePreservation.test.ts # Pregame Radar graded-state carry across snapshot rebuilds + wrong-slate snapshot refusal
npx tsx server/mlb/pregamePowerRadar/slateDateRepair.test.ts # Pregame Radar slate-date repair planner (startsAt/gameDate correction, collision detection, no blanket day-shift)
npx tsx server/mlb/pregamePowerRadar/nearHrRecentForm.test.ts # Pregame Radar near-HR recent-form component (retroactive nearHrContact reuse, recency weighting, consecutive-day bonus, leakage guard)
npx tsx server/utils/dateUtils.test.ts               # slateDateET() 6am-ET rollover + toEtDateKey() ET calendar-date conversion invariants
```

Railway runs the configured start command on each deploy; for local development run `npm run dev` and restart the dev server after server changes.

---

## 2. Stack

- **Frontend:** React + Vite, Tailwind, shadcn/ui, TanStack Query v5, wouter
- **Backend:** Express (TypeScript via `tsx`)
- **DB:** PostgreSQL with Drizzle ORM
- **Auth:** JWT + role-based access (`requireAuth`, `requireAdmin`, `requirePlayAccess`, `requireMLBAccess`, `requireTier`)
- **Notifications:** Twilio (SMS), Resend (email), web push
- **Payments:** Stripe (credentials supplied via Railway env vars; was a Replit-managed integration — do not re-install)
- **PWA:** custom service worker in `client/public/sw.js`

---

## 3. Architecture — Core Invariants

### 3.1 Engine isolation
NBA, MLB, NCAAB engines live in `server/engines/`, `server/mlb/`, `server/nba/`, `server/ncaab/` — fully isolated. **No shared calculation logic.** Files in one sport must not import from another sport. Phase 3B regression test enforces this for MLB.

### 3.2 MLB engine layering (do not collapse)
`Phase 1 → 1.5 → 2 → 2.5 → 3B` — each layer has a strict job:
- **Phase 1:** canonical sided probability
- **Phase 1.5:** caps bind **above** wrappers (e.g. `hits_allowed` UNDER cap=74 still clamps even if 3B wrapper would push higher)
- **Phase 2:** derive `signalTier` from `confidenceTier`
- **Phase 2.5:** near-HR contact detection (`nearHrContact.ts`) and HR Watch context fire; pitch-mix × handedness multiplier (`computePitchMixMatchupScore`), HR timing component (`computeHrTimingComponent`), and pitcher entry fatigue score (`computePitcherEntryFatigueScore`) are applied to HR markets here
- **Phase 3B:** math nudges (HRR compression, hits_allowed shift) **and** signal-composition nudges (HR Watch +3/+6 to `signalScore` only)

> Engine probability is **never** mutated by signal-composition layers.

### 3.2a HR Radar canonical state machine
`hrRadarStateMachine.ts` owns the **pure transition graph** for HR Radar lifecycle: `inactive → watch → build → ready → fire → cashed|missed|model_review|expired`. Terminal states are sticky. `hrRadarCanonicalStore.ts` owns in-memory persistence. `hrRadarSection.ts` provides section/outcome helpers for the API layer. `nonHrSignalState.ts` mirrors the same pattern for non-HR markets (`BUILDING → ACTIVE → COOLING → CLOSED`). No UI component may derive lifecycle state — all read from server-stamped values.

### 3.3 The signal pipeline (single source of truth)
```
ENGINE  →  NORMALIZER  →  LiveSignalBus  →  Lifecycle Store  →  UI / Alerts
                              ↑ sole ingress
```
- `MLBSignal` is the engine output object.
- `applyDisplayContract` (in `server/mlb/normalizeSignal.ts`) stamps `displaySide`, `displayProbability`, `over/underProbability`, `displayGrade`, `isBettable`, `isWatchOnly`, `displayDrivers`. **Clients are forbidden from re-deriving these.** Mismatches log `[MLB_DISPLAY_CONTRACT_MISMATCH]`.
- `CanonicalSignal` (`shared/canonicalSignal.ts`) is the post-normalization transport contract. `lifecycleState` (watch/build/strong/elite/cashed/missed/expired) is **orthogonal** to `signalTier` (watch/lean/strong/elite). Stable signalId scheme: `${sport}:${gameId}:${actorId}:${market}:${side}`.
- `LiveSignalBus` (`server/services/liveSignalBus.ts`) is the **sole ingress**. It owns dedupe (by signalId only — never by player name or UI label), freshness, and propagation. It does **not** own engine math, lifecycle transitions, or rendering.
- Lifecycle engine (`server/services/lifecycleEngine.ts` + `lifecycleStore.ts`) owns transitions only. Allowed mutations: `lifecycleState`, `lifecycleHistory`, `surfacedAt`, `updatedAt`, `expiresAt`, `suppressionReason`, `expirationReason`, `gradingLink`. **Forbidden:** anything else.
- `IMMUTABLE_FIELDS` in `shared/canonicalSignal.ts` is enforced by `signalMutationGuard.ts` — tampering logs `[LL_SIGNAL_MUTATION_DETECTED]`.

### 3.4 Eastern Time dominance
All server-side date logic must use `todayET()` (America/New_York). Late-night games will be off-by-one-day if you reach for `new Date()`.

### 3.5 Drivers + explainability
`SignalDriver` (`shared/signalDrivers.ts`) is built **server-side from real evidence only** (engine `displayDrivers`, `hrAlert.positiveDrivers`, `smartTags`, `scoreBreakdown`). The UI renders verbatim and is **forbidden from inventing or transforming drivers** beyond display formatting.

### 3.6 Analytics layer (Batch E)
`server/analytics/` is **read-only**. It taps lifecycle/alert/shadow/HR-Radar emit sites, appends to an in-memory ring buffer, and rolls up periodic snapshots for the admin dashboard. It must **never** mutate the engine, the bus, or any canonical field.

### 3.7 Shadow qualification
`server/mlb/shadowQualification.ts` runs a parallel lower-floor signal track for batter-over markets. It writes **only** to its shadow store — never to `storage.settlePlay`, `persisted_plays`, ROI, or W/L. Push outcomes are excluded from hit rate. ROI proxy at -110 vig (cashed=+0.909u, missed=-1u). Sample-size warning when settled<50.

---

## 4. Where Things Live

| Concern | Path |
| --- | --- |
| Shared schemas | `shared/schema.ts` |
| API contracts | `shared/routes.ts` |
| Canonical signal contract | `shared/canonicalSignal.ts`, `shared/signalDrivers.ts` |
| MLB engine | `server/mlb/signalScore.ts`, `server/mlb/markets.ts`, `server/mlb/probabilityEngine.ts` |
| MLB normalizer + display contract | `server/mlb/normalizeSignal.ts` |
| MLB signal bus + lifecycle | `server/services/liveSignalBus.ts`, `server/services/lifecycleStore.ts`, `server/services/lifecycleEngine.ts` |
| MLB HR Radar engine | `server/mlb/hrAlertEngine.ts`, `server/mlb/hrRadarUserStage.ts`, `server/mlb/hrConversionModel.ts` |
| MLB HR Radar state machine | `server/mlb/hrRadarStateMachine.ts`, `server/mlb/hrRadarCanonicalStore.ts`, `server/mlb/hrRadarSection.ts`, `server/mlb/hrRadarOutcomeStamp.ts` |
| MLB near-HR contact detector | `server/mlb/nearHrContact.ts` (Phase 2.5, pure function — no I/O) |
| MLB non-HR signal state engine | `server/mlb/nonHrSignalState.ts` (BUILDING→ACTIVE→COOLING→CLOSED) |
| MLB live event interpretation | `server/mlb/liveEventInterpretation.ts` |
| MLB integrity firewall | `server/mlb/integrityFirewall.ts` |
| MLB shadow qualification | `server/mlb/shadowQualification.ts` |
| MLB HR miss diagnostics (LLM payload, read-only) | `server/mlb/hrMissDiagnostics.ts` (pure builders), `server/mlb/hrMissDiagnosticsService.ts` (DB gatherer), `client/src/components/admin/HrMissDiagnosticsCard.tsx` (admin card) |
| MLB Pre-Game Power Radar + Win Attribution | `server/mlb/pregamePowerRadar/` — `shadowOutcomes.ts` (grading + `pregame_win`/`calibration_miss` attribution + public/admin stat getters), `winAttribution.ts` (pure attribution + daily-log builders), `calibrationStats.ts` (pure public/admin stat builders), `scoring.ts` (6-component weighted composite), `nearHrRecentForm.ts` (Component 6 — retroactive near-HR contact form via `nearHrContact.ts`, last 3 ET days, recency-weighted + consecutive-day bonus), `shared/pregameRadarWin.ts` (transport contracts: `DailyCashedLogResponse`, `PregameRadarPublicStats`, `PregameRadarCalibrationStats`); client `PregameWinCard.tsx` (public record + wins) + `components/admin/PregameRadarCalibrationCard.tsx` (admin calibration) |
| MLB orchestrator (per-tick driver) | `server/mlb/liveGameOrchestrator.ts` |
| Goldmaster lock + drift guard | `server/mlb/goldmasterGuard.ts` |
| NBA playoff rotation truth | `server/services/nbaRotationHistoryService.ts` |
| Analytics (read-only) | `server/analytics/` |
| HR Board Studio (admin growth, read-only) | `server/growth/hrBoardStudioCore.ts` (pure builders), `server/growth/hrBoardStudioService.ts` (live gatherers), `server/growth/hrBoardStudioRoutes.ts`, `server/growth/hrBoardCompliance.ts`, `server/growth/hrBoardAnalytics.ts`, `shared/hrBoardStudio.ts`, `client/src/components/admin/HrBoard*.tsx`, `client/src/pages/admin/hr-board-studio.tsx` |
| Alerts | `server/services/alertSubscriber.ts` |
| Auth | `server/auth.ts` |
| Storage interface | `server/storage.ts` |
| Routes (API) | `server/routes.ts` |
| Boot / cron / sweepers | `server/index.ts` |
| Admin pages | `client/src/pages/admin.tsx`, `client/src/pages/admin/*.tsx` |
| Unified analytics panel | `client/src/components/unified-analytics.tsx` |
| Agent specs | `docs/agents/{nba-agent,mlb-agent,mlb-lock-standard,mlb-guardrail-agent,mlb-reset-skill,mlb-goldmaster-prd}.md` |
| Signal engine reference | `docs/SIGNAL_ENGINE_REFERENCE.md` |

---

## 5. Diagnostic Tags (the truth lives in logs)

The codebase emits one-line bracketed tags as the primary observability surface. Familiar prefixes when debugging:

- **Bus:** `[LL_SIGNAL_REGISTER]`, `[LL_SIGNAL_UPDATE]`, `[LL_SIGNAL_DEDUPE]`, `[LL_SIGNAL_REJECTED]`, `[LL_SIGNAL_EXPIRED]`, `[LL_LEGACY_SIGNAL_CONSUMER]`
- **Lifecycle:** `[LL_SIGNAL_CREATED]`, `[LL_SIGNAL_UPGRADED]`, `[LL_SIGNAL_DOWNGRADED]`, `[LL_SIGNAL_CASHED]`, `[LL_SIGNAL_MISSED]`, `[LL_LIFECYCLE_INVALID_TRANSITION]`, `[LL_LIFECYCLE_SWEEP]`
- **Mutation guard:** `[LL_SIGNAL_MUTATION_DETECTED]` ← **must never fire in healthy runtime**
- **Display contract:** `[MLB_DISPLAY_CONTRACT_MISMATCH]` ← also must never fire
- **HR Radar:** `[HR_RADAR_TRANSITION]`, `[HR_RADAR_READY]`, `[HR_RADAR_FIRE]`, `[HR_RADAR_INACTIVE]`
- **Shadow:** `[LL_SHADOW_SIGNAL_QUALIFIED]`, `[LL_SHADOW_OUTCOME_RESOLVED|MISSING|PUSH|EXPIRED]`, `[LL_SHADOW_SIGNAL_CASHED|MISSED]`
- **Goldmaster:** `[MLB_GOLDMASTER_LOCK]` (boot), `[MLB_SIGNAL_PARITY]` (per cycle), `[MLB_DRIFT_WARNING]`
- **Alerts:** `[LL_ALERT_QUEUED]`, `[LL_ALERT_SENT]`, `[LL_ALERT_DEDUPE]`, `[LL_ALERT_SUPPRESSED]`, `[LL_ALERT_OPENED]`, `[LL_ALERT_CLICKED]`
- **Analytics:** `[LL_ANALYTICS_AGGREGATE]`, `[LL_ANALYTICS_HR_RADAR]`, `[LL_ANALYTICS_DRIVER]`, `[LL_ANALYTICS_SHADOW]`
- **PWA:** `[LL_PWA_REFRESH]`, `[LL_PWA_CACHE_INVALIDATE]`, `[LL_NOTIFICATION_ROUTE]`

---

## 6. Admin Endpoints

All gated by `requireAdmin`. Distinct namespaces:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/signal-bus` | Bus runtime metrics, legacy-consumer counts, propagation P50/P95 |
| `GET /api/admin/signal-lifecycle` | Paginated CanonicalSignal list (`?sport=mlb&limit=N`) |
| `GET /api/admin/signal-lifecycle/:signalId` | Full record with `lifecycleHistory[]`, `gradingLink`, etc. |
| `GET /api/admin/mlb-qualification` | Rolling-window qualification audit |
| `GET /api/admin/mlb-shadow-qualification` | Shadow outcome breakdown + ROI proxy |
| `GET /api/admin/mlb-signal-intelligence` | Batch E unified dashboard payload |
| `GET /api/admin/hr-board-studio/today` | Today's ranked Pre-Game HR board rows |
| `POST /api/admin/hr-board-studio/generate-pack` | Generate no-link content pack (does not post anywhere) |
| `GET /api/admin/hr-board-studio/movement-feed` | Pre-game board players who moved into live HR Radar stages |
| `POST /api/admin/hr-board-studio/generate-recap` | Generate postgame recap/proof assets for a date |
| `POST /api/admin/hr-board-studio/log-action` | Record admin copy/download/generate/view analytics |
| `GET /api/admin/hr-board-studio/analytics` | Admin workflow summary rollup |
| `GET /api/admin/mlb/pregame-radar/calibration` | Pregame Radar calibration breakdown (`?days=N`) — full denominator (wins + calibration misses), byTier/byScoreBand/byDriver + conversion rates |
| `GET /api/admin/hr-radar/miss-payload` | HR Miss Diagnostic Payload — LLM-ready miss dossier (`?days=N&limit=N&categories=csv&format=json\|markdown`): fired/ready-only false positives + uncalled/late false negatives with engine snapshots, review buckets, and signal timelines |

Admin pages live under `/admin`, `/admin/mlb-signal-intelligence`, `/admin/track-record`, and `/admin/hr-board-studio`.

---

## 7. Hard Rules — DO NOT

1. **Do not** mutate `IMMUTABLE_FIELDS` of a `CanonicalSignal` after it leaves the bus (probability, side, market, signalTier, signalScore, drivers, triggerSummary).
2. **Do not** add a new ingress path for signals — `LiveSignalBus.registerSignal` is the only entry point.
3. **Do not** dedupe by player name, market label, or UI string. Dedupe is `signalId`-only.
4. **Do not** re-derive `displaySide`, `displayProbability`, `displayGrade`, or `isBettable` on the client. Read from the server-stamped values.
5. **Do not** mutate engine probability from a signal-composition layer (HR Watch may bump `signalScore` only). *Engine-math changes that improve probability are allowed **inside the engine layer itself** (e.g. `hrConversionModel.ts`, `probabilityEngine.ts`) — see §7a; the prohibition is on composition/normalizer/lifecycle/bus layers reaching back and rewriting it.*
6. **Do not** import across sport engines (`server/mlb` ↔ `server/nba` ↔ `server/ncaab`).
7. **Do not** edit `package.json` directly — use the package management tools, and never modify Vite / Drizzle config without strong cause.
8. **Do not** add analytics code paths that mutate runtime state. Analytics are read-only and wrapped in `try/catch` so they can never break runtime.
9. **Do not** use `new Date()` for slate / window logic — use `todayET()`.
10. **Do not** display or write secret values. Use Railway-managed env vars.

---

## 7a. Sanctioned Engine Changes (improving behavior is allowed)

The Hard Rules above protect **structural integrity** (sole ingress, post-bus immutability,
cross-sport isolation, analytics read-only, ET dominance, secrets). They are **not** a freeze on
the model. **Intentionally changing engine math/behavior to improve accuracy — including HR
conversion probability, scoring thresholds, gates, and new predictive features — IS permitted**,
provided every change follows this discipline:

1. **Make the change in the right layer.** Probability/behavior changes live in the engine
   (`server/mlb/hrConversionModel.ts`, `evaluateHRAlert.ts`, `hrAlertEngine.ts`,
   `signalScore.ts`, `probabilityEngine.ts`, `nearHrContact.ts`) **before the bus**. Never via a
   composition/normalizer/lifecycle/bus/analytics layer (Hard Rules 1, 2, 5, 8 still hold).
2. **Keep new model inputs additive & no-op when absent** (return `1.0` / `+0` / `null`) so partial
   data never destabilizes runtime and regression fixtures stay green.
3. **Don't silently change the emitted payload shape.** New engine inputs/feature signals stay
   internal unless deliberately surfaced; a payload-shape change must be intentional (it trips the
   drift guard's `shape_change`).
4. **Cap probability effects** so a single feature can't swing the per-PA rate past existing clamps
   (Phase 1.5 caps still bind above all new multipliers).
5. **Re-baseline the goldmaster.** When engine behavior changes on purpose, bump
   `MLB_GOLDMASTER_VERSION` in `server/mlb/goldmasterGuard.ts` to document it — `[MLB_DRIFT_WARNING]`
   is then expected/acceptable transient noise, not a regression. "Drift" only means **unintended**
   change; a documented, re-baselined improvement is not drift.
6. **Run the regression suites** (§1) and add/adjust cases for the new behavior before merging.

In short: improvements are encouraged. The rules govern *how* (layer, caps, re-baseline,
test), not *whether*.

---

## 8. Common Gotchas

- **Stripe price IDs:** new subscriptions must use `price_1TJJ4M2ceUNmv10tYSsYXA6T` (Pro) and `price_1TJJ4M2ceUNmv10tB8JCzPYe` (All Sports). Legacy IDs are mapped in `server/billing/planMap.ts`.
- **MLB grading:** auto-graded HRs without prior alerts are excluded from the W/L record and marked "Uncalled HR".
- **NBA 2H plays:** must use `isNbaHalftimeWindow` and derived 2H lines — overly strict gating previously caused empty payloads.
- **HR Radar Ready section:** historically empty due to parallel scoring tracks; the `computeUnifiedCanonicalStage` collapse fixed this. Do not re-introduce a parallel track.
- **TanStack Query v5:** object form only — `useQuery({ queryKey: [...] })`, never positional. Use array query keys for hierarchical cache: `['/api/recipes', id]`.
- **Frontend env vars:** must be `VITE_` prefixed and accessed via `import.meta.env`. Never `process.env` on the client.
- **TypeScript iterators:** when iterating `Map.values()` / `Map.entries()`, wrap in `Array.from(...)` — the project's TS target requires it.
- **Forms:** use shadcn `useForm` + `Form` + `zodResolver` with insert schemas from `@shared/schema`. Provide `defaultValues`.

---

## 9. Working Conventions

- **Test IDs:** every interactive element gets `data-testid="{action}-{target}"` (e.g. `button-submit`); display elements get `{type}-{content}`; dynamic lists append a unique id.
- **File structure:** keep files modular — split JSX, CSS, and components into separate files. Maintain existing structure.
- **Toasts:** `useToast` is exported from `@/hooks/use-toast`.
- **Routing:** `wouter` everywhere — `Link` or `useLocation`, never modify `window.location` directly.
- **Storage:** every CRUD goes through the `IStorage` interface in `server/storage.ts`. Routes stay thin.
- **Validation:** Zod schemas from `drizzle-zod` validate every request body before it reaches storage.

---

## 10. References

- [Stripe Docs](https://stripe.com/docs)
- [Twilio Docs](https://www.twilio.com/docs)
- [Resend Docs](https://resend.com/docs)
- [Drizzle ORM](https://orm.drizzle.team/docs/overview/postgres)
- [TanStack Query](https://tanstack.com/query/latest)
- [Tailwind CSS](https://tailwindcss.com/docs)
- Internal: `docs/agents/`, `docs/SIGNAL_ENGINE_REFERENCE.md`, `replit.md`
