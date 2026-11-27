import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseOwnedGeoEvidence } from "./owned-geo-evidence.mjs";

const name = "cove-owned-geo-measurement";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const sha = process.env.GITHUB_SHA;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.equal(process.env.COVE_OWNED_PREPARED_ACCEPTANCE, "1");
assert.match(sha || "", /^[a-f0-9]{40}$/);
assert.match(process.env.COVE_GATE_TEST_BEARER || "", /^[a-f0-9]{64}$/);
const config = "wrangler.owned-geo.run.json";
const secrets = ".owned-geo-secrets.json";
const campaign = randomBytes(16).toString("hex");
const report = {
  sha,
  source: "independent-globalping-via-expiring-fixed-homepage-measurement-adapter",
  origin: "https://ssr-canary.covereads.com",
  // These are regionally repeated bounded bursts; the separate owned ingress
  // campaign certifies independent cold deployments and both 100-RPS phases.
  coldRegionalCapacityCertified: false,
  sustainedRegionalCapacityCertified: false,
  regions: ["ORD", "LAX", "IAD", "DFW"],
  phases: [],
  passed: false,
  cleanup: false,
};
const directory = "artifacts/owned-storefront";
fs.mkdirSync(directory, { recursive: true });
const save = () => fs.writeFileSync(directory + "/geography.json", JSON.stringify(report, null, 2));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const service = "https://api.globalping.io/v1/measurements";
const headers = { "content-type": "application/json", accept: "application/json" };
save();
try {
  fs.writeFileSync(
    config,
    JSON.stringify({
      name,
      main: "scripts/performance/owned-geo-probe-worker.mjs",
      compatibility_date: "2026-10-19",
      workers_dev: true,
      preview_urls: false,
      observability: { enabled: false },
      vars: {
        COVE_GEO_SHA: sha,
        COVE_GEO_CAMPAIGN: campaign,
        COVE_GEO_EXPIRES: String(Date.now() + 300000),
        COVE_GEO_ISOLATED_SNAPSHOT: "15ce2ea3-17f8-4d99-9015-a78a6a3af05d",
      },
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    secrets,
    JSON.stringify({ COVE_SSR_STAGING_GATE_KEY: process.env.COVE_GATE_TEST_BEARER }),
    { mode: 0o600 },
  );
  execFileSync(
    "npm",
    [
      "exec",
      "--yes",
      "--package=wrangler@4.151.0",
      "--",
      "wrangler",
      "deploy",
      "--config",
      config,
      "--secrets-file",
      secrets,
    ],
    { stdio: "inherit", timeout: 90000 },
  );
  fs.rmSync(secrets, { force: true });
  // Control-plane settling only; no authenticated homepage is prewarmed.
  await wait(75000);
  for (const concurrency of [1, 4, 8, 16, 32]) {
    const created = await fetch(service, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "http",
        target: name + ".cove-jibrilmohamud.workers.dev",
        locations: ["Chicago", "Los Angeles", "Ashburn", "Dallas"].map((city) => ({
          country: "US",
          city,
          limit: 1,
        })),
        measurementOptions: {
          protocol: "HTTPS",
          request: { method: "GET", path: "/" + campaign + "/" + concurrency },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(created.status, 202, "Distributed owned-homepage measurement not admitted");
    const queued = await created.json();
    assert.match(queued.id, /^[a-zA-Z0-9-]{10,100}$/);
    let measurement;
    for (let i = 0; i < 45; i++) {
      await wait(1000);
      const result = await fetch(service + "/" + queued.id, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(result.status, 200, "Distributed owned-homepage evidence unavailable");
      measurement = await result.json();
      if (measurement.status !== "in-progress") break;
    }
    const phase = parseOwnedGeoEvidence(measurement, sha, concurrency);
    report.phases.push(phase);
    save();
    console.log(
      JSON.stringify({
        concurrency,
        passed: phase.passed,
        colos: phase.observations.map((item) => item.colo),
      }),
    );
  }
  report.passed = report.phases.length === 5 && report.phases.every((phase) => phase.passed);
  assert.equal(
    report.passed,
    true,
    "Owned catalog regional bursts did not all meet exact-colo, fresh-authority and strict 800ms gates",
  );
} finally {
  fs.rmSync(secrets, { force: true });
  const deleted = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}?force=true`,
    {
      method: "DELETE",
      headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    },
  );
  report.cleanup = deleted.status === 200 || deleted.status === 404;
  save();
  assert.equal(report.cleanup, true, "Temporary geographic measurement adapter cleanup failed");
}
console.log(
  "PASS: owned licensed homepage repeated at 1/4/8/16/32 from ORD/LAX/IAD/DFW; gate credentials remained private",
);
