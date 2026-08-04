// Pre-Game Power Radar — v2 SHADOW PR6: recent-contact-form log-odds term.
// Run: npx tsx server/mlb/pregamePowerRadar/math/scoreRecentContactForm.test.ts

import { scoreRecentContactForm, RECENT_CONTACT_FORM_CAP } from "./scoreRecentContactForm";
import type { RecentContactFormTermInputs } from "./mathTypes";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const empty: RecentContactFormTermInputs = {
  recentFormBarrelPct: null, recentFormAvgEv: null, recentFormEv90: null,
  recentFormAirPct: null, effectiveBbe: null,
};

// ── No-op when absent / all-null ──────────────────────────────────────────────
ok(scoreRecentContactForm(null).logOdds === 0 && !scoreRecentContactForm(null).available,
  "null input → no-op");
ok(scoreRecentContactForm(undefined).logOdds === 0, "undefined input → no-op");
const none = scoreRecentContactForm(empty);
ok(!none.available && none.logOdds === 0, "all-null → no-op");

// ── Hot form → positive; cold form → negative ─────────────────────────────────
const hot = scoreRecentContactForm({
  recentFormBarrelPct: 16, recentFormAvgEv: 94, recentFormEv90: 110, recentFormAirPct: 52, effectiveBbe: 45,
});
const cold = scoreRecentContactForm({
  recentFormBarrelPct: 2, recentFormAvgEv: 85, recentFormEv90: 98, recentFormAirPct: 25, effectiveBbe: 45,
});
ok(hot.available && hot.logOdds > 0, "hot recent form → positive logOdds");
ok(cold.logOdds < 0, "cold recent form → negative logOdds");
ok(hot.logOdds > cold.logOdds, "hot > cold logOdds");

// ── Respects the cap ──────────────────────────────────────────────────────────
const maxed = scoreRecentContactForm({
  recentFormBarrelPct: 40, recentFormAvgEv: 105, recentFormEv90: 125, recentFormAirPct: 80, effectiveBbe: 5000,
});
ok(Math.abs(maxed.logOdds) <= RECENT_CONTACT_FORM_CAP + 1e-9, "respects RECENT_CONTACT_FORM_CAP");

// ── Monotone in barrel% (dominant weight) ─────────────────────────────────────
const lowB = scoreRecentContactForm({ ...empty, recentFormBarrelPct: 6, effectiveBbe: 45 });
const hiB = scoreRecentContactForm({ ...empty, recentFormBarrelPct: 15, effectiveBbe: 45 });
ok(hiB.logOdds > lowB.logOdds, "higher recent barrel% → higher logOdds");

// ── Reliability: thin window shrinks the SAME hot line toward no-op ────────────
const hotThin = scoreRecentContactForm({
  recentFormBarrelPct: 16, recentFormAvgEv: 94, recentFormEv90: 110, recentFormAirPct: 52, effectiveBbe: 5,
});
ok(hotThin.logOdds < hot.logOdds, "thin window (few BBE) mutes the contribution");
ok(hotThin.logOdds > 0, "thin window still directionally correct");

// ── Coverage: a 1-stat row degrades vs a full row ─────────────────────────────
const oneStat = scoreRecentContactForm({ ...empty, recentFormBarrelPct: 16, effectiveBbe: 45 });
ok(oneStat.available && oneStat.logOdds > 0, "1-stat row still positive");
ok(oneStat.logOdds < hot.logOdds, "sparse 1-stat row degraded below full-coverage row");

// ── No HR-count leakage surface: the input type carries no HR field ────────────
// (structural — recentFormBarrelPct etc. are contact-quality only; there is no
// recentHrCount/hrFB field on RecentContactFormTermInputs, so recent HRs can never
// lift this term. This test documents the invariant via the two hot/cold rows
// above producing identical results regardless of any (absent) HR notion.)
ok(hot.key === "recentContactForm", "term key stable");

console.log(`\nscoreRecentContactForm.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
