# Research Spike #33 — Pitcher allowed-by-opposing-batting-order-slot source

**Status:** research only (no production code). **Goal:** find a real, legal, stable,
programmatic source to populate `mlbPlayerCache.pitcherOrderSplits[pitcherId].slots[1..9]`
(`PitcherOrderSplitRow`: AB, R, H, 2B, 3B, HR, RBI, BB, HBP, SO, SB, CS, AVG, OBP, SLG, OPS).

> ⚠️ **Environment caveat — live probing was blocked.** This session's egress policy
> denies all non-allowlisted outbound HTTP (statsapi.mlb.com, baseballsavant.mlb.com,
> bdfed.stitch.mlbinfra.com, baseball-reference.com, and even example.com all return
> `403 CONNECT tunnel failed`). Findings below are from prior API knowledge and MUST be
> re-verified with live probes before implementation. Each "to verify" item is flagged.

---

## Summary recommendation

**No source exposes pitcher allowed-by-opposing-batting-order-slot as a direct, ready split**
(StatsAPI doesn't; MLB.com doesn't; only Baseball-Reference/Stathead has the literal table,
and its ToS forbids automated use).

**Recommended: DERIVE it** by aggregating opponent plate appearances by lineup slot from
**MLB StatsAPI play-by-play + boxscore** (both already trusted/used in this codebase, public,
cacheable, no licensing risk). Baseball Savant is a viable alternative for the stat pull
(1 call/pitcher) but still needs StatsAPI boxscores for the slot mapping, so it adds a second
source for little gain. **Recommend the StatsAPI-only derivation.**

| Source | Direct split? | All fields? | Legal risk | Difficulty | Verdict |
|---|---|---|---|---|---|
| StatsAPI `statSplits` | ❌ no batting-order sitCode | n/a | none | low | not viable (no such split) |
| MLB.com / BDFED | ❌ (UI has no pitcher-by-opp-slot) | n/a | none | low | not viable |
| StatsAPI play-by-play (DERIVE) | ✅ derivable | ✅ (R/RBI partial; SB/CS n/a) | none | medium | **RECOMMENDED** |
| Baseball Savant (DERIVE) | ✅ derivable | ✅ minus R/RBI/SB/CS | low (public, rate-limited) | medium | viable fallback |
| Baseball-Reference / Stathead | ✅ literal table | ✅ | **high (ToS/paywall)** | n/a | reference only — do NOT scrape |

---

## 1. MLB StatsAPI — `statSplits` situational splits

- **Endpoints tested (blocked, to verify):**
  - `GET /api/v1/people/{pitcherId}/stats?stats=statSplits&group=pitching&season=2024&gameType=R`
  - `GET /api/v1/people/{pitcherId}/stats?stats=statSplits&group=pitching&sitCodes=<code>&season=2024`
  - `GET /api/v1/situationCodes` (the authoritative list of valid `sitCodes`)
  - `GET /api/v1/statTypes` (confirms `statSplits` is a valid statType)
- **Response shape (known):** `stats[0].splits[]`, each `{ split: { code, description }, stat: {...full pitching line...} }`.
- **Supports pitcher allowed-by-opposing-slot?** **No (expected).** The situational
  `sitCodes` cover handedness (`vl`/`vr`), home/away, day/night, grass/turf, RISP, count,
  outs, innings, pre/post-ASB, etc. There is **no** "opponent batting order position" code.
  The "By Batting Order" view people recognize is a **Baseball-Reference** split, not a
  StatsAPI one.
- **To verify live:** fetch `/api/v1/situationCodes` and grep for any batting-order code
  (e.g. a `description` containing "batting 1st"/"order"). Expectation: none.
- **Fields:** n/a (split doesn't exist).
- **Legal:** none (public). **Difficulty:** low. **Verdict:** not viable.

## 2. MLB.com / BDFED (`bdfed.stitch.mlbinfra.com`, statsapi-backed)

- **Endpoint tested (blocked, to verify):** `GET https://bdfed.stitch.mlbinfra.com/bdfed/stats/player?...&group=pitching&stats=statSplits...`
- BDFED is the backing service for MLB.com stats tables; its split data comes from the same
  StatsAPI `statSplits` engine. MLB.com's player **Splits** tab shows "By Batting Order" only
  for **batters** (a hitter's own slot) — not a pitcher's allowed line by opposing slot.
- **Supports it?** **No (expected).** A UI filter would still resolve to a StatsAPI sitCode,
  which doesn't exist for this split.
- **Legal:** none. **Difficulty:** low. **Verdict:** not viable.

## 3. Baseball Savant / Statcast — DERIVE from play rows

- **Endpoint tested (blocked, to verify):** `GET https://baseballsavant.mlb.com/statcast_search/csv?player_type=pitcher&hfSea=2024|&pitchers_lookup[]={id}&type=details&min_pa=1&group_by=name`
- **Response shape (known):** one row per pitch; fields include `pitcher`, `batter`,
  `game_pk`, `at_bat_number`, `inning`, `events` (PA result: `single|double|triple|home_run|walk|strikeout|hit_by_pitch|field_out|...`), `description`, `launch_speed`, `stand`, etc.
- **Critical gap:** the CSV has **no lineup-slot field**. The opposing batter's batting-order
  slot must be derived per game from the **boxscore** (`liveData.boxscore.teams[side].battingOrder`)
  or play-by-play — i.e. Savant gives the outcomes, StatsAPI gives the slot.
- **Derivation:** filter to PA-terminating rows for the pitcher → for each `(game_pk, batter)`
  map batter→slot via that game's boxscore battingOrder → bucket events into AB/H/2B/3B/HR/BB/
  HBP/SO by slot → compute AVG/OBP/SLG/OPS. **R, RBI not present** at pitch level; **SB/CS not
  present** (both are fine — the scorer ignores SB/CS and treats R/RBI as low support).
- **Cost:** 1 Savant CSV per pitcher (efficient) + boxscore per distinct game (cacheable,
  shared across pitchers). **Legal:** public data; Savant rate-limits heavy scraping (we already
  use it for batter power, so it's an accepted dependency). **Difficulty:** medium.
  **Verdict:** viable fallback — but needs StatsAPI boxscores anyway, so no advantage over §4.

## 4. MLB StatsAPI play-by-play — DERIVE (RECOMMENDED)

- **Endpoints (blocked, to verify):**
  - Pitcher's games: `GET /api/v1/people/{id}/stats?stats=gameLog&group=pitching&season=2024` → list of `game_pk`.
  - Per game: `GET /api/v1.1/game/{gamePk}/feed/live` (or `/api/v1/game/{gamePk}/playByPlay`) →
    `liveData.plays.allPlays[]` with `matchup.batter.id`, `matchup.pitcher.id`, `result.eventType`,
    plus `liveData.boxscore.teams[side].battingOrder` for slot mapping.
- **Derivation:** for each game the pitcher appeared in → for each play where
  `matchup.pitcher.id == pitcherId` → map `matchup.batter.id` → slot via boxscore → aggregate
  `result.eventType` into AB/H/2B/3B/HR/BB/HBP/SO (+ RBI from `result.rbi`) by slot → compute
  AVG/OBP/SLG/OPS.
- **Fields:** AB, H, 2B, 3B, HR, BB, HBP, SO, AVG, OBP, SLG, OPS ✅; RBI ✅ (`result.rbi`);
  R derivable from scoring events (messy, low value); SB/CS n/a (ignored by scorer). **Full
  coverage of every field the scorer actually uses.**
- **Why preferred:** single source we already trust and call (`updateStartingLineups`,
  `syncWeather` hit the same `feed/live`); zero new licensing surface; fully cacheable.
- **Cost:** ~15–32 games × (1 feed/live) per probable pitcher. With ~15–30 probables/day,
  that's bounded and cache-friendly (24h TTL keyed by pitcherId; boxscore/feed cached per
  gamePk and reused). Best run as an **incremental season aggregate** (append new games)
  rather than a full re-pull each build. **Difficulty:** medium. **Verdict:** **RECOMMENDED.**

## 5. Baseball-Reference / Stathead

- **The literal table exists** (BBRef Pitching Splits → "Opp Batting Order Position": AB, R, H,
  2B, 3B, HR, RBI, BB, HBP, SO, SB, CS, AVG, OBP, SLG, OPS — matches our field set exactly; this
  is almost certainly the origin of the Tanner Bibee table in the bug report).
- **Legal:** BBRef/Stathead **ToS prohibits scraping/automated access**; the split-builder is a
  **paid Stathead** feature. **Do NOT build a production scraper.**
- **Verdict:** **reference/comparison only** — use to validate the derived numbers during
  development, never as a runtime source.

---

## Recommended implementation (for the #33 Phase-2 PR — not this spike)

Derive from StatsAPI play-by-play + boxscore; populate the existing cache the merged scorer
already consumes. No scoring changes (PR #32 owns the scorer/gate/tests).

1. `syncPitcherOrderSplits(pitcherId, season)` in `dataPullService.ts`:
   - resolve the pitcher's `game_pk` list (pitching `gameLog`);
   - for each game (cache per gamePk; skip already-aggregated games via an incremental store),
     pull `feed/live`, map opposing batters → slot via `battingOrder`, bucket `result.eventType`
     by slot;
   - write `mlbPlayerCache.pitcherOrderSplits[pitcherId] = { slots: {1..9: PitcherOrderSplitRow}, fetchedAt }`;
   - guarded (try/catch, no-op on failure) + 24h TTL → layer stays `unavailable` on any error.
2. Call it in `buildPregamePowerRadar.ts` next to the other syncs (scorer already reads the cache).
3. Validate against the existing `pitcherOrderSplit.test.ts` Bibee fixtures (#1/#2 vulnerable,
   #5 suppressive), and spot-check derived AB/HR/SLG/OPS against BBRef by hand (reference only).

**Performance guardrails:** incremental per-game aggregation, per-gamePk boxscore cache shared
across pitchers, only fetch for today's probables, 24h TTL, hard cap on games/pitcher.

**If live re-verification shows StatsAPI play-by-play is unavailable or too costly:** fall back
to the Savant-CSV + StatsAPI-boxscore hybrid (§3). **If both are blocked/over-budget:** leave the
layer `unavailable` (the model already handles this honestly) and revisit.

## Open items to verify live (when network is available)
- [ ] `/api/v1/situationCodes` — confirm no batting-order sitCode exists.
- [ ] `feed/live` `allPlays[].result` field names for 2B/3B/HBP/SO/RBI mapping.
- [ ] Real request volume/latency for a full slate of probables; tune TTL/incremental store.
- [ ] Spot-check derived Bibee #1/#2/#5 lines vs the BBRef reference table.
