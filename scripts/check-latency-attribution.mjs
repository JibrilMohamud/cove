import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnoseAttribution, writeAttributionReport } from "./performance/analyze-attribution.mjs";
import { isolatedD1Config, PRODUCTION_D1_ID } from "./performance/isolated-d1-gate.mjs";

// Offline deterministic regression test; never deploy and never query D1.
const fixture = {
  allValid: true,
  matchedColos: true,
  clientRegion: "unverified-gh-runner",
  clientRegionVerified: false,
  byRole: { baseline: [], current: [] },
  summaries: {
    baseline: [],
    current: [],
  },
  overlap: [],
};
for (const stage of ["edge", "d1", "rights", "bootstrap", "ssr"]) {
  for (const role of ["baseline", "current"]) {
    fixture.summaries[role].push({
      stage,
      concurrency: 8,
      requested: 8,
      valid: 8,
      latencyMs: {
        p50:
          stage === "edge"
            ? 190
            : stage === "d1"
              ? 240
              : stage === "rights"
                ? 590
                : stage === "bootstrap"
                  ? 640
                  : 1020,
        p95:
          stage === "edge"
            ? 220
            : stage === "d1"
              ? 270
              : stage === "rights"
                ? 660
                : stage === "bootstrap"
                  ? 700
                  : 1110,
        max: 1210,
      },
      cfWorkerMs: null,
      workerMetricCoverage: 0,
      sqlMs: null,
      colos: ["IAD"],
    });
  }
  fixture.overlap.push({ stage, concurrency: 8, sharedColos: ["IAD"] });
}
const diagnostic = diagnoseAttribution(fixture, {});
assert.equal(diagnostic.rootCauseProven, false);
assert.match(diagnostic.confidence, /cfWorker absent/);
assert.ok(diagnostic.hypotheses.some((x) => x.includes("Rights-bearing shelf")));
assert.ok(diagnostic.hypotheses.some((x) => x.includes("Full SSR")));
assert.equal(diagnostic.verifiedClientRegion, false);
const target = fs.mkdtempSync(path.join(os.tmpdir(), "cove-attribution-"));
try {
  const { jsonFile, csvFile, mdFile } = writeAttributionReport(fixture, {
    root: target,
    revision: { baseline: "same", current: "same" },
    workerPlatform: {},
  });
  assert.equal(JSON.parse(fs.readFileSync(jsonFile)).diagnostic.rootCauseProven, false);
  assert.match(fs.readFileSync(mdFile, "utf8"), /NOT full Worker CPU\/wall/);
  assert.match(fs.readFileSync(csvFile, "utf8"), /current,ssr,8,8,8/);
  assert.doesNotMatch(fs.readFileSync(mdFile, "utf8"), /production SLO qualification achieved/i);
} finally {
  fs.rmSync(target, { recursive: true, force: true });
}
const template = fs.readFileSync("wrangler.frontend.staging.toml", "utf8");
const generated =
  isolatedD1Config(template, "current", "cove-lazyfacet-candidate-staging", "732011") +
  '\nCOVE_SSR_DIAGNOSTICS = "1"\n';
assert.doesNotMatch(generated, new RegExp(PRODUCTION_D1_ID));
assert.match(generated, /COVE_SSR_STAGING = "1"/);
assert.match(generated, /COVE_SSR_DIAGNOSTICS = "1"/);
assert.doesNotMatch(template, /COVE_SSR_DIAGNOSTICS/);
assert.doesNotMatch(
  fs.readFileSync("wrangler.frontend.production.toml", "utf8"),
  /COVE_SSR_DIAGNOSTICS/,
);
const server = fs.readFileSync("src/server.ts", "utf8");
assert.match(
  server,
  /if \(!staging \|\| foreEnv\.COVE_SSR_DIAGNOSTICS !== "1" \|\| !foreEnv\.DB\)/,
);
assert.ok(
  server.indexOf("rejectUnauthenticatedStagingRequest(request, foreEnv)") <
    server.indexOf('new URL(request.url).pathname.startsWith("/__cove_perf/")'),
  "Diagnostic routes must run AFTER fail-closed bearer authorization",
);
console.log(
  "PASS: honest attribution hypotheses, synthetic-only config and stage authorization ordering.",
);
