import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// This imported file contains 33 reviewed canonical SQL mutations. Editing it,
// even to redact logs, invalidates the exact source-bound writer fingerprints.
// This test preserves the release hold until its writer sites are re-attested.
const api = readFileSync("src/features/fore/api.server.ts", "utf8");
const backendWrangler = readFileSync("wrangler.backend.production.toml", "utf8");
const backendDeploy = readFileSync(".github/workflows/deploy-persistence-backend.yml", "utf8");

const riskyLogCalls = [
  'console.warn("Initial search index sync failed", error)',
  'console.warn("Commercial catalog search failed closed", error)',
  'console.warn("Catalog asset maintenance failed", error)',
  'console.warn("Regional search sync failed", error)',
  'console.warn("Catalog search sync failed", error)',
  'console.error("Reading Journey generation failed", e)',
  'console.error("Annotation version anchor snapshot failed", e)',
];

test("track imported Worker API raw-error logger risks until writer re-review", () => {
  // A changed count means a fresh inventory and reviewer decision is needed.
  const allCalls = [...api.matchAll(/console\.(?:warn|error|info|log|debug)\s*\(/g)];
  assert.equal(allCalls.length, 9, "Unreviewed API handler log site");
  for (const site of riskyLogCalls) {
    assert.equal(api.split(site).length - 1, 1, "Writer-bound API logger changed: re-review required");
  }
});

test("full production Worker invocation logging is forbidden while raw API errors remain", () => {
  // Production source configs and the actual generated deploy workflow must
  // BOTH stay logging-disabled; changing the checked-in TOML alone is insufficient.
  assert.doesNotMatch(
    backendWrangler,
    /(?:observability|logpush\s*=\s*true|tail_consumers)/i,
    "Do not enable production Worker Logs before imported API redaction and writer re-review",
  );
  assert.doesNotMatch(
    backendDeploy,
    /(?:observability|logpush\s*=\s*true|tail_consumers)/i,
    "Generated production Wrangler config must not enable unsafe Worker Logs",
  );
});
