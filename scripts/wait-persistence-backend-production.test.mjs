import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployedBackendRun,
  verifiedBackendDeployment,
  waitForBackendProduction,
} from "./wait-persistence-backend-production.mjs";

const sha = "a".repeat(40);
const fields = { repository: "JibrilMohamud/cove", sha, token: "unit-test", pause: async () => {} };
const run = { id: 100, event: "push", head_sha: sha, status: "completed", conclusion: "success" };
const jobs = [
  {
    name: "deploy",
    conclusion: "success",
    steps: [
      { name: "Deploy persistence Worker", conclusion: "success" },
      { name: "Verify production persistence binding after deployment", conclusion: "success" },
    ],
  },
];
function ok(value) {
  return { ok: true, json: async () => value };
}

test("only the exact main push SHA is eligible for backend acceptance", () => {
  assert.equal(
    deployedBackendRun([run, { ...run, id: 200, head_sha: "b".repeat(40) }], sha)?.id,
    100,
  );
  assert.equal(deployedBackendRun([{ ...run, event: "pull_request" }], sha), null);
  assert.equal(verifiedBackendDeployment(run, jobs), true);
  assert.equal(
    verifiedBackendDeployment(run, [{ ...jobs[0], steps: jobs[0].steps.slice(0, 1) }]),
    false,
  );
  assert.equal(verifiedBackendDeployment({ ...run, conclusion: "failure" }, jobs), false);
});

test("frontend-only pushes proceed without pretending any backend was deployed", async () => {
  let calls = 0;
  const result = await waitForBackendProduction({
    ...fields,
    fetcher: async (url) => {
      assert.match(url, /deploy-persistence-backend\.yml\/runs\?/);
      calls += 1;
      return ok({ workflow_runs: [] });
    },
  });
  assert.equal(result, "not-required");
  assert.equal(calls, 2);
});

test("matched backend deploy is accepted only after verified Worker deployment", async () => {
  let polled = 0;
  const fetcher = async (url) => {
    if (url.includes("/workflows/")) return ok({ workflow_runs: [run] });
    if (url.includes("/jobs?")) return ok({ jobs });
    if (url.endsWith("/actions/runs/100")) {
      polled += 1;
      return ok(polled === 1 ? { ...run, status: "in_progress", conclusion: null } : run);
    }
    throw new Error("Unexpected URL");
  };
  const result = await waitForBackendProduction({ ...fields, fetcher });
  assert.equal(result, "verified");
  assert.equal(polled, 2);
});

test("failed, skipped or mismatched backend releases block performance certification", async () => {
  for (const kind of ["failed", "skipped", "mismatched"]) {
    const fetcher = async (url) => {
      if (url.includes("/workflows/")) return ok({ workflow_runs: [run] });
      if (url.includes("/jobs?")) return ok({ jobs: kind === "skipped" ? [{ ...jobs[0], steps: [] }] : jobs });
      if (url.endsWith("/actions/runs/100"))
        return ok(
          kind === "failed"
            ? { ...run, conclusion: "failure" }
            : kind === "mismatched"
              ? { ...run, head_sha: "b".repeat(40) }
              : run,
        );
      throw new Error("Unexpected URL");
    };
    await assert.rejects(
      waitForBackendProduction({ ...fields, fetcher }),
      /failed|without a verified|changed its target/,
    );
  }
});
