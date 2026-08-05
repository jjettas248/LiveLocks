// Run: npx tsx server/engines/nbaPregame/flags.test.ts
// Pregame Targets PR3 — shadow flag parser: fail-closed default off, exact
// affirmatives only, public-implies-shadow, no runtime wiring.
import {
  parseNbaPregameFlag,
  readNbaPregameFlags,
  isNbaPregameShadowEnabled,
  isNbaPregamePublicEnabled,
  NBA_PREGAME_SHADOW_ENV,
  NBA_PREGAME_PUBLIC_ENV,
} from "./flags";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── Fail-closed default off ─────────────────────────────────────────────────
{
  ok(!parseNbaPregameFlag(undefined), "undefined → off");
  ok(!parseNbaPregameFlag(null), "null → off");
  ok(!parseNbaPregameFlag(""), "empty → off");
  ok(!parseNbaPregameFlag("tru"), "typo → off");
  ok(!parseNbaPregameFlag("false"), "false → off");
  ok(!parseNbaPregameFlag("0"), "0 → off");
}

// ── Exact affirmatives (case/space-insensitive) ─────────────────────────────
{
  for (const v of ["true", "TRUE", " true ", "1", "on", "YES", "yes"]) {
    ok(parseNbaPregameFlag(v), `"${v}" → on`);
  }
}

// ── readNbaPregameFlags: public implies shadow, fail-closed ─────────────────
{
  ok(JSON.stringify(readNbaPregameFlags({})) === JSON.stringify({ shadow: false, public: false }), "empty env → all off");
  const shadowOnly = readNbaPregameFlags({ [NBA_PREGAME_SHADOW_ENV]: "true" });
  ok(shadowOnly.shadow && !shadowOnly.public, "shadow only → shadow on, public off");
  // Public on but shadow off → public cannot activate without shadow (fail closed),
  // but public turning on implies shadow is on.
  const publicNoShadow = readNbaPregameFlags({ [NBA_PREGAME_PUBLIC_ENV]: "true" });
  ok(publicNoShadow.shadow, "public → shadow implied on");
  ok(!publicNoShadow.public, "public without explicit shadow → public stays gated off (fail closed)");
  const both = readNbaPregameFlags({ [NBA_PREGAME_SHADOW_ENV]: "true", [NBA_PREGAME_PUBLIC_ENV]: "true" });
  ok(both.shadow && both.public, "shadow + public → both on");
}

// ── Convenience readers ─────────────────────────────────────────────────────
{
  ok(isNbaPregameShadowEnabled({ [NBA_PREGAME_SHADOW_ENV]: "1" }), "isShadowEnabled true");
  ok(!isNbaPregameShadowEnabled({}), "isShadowEnabled false default");
  ok(isNbaPregamePublicEnabled({ [NBA_PREGAME_SHADOW_ENV]: "true", [NBA_PREGAME_PUBLIC_ENV]: "true" }), "isPublicEnabled true");
  ok(!isNbaPregamePublicEnabled({ [NBA_PREGAME_PUBLIC_ENV]: "true" }), "isPublicEnabled false without shadow");
}

console.log(`\nflags.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
