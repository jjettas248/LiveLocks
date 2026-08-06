# PR7A — Zone-Independent Plate-Discipline Upgrade (`plateDisciplineNoLocationV1`)

> **Status: PROPOSAL FOR REVIEW. No model fitting, no adapter, no fixtures written yet.**
> Per the locked ordering, this document (the Retrosheet field-availability audit + the
> proposed feature contract) is produced **first** and must be reviewed before any fixtures,
> adapter, or fitting work begins. This is a design artifact only — it changes no runtime code.

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

---

## 2. Scope boundary (what PR7A is and is not)

- **Is:** a shadow, flag-gated, Retrosheet-sourced **plate-discipline prior** feature group
  (`plateDisciplineNoLocationV1`) — pre-contact approach metrics, hand-split, plus a matching
  pitcher-discipline sub-block, with strict provenance and fail-closed derivation.
- **Is not:** any location/zone signal (preserved unavailable), any pitch-type signal (Retrosheet
  lacks it), any contact-quality signal (Statcast), any `starterBullpen` use (excluded), and any
  change to champion/public/`scoring.ts`/`evaluatePlateModel.ts`.

Structural isolation (to be enforced by a grep + test-time check, mirroring the mound/v2 pattern):
new PR7A files import **no** Savant/MLB-Stats data-source module and are imported by **no** champion
or public path. Capture writes only to the shadow research store.

---

## 3. Proposed feature contract — `plateDisciplineNoLocationV1`

New **feature group**, additive to the V2 vector as a **new version** `plate_hr_v2_features_v3`
(V1/V2 preserved unchanged; a single version never represents two shapes — same discipline as the
existing V1→V2 addition). Group key: `plateDisciplineNoLocation`. Every leaf is
`z.number().nullable()` and **required** (missing ⇒ explicit `null`, never a dropped key), `.strict()`,
with an `extra: z.record(z.string(), z.number().nullable())` escape hatch. Sample counts are
first-class leaves so shrinkage never borrows a wrong denominator. **No forbidden names appear.**

### 3.1 Batter discipline (Retrosheet history, as-of cutoff)

```
kRatePct                    // K / PA
bbRatePct                   // (BB − IBB) / PA   (unintentional walks)
ibbRatePct                  // IBB / PA
hbpRatePct                  // HBP / PA
ballInPlayPerPaPct          // (X + Y) terminal / PA
swingRatePct                // swings / pitches
contactPerSwingPct          // contact swings / swings
whiffPerSwingPct            // whiff swings / swings
foulPerSwingPct             // foul (F/T/L/O/R) / swings
calledStrikeRatePct         // C / taken pitches      (location-free discipline proxy)
firstPitchSwingRatePct      // swing on pitch 1 / PA
avgPitchesPerPa             // pitch count / PA
threeBallReachedRatePct     // PAs reaching a 3-ball count / PA   (count progression)
twoStrikeReachedRatePct     // PAs reaching 2 strikes / PA        (count progression)
twoStrikeKRatePct           // K | reached 2 strikes
twoStrikeContactPerSwingPct // contact/swing | 2-strike counts    (two-strike approach)
twoStrikeSurvivalRatePct    // (reached 2 strikes, did NOT strike out) / reached 2 strikes
// samples
paSample
pitchSample
swingSample
twoStrikePaSample
```

### 3.2 Batter hand-splits (top-line only, to bound cardinality)

```
kRatePctVsL, kRatePctVsR
bbRatePctVsL, bbRatePctVsR
contactPerSwingPctVsL, contactPerSwingPctVsR
whiffPerSwingPctVsL, whiffPerSwingPctVsR
paSampleVsL, paSampleVsR
```

### 3.3 Pitcher discipline sub-block (conditional on pitcher known)

```
pitcherKnown                // boolean (z.boolean())
pitcherKRatePct
pitcherBbRatePct            // unintentional
pitcherWhiffPerSwingPct
pitcherCalledStrikeRatePct
pitcherFirstPitchStrikeSeenRatePct   // C/S/F/T/X on pitch 1 / PA  (location-free "strike seen")
pitcherKRatePctVsHand       // vs this batter's hand
pitcherBbRatePctVsHand
pitcherBfSample
pitcherBfSampleVsHand
```

### 3.4 Data-quality block (PR7A-specific)

```
retrosheetDatasetVersion    // string — release tag / content hash of the loaded dataset
dataThroughDate             // ISO date — last game date covered by the aggregate
pitchSequenceCoveragePct    // share of window PAs that are sequence-complete (§1.4)
sequenceFloorMet            // boolean — coveragePct ≥ floor (0.90 proposed)
overallQuality              // "full" | "degraded" | "missing"
```

### 3.5 `zoneLocationV1` — preserved as UNAVAILABLE

PR7A **formalizes** the location group's unavailability (today it is silently stripped). The
contract declares a stable availability record:

```
zoneLocationV1: { available: false, reason: "licensed_source_unavailable" }
```

- Added to the availability/`missingInputs` vector for every PR7A snapshot.
- The existing `zoneLocation` derived group stays all-null and stripped from the authorized
  projection (unchanged). No PR7A code reads, derives, or proxies any location field.
- New reason enum value **`licensed_source_unavailable`** added alongside the existing reasons.

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

---

## 5. Fixtures to freeze BEFORE the adapter (requirement 6)

The adapter is **not** written until these representative Retrosheet normalization fixtures are
frozen with expected normalized output. Proposed fixture set (raw `cwevent`/`PITCH_SEQ_TX` rows →
expected parsed PA):

1. Clean strikeout (`CCS`), clean walk (`BBBB`), unintentional vs intentional walk (`IIII` / `V`).
2. HBP (`H`), ball-in-play single (`BX`), foul-heavy AB (`CFFFFX`).
3. Two-strike foul-off then K (`CSFFFS`) vs two-strike foul-off then in-play → **survival** (`CSFFX`).
4. Switch-hitter PA (verifies `RESP_BAT_HAND_CD` vs roster `bats`).
5. Non-pitch markers in sequence: pickoff throws + steal (`CB1.FX`, `>`, `+`, `*`) → correctly stripped.
6. **Uncountable:** `U`/`K` present, and an empty/missing sequence → **fail sequence-complete** (excluded, not guessed).
7. Pitchout swing/contact (`P`, `Q`, `R`, `Y`).
8. A `cwgame` record → park ID + starting lineup slot (context crosswalk).
9. Retrosheet-parkID → LiveLocks venue crosswalk fixture; RetrosheetID → roster crosswalk fixture.

Each fixture freezes: swing/whiff/contact/foul classification, ball/called-strike counts, count
progression, two-strike detection, PA outcome, and completeness verdict.

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

## 7. Proposed build order (AFTER this contract is reviewed)

1. **[this doc]** Audit + contract → **review gate**.
2. Freeze §5 fixtures (no adapter yet).
3. Add contract types + flags + evidence kind + `licensed_source_unavailable` reason (+ unit tests).
4. Write the Retrosheet normalization adapter **against the frozen fixtures** (fail-closed).
5. Wire shadow forward-capture behind both flags; leakage + re-derivability + isolation tests.
6. **Only then**, and only on separate authorization, begin model fitting.

**Not in PR7A:** any location/zone feature, any pitch-type feature, `starterBullpen`, champion or
public change, and (until step 6 is separately authorized) any fitting.

---

## 8. Open questions for the reviewer

1. **Coverage floor** — is `0.90` sequence-completeness (and a minimum `paSample`, proposed 150 PA
   for a stable discipline prior) the right bar, or stricter?
2. **New feature version** — confirm PR7A lands as `plate_hr_v2_features_v3` inside the existing V2
   vector (chosen for storage reuse), rather than a wholly separate table.
3. **Live-serving context (§1.3)** — confirm park/lineup/opposing-pitcher context stays CONDITIONAL
   (default-unavailable live) so PR7A's live path ingests nothing forbidden; or specify an
   already-authorized non-forbidden context source.
4. **Retrosheet ID/park crosswalks** — confirm the authorized source of the RetrosheetID→roster and
   parkID→venue crosswalks (frozen fixtures) so even the crosswalk carries provenance.
5. **Attribution** — confirm the exact Retrosheet notice string to store in provenance now (for the
   eventual public-promotion obligation).
