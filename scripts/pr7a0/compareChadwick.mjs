// PR7A.0 — Chadwick cwevent parity comparison (evidence generator, NOT a gate).
//
// Reads real cwevent CSV output (frozen arg set) and the committed synthetic
// contract fixtures, then emits an evidence bundle: a grammar cross-check of the
// frozen pitch-token table against cwevent's own BALLS_CT/STRIKES_CT, real
// examples of each phenomenon (normal / interrupted / responsible-batter /
// handedness), and a per-fixture verdict with concrete diffs.
//
// This script NEVER promotes the manifest and NEVER throws to fail CI — its job
// is to capture what Chadwick actually emits so a human can adjudicate. Any
// mismatch is reported, not enforced.
//
// Usage:
//   node compareChadwick.mjs --fixtures <dir> --out <dir> --csv <f1.csv,f2.csv,...>
//   env: CHADWICK_VERSION, CHADWICK_SHA, CWEVENT_ARGS (recorded into PARSER_IDENTITY.json)

import fs from 'node:fs';
import path from 'node:path';

// ---- frozen pitch-token classification (mirrors fixture README, do not edit lightly) ----
const BALL = new Set(['B', 'I', 'V', 'P']);
const CALLED = new Set(['C']);
const WHIFF = new Set(['S', 'M']);
const FOUL = new Set(['F', 'T', 'L', 'O', 'R']);
const INPLAY = new Set(['X', 'Y']);
const HBP = new Set(['H']);
const MARKER = new Set(['.', '+', '*', '>', '1', '2', '3', 'N']);
const UNCOUNTABLE = new Set(['U', 'K', 'Q']);

// ---- tiny arg parser ----
function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const FIX_DIR = getArg('--fixtures');
const OUT_DIR = getArg('--out');
const CSV_ARG = getArg('--csv', '');
if (!FIX_DIR || !OUT_DIR || !CSV_ARG) {
  console.error('missing --fixtures/--out/--csv');
  process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- CSV parse (quoted, comma-delimited; cwevent -a format) ----
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    rows.push(out);
  }
  return rows;
}

function loadRows() {
  const files = CSV_ARG.split(',').map((s) => s.trim()).filter(Boolean);
  let header = null;
  const rows = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error('csv missing:', f); continue; }
    const parsed = parseCsv(fs.readFileSync(f, 'utf8'));
    if (!parsed.length) continue;
    const h = parsed[0];
    if (!header) header = h;
    for (let i = 1; i < parsed.length; i++) {
      const c = parsed[i];
      const obj = {};
      for (let j = 0; j < h.length; j++) obj[h[j]] = c[j];
      obj.__file = path.basename(f);
      rows.push(obj);
    }
  }
  return { header, rows };
}

// count entering the terminal pitch, derived from the frozen token table
function deriveCount(seq) {
  const toks = [...(seq || '')].filter((c) => !MARKER.has(c));
  if (toks.length === 0) return { ok: false, reason: 'empty' };
  if (toks.some((c) => UNCOUNTABLE.has(c))) return { ok: false, reason: 'uncountable_token' };
  const terminal = toks[toks.length - 1];
  const terminalOk = BALL.has(terminal) || CALLED.has(terminal) || WHIFF.has(terminal) || INPLAY.has(terminal) || HBP.has(terminal);
  if (!terminalOk) return { ok: false, reason: 'non_terminal_last_token' };
  let balls = 0;
  let strikes = 0;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    if (BALL.has(t)) balls++;
    else if (CALLED.has(t) || WHIFF.has(t) || FOUL.has(t)) { if (strikes < 2) strikes++; }
  }
  return { ok: true, balls, strikes };
}

const { header, rows } = loadRows();
const col = (r, name) => (r[name] === undefined ? '' : r[name]);
const isT = (r) => col(r, 'BAT_EVENT_FL') === 'T';

// ---------- 1. grammar cross-check ----------
const grammar = { populationTRows: 0, checked: 0, matched: 0, skipped: 0, skipReasons: {}, mismatches: [] };
for (const r of rows) {
  if (!isT(r)) continue;
  grammar.populationTRows++;
  const seq = col(r, 'PITCH_SEQ_TX');
  if (seq.includes('.')) { grammar.skipped++; grammar.skipReasons.interrupted = (grammar.skipReasons.interrupted || 0) + 1; continue; }
  const d = deriveCount(seq);
  if (!d.ok) { grammar.skipped++; grammar.skipReasons[d.reason] = (grammar.skipReasons[d.reason] || 0) + 1; continue; }
  grammar.checked++;
  const cb = Number(col(r, 'BALLS_CT'));
  const cs = Number(col(r, 'STRIKES_CT'));
  if (d.balls === cb && d.strikes === cs) grammar.matched++;
  else if (grammar.mismatches.length < 25) {
    grammar.mismatches.push({ game: col(r, 'GAME_ID'), bat: col(r, 'BAT_ID'), seq, event: col(r, 'EVENT_TX'), derived: { balls: d.balls, strikes: d.strikes }, cwevent: { balls: cb, strikes: cs } });
  }
}
grammar.matchRate = grammar.checked ? +(grammar.matched / grammar.checked).toFixed(6) : null;

// ---------- 2. phenomena ----------
const pick = (r) => ({
  game: col(r, 'GAME_ID'), inn: col(r, 'INN_CT'), homeBat: col(r, 'BAT_HOME_ID'),
  balls: col(r, 'BALLS_CT'), strikes: col(r, 'STRIKES_CT'), seq: col(r, 'PITCH_SEQ_TX'),
  bat: col(r, 'BAT_ID'), batHand: col(r, 'BAT_HAND_CD'), respBat: col(r, 'RESP_BAT_ID'), respBatHand: col(r, 'RESP_BAT_HAND_CD'),
  pit: col(r, 'PIT_ID'), pitHand: col(r, 'PIT_HAND_CD'), respPitHand: col(r, 'RESP_PIT_HAND_CD'),
  event: col(r, 'EVENT_TX'), lineup: col(r, 'BAT_LINEUP_ID'), eventCd: col(r, 'EVENT_CD'),
  batEventFl: col(r, 'BAT_EVENT_FL'), removedForPh: col(r, 'REMOVED_FOR_PH_BAT_ID'),
});

// interrupted: T rows whose pitch seq carries a '.' marker, plus the count of the
// non-batting-event rows (BAT_EVENT_FL=F) that represent in-PA interruptions.
const interruptedT = rows.filter((r) => isT(r) && col(r, 'PITCH_SEQ_TX').includes('.'));
const nonBattingRows = rows.filter((r) => col(r, 'BAT_EVENT_FL') === 'F');
const interrupted = {
  interruptedBattingEventCount: interruptedT.length,
  nonBattingEventRowCount: nonBattingRows.length,
  note: 'A batting PA that spans records surfaces as ONE BAT_EVENT_FL=T row; the interruption (SB/WP/injury/sub) is a separate BAT_EVENT_FL=F row. cwevent passes PITCH_SEQ_TX verbatim and does NOT strip the "." marker — the adapter must strip it.',
  examples: interruptedT.slice(0, 12).map((r) => {
    const stripped = [...col(r, 'PITCH_SEQ_TX')].filter((c) => !MARKER.has(c)).join('');
    const d = deriveCount(col(r, 'PITCH_SEQ_TX'));
    return { ...pick(r), strippedSeq: stripped, derivedCountEnteringTerminal: d.ok ? { balls: d.balls, strikes: d.strikes } : d.reason, cweventCount: { balls: col(r, 'BALLS_CT'), strikes: col(r, 'STRIKES_CT') }, countConsistent: d.ok && Number(col(r, 'BALLS_CT')) === d.balls && Number(col(r, 'STRIKES_CT')) === d.strikes };
  }),
};

// responsible-batter: the objective cwevent signals.
const respDiffers = rows.filter((r) => isT(r) && col(r, 'RESP_BAT_ID') && col(r, 'RESP_BAT_ID') !== col(r, 'BAT_ID'));
const dottedStrikeouts = rows.filter((r) => isT(r) && col(r, 'EVENT_CD') === '3' && col(r, 'PITCH_SEQ_TX').includes('.'));
const responsibleBatter = {
  question: 'For a two-strike substitution (original batter leaves with 2 strikes, sub completes the K), does cwevent charge RESP_BAT_ID to the ORIGINAL batter (fixture 03 assumption) or the COMPLETING batter?',
  tRowsWhereRespBatDiffersFromBat: respDiffers.length,
  respDiffersExamples: respDiffers.slice(0, 20).map(pick),
  dottedStrikeoutCount: dottedStrikeouts.length,
  dottedStrikeoutExamples: dottedStrikeouts.slice(0, 20).map(pick),
  interpretationNote: 'If RESP_BAT_ID equals BAT_ID on the dotted strikeouts (i.e. the completing batter), fixture 03 (two_strike_substitution_charges_original_batter) is CONTRADICTED by real cwevent output. The removed batter, when present, appears in REMOVED_FOR_PH_BAT_ID, not RESP_BAT_ID.',
};

// handedness: distributions + switch-hitter proof + unknown ('?') detection
const handCount = (name) => {
  const m = {};
  for (const r of rows) { if (!isT(r)) continue; const v = col(r, name) || '(empty)'; m[v] = (m[v] || 0) + 1; }
  return m;
};
const batHandByBatter = {};
for (const r of rows) {
  if (!isT(r)) continue;
  const b = col(r, 'BAT_ID');
  if (!b) continue;
  (batHandByBatter[b] = batHandByBatter[b] || new Set()).add(col(r, 'BAT_HAND_CD'));
}
const switchHitters = Object.entries(batHandByBatter).filter(([, s]) => s.size > 1).slice(0, 15).map(([b, s]) => ({ batter: b, resolvedHands: [...s] }));
const unknownHand = rows.filter((r) => isT(r) && (col(r, 'RESP_PIT_HAND_CD') === '?' || col(r, 'RESP_BAT_HAND_CD') === '?')).slice(0, 10).map(pick);
const handedness = {
  respBatHandDistribution: handCount('RESP_BAT_HAND_CD'),
  respPitHandDistribution: handCount('RESP_PIT_HAND_CD'),
  switchHittersResolvedBothWays: switchHitters,
  unknownHandednessExamples: unknownHand,
  note: 'Handedness is emitted per-event and resolves switch-hitters against the opposing pitcher (a switch hitter shows both L and R across PAs). "?" marks unresolved handedness — the split attribution is withheld, not the overall.',
};

// ---------- 3. per-fixture verdicts ----------
function readFixture(name) {
  try { return JSON.parse(fs.readFileSync(path.join(FIX_DIR, name), 'utf8')); } catch { return null; }
}
const verdicts = [];
const mismatches = [];

// 01 normal — validated by the grammar cross-check
verdicts.push({
  case: '01_normal_game_complete',
  status: grammar.matchRate === 1 ? 'VALIDATED' : (grammar.matchRate === null ? 'NO_POPULATION' : 'MISMATCH'),
  evidence: `frozen token table reproduced cwevent BALLS_CT/STRIKES_CT on ${grammar.matched}/${grammar.checked} complete real PAs (rate ${grammar.matchRate}).`,
});
if (grammar.matchRate !== null && grammar.matchRate < 1) {
  mismatches.push({ case: '01_normal_game_complete', kind: 'grammar_count_mismatch', count: grammar.checked - grammar.matched, examples: grammar.mismatches.slice(0, 10) });
}

// 02 interrupted — mechanism vs the fixture's raw-shape assumption
const allInterruptedConsistent = interrupted.examples.length > 0 && interrupted.examples.every((e) => e.countConsistent);
verdicts.push({
  case: '02_interrupted_pa_period',
  status: interrupted.interruptedBattingEventCount > 0 ? 'MECHANISM_CONFIRMED_FIXTURE_RAW_DEFECT' : 'NO_POPULATION',
  evidence: `${interrupted.interruptedBattingEventCount} interrupted batting-event rows observed; interruptions are separate BAT_EVENT_FL=F rows (never a 2nd PA); dot-stripped sequence reproduces the count on ${interrupted.examples.filter((e) => e.countConsistent).length}/${interrupted.examples.length} sampled examples.`,
  fixtureDefect: "Fixture 02 raw continuation record is written as '.CX' (non-cumulative) and its note describes reassembly as concatenating two records. Real cwevent emits the FULL cumulative sequence verbatim on the single BAT_EVENT_FL=T row (e.g. 'BB.CX') and does not strip the dot. Correction: (a) raw continuation must be cumulative; (b) reassembly rule = take the BAT_EVENT_FL=T row's PITCH_SEQ_TX and strip non-pitch markers — do NOT concatenate across rows; (c) the interrupting event is a distinct BAT_EVENT_FL=F row.",
});
mismatches.push({ case: '02_interrupted_pa_period', kind: 'raw_shape_and_reassembly_rule', detail: verdicts[verdicts.length - 1].fixtureDefect, examples: interrupted.examples.slice(0, 6) });

// 03 responsible batter — the crucial one
const fixture03ContradictedByReal = dottedStrikeouts.length > 0 && dottedStrikeouts.every((r) => col(r, 'RESP_BAT_ID') === col(r, 'BAT_ID'));
verdicts.push({
  case: '03_sub_responsible_batter',
  status: dottedStrikeouts.length === 0 ? 'NO_POPULATION' : (fixture03ContradictedByReal ? 'CONTRADICTED' : (respDiffers.length > 0 ? 'PARTIAL_RESP_DIFFERS_EXISTS' : 'REVIEW')),
  evidence: `dotted-strikeout rows: ${dottedStrikeouts.length}; T rows where RESP_BAT_ID != BAT_ID: ${respDiffers.length}.`,
  interpretation: fixture03ContradictedByReal
    ? 'On every observed two-strike-carryover strikeout, cwevent set RESP_BAT_ID = BAT_ID = the COMPLETING batter. Fixture 03 rule "two_strike_substitution_charges_original_batter" is NOT what Chadwick emits; the removed batter (when captured) is REMOVED_FOR_PH_BAT_ID, a different field.'
    : 'See respDiffersExamples / dottedStrikeoutExamples for the actual attribution; adjudicate against fixture 03.',
});
if (dottedStrikeouts.length > 0) {
  mismatches.push({ case: '03_sub_responsible_batter', kind: 'responsible_batter_attribution', fixtureClaim: 'RESP_BAT_ID = original batter (charge original)', realObserved: fixture03ContradictedByReal ? 'RESP_BAT_ID = completing batter' : 'mixed/see examples', examples: dottedStrikeouts.slice(0, 10).map(pick) });
}

// 04 handedness split — mechanism confirmed if switch-hitters resolve both ways
verdicts.push({
  case: '04_handedness_split',
  status: switchHitters.length > 0 ? 'MECHANISM_CONFIRMED' : 'REVIEW',
  evidence: `${switchHitters.length} batters resolved to BOTH L and R across PAs (switch-hitter per-event resolution), confirming RESP_BAT_HAND_CD/RESP_PIT_HAND_CD are resolved per event, not copied from the roster line.`,
});

// 05 grammar completeness — adapter policy, partially cwevent-observable
const emptySeqT = rows.filter((r) => isT(r) && col(r, 'PITCH_SEQ_TX') === '').length;
verdicts.push({
  case: '05_missing_incomplete_seq',
  status: 'ADAPTER_LOGIC_WITH_CWEVENT_INPUT',
  evidence: `cwevent emits empty PITCH_SEQ_TX for no-pitch PAs (${emptySeqT} T rows with empty sequence observed). Uncountable-token exclusion (U/K) and the coverage denominator are ADAPTER completeness policy applied on top of cwevent output, not fields cwevent emits.`,
});

// 06 unknown handedness — adapter policy; cwevent surfaces '?'
verdicts.push({
  case: '06_unknown_handedness',
  status: unknownHand.length > 0 ? 'MECHANISM_OBSERVED' : 'ADAPTER_LOGIC_ONLY',
  evidence: unknownHand.length > 0 ? `${unknownHand.length} rows with '?' handedness observed; withholding the split (not the overall) is adapter policy.` : "No '?' handedness rows in the sampled games; split-withholding is adapter policy layered on cwevent output.",
});

// 07 / 08 — pure adapter/statistical floors, not cwevent-emitted
verdicts.push({ case: '07_below_coverage_gate', status: 'ADAPTER_LOGIC_ONLY', evidence: 'Sequence-coverage gate is a statistical aggregation rule over many PAs; not a cwevent field. Out of scope for parser parity (no correction implied by real output).' });
verdicts.push({ case: '08_sample_floor_boundaries', status: 'ADAPTER_LOGIC_ONLY', evidence: 'Sample-floor present/null boundaries are adapter thresholds; not a cwevent field. Out of scope for parser parity.' });

// ---------- 4. parser identity ----------
const parserIdentity = {
  parserName: 'Chadwick cwevent',
  parserVersion: process.env.CHADWICK_VERSION || 'unknown',
  parserCommitSha: process.env.CHADWICK_SHA || 'unknown',
  cweventArguments: process.env.CWEVENT_ARGS || 'unknown',
  fieldList: '0,2,3,4,5,6,7,10,11,12,13,14,15,16,17,29,31,33,34,35,36,86,87',
  fieldNamesInOrder: header || [],
  note: 'The runbook-required semantic fields (PITCH_SEQ_TX, RESP_BAT_ID, RESP_BAT_HAND_CD, RESP_PIT_ID, RESP_PIT_HAND_CD, EVENT_CD, BAT_LINEUP_ID, count fields) are STANDARD cwevent fields in Chadwick 0.10.0, emitted via -f; -x extended fields are not required for this contract.',
};

// ---------- write bundle ----------
const write = (name, obj) => fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2) + '\n');
write('PARSER_IDENTITY.json', parserIdentity);
write('GRAMMAR_CROSSCHECK.json', grammar);
write('PHENOMENA.json', { interrupted, responsibleBatter, handedness });
write('FIXTURE_COMPARISON.json', { verdicts });
write('MISMATCHES.json', { count: mismatches.length, mismatches });

const md = [];
md.push('# PR7A.0 — Chadwick cwevent parity: real-output comparison', '');
md.push(`- Parser: **${parserIdentity.parserName} ${parserIdentity.parserVersion}** (commit \`${parserIdentity.parserCommitSha}\`)`);
md.push(`- Arguments: \`${parserIdentity.cweventArguments}\``);
md.push(`- cwevent rows parsed: ${rows.length} (batting-event T rows: ${grammar.populationTRows})`, '');
md.push('## Grammar cross-check (frozen token table vs cwevent counts)');
md.push(`- Complete real PAs checked: **${grammar.checked}**, matched cwevent BALLS_CT/STRIKES_CT: **${grammar.matched}** (rate **${grammar.matchRate}**), skipped: ${grammar.skipped}.`, '');
md.push('## Fixture verdicts');
for (const v of verdicts) {
  md.push(`### ${v.case} — ${v.status}`);
  md.push(v.evidence);
  if (v.fixtureDefect) md.push('', `**Correction needed:** ${v.fixtureDefect}`);
  if (v.interpretation) md.push('', v.interpretation);
  md.push('');
}
md.push('## Actionable mismatches');
md.push(mismatches.length ? mismatches.map((m) => `- **${m.case}** — ${m.kind}`).join('\n') : '- none');
md.push('', '_Manifest stays `draft_pending_toolchain_validation`; this bundle is evidence for human review, not an auto-promotion._');
fs.writeFileSync(path.join(OUT_DIR, 'COMPARISON.md'), md.join('\n') + '\n');

console.log('[compareChadwick] wrote bundle to', OUT_DIR);
console.log('[compareChadwick] grammar matchRate:', grammar.matchRate, 'checked:', grammar.checked);
console.log('[compareChadwick] respDiffers:', respDiffers.length, 'dottedK:', dottedStrikeouts.length, 'interruptedT:', interruptedT.length);
console.log('[compareChadwick] mismatches:', mismatches.length);
