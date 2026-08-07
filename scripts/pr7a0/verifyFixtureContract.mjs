// PR7A.1 — revised contract comparison (offline verifier, NOT wired into runtime).
//
// Validates EVERY declared expectation in the retrosheetDiscipline fixtures, cross-checks
// the real-anchored cases against the committed PR7A.0 proof CSVs, and verifies the
// content-addressed provenance (SHA-256 of every committed proof CSV + parser identity)
// that backs SOURCE_MANIFEST.status = "validated".
//
// Coverage:
//   PER-PA        : discipline fields recomputed from the frozen token table
//                   (balls/calledStrikes/swingingStrikes/fouls/inPlay/takenPitches/swings,
//                    contacts=fouls+inPlay, entering count, firstPitchStrike, reachedTwoStrikes).
//   AGGREGATES    : case 01/02 batterAggregate totals + rates recomputed from the PAs.
//   CASE 04       : resolved handedness + both batter/pitcher split buckets.
//   CASE 05       : PA + coded-pitch denominators, aggregate coverage, fail-closed null leaves,
//                   per-PA completeness reason / counts flags / uncountable tokens.
//   CASE 06       : overall inclusion + split withholding + unknown-handedness consistency.
//   CASE 07       : outcome-only rate values, null sequence leaves, null reason, raw counts.
//   CASE 08       : batter/pitcher OVERALL and HAND-SPLIT floor boundaries, present flags, null reasons.
//   REAL X-CHECK  : cases 02/03 terminal record matched field-for-field to the proof CSV row.
//   PROVENANCE    : every committed proof CSV SHA-256 == manifest + SOURCE_PROVENANCE + fixture-declared;
//                   event-file + archive hashes cross-agree; parser version/commit/args/fieldList
//                   match PARSER_IDENTITY.json. Gates status="validated".
//
// Exits non-zero if ANY case or the provenance section fails. No network, no ingestion, no DB,
// imports zero project code.
//
// Usage: node scripts/pr7a0/verifyFixtureContract.mjs \
//          --fixtures server/mlb/pregamePowerRadar/hrProbabilityV2/fixtures/retrosheetDiscipline \
//          --proof docs/plate/pr7a0-proof [--out <result.json>]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---- frozen pitch-token classification (mirrors fixture README) ----
const BALL = new Set(['B', 'I', 'V', 'P']);
const CALLED = new Set(['C']);
const WHIFF = new Set(['S', 'M']);
const FOUL = new Set(['F', 'T', 'L', 'O', 'R']);
const INPLAY = new Set(['X', 'Y']);
const HBP = new Set(['H']);
const MARKER = new Set(['.', '+', '*', '>', '1', '2', '3', 'N']);
const UNCOUNTABLE = new Set(['U', 'K', 'Q']);

function getArg(name, fb = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fb;
}
const FIX_DIR = getArg('--fixtures');
const PROOF_DIR = getArg('--proof');
const OUT = getArg('--out');
if (!FIX_DIR || !PROOF_DIR) { console.error('missing --fixtures/--proof'); process.exit(2); }

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const strip = (seq) => [...(seq || '')].filter((c) => !MARKER.has(c));
const eq = (a, b) => String(a) === String(b);
const near = (a, b, t = 1e-6) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= t;

// per-case accumulator
function mk(caseId, realAnchored) { return { case: caseId, realAnchored: !!realAnchored, checks: 0, problems: [] }; }
function assert(acc, cond, msg) { acc.checks++; if (!cond) acc.problems.push(msg); }

// recompute discipline stats from a marker-stripped pitch-token list
function classify(tokens) {
  let balls = 0, calledStrikes = 0, swingingStrikes = 0, fouls = 0, inPlay = 0, hbp = 0;
  for (const t of tokens) {
    if (BALL.has(t)) balls++;
    else if (CALLED.has(t)) calledStrikes++;
    else if (WHIFF.has(t)) swingingStrikes++;
    else if (FOUL.has(t)) fouls++;
    else if (INPLAY.has(t)) inPlay++;
    else if (HBP.has(t)) hbp++;
  }
  const takenPitches = balls + calledStrikes;
  const swings = fouls + swingingStrikes + inPlay;
  const contacts = fouls + inPlay;
  let cb = 0, cs = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (BALL.has(t)) cb++;
    else if (CALLED.has(t) || WHIFF.has(t) || FOUL.has(t)) { if (cs < 2) cs++; }
  }
  let running = 0, reachedTwo = false;
  for (const t of tokens) { if (CALLED.has(t) || WHIFF.has(t) || FOUL.has(t)) { if (running < 2) running++; } if (running >= 2) reachedTwo = true; }
  const first = tokens[0];
  const firstPitchStrike = !!first && (CALLED.has(first) || WHIFF.has(first) || FOUL.has(first) || INPLAY.has(first));
  return { balls, calledStrikes, swingingStrikes, fouls, inPlay, hbp, takenPitches, swings, contacts, enteringCount: { balls: cb, strikes: cs }, reachedTwoStrikes: reachedTwo, firstPitchStrike, pitches: tokens.length };
}

// ---- CSV loader ----
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = []; let cur = ''; let q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); rows.push(out);
  }
  return rows;
}
function loadCsvRows(file) {
  const parsed = parseCsv(fs.readFileSync(file, 'utf8'));
  const h = parsed[0].map((s) => s.replace(/^"|"$/g, ''));
  return parsed.slice(1).map((c) => { const o = {}; for (let j = 0; j < h.length; j++) o[h[j]] = (c[j] || '').replace(/^"|"$/g, ''); return o; });
}

// ---- per-PA discipline check ----
function checkPa(acc, i, pa) {
  const tokens = pa.reassembledPitches || pa.pitches;
  if (pa.sequenceComplete === false) return;      // completeness handled per-case
  if (!Array.isArray(tokens)) return;
  if (typeof pa.seq === 'string') {
    const stripped = strip(pa.seq).join('');
    assert(acc, stripped === tokens.join(''), `PA[${i}] stripped seq '${stripped}' != pitches '${tokens.join('')}' (strip-once/no-concat)`);
  }
  const d = classify(tokens);
  for (const f of ['balls', 'calledStrikes', 'swingingStrikes', 'fouls', 'inPlay', 'takenPitches', 'swings'])
    if (pa[f] !== undefined) assert(acc, eq(pa[f], d[f]), `PA[${i}].${f}: declared ${pa[f]} != recomputed ${d[f]}`);
  if (pa.count) assert(acc, eq(pa.count.balls, d.enteringCount.balls) && eq(pa.count.strikes, d.enteringCount.strikes), `PA[${i}].count ${JSON.stringify(pa.count)} != recomputed ${JSON.stringify(d.enteringCount)}`);
  if (pa.firstPitchStrike !== undefined) assert(acc, pa.firstPitchStrike === d.firstPitchStrike, `PA[${i}].firstPitchStrike ${pa.firstPitchStrike} != ${d.firstPitchStrike}`);
  if (pa.reachedTwoStrikes !== undefined) assert(acc, pa.reachedTwoStrikes === d.reachedTwoStrikes, `PA[${i}].reachedTwoStrikes ${pa.reachedTwoStrikes} != ${d.reachedTwoStrikes}`);
}

// ---- aggregate recomputed from the PAs (cases 01, 02) ----
function checkBatterAggregate(acc, fx) {
  const e = fx.expected || {};
  const agg = e.batterAggregate;
  const pas = e.plateAppearances || [];
  if (!agg || !pas.length) return;
  const complete = pas.filter((p) => p.sequenceComplete !== false && (p.reassembledPitches || p.pitches));
  const sum = { pitches: 0, swings: 0, whiffs: 0, contacts: 0, fouls: 0, calledStrikes: 0, takenPitches: 0, inPlay: 0 };
  let k = 0, bb = 0, ibb = 0, hbp = 0, fps = 0, twoStrikePa = 0, twoStrikeK = 0, twoStrikeSurvived = 0;
  for (const p of complete) {
    const d = classify(p.reassembledPitches || p.pitches);
    sum.pitches += d.pitches; sum.swings += d.swings; sum.whiffs += d.swingingStrikes; sum.contacts += d.contacts;
    sum.fouls += d.fouls; sum.calledStrikes += d.calledStrikes; sum.takenPitches += d.takenPitches; sum.inPlay += d.inPlay;
    if (p.struckOut === true || eq(p.eventCd, 3)) k++;
    if (eq(p.eventCd, 14) || eq(p.eventCd, 15) || p.outcome === 'BB') { bb++; if (eq(p.eventCd, 15)) ibb++; }
    if (eq(p.eventCd, 16)) hbp++;
    if (d.firstPitchStrike) fps++;
    if (d.reachedTwoStrikes) { twoStrikePa++; if (p.struckOut === true || eq(p.eventCd, 3)) twoStrikeK++; if (p.twoStrikeSurvived === true) twoStrikeSurvived++; }
  }
  const map = {
    pa: pas.length, codedPitchPa: complete.length, pitches: sum.pitches, swings: sum.swings, whiffs: sum.whiffs,
    contacts: sum.contacts, fouls: sum.fouls, calledStrikes: sum.calledStrikes, takenPitches: sum.takenPitches,
    inPlay: sum.inPlay, k, bb, ibb, hbp, firstPitchStrikes: fps, twoStrikePa, twoStrikeK, twoStrikeSurvived,
  };
  for (const [key, val] of Object.entries(map)) if (agg[key] !== undefined) assert(acc, eq(agg[key], val), `batterAggregate.${key}: declared ${agg[key]} != recomputed ${val}`);
  if (agg.pitchSequenceCoverage !== undefined) assert(acc, near(agg.pitchSequenceCoverage, pas.length ? complete.length / pas.length : 0), `batterAggregate.pitchSequenceCoverage ${agg.pitchSequenceCoverage} != codedPitchPa/pa`);
  if (agg.sequenceFloorMet !== undefined) { const cov = pas.length ? complete.length / pas.length : 0; assert(acc, agg.sequenceFloorMet === (cov >= (fx.floors?.pitchSequenceCoverage ?? 0.90)), `batterAggregate.sequenceFloorMet inconsistent with coverage`); }
}

// ---- completeness (case 05) ----
function checkCompleteness(acc, pas) {
  for (let i = 0; i < pas.length; i++) {
    const pa = pas[i];
    if (pa.sequenceComplete !== false) continue;
    const stripped = strip(pa.seq);
    const hasUncountable = stripped.some((c) => UNCOUNTABLE.has(c));
    const isEmpty = stripped.length === 0;
    if (isEmpty) assert(acc, pa.completenessReason === 'empty_sequence', `PA[${i}] empty seq but reason='${pa.completenessReason}'`);
    else if (hasUncountable) assert(acc, pa.completenessReason === 'uncountable_pitch_token', `PA[${i}] uncountable seq but reason='${pa.completenessReason}'`);
    assert(acc, pa.sequenceDerivedContribution === null || pa.sequenceDerivedContribution === undefined ? true : false, `PA[${i}] incomplete but sequenceDerivedContribution not null`);
    if (pa.countsTowardBatterPa !== undefined) assert(acc, pa.countsTowardBatterPa === true, `PA[${i}] incomplete must still count toward batterPa`);
    if (pa.countsTowardCodedPitchPa !== undefined) assert(acc, pa.countsTowardCodedPitchPa === false, `PA[${i}] incomplete must NOT count toward codedPitchPa`);
    if (Array.isArray(pa.uncountableTokens)) { const actual = stripped.filter((c) => UNCOUNTABLE.has(c)); assert(acc, JSON.stringify(pa.uncountableTokens) === JSON.stringify(actual), `PA[${i}] uncountableTokens ${JSON.stringify(pa.uncountableTokens)} != ${JSON.stringify(actual)}`); }
  }
}

// ---- case-specific validators ----
function checkCase04(acc, fx) {
  const e = fx.expected || {}; const h = e.handednessResolution || {}; const sa = e.splitAttribution || {};
  assert(acc, ['L', 'R'].includes(h.resolvedBatterHand), `04 resolvedBatterHand '${h.resolvedBatterHand}' not L/R`);
  assert(acc, ['L', 'R'].includes(h.resolvedPitcherHand), `04 resolvedPitcherHand '${h.resolvedPitcherHand}' not L/R`);
  assert(acc, h.batterSplitBucket === 'vs' + h.resolvedPitcherHand, `04 batterSplitBucket '${h.batterSplitBucket}' != vs${h.resolvedPitcherHand}`);
  assert(acc, h.pitcherSplitBucket === 'vs' + h.resolvedBatterHand, `04 pitcherSplitBucket '${h.pitcherSplitBucket}' != vs${h.resolvedBatterHand}`);
  const n = (e.plateAppearances || []).length;
  if (sa.batter) {
    assert(acc, eq(sa.batter['paVs' + h.resolvedPitcherHand], n), `04 batter paVs${h.resolvedPitcherHand} != ${n}`);
    const other = h.resolvedPitcherHand === 'R' ? 'L' : 'R';
    assert(acc, eq(sa.batter['paVs' + other], 0), `04 batter paVs${other} != 0`);
  }
  if (sa.pitcher) {
    assert(acc, eq(sa.pitcher['bfVs' + h.resolvedBatterHand], n), `04 pitcher bfVs${h.resolvedBatterHand} != ${n}`);
    const other = h.resolvedBatterHand === 'R' ? 'L' : 'R';
    assert(acc, eq(sa.pitcher['bfVs' + other], 0), `04 pitcher bfVs${other} != 0`);
  }
}
function checkCase05(acc, fx) {
  const e = fx.expected || {}; const pas = e.plateAppearances || []; const agg = e.batterAggregate || {};
  checkCompleteness(acc, pas);
  const pa = pas.length;
  const coded = pas.filter((p) => p.countsTowardCodedPitchPa === true).length;
  assert(acc, eq(agg.pa, pa), `05 aggregate.pa ${agg.pa} != ${pa}`);
  assert(acc, eq(agg.codedPitchPa, coded), `05 aggregate.codedPitchPa ${agg.codedPitchPa} != ${coded}`);
  assert(acc, near(agg.pitchSequenceCoverage, pa ? coded / pa : 0), `05 coverage ${agg.pitchSequenceCoverage} != codedPitchPa/pa`);
  assert(acc, agg.sequenceFloorMet === (agg.pitchSequenceCoverage >= 0.90), `05 sequenceFloorMet inconsistent`);
  assert(acc, agg.sequenceDerivedLeaves === null, `05 sequenceDerivedLeaves must be null when floor not met`);
  if (agg.sequenceDerivedNullReason !== undefined) assert(acc, agg.sequenceDerivedNullReason === 'below_sequence_coverage', `05 nullReason '${agg.sequenceDerivedNullReason}'`);
}
function checkCase06(acc, fx) {
  const e = fx.expected || {}; const h = e.handednessResolution || {}; const agg = e.batterAggregate || {};
  const unknown = h.resolvedPitcherHand === '?' || h.resolvedBatterHand === '?';
  assert(acc, h.unknownHandedness === unknown, `06 unknownHandedness ${h.unknownHandedness} != ${unknown}`);
  assert(acc, h.splitAttributed === !unknown, `06 splitAttributed ${h.splitAttributed} should be ${!unknown}`);
  if (agg.split) { assert(acc, eq(agg.split.paVsL, 0) && eq(agg.split.paVsR, 0), `06 split not withheld (paVsL=${agg.split.paVsL} paVsR=${agg.split.paVsR})`); }
  const pas = e.plateAppearances || [];
  if (agg.overall) {
    assert(acc, eq(agg.overall.pa, pas.length), `06 overall.pa ${agg.overall.pa} != ${pas.length}`);
    const complete = pas.filter((p) => p.sequenceComplete !== false);
    let k = 0, sw = 0, wh = 0, fo = 0;
    for (const p of complete) { const d = classify(p.reassembledPitches || p.pitches); sw += d.swings; wh += d.swingingStrikes; fo += d.fouls; if (p.struckOut === true || eq(p.eventCd, 3)) k++; }
    for (const [key, val] of [['k', k], ['swings', sw], ['whiffs', wh], ['fouls', fo]]) if (agg.overall[key] !== undefined) assert(acc, eq(agg.overall[key], val), `06 overall.${key} ${agg.overall[key]} != ${val}`);
  }
}
function checkCase07(acc, fx) {
  const e = fx.expected || {}; const cov = e.coverage || {};
  assert(acc, near(cov.pitchSequenceCoverage, cov.batterPa ? cov.codedPitchPa / cov.batterPa : 0), `07 coverage ${cov.pitchSequenceCoverage} != codedPitchPa/batterPa`);
  assert(acc, cov.sequenceFloorMet === (cov.pitchSequenceCoverage >= cov.coverageFloor), `07 sequenceFloorMet inconsistent`);
  const ool = e.outcomeOnlyLeaves || {};
  const rateChecks = [
    ['kRatePct', ool.kRatePct, (c) => 100 * (c.k) / c.pa],
    ['bbRatePct', ool.bbRatePct, (c) => 100 * (c.bb) / c.pa],
    ['inPlayRatePct', ool.inPlayRatePct, (c) => 100 * (c.inPlayTerminal) / c.pa],
  ];
  for (const [name, leaf, fn] of rateChecks) if (leaf && leaf.counts) { assert(acc, near(leaf.value, fn(leaf.counts), 1e-4), `07 ${name}.value ${leaf.value} != recomputed ${fn(leaf.counts)}`); assert(acc, leaf.present === true, `07 ${name}.present must be true`); }
  const sdl = e.sequenceDerivedLeaves || {};
  for (const k of ['whiffRatePct', 'contactRatePct', 'foulStrikeRatePct', 'firstPitchStrikeRatePct', 'twoStrikeSurvivalRatePct']) if (k in sdl) assert(acc, sdl[k] === null, `07 sequenceDerivedLeaves.${k} must be null`);
  if (sdl.nullReason !== undefined) assert(acc, sdl.nullReason === 'below_sequence_coverage', `07 sequenceDerived nullReason '${sdl.nullReason}'`);
  if (e.rawCountsPreserved !== undefined) assert(acc, e.rawCountsPreserved === true, `07 rawCountsPreserved must be true`);
}
function checkCase08(acc, fx) {
  const e = fx.expected || {}; const f = fx.floors || {};
  for (const b of (e.batterOverall || [])) { const p = b.pa >= f.batterOverallPa; assert(acc, b.batterRatesPresent === p, `08 batterOverall ${b.batterId} present ${b.batterRatesPresent} vs pa${b.pa}>=${f.batterOverallPa}`); assert(acc, p ? b.nullReason === null : b.nullReason === 'below_batter_pa_floor', `08 batterOverall ${b.batterId} nullReason '${b.nullReason}'`); }
  for (const p of (e.pitcherOverall || [])) { const ok = p.bf >= f.pitcherOverallBf; assert(acc, p.pitcherRatesPresent === ok, `08 pitcherOverall ${p.pitcherId} present ${p.pitcherRatesPresent} vs bf${p.bf}>=${f.pitcherOverallBf}`); assert(acc, ok ? p.nullReason === null : p.nullReason === 'below_pitcher_bf_floor', `08 pitcherOverall ${p.pitcherId} nullReason '${p.nullReason}'`); }
  for (const s of (e.batterHandSplit || [])) { const l = s.paVsL >= f.batterHandSplitPa, r = s.paVsR >= f.batterHandSplitPa; assert(acc, s.vsLPresent === l, `08 batterHandSplit vsLPresent ${s.vsLPresent} vs ${s.paVsL}>=${f.batterHandSplitPa}`); assert(acc, s.vsRPresent === r, `08 batterHandSplit vsRPresent ${s.vsRPresent} vs ${s.paVsR}>=${f.batterHandSplitPa}`); assert(acc, l ? s.vsLNullReason === null : s.vsLNullReason === 'below_hand_split_pa_floor', `08 batterHandSplit vsLNullReason '${s.vsLNullReason}'`); assert(acc, r ? s.vsRNullReason === null : s.vsRNullReason === 'below_hand_split_pa_floor', `08 batterHandSplit vsRNullReason '${s.vsRNullReason}'`); }
  for (const s of (e.pitcherHandSplit || [])) { const l = s.bfVsL >= f.pitcherHandSplitBf, r = s.bfVsR >= f.pitcherHandSplitBf; assert(acc, s.vsLPresent === l, `08 pitcherHandSplit vsLPresent ${s.vsLPresent} vs ${s.bfVsL}>=${f.pitcherHandSplitBf}`); assert(acc, s.vsRPresent === r, `08 pitcherHandSplit vsRPresent ${s.vsRPresent} vs ${s.bfVsR}>=${f.pitcherHandSplitBf}`); assert(acc, l ? s.vsLNullReason === null : s.vsLNullReason === 'below_hand_split_bf_floor', `08 pitcherHandSplit vsLNullReason '${s.vsLNullReason}'`); assert(acc, r ? s.vsRNullReason === null : s.vsRNullReason === 'below_hand_split_bf_floor', `08 pitcherHandSplit vsRNullReason '${s.vsRNullReason}'`); }
}

// ---- real cwevent output cross-check (cases 02/03) ----
function crossCheckReal(acc, fx) {
  const rec = fx.raw && fx.raw.terminalBatterEventRecord;
  const csvRel = fx.validatedAgainstProof && fx.validatedAgainstProof.cweventOutputFile;
  if (!rec || !csvRel) { acc.problems.push('real fixture missing terminalBatterEventRecord/cweventOutputFile'); return; }
  const csvPath = path.join(process.cwd(), csvRel);
  if (!fs.existsSync(csvPath)) { acc.problems.push(`proof CSV not found: ${csvRel}`); return; }
  const rows = loadCsvRows(csvPath);
  const m = rows.find((r) => eq(r.BAT_ID, rec.BAT_ID) && eq(r.PITCH_SEQ_TX, rec.PITCH_SEQ_TX) && eq(r.INN_CT, rec.INN_CT));
  if (!m) { acc.problems.push(`no real row BAT_ID=${rec.BAT_ID} INN=${rec.INN_CT} SEQ=${rec.PITCH_SEQ_TX} in ${path.basename(csvRel)}`); acc.checks++; return; }
  for (const k of ['GAME_ID', 'RESP_BAT_ID', 'PITCH_SEQ_TX', 'EVENT_CD', 'BAT_EVENT_FL', 'BALLS_CT', 'STRIKES_CT', 'PIT_ID', 'REMOVED_FOR_PH_BAT_ID', 'BAT_HAND_CD', 'RESP_BAT_HAND_CD'])
    if (rec[k] !== undefined) assert(acc, eq(m[k], rec[k]), `real ${k}='${m[k]}' != fixture '${rec[k]}'`);
}

// ---- provenance + parser identity (gates status=validated) ----
function checkProvenance() {
  const acc = { case: '__provenance__', realAnchored: false, checks: 0, problems: [] };
  const proofAbs = path.join(process.cwd(), PROOF_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'SOURCE_MANIFEST.json'), 'utf8'));
  const parserId = JSON.parse(fs.readFileSync(path.join(proofAbs, 'PARSER_IDENTITY.json'), 'utf8'));
  const prov = fs.readFileSync(path.join(proofAbs, 'SOURCE_PROVENANCE.txt'), 'utf8');
  const provGet = (re) => { const m = prov.match(re); return m ? m[1] : null; };
  const tp = manifest.toolchainProof || {};

  // 1. every committed proof CSV: recomputed sha256 == manifest == SOURCE_PROVENANCE
  const csvDir = path.join(proofAbs, 'cwevent_output');
  for (const f of fs.readdirSync(csvDir).filter((x) => x.endsWith('.csv'))) {
    const got = sha256(path.join(csvDir, f));
    const wantManifest = tp.cweventOutputSha256 && tp.cweventOutputSha256[f];
    const wantProv = provGet(new RegExp(`output_sha256\\[${f.replace(/[.[\]]/g, '\\$&')}\\]=([a-f0-9]{64})`));
    assert(acc, wantManifest === got, `CSV ${f}: recomputed sha ${got} != manifest ${wantManifest}`);
    assert(acc, wantProv === got, `CSV ${f}: recomputed sha ${got} != SOURCE_PROVENANCE ${wantProv}`);
  }
  // 2. archive + event-file hashes: manifest cross-agrees with SOURCE_PROVENANCE
  assert(acc, tp.retrosheetArchive && tp.retrosheetArchive.sha256 === provGet(/archive_sha256=([a-f0-9]{64})/), `archive sha manifest != SOURCE_PROVENANCE`);
  for (const [ev, h] of Object.entries(tp.eventFileSha256 || {})) assert(acc, h === provGet(new RegExp(`eventfile_sha256\\[${ev.replace(/[.[\]]/g, '\\$&')}\\]=([a-f0-9]{64})`)), `eventfile ${ev} sha manifest != SOURCE_PROVENANCE`);

  // 3. parser identity: manifest == PARSER_IDENTITY.json
  const normV = (v) => String(v || '').replace(/^v/, '');
  assert(acc, normV(manifest.parser.parserVersion) === normV(parserId.parserVersion), `parserVersion manifest '${manifest.parser.parserVersion}' != PARSER_IDENTITY '${parserId.parserVersion}'`);
  assert(acc, manifest.parser.parserCommitSha === parserId.parserCommitSha, `parserCommitSha manifest '${manifest.parser.parserCommitSha}' != PARSER_IDENTITY '${parserId.parserCommitSha}'`);
  assert(acc, manifest.parser.fieldList === parserId.fieldList, `fieldList manifest != PARSER_IDENTITY`);
  // args: manifest uses <season>/<eventfile> placeholders; compare on the field-list substring
  assert(acc, parserId.cweventArguments.includes('-f ' + parserId.fieldList) && manifest.parser.parserArguments.includes('-f ' + manifest.parser.fieldList), `parser arguments field-list mismatch`);

  // 4. fixture-declared hashes (cases 02/03) == recomputed CSV + manifest
  for (const cf of ['02_interrupted_pa_period.json', '03_sub_responsible_batter.json']) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'cases', cf), 'utf8'));
    const v = fx.validatedAgainstProof || {};
    const csvName = path.basename(v.cweventOutputFile || '');
    const got = sha256(path.join(csvDir, csvName));
    assert(acc, v.cweventOutputSha256 === got, `${cf}: declared cweventOutputSha256 != recomputed`);
    assert(acc, (tp.cweventOutputSha256 || {})[csvName] === v.cweventOutputSha256, `${cf}: fixture hash != manifest hash`);
    if (v.eventFile && v.eventFileSha256) assert(acc, (tp.eventFileSha256 || {})[v.eventFile] === v.eventFileSha256, `${cf}: fixture eventFileSha256 != manifest`);
    assert(acc, (v.parser || '').includes(manifest.parser.parserCommitSha), `${cf}: fixture parser string missing pinned commit`);
  }
  // 5. status gate
  assert(acc, manifest.status === 'validated', `manifest.status is '${manifest.status}', expected 'validated'`);
  return acc;
}

// ---- drive all cases ----
const results = [];
const caseFiles = fs.readdirSync(path.join(FIX_DIR, 'cases')).filter((f) => f.endsWith('.json')).sort();
for (const cf of caseFiles) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'cases', cf), 'utf8'));
  const realAnchored = !!(fx.raw && fx.raw.sourceFormat === 'chadwick_cwevent_output_row');
  const acc = mk(fx.case, realAnchored);
  const pas = (fx.expected && fx.expected.plateAppearances) || [];
  for (let i = 0; i < pas.length; i++) checkPa(acc, i, pas[i]);
  checkBatterAggregate(acc, fx);
  if (fx.case.startsWith('04')) checkCase04(acc, fx);
  if (fx.case.startsWith('05')) checkCase05(acc, fx);
  if (fx.case.startsWith('06')) checkCase06(acc, fx);
  if (fx.case.startsWith('07')) checkCase07(acc, fx);
  if (fx.case.startsWith('08')) checkCase08(acc, fx);
  if (realAnchored) crossCheckReal(acc, fx);
  acc.status = acc.problems.length ? 'FAIL' : 'PASS';
  results.push(acc);
}
const provenance = checkProvenance();
provenance.status = provenance.problems.length ? 'FAIL' : 'PASS';

let grammarBacking = null;
try { const g = JSON.parse(fs.readFileSync(path.join(process.cwd(), PROOF_DIR, 'GRAMMAR_CROSSCHECK.json'), 'utf8')); grammarBacking = { checked: g.checked, matched: g.matched, matchRate: g.matchRate }; } catch { /* optional */ }

const allPass = results.every((r) => r.status === 'PASS') && provenance.status === 'PASS';
const summary = {
  revised_contract_comparison: 'pr7a1',
  parser: 'Chadwick cwevent 0.10.0 (8f7e0ecd8984cd752e6aca5deba81b86fb369602)',
  grammarCrossCheckFromProof: grammarBacking,
  cases: results,
  provenance,
  overall: allPass ? 'PASS' : 'FAIL',
};
if (OUT) fs.writeFileSync(path.join(process.cwd(), OUT), JSON.stringify(summary, null, 2) + '\n');

console.log('PR7A.1 revised contract comparison');
if (grammarBacking) console.log(`  grammar cross-check (proof): ${grammarBacking.matched}/${grammarBacking.checked} rate ${grammarBacking.matchRate}`);
for (const r of [...results, provenance]) {
  console.log(`  ${r.status.padEnd(4)} ${r.case}${r.realAnchored ? ' [real]' : ''}  (${r.checks} checks)`);
  for (const p of r.problems) console.log(`       - ${p}`);
}
console.log(`  OVERALL: ${summary.overall}`);
process.exit(allPass ? 0 : 1);
