import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import yaml from "js-yaml";

const workflow = yaml.load(readFileSync(".github/workflows/security.yml", "utf8"));
const jobs = workflow.jobs;

test("dependency compatibility checks run before their mandatory high-severity audit", () => {
  const compatibility = yaml.load(
    readFileSync(".github/workflows/zod-security-compatibility.yml", "utf8"),
  ).jobs["secured-v4-runtime"];
  assert.equal(compatibility["continue-on-error"], undefined);
  for (const step of compatibility.steps) assert.equal(step["continue-on-error"], undefined);
  const runs = compatibility.steps.filter((step) => step.run).map((step) => step.run);
  assert.equal(runs.at(-1), "npm audit --audit-level=high");
  for (const command of [
    "npm run typecheck",
    "npm run test:rights",
    "npm run test:commerce",
    "npm run test:soundtracks",
    "npm run test:matching",
  ]) {
    assert.ok(runs.indexOf(command) > 0 && runs.indexOf(command) < runs.length - 1);
  }
});

test("the protected supply-chain check requires independent audit and source checks", () => {
  assert.deepEqual(jobs["supply-chain"].needs, ["dependency-audit", "source-checks"]);
  assert.equal(jobs["supply-chain"].if, "${{ always() }}");
  assert.equal(jobs["dependency-audit"].needs, undefined);
  assert.equal(jobs["source-checks"].needs, undefined);
  assert.equal(jobs["dependency-audit"].if, undefined);
  assert.equal(jobs["source-checks"].if, undefined);
  assert.equal(jobs.provenance.needs, "supply-chain");
  assert.equal(
    jobs.provenance.if,
    "github.event_name == 'push' && github.ref == 'refs/heads/main'",
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const name of ["dependency-audit", "source-checks", "supply-chain"]) {
    assert.equal(jobs[name]["continue-on-error"], undefined);
    for (const step of jobs[name].steps) assert.equal(step["continue-on-error"], undefined);
  }
  const audit = jobs["dependency-audit"].steps.find(
    (step) => step.name === "Dependency vulnerability audit",
  );
  assert.equal(audit.run, "npm audit --audit-level=high");
  assert.equal(audit.if, undefined);
  assert.ok(jobs["source-checks"].steps.some((step) => step.run === "npm run typecheck"));
  assert.ok(jobs["source-checks"].steps.some((step) => step.run === "npm run build"));
  assert.ok(jobs["source-checks"].steps.some((step) => step.run === "npm run security:sbom"));
});

test("the actual aggregate command rejects failures, skips, cancellations and missing results", () => {
  const gate = jobs["supply-chain"].steps[0];
  assert.deepEqual(gate.env, {
    DEPENDENCY_AUDIT_RESULT: "${{ needs.dependency-audit.result }}",
    SOURCE_CHECKS_RESULT: "${{ needs.source-checks.result }}",
  });
  for (const audit of ["success", "failure", "skipped", "cancelled", "", "unknown"]) {
    for (const source of ["success", "failure", "skipped", "cancelled", "", "unknown"]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", gate.run], {
        encoding: "utf8",
        timeout: 5000,
        env: { DEPENDENCY_AUDIT_RESULT: audit, SOURCE_CHECKS_RESULT: source },
      });
      assert.ifError(result.error);
      assert.equal(
        result.status,
        audit === "success" && source === "success" ? 0 : 1,
        `audit=${audit} source=${source}: ${result.stdout} ${result.stderr}`,
      );
    }
  }
});
