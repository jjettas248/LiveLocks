import { runNBAValidation, formatValidationReport } from "./harness";

const result = runNBAValidation();
const report = formatValidationReport(result);
console.log(report);

process.exit(result.passed ? 0 : 1);
