// Mound official-firewall measurement flag — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/moundOfficialFirewallGateFlags.test.ts

import { parseMoundFirewallMeasurementBooleanFlag, isMoundOfficialFirewallMeasurementEnabled } from "./moundOfficialFirewallGateFlags";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

ok(parseMoundFirewallMeasurementBooleanFlag(undefined) === false, "undefined -> false (fail-closed default)");
ok(parseMoundFirewallMeasurementBooleanFlag("") === false, "empty string -> false");
ok(parseMoundFirewallMeasurementBooleanFlag("false") === false, "'false' -> false");
ok(parseMoundFirewallMeasurementBooleanFlag("0") === false, "'0' -> false");
ok(parseMoundFirewallMeasurementBooleanFlag("no") === false, "'no' -> false");
ok(parseMoundFirewallMeasurementBooleanFlag("nonsense") === false, "garbage input -> false, never throws");

for (const v of ["true", "True", "TRUE", " true ", "1", "on", "ON", "yes", "Yes"]) {
  ok(parseMoundFirewallMeasurementBooleanFlag(v) === true, `'${v}' -> true (case/whitespace-insensitive true-like value)`);
}

const original = process.env.MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED;
delete process.env.MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED;
ok(isMoundOfficialFirewallMeasurementEnabled() === false, "unset env var -> disabled by default");
process.env.MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED = "true";
ok(isMoundOfficialFirewallMeasurementEnabled() === true, "explicit true env var -> enabled");
process.env.MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED = "false";
ok(isMoundOfficialFirewallMeasurementEnabled() === false, "explicit false env var -> disabled");
if (original === undefined) delete process.env.MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED;
else process.env.MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED = original;

console.log(`\nmoundOfficialFirewallGateFlags.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
