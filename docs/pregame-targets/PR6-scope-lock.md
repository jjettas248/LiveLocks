# PR6 — Scope Lock: NFL data & entitlement

**Status:** Approved, repository-owned scope lock. It continues the dependency-based
roadmap recorded in `PR5-scope-lock.md` (which remains the program's boundary authority
because the external PR5–PR9 build spec could not be recovered). This document records
the PR6 boundary and the two owner-confirmed decisions below; it does **not** claim to
recover external authority and does **not** edit the PR0 audit documents.

---

## 1. Basis

`PR5-scope-lock.md:23` assigns **PR6 = NFL data & entitlement** (provider selection,
canonical NFL ids, 3-season backfill, `hasNFL` tier mapping), grounded in the
conflict-matrix cell C3 (`PR0-conflicts-and-migration.md:15`) and the greenfield NFL
coverage matrix (`PR0-data-coverage.md`, §2: "NFL data ingestion is a full PR6
workstream"). At PR6 start the repo has **no** `server/nfl/`, `PREGAME_SPORTS = ["nba"]`
(no NFL in the canonical union), and `hasNFL` is a contract-only entitlement
(`server/utils/access.ts` — `false` for every real tier, `true` only under the admin
bypass; "no product reads it operationally yet").

## 2. Owner-confirmed decisions (locked before implementation)

1. **Provider = nflverse** (`nflreadr`/`nflfastR`, the `nflverse-data` GitHub releases:
   weekly player stats, schedules, rosters as bulk per-season CSV). Rationale: a
   documented, stable, community-standard schema with permissive **data** licensing (NFL
   trademarks excluded), and bulk per-season files (no per-record pagination). It is the
   cleanest analog to a defined source and mirrors PR5's raw-capture discipline.
2. **Entitlement = define the mapping, keep it gated OFF.** PR6 encodes which
   subscription tier *would* grant NFL behind a fail-closed flag, but `hasNFL` stays
   `false` operationally until a real NFL product exists (PR7 shadow build → later public
   PR). No assignable tier gains operational access in PR6.

**Licensing boundary (unchanged from PR5's posture):** nflverse redistributes NFL data
under its own terms; **production use of the NFL ingestion runner is `PENDING OWNER
CONFIRMATION`**. PR6 commits code + fixtures + a manual runner and performs **no** live
production ingestion. See `PR6-nfl-source-manifest.md`.

## 3. PR6 hard boundary

**In scope:**
- **Canonical NFL ids** — add `"nfl"` to `PREGAME_SPORTS` (the PR1 fail-closed resolver
  and id scheme extend to NFL unchanged; MLB/NCAAB stay out — they are not pregame-target
  sports in this program).
- **`hasNFL` entitlement mapping** — a contract mapping (which tier maps to NFL) behind a
  default-off, fail-closed flag; `hasNFL` remains `false` operationally. Additive; never
  changes `hasNBA`/`hasNCAAB`/`hasMLB`/`hasUnlimited` for any tier.
- **nflverse source layer** — normalized source contracts, a raw provider fetch that
  preserves the verbatim provider payload (post-decode observation instant; typed
  transport/HTTP/parse failures; no value coercion), and fail-closed adapters (schema
  drift / duplicate headers / conflicting rows rejected) reusing the shared, sport-neutral
  `rawSnapshotIdentity` (three-identity capture) and the audit-4 head-by-`knownAt`
  observation-chain ingest.
- **NFL as-of feature construction** — per-week rate features anchored to the schedule's
  game date (`validAt = gameday`, `knownAt = fetchedAt`, `missing` vs `observed_zero`
  distinct), folded through the **existing PR1** posterior/recency modules (no new
  posterior math).
- **Per-source/per-season coverage classification** and an **explicit manual backfill
  runner** (fail-closed flag **and** `--confirm`; sanitized failure records).
- Mocked + synthetic-fixture replay verification (no live network in this environment).

**Out of scope (deferred / other PRs):** PR3/PR4 math changes; NFL projection engine;
qualification/tiers/tags/role-certainty/risk; target-snapshot capture; decision-snapshot
persistence; `persisted_plays` writes; grading; calibration-history wiring; analytics
emitters; routes/public APIs; UI; scheduled production build loops; **any operational NFL
product surface**. Cross-sport isolation holds: NFL code imports no other sport engine
(`server/mlb` ↔ `server/nba` ↔ NFL), only the shared PR1 foundation + the sport-neutral
storage/identity utilities.

**Runtime rule:** normal server startup must **never** trigger NFL ingestion. The only
boot wiring is the additive, idempotent schema bootstrap (the PR1 tables already exist;
no new destructive SQL). Ingestion runs **only** from the explicit CLI runner, guarded by
the default-off `NFL_PREGAME_INGEST_ENABLED` flag **and** an explicit `--confirm`. No
scheduler, cron, public route, or deploy-time backfill is added.

**Rollback rule:** rollback = disable the ingestion invocation and any new readers,
**preserving all immutable snapshots and audit lineage**. The PR1 foundation tables are
immutable audit records and are **never** truncated or deleted as a rollback mechanism.

## 4. Not done here

PR6 does not implement an NFL projection engine (no PR3/PR4 analog), does not build a
public NFL surface, does not begin PR7 (inferred NBA shadow build) or PR8 (analytics),
and does not enable NFL entitlement operationally. PR9 remains unapproved pending its own
scope lock.

## 5. Branch-name artifact (documented, deliberately not renamed)

PR6's work lives on the branch **`claude/nba-pregame-ingestion`** (draft PR #178), whose
name reads as NBA even though PR6 delivers **NFL** data + entitlement. This is a naming
artifact only — the branch was continued from the PR5 lineage rather than cut fresh, and
the actual diff is entirely NFL-scoped (see §3 and the scope audit in the PR6 convergence
audit comment). A cleaner name would be `claude/nfl-pregame-data-entitlement`.

**Why it is not renamed:** renaming the branch of an already-open PR is not safely
available through the tooling in this environment without closing/recreating PR #178,
which the reviewer explicitly asked to keep as a single draft. GitHub branch-rename is not
exposed via the MCP surface, and a local rename + force-push under a new ref would orphan
the PR. Per the sanctioned fallback, the branch is **left alone and the naming artifact is
documented here** rather than churning the PR. The next fresh-cut branch in the program
should adopt the sport-accurate naming convention.
