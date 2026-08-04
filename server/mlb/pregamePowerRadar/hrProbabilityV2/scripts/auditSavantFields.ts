// Plate HR V2 — READ-ONLY Baseball Savant field-availability spike (plan §6, PR2).
//
// Purpose: empirically verify which Savant `type=details` CSV columns are
// actually present and how well-populated they are — especially the fields the
// engine upgrades depend on but has NOT confirmed against a live response:
//   • pitch LOCATION: plate_x, plate_z, zone, sz_top, sz_bot  (gates Upgrade 2A / PR7)
//   • official barrel: launch_speed_angle  (6 == barrel)      (Upgrade 1 quality)
//   • bat tracking:    bat_speed, swing_length                (2023+ only)
// plus the exact pitch-type / damage columns Upgrade 1 needs.
//
// This script is READ-ONLY: it performs GET requests to Baseball Savant and
// prints a report. It writes NOTHING (no DB, no files). It is NOT imported by any
// runtime path. Its output feeds the human-signed go/no-go artifact
// (docs/plate/plateHrV2DataFeasibility.md). Fail-closed: a field this spike
// cannot confirm present + adequately populated is NOT authorized for capture.
//
// Run (in an environment with Baseball Savant access):
//   npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/scripts/auditSavantFields.ts \
//     --player 592450 --type batter --season 2025 --from 2025-04-01 --to 2025-04-15
//
// Flags (all optional; defaults are a small recent-window batter sample):
//   --player <mlbamId>   MLBAM id to sample (column presence only, not a fixture)
//   --type   batter|pitcher
//   --season <YYYY>
//   --from <YYYY-MM-DD> --to <YYYY-MM-DD>
//   --timeout <ms>

interface Args { player: string; type: "batter" | "pitcher"; season: string; from: string; to: string; timeout: number; }

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  // Default player is a well-known active hitter used ONLY to sample which
  // columns exist — never a modeling fixture or a desired result.
  return {
    player: get("--player", "592450"),
    type: (get("--type", "batter") as "batter" | "pitcher"),
    season: get("--season", "2025"),
    from: get("--from", "2025-04-01"),
    to: get("--to", "2025-04-15"),
    timeout: Number(get("--timeout", "15000")),
  };
}

// Fields whose presence/coverage decide what PR3 may capture and whether PR7
// (zone) is a go. Grouped for the report.
const FIELD_GROUPS: Record<string, string[]> = {
  identity: ["game_pk", "game_date", "player_name", "batter", "pitcher", "events", "description"],
  handedness: ["stand", "p_throws"],
  pitch_type: ["pitch_type", "pitch_name"],
  contact_quality: ["launch_speed", "launch_angle", "launch_speed_angle", "estimated_ba_using_speedangle", "estimated_slg_using_speedangle", "estimated_woba_using_speedangle", "bb_type", "hc_x", "hc_y"],
  bat_tracking: ["bat_speed", "swing_length"],
  location_ZONE_GATE: ["plate_x", "plate_z", "zone", "sz_top", "sz_bot"],
  movement: ["pfx_x", "pfx_z", "release_speed", "release_spin_rate", "arm_angle"],
};

function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.replace(/"/g, "").trim());
}

function buildUrl(a: Args): string {
  const lookup = a.type === "batter" ? "batters_lookup%5B%5D" : "pitchers_lookup%5B%5D";
  return `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${a.season}%7C&player_type=${a.type}&game_date_gt=${a.from}&game_date_lt=${a.to}&min_pitches=0&min_results=0&min_pa=1&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&${lookup}=${a.player}&type=details`;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const url = buildUrl(a);
  console.log(`[auditSavantFields] READ-ONLY spike`);
  console.log(`  player=${a.player} type=${a.type} season=${a.season} window=${a.from}..${a.to}`);
  console.log(`  url=${url}\n`);

  let text: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LiveLocks-audit/1.0)" },
      signal: AbortSignal.timeout(a.timeout),
    });
    if (!res.ok) {
      console.error(`[auditSavantFields] HTTP ${res.status} — spike INCONCLUSIVE. Re-run in an environment with Baseball Savant access.`);
      console.error(`  Fail-closed: all UNVERIFIED fields remain UNAUTHORIZED for capture.`);
      process.exit(2);
    }
    text = await res.text();
  } catch (err) {
    console.error(`[auditSavantFields] fetch failed (${(err as Error).message}) — spike INCONCLUSIVE.`);
    console.error(`  Re-run where Baseball Savant is reachable. Fail-closed: UNVERIFIED fields stay UNAUTHORIZED.`);
    process.exit(2);
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    console.error(`[auditSavantFields] response had no data rows (${lines.length} lines) — INCONCLUSIVE.`);
    process.exit(2);
  }
  const headers = splitCsvRow(lines[0]).map((h) => h.toLowerCase());
  const headerSet = new Set(headers);
  const rows = lines.slice(1).map(splitCsvRow);
  console.log(`[auditSavantFields] ${rows.length} rows, ${headers.length} columns.\n`);

  const coverage = (field: string): { present: boolean; nonEmpty: number; pct: number } => {
    const idx = headers.indexOf(field);
    if (idx < 0) return { present: false, nonEmpty: 0, pct: 0 };
    let n = 0;
    for (const r of rows) {
      const v = r[idx];
      if (v != null && v !== "" && v.toLowerCase() !== "null") n++;
    }
    return { present: true, nonEmpty: n, pct: rows.length ? n / rows.length : 0 };
  };

  for (const [group, fields] of Object.entries(FIELD_GROUPS)) {
    console.log(`── ${group} ──`);
    for (const f of fields) {
      const c = coverage(f);
      const mark = !c.present ? "ABSENT " : c.pct >= 0.95 ? "OK     " : c.pct >= 0.5 ? "PARTIAL" : "SPARSE ";
      console.log(`  [${mark}] ${f.padEnd(34)} ${c.present ? `${(c.pct * 100).toFixed(1)}% (${c.nonEmpty}/${rows.length})` : "not in header"}`);
    }
    console.log("");
  }

  const zoneFields = FIELD_GROUPS.location_ZONE_GATE;
  const zoneAllPresent = zoneFields.every((f) => headerSet.has(f));
  const zoneAllPopulated = zoneFields.every((f) => coverage(f).pct >= 0.9);
  console.log(`── ZONE GATE (Upgrade 2A / PR7) ──`);
  console.log(`  plate_x/plate_z/zone/sz_top/sz_bot all present:   ${zoneAllPresent}`);
  console.log(`  all >= 90% populated:                             ${zoneAllPopulated}`);
  console.log(`  → PR7 zone term is ${zoneAllPresent && zoneAllPopulated ? "GO (pending licensing sign-off)" : "NO-GO (defer 2A; no proxy labeled as zone)"}\n`);

  console.log(`[auditSavantFields] Done. Record these results (with date + commit) in`);
  console.log(`  docs/plate/plateHrV2DataFeasibility.md and freeze the authorized-field list there.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
