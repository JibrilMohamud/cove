import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseOwnedGeoEvidence } from "./owned-geo-evidence.mjs";
import {
  routeCandidates,
  pinnedRoute,
  routeSelectionEvidence,
  measurePinnedRegion,
} from "./owned-geo-selection.mjs";

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
  routingRejections: [],
  receiptMetric: "external-evidence-receipt-not-homepage-ttfb",
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
      // The target is another Worker in this account. Explicitly traverse
      // its public HTTPS front door, never a private-origin routing shortcut.
      compatibility_flags: ["global_fetch_strictly_public"],
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
  async function measure(locations, suffix) {
    const created = await fetch(service, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "http",
        target: name + ".cove-jibrilmohamud.workers.dev",
        locations,
        measurementOptions: {
          protocol: "HTTPS",
          request: { method: "GET", path: "/" + campaign + "/" + suffix },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(created.status, 202, "Distributed measurement not admitted");
    const queued = await created.json();
    assert.match(queued.id, /^[a-zA-Z0-9-]{10,100}$/);
    for (let i = 0; i < 45; i++) {
      await wait(1000);
      const result = await fetch(service + "/" + queued.id, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(result.status, 200, "Distributed evidence unavailable");
      const measurement = await result.json();
      if (measurement.status !== "in-progress") return measurement;
    }
    throw Error("Distributed measurement incomplete");
  }
  const discovery = await measure(
    [
      // Chicago networks can be served in ATL/CMH even while other Chicago
      // probes reach ORD. Discover broadly before pinning by actual ingress;
      // 42 route-only probes remain below Globalping's 50-probe request cap.
      { country: "US", city: "Chicago", limit: 30 },
      ...["Los Angeles", "Ashburn", "Dallas"].map((city) => ({ country: "US", city, limit: 4 })),
    ],
    "route",
  );
  report.routeDiscovery = routeSelectionEvidence(discovery, sha);
  report.routePins = [];
  const candidates = routeCandidates(discovery, sha);
  save();
  // Candidate order is fixed by route-only discovery, never by timed latency.
  // Remember already tried networks per region so a drifted pin can be replaced
  // by another independently verified network without redoing timed work.
  const used = new Map(report.regions.map((colo) => [colo, new Set()]));
  async function pinRegion(colo) {
    const seen = used.get(colo);
    for (const candidate of candidates.filter((value) => value.colo === colo)) {
      const key = JSON.stringify(candidate.location);
      if (seen.has(key)) continue;
      seen.add(key);
      const verified = await measure([candidate.location], "route");
      report.routePins.push(routeSelectionEvidence(verified, sha));
      save();
      const pin = pinnedRoute(verified, sha, colo);
      if (pin) return pin;
    }
    return null;
  }
  const pinResults = await Promise.allSettled(
    report.regions.map(async (colo) => {
      const pin = await pinRegion(colo);
      assert.ok(pin, "No stable independent probe reaches required ingress " + colo);
      return pin;
    }),
  );
  assert.ok(
    pinResults.every((result) => result.status === "fulfilled"),
    "Independent route-only probe pinning failed: " +
      pinResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason.message)
        .join("; "),
  );
  const pins = pinResults.map((result) => result.value);
  report.pinnedProbes = [...pins];
  save();
  for (const concurrency of [1, 4, 8, 16, 32]) {
    // All actual timed bursts remain concurrent across the four regions.
    // Retry ONLY run-bound zero-upstream route rejections; retain each in
    // the evidence. A failed actual homepage sample is never replaced.
    const completed = await Promise.allSettled(
      pins.map((pin) =>
        measurePinnedRegion({
          pin,
          sha,
          campaign,
          concurrency,
          measure,
          rePin: (previous) => pinRegion(previous.colo),
          onRejected: (rejection) => {
            report.routingRejections.push(rejection);
            save();
          },
        }),
      ),
    );
    assert.ok(
      completed.every((result) => result.status === "fulfilled"),
      "Timed regional measurement failed; no samples retried",
    );
    const measurement = completed.map((result, index) => {
      pins[index] = result.value.pin;
      return result.value.measurement;
    });
    report.finalPinnedProbes = [...pins];
    const phase = parseOwnedGeoEvidence(measurement, sha, concurrency);
    report.phases.push(phase);
    save();
    console.log(
      JSON.stringify({
        concurrency,
        passed: phase.passed,
        colos: phase.observations.map((item) => item.colo),
        observations: phase.observations.map(
          ({ colo, valid, receiptMs, maxHomepageTtfbMs, rows }) => ({
            colo,
            valid,
            receiptMs,
            maxHomepageTtfbMs,
            samples: rows.length,
            invalid: rows.filter(
              (row) => !row.valid || !Number.isFinite(row.ttfbMs) || row.ttfbMs >= 800,
            ).length,
          }),
        ),
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
