// PR7A stage 4 — structural isolation + location-blindness (mirrors
// mound/v2/moundV2PriceIndependence.test.ts's source-read assertions).
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineIsolation.test.ts

import { readFileSync } from "node:fs";
import {
  plateHrV2ContactOpportunityFeaturesSchema,
  plateHrV2ContactOpportunityV3FeaturesSchema,
  plateHrV2PitcherDisciplineFeaturesSchema,
  plateHrV2AuthorizedProjectionV3Schema,
  plateHrV2UnavailableZoneLocationV3,
} from "./plateHrV2FeatureContract";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

const DIR = "server/mlb/pregamePowerRadar/hrProbabilityV2";
const evidenceSrc = readFileSync(`${DIR}/retrosheetDisciplineEvidence.ts`, "utf8");
// strip line + block comments so header prose ("Baseball Savant", "location") is not counted
const evidenceCode = evidenceSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// 1. The pure PR7A evidence module imports NOTHING (like the mound policy module).
ok(!/^\s*import\s/m.test(evidenceCode), "retrosheetDisciplineEvidence.ts has ZERO import statements");

// 2. It references no Savant / MLB-Stats data-source module or endpoint.
const FORBIDDEN_SOURCES = [
  "dataSources", "dataPullService", "rosterService", "gameDiscoveryService",
  "liveGameOrchestrator", "plateHrV2OutcomeSource", "opponentBatterKProfile",
  "pitchTypeNormalizer", "statcastBarrel",
  "baseball_savant", "BaseballSavantData", "statsapi.mlb.com", "savant", "statcast",
];
for (const t of FORBIDDEN_SOURCES) ok(!evidenceCode.includes(t), `evidence module must not reference "${t}"`);

// 3. Forbidden zone-term name sweep over the NEW v3 leaf names only (legacy
//    chaseRatePct/zoneContactRatePct are retained-null and exempt).
const FORBIDDEN_TERMS = ["chase", "heart", "inside", "outside", "shadow", "zone", "platex", "plate_x"];
const legacyKeys = new Set(Object.keys(plateHrV2ContactOpportunityFeaturesSchema.shape));
const v3ContactKeys = Object.keys(plateHrV2ContactOpportunityV3FeaturesSchema.shape).filter((k) => !legacyKeys.has(k));
const pitcherDisciplineKeys = Object.keys(plateHrV2PitcherDisciplineFeaturesSchema.shape);
const newLeafNames = [...v3ContactKeys, ...pitcherDisciplineKeys];
ok(newLeafNames.length >= 20, `expected the new v3 discipline leaves to be present (got ${newLeafNames.length})`);
for (const name of newLeafNames) {
  const lower = name.toLowerCase();
  for (const term of FORBIDDEN_TERMS) ok(!lower.includes(term), `new v3 leaf "${name}" must not contain forbidden term "${term}"`);
}

// 4. Location-blindness: the authorized (persisted/training) V3 projection carries
//    NO zoneLocation group and NO market group.
const projKeys = new Set(Object.keys(plateHrV2AuthorizedProjectionV3Schema.shape));
ok(!projKeys.has("zoneLocation"), "authorized V3 projection strips zoneLocation");
ok(!projKeys.has("market"), "authorized V3 projection strips market");

// 5. The explicit-unavailable zoneLocation record holds only nulls for every
//    location field (no coordinate/zone can ride along, by type).
const zl = plateHrV2UnavailableZoneLocationV3();
for (const k of ["plateX", "plateZ", "zone", "szTop", "szBot"] as const) ok(zl[k] === null, `zoneLocation.${k} is null`);
ok(zl.status === "unavailable" && zl.reason === "licensed_source_unavailable", "zoneLocation is the licensed_source_unavailable record");

console.log(`retrosheetDisciplineIsolation.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
