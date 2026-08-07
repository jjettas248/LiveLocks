# PR5 — Scope Lock: NBA historical ingestion & as-of feature population

**Status:** Approved, repository-owned scope lock. **This document is the authority for PR5's boundary** because the external build-spec PR5–PR9 breakdown could not be recovered (see below). It records a decision made now; it does **not** claim to recover a pre-existing external roadmap, and it does **not** retroactively edit the PR0 audit documents (`PR0-conflicts-and-migration.md`, `PR0-current-state-trace.md`, `PR0-data-coverage.md`), which remain as originally written.

---

## 1. Why this lock exists

The NBA/NFL Pregame Targets program completed PR1 (as-of temporal foundation) → PR2 (contract layer) → PR3 (blind projection core) → PR4 (calibration + fresh-line decision layer). The **authoritative per-PR breakdown for PR5–PR9 lives in an external build spec that is not present in this repository or its git history** (confirmed: no deleted or renamed planning file exists; the repo only *cites* the spec via `§`-references). The only in-repo forward pointers for this program were three incidental conflict-matrix cells in `PR0-conflicts-and-migration.md`:

- C7 (`:19`): "read-only NBA/NFL analytics emitters in **PR5/PR8**"
- C3 (`:15`): "NFL … in PR2 (contract) / **PR6 (data)**"

A separate, unrelated program — **MLB "Plate HR V2"** (`docs/plate/plateHrV2UpgradePlan.md`) — has its **own** PR5–PR11 numbering. Those are **not** this program's roadmap and must not be imported.

Because the external spec cannot be recovered, the numbering below is the **approved dependency-based continuation** of PR1–PR4 — not recovered external authority.

## 2. Approved dependency-based roadmap (repository-owned)

| PR | Responsibility | Basis |
| --- | --- | --- |
| **PR5 (this lock)** | **NBA historical ingestion & as-of feature population** — real current-plus-two-prior-season NBA data into the PR1 foundation, so the PR3 blind projection core has genuine inputs. **No public targets.** | Dependency root: the PR3/PR4 engine has no inputs and the PR1 tables are empty. PR1's own description names ingestion as "the next PR." |
| **PR6** | **NFL data & entitlement** (provider selection, canonical NFL ids, 3-season backfill, `hasNFL` tier mapping). | Explicit: C3 / `PR0-data-coverage.md:43`. |
| **PR7** | **Inferred** NBA shadow build + qualification + target-snapshot capture (run PR3/PR4 per slate offline, freeze immutable target snapshots, populate the reserved `projection_snapshot_id`/`decision_snapshot_id` provenance). Still no public surface. | Inferred from the §7 target data-flow (`PR0-current-state-trace.md:156`). Not externally defined. |
| **PR8** | **Read-only NBA/NFL analytics** emitters — extend the read-only ring buffer for NBA and NFL. | Explicit C7, **re-sequenced to PR8**: analytics can only run **after** prediction and grading data exist (which arrive in PR7+), so the C7 "PR5" analytics assignment is resolved by placing **both** NBA and NFL analytics at PR8. |
| **PR9** | **Unapproved.** The official `persisted_plays` target write, grading, calibration-history wiring, and any public API/UI must **not** be implemented without a separate scope lock. | Inferred placeholder only. |

**C7 resolution (explicit):** the old C7 wording ("read-only analytics emitters in PR5/PR8") conflicted with the dependency order. It is resolved here by assigning **NBA and NFL analytics to PR8**, after prediction and grading data exist. PR5 introduces **no** analytics.

## 3. PR5 hard boundary

**In scope:** an optional `season` argument on the existing NBA player/team game-log provider methods (byte-equivalent current-season behavior when omitted); an NBA source adapter + normalized source contracts; immutable raw-source-snapshot ingestion into the existing PR1 tables; as-of feature construction through the existing PR1 leakage firewall; posterior folding through the existing PR1 posterior/recency modules; per-source/per-season coverage classification; an **explicit manual backfill/ingestion runner**; mocked & fixture-based replay verification.

**Out of scope:** PR3/PR4 math changes; qualification rules; tags/tiers/role-certainty/risk; target-snapshot capture; decision-snapshot persistence; `persisted_plays` writes; grading; calibration-history wiring; analytics emitters; routes/public APIs; access/subscription logic; UI; scheduled production build loops; **all NFL code**.

**Runtime rule:** normal server startup must **never** trigger multi-season ingestion. Invocation is explicit (a CLI/manual runner). A default-off, fail-closed flag may additionally guard execution, but is not a substitute for explicit invocation. No scheduler, cron, public route, or deploy-time backfill is added.

**Rollback rule:** rollback = disable the ingestion invocation and any new readers, **preserving all immutable snapshots and audit lineage**. The PR1 foundation tables are immutable audit records and are **never truncated or deleted** as a rollback mechanism.

## 4. Not done here

PR5 does not merge itself, does not begin PR6, and does not implement PR7–PR9. PR9 in particular remains unapproved pending its own scope lock.
