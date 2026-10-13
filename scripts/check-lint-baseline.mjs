/**
 * Non-regressing ESLint gate for Cove's pre-existing TypeScript debt.
 *
 * This does NOT disable any ESLint rules. Every file/rule pair has a checked-in
 * maximum count. New files and newly introduced rule violations fail CI.
 * Run `npm run lint:strict` to view all outstanding debt.
 *
 * Replace this ledger only as a consciously reviewed maintenance change, and
 * never regenerate it as part of the normal CI workflow.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative, sep } from "node:path";

const baseline = JSON.parse(readFileSync("config/eslint-legacy-baseline.json", "utf8"));
if (baseline.version !== 1 || !baseline.counts || typeof baseline.counts !== "object") {
  throw new Error("Missing or unsupported reviewed legacy ESLint baseline.");
}

const proc = spawnSync("./node_modules/.bin/eslint", [".", "--format", "json"], {
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
  timeout: 10 * 60 * 1000,
});
if (proc.error || proc.status === null || proc.status > 1) {
  throw new Error("ESLint failed to execute: " + String(proc.error || proc.stderr || proc.status));
}
let results;
try {
  results = JSON.parse(proc.stdout);
  if (!Array.isArray(results)) throw new Error("Expected ESLint JSON report");
} catch (error) {
  console.error(proc.stderr.slice(-3000));
  throw new Error("ESLint did not produce its expected report: " + String(error));
}

let currentErrors = 0;
let currentWarnings = 0;
const regressions = [];
const protectedRules = new Set(["prettier/prettier", "no-restricted-imports"]);
for (const result of results) {
  const file = relative(process.cwd(), result.filePath).split(sep).join("/");
  const ruleCounts = {};
  for (const message of result.messages || []) {
    if (message.severity === 1) {
      currentWarnings++;
      continue;
    }
    if (message.severity !== 2) continue;
    currentErrors++;
    const rule = message.ruleId || "<parser-error>";
    ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
  }
  const permitted = baseline.counts[file] || {};
  for (const [rule, count] of Object.entries(ruleCounts)) {
    const allowed = protectedRules.has(rule) ? 0 : Number(permitted[rule] || 0);
    if (count > allowed) {
      regressions.push({
        file,
        rule,
        existing: allowed,
        actual: count,
        added: count - allowed,
        locations: (result.messages || [])
          .filter((message) => message.severity === 2 && (message.ruleId || "<parser-error>") === rule)
          .map(({ line, column, message }) => ({ line, column, message }))
          .slice(-Math.max(1, count - allowed)),
      });
    }
  }
}
console.log(
  `ESLint: ${currentErrors} known errors, ${currentWarnings} warnings; ${regressions.length} new or increased error groups.`,
);
if (regressions.length) {
  for (const issue of regressions.slice(0, 80))
    console.error("NEW LINT ERROR:", JSON.stringify(issue));
  if (regressions.length > 80) console.error(`And ${regressions.length - 80} further groups.`);
  process.exitCode = 1;
} else {
  console.log(
    "PASS: no unbaselined lint errors. Prettier and restricted imports remain strictly enforced.",
  );
}
