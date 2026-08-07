# PR7A — Zone-Independent Plate-Discipline Upgrade (`plateDisciplineNoLocationV1`)

> **Status: TOOLCHAIN VALIDATED (PR7A.0 proved parity; PR7A.1 reconciled fixtures + manifest).**
> The audit + redundancy + contract were reviewed and **approved**; the architecture is locked
> (no separate `plateDisciplineNoLocation` group — the canonical `contactOpportunity` group is
> extended, with a separate `pitcherDiscipline` group and an explicitly-unavailable `zoneLocation`
> group). **PR7A.0** ran the pinned Chadwick `cwevent` over real, SHA-verified 2019 Retrosheet event
> files on a clean GitHub Actions runner (no production secrets, no deploy/DB/Railway/runtime/model
> change) and captured actual output (`docs/plate/pr7a0-proof/`). **PR7A.1** reconciled the fixtures
> and manifest to that real output: the pitch-sequence grammar reproduced cwevent's own counts on
> **5561/5561** real PAs; cases 02 (interrupted PA) and 03 (responsible batter) are **re-anchored to
> real cwevent output rows**; all 8 cases pass the revised contract comparison
> (`scripts/pr7a0/verifyFixtureContract.mjs`). The source manifest is now **`status: validated`** with
> the parser version/commit, exact `cwevent` arguments, and archive/source/output hashes pinned. **The
> 2000+ training floor remains provisional and the 2000–2025 season matrix remains PENDING_MEASUREMENT
> — PR7A.0/PR7A.1 validated the parser + raw-shape contract only, not multi-season coverage.** Still
> prohibited: full/multi-season ingestion, the 2000–2025 matrix job, DB changes, fetch scheduling,
> feature-envelope TypeScript changes, evidence-kind wiring, feature-builder wiring, fitting, PR8,
> champion/public changes. This doc changes no runtime code.

## 0. Why PR7A exists

The original location-based PR7 (`plate_x`, `plate_z`, `zone`, `sz_top`, `sz_bot`) passed its
**data coverage gate** (98.4% in the 2026-08-05 production spike) but is **licensing-blocked**:
no commercially authorized source currently supplies those five Statcast fields
(`docs/plate/plateHrV2DataFeasibility.md` §8.2). PR7A is a **separate, zone-independent** feature
group that delivers plate-discipline signal from a **commercially usable historical source
(Retrosheet)** and other already-authorized inputs — with **zero** pitch-location content.

**Hard constraints (restated, and enforced by this contract):**

1. Do **not** ingest Baseball Savant or MLB Stats API data for PR7A.
2. Do **not** derive, estimate, or proxy pitch coordinates or zone labels.
3. Do **not** name any feature `chase`, `heart`, `shadow`, `inside`, `outside`, or any zone-based term.
4. Preserve `zoneLocationV1` as **unavailable** with reason **`licensed_source_unavailable`**.
5. Capture source provenance: **dataset version, game IDs, and as-of timestamps**.
6. **Freeze representative Retrosheet normalization fixtures before writing the adapter.**
7. **Fail closed** when required source evidence is unavailable.
8. Keep all work **shadow-only and flag-gated**.
9. Do **not** change champion or public behavior.
10. Exclude `starterBullpen` until its production fetchers are independently authorized and verified.

---

## 1. Retrosheet field-availability audit (exact)

**Source products.** Retrosheet publishes annual **event files** (`.EVN`/`.EVA`, play-by-play),
**roster files** (`.ROS`), and **game-info records** (embedded `info,*`, `start`, `sub` records).
The canonical machine-readable extraction is via **Chadwick** (`cwevent`, `cwgame`), which emits
one row per event (plate appearance / play) with stable column codes. This audit is written
against the Chadwick `cwevent` field set; a raw-parser path would target the same fields.

### 1.1 AVAILABLE — directly present, no location required

| Concept | Retrosheet / Chadwick field | Notes |
|---|---|---|
| Game identity | `GAME_ID` | e.g. `ATL201904150` — carries date + home team + game number |
| Game date | derived from `GAME_ID` / `cwgame` `GAME_DT` | ET calendar handling still via `todayET()`/`toEtDateKey()` |
| Park | `cwgame` `info,site` (park ID) | needs a **Retrosheet-parkID → LiveLocks venue** crosswalk (a frozen fixture) |
| Batter identity | `BAT_ID` | Retrosheet player id (e.g. `acunr001`) — needs a **RetrosheetID → MLBAM/roster** crosswalk |
| Pitcher identity | `PIT_ID` | same crosswalk need |
| **Batter hand (actual)** | `RESP_BAT_HAND_CD` | resolves switch-hitters vs the actual pitcher — better than roster `bats` |
| **Pitcher hand (actual)** | `RESP_PIT_HAND_CD` | resolves the actual arm faced |
| PA-ending outcome | `EVENT_CD` | K=3, BB=14, IBB=15, HBP=16, 1B=20, 2B=21, 3B=22, HR=23, … |
| PA / AB flags | `PA_FLAG`, `AB_FL`, `SH_FL`, `SF_FL` | denominators for K%/BB%/in-play% |
| Count at plate | `BALLS_CT`, `STRIKES_CT` | end-of-PA count; **per-pitch progression** comes from the sequence below |
| **Pitch sequence** | `PITCH_SEQ_TX` | the char string (e.g. `CBBFFX`) — the raw material for whiff/foul/contact/two-strike/count-progression, **location-free** |
| Inning / half | `INN_CT`, `BAT_HOME_ID` | context only |
| Batting-order slot | `start`/`sub` records (`cwgame` lineup) | historical lineup slot — see §1.3 for the live caveat |

### 1.2 UNAVAILABLE from Retrosheet — must NOT be proxied

| Concept | Status | Consequence |
|---|---|---|
| Pitch **location / zone** (`plate_x/plate_z/zone/sz_top/sz_bot`) | **ABSENT** | `zoneLocationV1` stays unavailable, reason `licensed_source_unavailable` (§4). No proxy, ever. |
| Pitch **type / velocity** (fastball/breaking/offspeed) | **ABSENT** — Retrosheet records no pitch type | **No pitch-family outcomes in PR7A.** The `pitchType` group stays Savant-gated and untouched. Reason code `source_lacks_pitch_type`. |
| Exit velocity / launch angle / barrel / xSLG | **ABSENT** (Statcast) | PR7A carries **no contact-quality** signal; those groups stay Savant-blocked. |
| Batted-ball trajectory (GB/FB/LD) | **PARTIAL** (`BATTEDBALL_CD` present in modern files, coverage-variable) | **Deferred / out of PR7A scope** — not a discipline metric; do not include in v1. |

### 1.3 CONDITIONAL — available for TRAINING, not for live serving under PR7A rules

The discipline **features** are batter/pitcher **priors** computed from Retrosheet history — those
are fine. But some **prediction-game context** (today's park, today's confirmed lineup slot,
today's opposing pitcher identity) is **not** knowable from Retrosheet (a historical source) and
its usual live source is **MLB Stats API / Savant — forbidden for PR7A**. Therefore:

- **Historical/training frame:** park, batting-order slot, and opposing-pitcher identity come from
  the same Retrosheet game record → available for building the training set.
- **Live pregame serving:** these context fields **default to unavailable** for PR7A unless supplied
  by an already-authorized, non-forbidden source. PR7A v1 treats them as **CONDITIONAL** and does
  not block on them. This keeps PR7A's live path free of any forbidden ingestion.

### 1.4 Pitch-sequence grammar (the completeness gate)

`PITCH_SEQ_TX` is the crux. Its per-character classification (to be **frozen by fixtures** before
any adapter):

- **Balls:** `B` (ball), `I` (intentional ball), `V` (auto/‘to-mouth’ ball), `P` (pitchout, if taken)
- **Called strike:** `C`
- **Swing — miss (whiff):** `S` (swinging strike), `M` (missed bunt)
- **Swing — contact, not in play:** `F` (foul), `T` (foul tip), `L` (foul bunt), `O` (foul-tip bunt), `R` (foul on pitchout)
- **Swing — in play:** `X` (in play), `Y` (in play on pitchout)
- **Hit by pitch:** `H`
- **Non-pitch markers (stripped):** `.` `+` `*` `>` `1` `2` `3` `N`
- **UNKNOWN / uncountable:** `U` (unknown/missed pitch), `K` (strike, unknown type) → **degrade completeness**

**Completeness rule (fail-closed):** a PA is *sequence-complete* only if its stripped sequence
contains no `U`/`K`, is non-empty, and its terminal token is consistent with `EVENT_CD` (e.g. an
in-play `EVENT_CD` ends in `X`/`Y`; a strikeout ends in `S`/`C`/`M`). A batter's window is eligible
only when the **share of sequence-complete PAs ≥ a coverage floor** (proposed `0.90`); otherwise the
window degrades → the leaf is `null`, never estimated. Pitch-sequence coverage is high in the modern
era but **not** universal historically — this floor is mandatory, not cosmetic.

**Interrupted-PA raw shape (VALIDATED against real Chadwick output — PR7A.0).** A PA that spans
multiple event-file play records (a stolen base, wild pitch, injury, or substitution mid-AB) surfaces
in **actual cwevent output** as **ONE `BAT_EVENT_FL=T` row whose `PITCH_SEQ_TX` carries the FULL
CUMULATIVE sequence with the `.` marker preserved verbatim** — cwevent does **not** strip the dot
(e.g. real rows `.BBCX`, `CC.FS`, `BCBB.CX`). The interrupting event is a **separate
`BAT_EVENT_FL=F` row** and is **never** a second PA. Normalization therefore **reads the single
terminal row and strips the `.` in one pass** (`.BBCX` → `[B,B,C,X]`); it **must not** concatenate
pitch fragments from separate records. On a two-strike substitution, cwevent charges the PA to the
**original** batter via `RESP_BAT_ID`, with `BAT_ID` the completing batter and `REMOVED_FOR_PH_BAT_ID`
the removed original — confirmed on real 2019 rows (`docs/plate/pr7a0-proof/`, fixtures 02 & 03).

### 1.5 Licensing / attribution posture (record, do not self-approve)

Retrosheet is the **commercially usable** premise authorizing PR7A (per the task). It nonetheless
carries a **mandatory attribution notice** wherever derived output is displayed, and prohibits
reselling the raw data (transformed model output is permitted). This is analogous to Open-Meteo's
CC BY 4.0 obligation:

- The Retrosheet notice **must** be displayed at any **public** promotion of PR7A output (not now —
  PR7A is shadow-only). Flagged here so promotion carries it.
- The **dataset version + the Retrosheet notice string** are captured in provenance (§5) so every
  training row and prediction is traceable to a specific, attributable release.
- Reselling raw Retrosheet data is out of scope; PR7A stores only **derived sufficient statistics**.

> Counsel should still confirm the attribution wording and commercial terms before public
> promotion. PR7A proceeding as **shadow-only** does not depend on that confirmation.

### 1.6 Season / era coverage (which seasons support which concept)

The limiting factor is **`PITCH_SEQ_TX` completeness**, not `EVENT_CD`. Per-PA *outcomes* exist
whenever an event file exists; per-*pitch* behavior needs the sequence, which is sparse before the
late 1980s and effectively complete from ~2000.

| Concept | Requires | Reliable seasons |
|---|---|---|
| K%, BB%, IBB%, HBP%, balls-in-play% | `EVENT_CD` (+ PA flags) | modern era broadly; **safe 2000+** |
| Batter/pitcher **outcome** splits (K%/BB% by opposing hand) | `EVENT_CD` + `RESP_*_HAND_CD` | modern era broadly |
| Batting-order context | `start`/`sub` lineup records | modern era (reliable) |
| Foul-strike behavior, swing/whiff/contact, first-pitch behavior | **`PITCH_SEQ_TX`** | ~1988+, **strong 2000+** |
| Two-strike outcomes, count progression, two-strike survival | **`PITCH_SEQ_TX`** | ~1988+, **strong 2000+** |
| Handedness **swing/whiff** splits (not just outcomes) | `PITCH_SEQ_TX` + hand | ~1988+, **strong 2000+** |

**Recommendation (PROVISIONAL — not empirically verified):** set PR7A's **training season floor =
2000** for all sequence-derived leaves. This is a **working assumption**, believed to keep the
completeness floor met at population scale, but it is **not proven** until the §3.6 season matrix is
measured — the matrix confirms or corrects the floor. Outcome-only leaves (K%/BB%) could extend
earlier if ever needed, but v1 keeps a single provisional 2000+ window. This is a training-window
choice; the per-batter **as-of** leakage rule (§4) is orthogonal and always applies.

### 1.7 Redundancy analysis against existing V2 features

The concern: does PR7A duplicate signal already in the V2 vector? Audited group-by-group.

| Existing V2 group / leaf | Source (intended) | Currently populated? | Overlap with PR7A | Verdict |
|---|---|---|---|---|
| `contactOpportunity` (`kRatePct`, `bbRatePct`, `whiffRatePct`, `contactRatePct`, `zoneContactRatePct`, `chaseRatePct`) | Savant/plate-discipline | **NO — hard-coded all-null placeholder** (`buildPregamePowerRadar.ts:1446`, no producer) | **Nominal** name overlap on K%/BB%/whiff%/contact% | **No live redundancy.** PR7A is the first real discipline producer. |
| `pitchType.*.batterWhiffPct` | Savant (per pitch-family) | populated when Savant present | PR7A whiff is **aggregate** (no pitch type) | **Complementary** — different grain; Retrosheet cannot do per-family. |
| `pitcherVulnerability` (`hrPer9*`, `barrelAllowedPct`, `hardHitAllowedPct`) | Savant | populated when Savant present | PR7A pitcher block is **discipline** (K/BB/whiff/CS), not HR-damage | **Complementary** — different axis. |
| `recentContactForm` (EV/EV90/barrel) | `contact_events` | populated (PR5) | contact **quality**, post-contact | **No overlap** — PR7A is pre-contact approach. |
| `batterPower`, `batTracking` | Savant | populated when present | power/swing mechanics | **No overlap.** |

**LOCKED ARCHITECTURE DECISION (reviewer, supersedes the earlier "own group" proposal).**
Although there is no *runtime* redundancy (the group is empty), a parallel `plateDisciplineNoLocation`
group would create *schema* redundancy — two canonical homes for K%/BB%/whiff%/contact% — violating
the no-duplicate-system rule and complicating fitting, evidence binding, and later zone migration.
Therefore:

1. **`contactOpportunity` becomes the single canonical Retrosheet-backed discipline group.** PR7A
   populates its existing non-location leaves and **extends** it with new v3 non-location fields
   (§3.1). There is **no** `plateDisciplineNoLocation` group. K/BB/contact live in exactly one place.
2. **The zone-dependent leaves stay `null` forever under Retrosheet.** `chaseRatePct` and
   `zoneContactRatePct` require a zone — Retrosheet cannot and must not fill them; they remain
   declared in `contactOpportunity` but permanently null. No proxy.
3. **Pitcher discipline is a separate `pitcherDiscipline` group** (§3.3), because the strict flat
   `contactOpportunity` schema mixes two actors poorly. Batter K/BB/contact are **never** duplicated
   there.
4. **`zoneLocation` stays a separate, explicitly-unavailable location group** (§3.5).

**Net:** PR7A adds genuinely new, non-redundant signal into the *existing* canonical home, with a
distinct attributable source; overlaps with populated V2 groups (per-family whiff, HR-damage,
contact-quality) remain complementary, not duplicative.

---

## 2. Scope boundary (what PR7A is and is not)

- **Is:** shadow, flag-gated, Retrosheet-sourced **plate-discipline priors** landed into the
  **existing canonical `contactOpportunity` group** (extended with new v3 non-location fields) plus a
  separate **`pitcherDiscipline`** group — pre-contact approach metrics, hand-split, with strict
  provenance and fail-closed derivation.
- **Is not:** any location/zone signal (preserved unavailable), any pitch-type signal (Retrosheet
  lacks it), any contact-quality signal (Statcast), any `starterBullpen` use (excluded), any new
  duplicate discipline group, and any change to champion/public/`scoring.ts`/`evaluatePlateModel.ts`.

Structural isolation (to be enforced by a grep + test-time check, mirroring the mound/v2 pattern):
new PR7A files import **no** Savant/MLB-Stats data-source module and are imported by **no** champion
or public path. Capture writes only to the shadow research store.

---

## 3. Feature contract (LOCKED architecture) — `plate_hr_v2_features_v3`

`plate_hr_v2_features_v3` is a **feature-envelope version, not a model/champion version.** V2
prediction readers continue reading existing V1/V2 snapshots without reinterpretation. V3 =
V2 shape with `contactOpportunity` populated + extended, a new `pitcherDiscipline` group, and
`zoneLocation` reshaped to the explicit unavailable record. Every rate leaf is
`z.number().nullable()` and **required** (missing ⇒ explicit `null`), `.strict()`. Raw counts are
first-class leaves so PR8 can test shrinkage/alternative thresholds rather than inheriting hard-coded
modeling assumptions. **No forbidden names.**

```
contactOpportunity = canonical Retrosheet-backed discipline group
pitcherDiscipline  = separate pitcher-actor discipline group
zoneLocation       = separate, explicitly-unavailable location group
```

### 3.1 `contactOpportunity` — canonical discipline group (batter)

```
contactOpportunity: {
  // existing leaves, now populated from Retrosheet:
  kRatePct,                    // K / PA
  bbRatePct,                   // (BB − IBB) / PA   (unintentional)
  whiffRatePct,                // whiff swings / swings
  contactRatePct,              // contact swings / swings

  // remain null — Retrosheet cannot support (zone-dependent), never proxied:
  chaseRatePct: null,
  zoneContactRatePct: null,

  // new v3 non-location fields:
  foulStrikeRatePct,           // foul strikes (F/T/L/O/R) / swings
  firstPitchStrikeRatePct,     // strike seen on pitch 1 (C/S/F/T/X) / PA
  twoStrikeSurvivalRatePct,    // (reached 2 strikes, not K) / reached 2 strikes
  inPlayRatePct,               // (X + Y) terminal / PA

  // required evidence-quality leaves (co-located so a rate is never read without its provenance):
  batterPa,                    // raw PA denominator
  codedPitchPa,                // PAs with a usable (sequence-complete) PITCH_SEQ_TX
  pitchSequenceCoverage,       // codedPitchPa / batterPa
  datasetVersion,              // Retrosheet dataset release id (string leaf via `extra`/typed)

  // hand-splits (top-line only, to bound cardinality):
  kRatePctVsL, kRatePctVsR,
  bbRatePctVsL, bbRatePctVsR,
  contactRatePctVsL, contactRatePctVsR,
  whiffRatePctVsL, whiffRatePctVsR,
  paVsL, paVsR,
}
```

> Note: `datasetVersion` is a string; if the strict all-numeric leaf rule must hold for
> `contactOpportunity`, `datasetVersion` is carried in the group's typed metadata / evidence
> descriptor rather than as a numeric leaf. The evidence descriptor (§4) is the authoritative home
> for `datasetVersion`, `dataThroughAt`, and `gameIds[]`; the leaf here is a convenience mirror.

### 3.2 Raw counts preserved (for PR8 shrinkage tests)

Every rate above is accompanied by its integer numerator/denominator in the **evidence payload**
(§4) — e.g. `k`, `bb`, `ibb`, `hbp`, `pa`, `pitches`, `swings`, `whiffs`, `contacts`, `fouls`,
`calledStrikes`, `takenPitches`, `inPlay`, `firstPitchStrikes`, `twoStrikePa`, `twoStrikeK`,
`twoStrikeSurvived`, per-hand denominators. Rates are re-derivable from counts; PR8 may re-shrink.

### 3.3 `pitcherDiscipline` — separate group (conditional on pitcher known)

```
pitcherDiscipline: {
  pitcherKnown,                        // boolean
  pitcherKRatePct,
  pitcherBbRatePct,                    // unintentional
  pitcherWhiffRatePct,                 // whiff / swings induced
  pitcherCalledStrikeRatePct,
  pitcherFirstPitchStrikeRatePct,      // strike seen on pitch 1 / BF
  pitcherKRatePctVsHand,               // vs this batter's resolved hand
  pitcherBbRatePctVsHand,
  pitcherBf,                           // raw BF denominator
  pitcherBfVsHand,
}
```

Batter K/BB/contact are **never** duplicated here.

### 3.4 Floors → null-with-reason (capture-usability, NOT final modeling thresholds)

Approved floors. Below a floor, the affected derived rate is `null` with an explicit reason; **raw
counts are always preserved** so PR8 can test alternative thresholds:

```
Pitch-sequence coverage:  ≥ 0.90     (else sequence-derived leaves null: reason "below_sequence_coverage")
Batter overall sample:    ≥ 150 PA   (else batter rates null: reason "below_batter_pa_floor")
Pitcher overall sample:   ≥ 300 BF   (else pitcher rates null: reason "below_pitcher_bf_floor")
Batter handedness split:  ≥ 75 PA    per split (else that split null: reason "below_hand_split_pa_floor")
Pitcher handedness split: ≥ 150 BF   per split (else that split null: reason "below_hand_split_bf_floor")
```

Data-quality block (per snapshot): `datasetVersion`, `dataThroughDate` (ISO), `pitchSequenceCoverage`,
`sequenceFloorMet` (bool), `overallQuality` (`full`/`degraded`/`missing`).

### 3.5 `zoneLocation` — separate, explicitly UNAVAILABLE group

```
zoneLocation: {
  status: "unavailable",
  reason: "licensed_source_unavailable",
  plateX: null,
  plateZ: null,
  zone:  null,
  szTop: null,
  szBot: null,
}
```

- New reason enum value **`licensed_source_unavailable`**.
- No PR7A code reads, derives, or proxies any location field. Stripped from the authorized projection
  exactly as today. This is the seam a future licensed zone source would fill — kept explicit, not
  silently dropped.

### 3.6 Measured season matrix 2000–2025 (REQUIRED — evidence, not conclusion)

"Strong 2000+" is a conclusion; the contract requires the **measured** matrix as its evidence. The
matrix has one row per season with columns:

```
season | qualifyingPa | paWithUsablePitchSeq | sequenceCoveragePct
       | unknownHandednessPct | interruptedSequencePct | playersMeetingFloors
```

> **PENDING MEASUREMENT — values must never be fabricated.** Measuring this matrix requires ingesting
> the licensed Retrosheet dataset and running the frozen parser (§4 manifest) — which is **prohibited
> at this stage** (no network ingestion). It must be produced by running the frozen parser over the
> licensed dataset in the **authorized environment** (same pattern as the Railway zone audit), and
> pasted into this section before ingestion/fitting is authorized. This document ships the matrix
> **schema**; the numbers are a gated follow-up.

---

## 4. Evidence, provenance & fail-closed derivation

Mirrors the `starter_bullpen` / `contact_events` content-addressed evidence pattern
(`starterBullpenPaPathEvidence.ts`):

- **New provider:** `retrosheet` (added to the provider set).
- **New `EVIDENCE_KINDS` value:** `retrosheet_discipline`.
- **New `zoneLocationV1` reason enum value:** `licensed_source_unavailable`.
- **Entity:** one descriptor per `batter`; a separate descriptor per `pitcher` for §3.3.
- **`availabilitySource`:** `verified_as_of` — Retrosheet is a published dataset with a known
  coverage-through date. `dataThroughAt` = last covered game date; `availableAt`/`fetchedAt` =
  dataset ingest time. **Leakage rule:** `dataThroughAt < predictionAsOf ≤ firstPitch`, and the
  aggregate includes **only games strictly before** the prediction game (enforced, tested).
- **Payload (content-addressed, re-derivable):** the **integer sufficient statistics** (counts, not
  just rates) + the **list of contributing `GAME_ID`s** + window bounds (`from`/`to`) +
  `retrosheetDatasetVersion` + the Retrosheet notice string. The projection (§3) must **re-derive
  exactly** from this payload (round-trip test), same as PR6.2's re-derivability invariant.
- **Fail-closed `evidence: null`** when any of: dataset version absent, non-finite timestamp,
  `pitchSequenceCoveragePct` < floor, `paSample` < floor, or `dataThroughAt ≥ predictionAsOf`.
  A null-evidence leaf serializes as `null` with `overallQuality: "missing"` — never estimated.

**Provenance captured (per requirement 5):** `retrosheetDatasetVersion`, contributing `gameIds[]`,
`dataThroughAt`, `availableAt`/`fetchedAt`, window `from`/`to`, `contentHash`, plus the attribution
notice string.

### 4.1 Authorized crosswalk + parser identity (frozen manifest)

Two-part authority, frozen in `fixtures/retrosheetDiscipline/SOURCE_MANIFEST.json`:

1. **Semantic authority:** the official **Retrosheet Play-by-Play Crosswalk** — maps `PITCH_SEQ_TX`
   to parsed `pitches`, `BAT_LINEUP_ID` to lineup position, and identifies the batter/pitcher
   handedness and event fields.
2. **Executable parser identity:** a **pinned Chadwick `cwevent`** version/commit + exact frozen
   arguments (the parser that turns raw event files into the coded rows the semantic crosswalk
   describes).

```
semanticCrosswalk: Retrosheet Play-by-Play Crosswalk
parser:            Chadwick cwevent
parserVersion:     0.10.0  (commit 8f7e0ecd8984cd752e6aca5deba81b86fb369602)
parserArguments:   cwevent -n -y <season> -f 0,2,3,4,5,6,7,10,11,12,13,14,15,16,17,29,31,33,34,35,36,86,87 <eventfile>
```

> `parserVersion`/`parserArguments` are now **pinned** to the toolchain proven in PR7A.0 (Chadwick
> built from source on a clean GitHub Actions runner; frozen argument set above). The manifest
> (`fixtures/retrosheetDiscipline/SOURCE_MANIFEST.json`, `status: validated`) records these plus the
> Retrosheet archive hash, per-event-file hashes, and per-game output hashes from the proof
> (`docs/plate/pr7a0-proof/`). Nothing was fabricated.

### 4.2 Required Retrosheet attribution notice

Exact statement (stored in provenance now; displayed at public promotion):

> "The information used here was obtained free of charge from and is copyrighted by Retrosheet.
> Interested parties may contact Retrosheet at www.retrosheet.org."

Required placements (recorded now; PR7A is shadow-only so public display activates at promotion):

```
Public attribution:     LiveLocks Data Sources / About surface
Repository attribution: dataset README and evidence-contract documentation
Fixture attribution:    fixture README
```

---

## 5. Fixtures to freeze BEFORE the adapter (requirement 6)

The adapter is **not** written until these fixtures are frozen with expected normalized output.
These are raw-shape + normalization contract fixtures. **PR7A.0 validated the parser and raw shape
against real Chadwick output**, and **PR7A.1 reconciled the fixtures to it**: cases 02 & 03 are now
**real-anchored** (`fixtureOrigin: real_retrosheet_chadwick_v0_10_0` + a `validatedAgainstProof` block
citing the game, output CSV, and hashes); cases 01 & 04 were confirmed by the proof (grammar
5561/5561; per-event handedness); cases 05–08 remain **adapter-policy specifications**
(`fixtureOrigin: synthetic`) — fail-closed completeness, unknown-handedness split-withholding, the
coverage gate, and the sample floors are adapter policies layered on cwevent output, not fields
Chadwick emits, and real output does not contradict them. All 8 pass the revised contract comparison
(`scripts/pr7a0/verifyFixtureContract.mjs` → `CONTRACT_COMPARISON_RESULT.json`). Committed under
`server/mlb/pregamePowerRadar/hrProbabilityV2/fixtures/retrosheetDiscipline/`:

1. **Normal modern game, complete pitch sequences** — several sequence-complete PAs (K, BB, in-play, foul-heavy). *Grammar validated on 5561/5561 real PAs (PR7A.0).*
2. **Interrupted PA with the Retrosheet period separator** — VALIDATED raw shape: cwevent emits ONE
   `BAT_EVENT_FL=T` row carrying the FULL CUMULATIVE `PITCH_SEQ_TX` with the `.` preserved (real row
   `.BBCX`); the interrupting event is a separate `BAT_EVENT_FL=F` row, never a second PA. Reassembly =
   read the single terminal row and strip the `.` once — **no fragment concatenation**.
3. **Substitution / pinch-hit where the responsible batter differs** — VALIDATED: real two-strike
   carryover charges the PA to the **original** batter via `RESP_BAT_ID` (`BAT_ID` = completing batter,
   `REMOVED_FOR_PH_BAT_ID` = original); real row `CC.FS`, K.
4. **Handedness-split example** — resolved `RESP_BAT_HAND_CD`/`RESP_PIT_HAND_CD` contributing to a specific split.
5. **Missing / incomplete `PITCH_SEQ_TX`** — empty sequence or `U`/`K` present → **fails closed** (excluded, not guessed).
6. **Unknown handedness** — hand `?` → **only the affected split** nulls; overall metrics still count.
7. **Game below the 0.90 coverage gate** — enough incomplete PAs that sequence-derived leaves degrade to null-with-reason.
8. **Samples immediately below and above the floors** — batter ~149 vs ~151 PA, pitcher ~299 vs ~301 BF,
   and hand-split 74 vs 76 PA / 149 vs 151 BF → freezes the present-vs-null boundary at each floor.

Each fixture freezes: swing/whiff/contact/foul classification, ball/called-strike counts, count
progression, two-strike detection, PA outcome, responsible-actor + handedness resolution, and the
completeness/floor verdict. Fixtures are **hand-authored representative data, not ingested** — no
network, no dataset download.

---

## 6. Flags, isolation & storage

- **New flag:** `PLATE_DISCIPLINE_NO_LOCATION_V1_ENABLED` — fail-closed affirmative parser
  (reuses the `plateHrV2CaptureFlags.ts` pattern). PR7A capture additionally requires the master
  `PLATE_HR_V2_FORWARD_CAPTURE_ENABLED`. Both default off ⇒ inert.
- **Shadow-only storage:** writes only to the existing plate-HR-V2 research tables (new
  `featureVersion` = `plate_hr_v2_features_v3`, new evidence kind). No champion, public, `scoring.ts`,
  `evaluatePlateModel.ts`, or `persisted_plays` write. No new user-reachable read path.
- **Isolation test:** grep + structural assertion that PR7A modules import no Savant/MLB-Stats data
  source and are unreachable from any champion/public entry (mirrors the mound/v2 isolation test).

---

## 7. Build order & current authorization

1. **[done]** Audit + redundancy + contract → reviewed & **approved**; architecture locked.
2. **[done]** Remove the duplicate group; commit the **synthetic raw-shape contract fixtures**; draft
   the source manifest. Fixtures marked synthetic; manifest `draft_pending_toolchain_validation`;
   2000+ floor provisional.
3. **[done — PR7A.0]** Narrow Retrosheet/Chadwick compatibility proof, run in a disposable GitHub
   Actions workflow (no production secrets, no deploy/DB/Railway/runtime/model change): pinned Chadwick
   `cwevent` 0.10.0 (`8f7e0ec`); frozen `cwevent` arguments; SHA-verified `2019eve.zip`
   (`90160a30…fe7b6e9`); real games `ANA201904040`, `ARI201908060`, `ARI201909140`, `BAL201908010`;
   actual output captured and compared against the fixtures. Evidence bundle committed under
   `docs/plate/pr7a0-proof/` (parser identity, source/output hashes, per-game CSVs, comparison,
   reviewer summary). The full archive and full-season CSV are **not** committed.
3a. **[done — PR7A.1]** Fixture + manifest reconciliation (docs-and-fixtures only): cases 02 & 03
   re-anchored to real cwevent output rows; the interruption raw shape and responsible-batter
   attribution corrected to match real output (§1.4, §5); README + this contract updated; manifest
   populated (parser version/commit, exact arguments, archive/source/output hashes, proof-run identity)
   and advanced `draft_pending_toolchain_validation → validated` **after** all 8 fixtures passed the
   revised contract comparison (`scripts/pr7a0/verifyFixtureContract.mjs`). The 2000+ floor stays
   provisional and the 2000–2025 matrix stays PENDING_MEASUREMENT.
4. **[done — PR7A.2]** Add contract types + flags + evidence kind + `licensed_source_unavailable`
   reason (+ unit tests). ADDITIVE/SHADOW, `npx tsc --noEmit` clean, no champion/public change:
   `plate_hr_v2_features_v3` (V1/V2 preserved; `PLATE_HR_V2_FEATURES_CURRENT` stays V2 — no producer
   emits V3 yet) extends `contactOpportunity`, adds a `pitcherDiscipline` group, and reshapes
   `zoneLocation` to the explicit `{ status:"unavailable", reason:"licensed_source_unavailable", … }`
   record (all location leaves typed `null`). New flag `PLATE_DISCIPLINE_NO_LOCATION_V1_ENABLED`
   (fail-closed; PR7A capture requires it AND the master flag). New `retrosheet_discipline` evidence
   kind (provider `retrosheet`, strict counts+provenance payload validator, historical point-in-time
   eligibility) in the pure `retrosheetDisciplineEvidence.ts`. Unit + structural-isolation +
   location-blindness tests: `plateHrV2FeaturesV3.test.ts`, `plateDisciplineNoLocationFlag.test.ts`,
   `retrosheetDisciplineEvidence.test.ts`, `retrosheetDisciplineIsolation.test.ts`. No adapter,
   capture wiring, ingestion, DB DDL, fitting, or champion/public change.
5. **[BLOCKED — separate authorization]** Write the Retrosheet normalization adapter against the validated fixtures (fail-closed).
6. **[BLOCKED]** Wire shadow forward-capture behind both flags; leakage + re-derivability + isolation tests.
7. **[BLOCKED]** Run the §3.6 season matrix in the authorized environment; then, only on separate
   authorization, begin model fitting.

**Still NOT authorized:** full/multi-season ingestion, the 2000–2025 matrix job, database work,
production scheduling, feature-envelope TypeScript changes, evidence-kind wiring, feature-builder
wiring, fitting, PR8, champion/public changes, location/zone proxies, `starterBullpen`. PR7A.0 is
scoped to a 1–2 game toolchain-parity proof only.

---

## 8. Reviewer decisions (LOCKED)

1. **Floors (capture-usability, not final modeling thresholds):** sequence coverage ≥ 0.90; batter
   ≥ 150 PA; pitcher ≥ 300 BF; batter hand-split ≥ 75 PA; pitcher hand-split ≥ 150 BF. Below floor ⇒
   `null` + explicit reason; **raw counts always preserved** (§3.4). Plus the **measured 2000–2025
   season matrix** (§3.6) — pending authorized-environment measurement, never fabricated.
2. **Version:** `plate_hr_v2_features_v3` — a **feature-envelope** version, not a model/champion
   version; V1/V2 readers unaffected (§3).
3. **Park/lineup/live-pitcher context:** **NOT** added to the discipline group — those stay in their
   own independently-sourced, independently as-of-validated families. PR7A builds **no** second
   historical park/lineup implementation. Historical **pitcher-discipline** priors from Retrosheet are
   allowed; current matchup/lineup/park context stays conditional on existing authorized sources.
4. **Crosswalk:** Retrosheet Play-by-Play Crosswalk (semantic authority) + pinned Chadwick `cwevent`
   (executable parser identity), frozen in the source manifest (§4.1).
5. **Attribution:** exact Retrosheet notice stored now; placements = About surface / dataset README +
   evidence-contract docs / fixture README (§4.2).
