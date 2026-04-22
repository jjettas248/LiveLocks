import { storage } from "../server/storage";
import { validateHrRadarLadder } from "../server/validation/hrRadar/ladderInvariants";

async function main() {
  const ladder = await storage.getHrRadarLadder();
  const report = validateHrRadarLadder(ladder);
  console.log(JSON.stringify({
    sessionDate: ladder.sessionDate,
    ok: report.violations.length === 0,
    totalRows: report.totalRows,
    liveRows: report.liveRows,
    resolvedRows: report.resolvedRows,
    violationCount: report.violations.length,
    violationCodes: report.violations.reduce((acc: Record<string, number>, v) => {
      acc[v.code] = (acc[v.code] ?? 0) + 1;
      return acc;
    }, {}),
    sampleViolations: report.violations.slice(0, 10),
    sectionCounts: Object.fromEntries(
      Object.entries(ladder.sections).map(([k, v]: [string, any[]]) => [k, v.length]),
    ),
  }, null, 2));
  process.exit(report.violations.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
