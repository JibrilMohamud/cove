import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  inventoryLegacyCloudflareCredential,
  requireNoLegacyCloudflareWorkflowReferences,
} from "./audit-legacy-cloudflare-credential.mjs";

const repo = "JibrilMohamud/cove";
const protectedAction = "confirm_protected_cloudflare_action";
const child = (name, jobs, confirmation = protectedAction, extra = {}) => ({
  name: name + ".yml",
  jobs,
  inputs: { [confirmation]: "true", ...extra },
});
const lanes = [
  [
    child("cove-commerce-private-qa-deploy", ["private-commerce", "authenticated-commerce"]),
    child("deployed-commerce-browser-acceptance", ["authenticated-commerce"]),
  ],
  [
    child(
      "fast-storefront-real-catalog-acceptance",
      ["protected-real-catalog-acceptance"],
      "confirm_real_catalog_readonly",
    ),
    child("strangler-hosted-capacity-evaluation", ["protected-staging-only"]),
    child("cove-sounds-private-rollout", ["private-sounds-release"], "confirm_private_sounds", {
      disable_private_sounds: "false",
    }),
    child("covereads-secure-ssr-gateway", ["isolated-asset-auth"], "confirm_isolated_stage_only"),
  ],
  [
    child("publication-source-isolation-qa", ["physically-isolated-publication"]),
    child("continuous-publication-qa", ["private-qa"]),
  ],
  [child("literary-progressive-canonical-publication", ["protected-publish"])],
];

function requiredJobsPassed(jobs, names) {
  return names.every((name) => {
    const found = jobs.filter((job) => job.name === name);
    return (
      found.length === 1 && found[0].status === "completed" && found[0].conclusion === "success"
    );
  });
}
function matchNewRuns(runs, known, sha) {
  return runs.filter(
    (run) =>
      !known.has(run.id) &&
      run.head_sha === sha &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch",
  );
}
function sourceContract() {
  assert.equal(new Set(lanes.flat().map((task) => task.name)).size, 9);
  for (const task of lanes.flat()) {
    const source = readFileSync(".github/workflows/" + task.name, "utf8");
    assert.ok(source.includes("  workflow_dispatch:"));
    assert.ok(source.includes("inputs.reviewed_main_sha == github.sha"));
    for (const name of task.jobs) {
      const start = source.indexOf("  " + name + ":\n");
      assert.ok(start >= 0, "Missing child job: " + name);
      const tail = source.slice(start);
      const next = tail.slice(1).search(/\n  [a-z][a-z0-9-]+:\n/);
      const job = next < 0 ? tail : tail.slice(0, next + 1);
      assert.ok(job.includes("environment: cove-production-release-audit"));
      assert.ok(job.includes("github.event_name == 'workflow_dispatch'"));
      assert.ok(job.includes("github.ref == 'refs/heads/main'"));
      assert.ok(job.includes("inputs.reviewed_main_sha == github.sha"));
      for (const [input, value] of Object.entries(task.inputs))
        if (value === "true") assert.ok(job.includes("inputs." + input + " == true"));
    }
  }
  const sounds = lanes.flat().find((task) => task.name === "cove-sounds-private-rollout.yml");
  assert.equal(sounds.inputs.disable_private_sounds, "false");
  const fixture = { id: 3, head_sha: "sha", head_branch: "main", event: "workflow_dispatch" };
  assert.deepEqual(matchNewRuns([fixture], new Set([3]), "sha"), []);
  assert.deepEqual(matchNewRuns([fixture], new Set(), "wrong"), []);
  assert.deepEqual(matchNewRuns([fixture], new Set(), "sha"), [fixture]);
  assert.equal(
    requiredJobsPassed(
      [{ name: "protected", status: "completed", conclusion: "skipped" }],
      ["protected"],
    ),
    false,
  );
  assert.equal(
    requiredJobsPassed(
      [{ name: "protected", status: "completed", conclusion: "success" }],
      ["protected"],
    ),
    true,
  );
  assert.equal(requiredJobsPassed([], ["protected"]), false);
  console.log("PASS: nine fixed children, exact-main protected admission, no skipped hosted jobs");
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 45000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function api(path) {
  return JSON.parse(gh(["api", "repos/" + repo + "/" + path]));
}
function listRuns(task) {
  const query =
    "actions/workflows/" + task.name + "/runs?branch=main&event=workflow_dispatch&per_page=100";
  const response = api(query);
  assert.ok(Array.isArray(response.workflow_runs));
  return response.workflow_runs;
}
function requireMain(sha) {
  assert.equal(api("git/ref/heads/main").object.sha, sha, "Main advanced; stop protected batch");
}
async function runChild(task, sha) {
  requireMain(sha);
  const prior = listRuns(task);
  assert.ok(
    prior.every((run) => run.status === "completed"),
    "Child already active: " + task.name,
  );
  const known = new Set(prior.map((run) => run.id));
  const fields = Object.entries({ reviewed_main_sha: sha, ...task.inputs }).flatMap(
    ([key, value]) => ["-f", key + "=" + value],
  );
  gh(["workflow", "run", task.name, "-R", repo, "--ref", "main", ...fields]);
  let id;
  for (let attempt = 0; attempt < 45; attempt++) {
    const matches = matchNewRuns(listRuns(task), known, sha);
    assert.ok(matches.length <= 1, "Ambiguous child dispatch: " + task.name);
    if (matches.length === 1) {
      id = matches[0].id;
      break;
    }
    await sleep(4000);
  }
  assert.ok(Number.isSafeInteger(id), "Child dispatch not observed: " + task.name);
  for (let attempt = 0; attempt < 260; attempt++) {
    const run = api("actions/runs/" + id);
    assert.equal(run.head_sha, sha);
    assert.equal(run.head_branch, "main");
    assert.equal(run.event, "workflow_dispatch");
    if (run.status === "completed") {
      const result = api("actions/runs/" + id + "/jobs?filter=latest&per_page=100");
      assert.equal(result.total_count, result.jobs.length, "Incomplete job inventory");
      const passed = run.conclusion === "success" && requiredJobsPassed(result.jobs, task.jobs);
      return { workflow: task.name, runId: id, passed, conclusion: run.conclusion };
    }
    await sleep(15000);
  }
  return { workflow: task.name, runId: id, passed: false, conclusion: "timeout" };
}

sourceContract();
if (!process.argv.includes("--self-test")) {
  assert.equal(process.env.GITHUB_REPOSITORY, repo);
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  const sha = process.env.REVIEWED_SHA;
  assert.match(sha || "", /^[a-f0-9]{40}$/);
  assert.equal(process.env.GITHUB_SHA, sha);
  assert.equal(gh(["api", "repos/" + repo + "/git/ref/heads/main", "--jq", ".object.sha"]), sha);
  requireNoLegacyCloudflareWorkflowReferences(inventoryLegacyCloudflareCredential());
  const directory = "artifacts/credential-retirement-hosted";
  mkdirSync(directory, { recursive: true });
  const results = [];
  const save = () =>
    writeFileSync(
      directory + "/results.json",
      JSON.stringify({ sha, results, physicalRevocationCertified: false }, null, 2) + "\n",
    );
  const runLane = async (lane) => {
    let failed = false;
    for (const task of lane) {
      let result;
      if (failed) result = { workflow: task.name, passed: false, conclusion: "dependency-failed" };
      else {
        try {
          result = await runChild(task, sha);
        } catch {
          result = {
            workflow: task.name,
            passed: false,
            conclusion: "dispatch-or-evidence-failure",
          };
        }
      }
      results.push(result);
      save();
      console.log(JSON.stringify(result));
      // Only the same fixture's dependent browser or continuous deployment
      // is blocked. Capacity and Sounds are distinct gates.
      if (lane === lanes[0] || lane === lanes[2]) failed ||= !result.passed;
    }
  };
  // Do not overlap heavy primary reads with the publication capture, and
  // keep old owned SSR stress last. Independent commerce still overlaps.
  await Promise.all([
    runLane(lanes[0]),
    (async () => {
      await runLane(lanes[2]);
      await runLane(lanes[3]);
      await runLane(lanes[1]);
    })(),
  ]);
  assert.equal(results.length, 9);
  assert.ok(
    results.every((result) => result.passed),
    "Hosted replacement acceptance incomplete",
  );
  requireMain(sha);
  console.log("PASS: all nine hosted replacement checks; physical revocation NOT certified");
}
