import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

async function loadSource(path) {
  const source = fs.readFileSync(path, "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}
const { classifyThrownStorefrontAdmission: classify } = await loadSource(
  "src/features/fore/storefront-thrown-admission.ts",
);
function apiError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
assert.equal(classify(apiError(429, "Please wait a minute before trying again.")), "throttled");
assert.equal(
  classify(apiError(503, "Native storefront read limiter is unavailable.")),
  "limiter_unavailable",
);
for (const error of [
  null,
  "429",
  { status: 429, message: "Please wait a minute before trying again." },
  new Error("private D1 connection failure"),
  apiError(429, "private hidden upstream details"),
  apiError(503, "private SQL failure"),
  apiError(403, "Please wait a minute before trying again."),
]) {
  assert.equal(classify(error), null, "Unknown error may not invent quota classification");
}

const { sanitizedStagingCatalogFailureTiming: safeTiming } = await loadSource(
  "src/lib/staging-empty-catalog-response.ts",
);
assert.equal(
  safeTiming(
    "cove_ssr_primary_throttled;dur=0, cove_ssr_primary_limiter_unavailable;dur=0, " +
      "cove_ssr_primary_d1_overload;dur=0",
  ),
  "cove_ssr_empty;dur=0, cove_ssr_primary_throttled;dur=0, " +
    "cove_ssr_primary_limiter_unavailable;dur=0, cove_ssr_primary_d1_overload;dur=0",
);
assert.equal(
  safeTiming('cove_ssr_primary_limiter_unavailable;dur=0;desc="private"'),
  "cove_ssr_empty;dur=0",
);
const hedged = fs.readFileSync("src/features/fore/storefront-hedged-fetch.ts", "utf8");
assert.match(hedged, /const admission = classifyThrownStorefrontAdmission\(error\)/);
assert.match(hedged, /if \(admission\) options\.onPrimaryAdmissionFailure\?\.\(admission\)/);
assert.match(hedged, /if \(isPrimaryD1Overload\(error\)\) options\.onPrimaryD1Overload\?\.\(\)/);
const loader = fs.readFileSync("src/features/fore/storefront-loader.ts", "utf8");
assert.match(loader, /phase\.primaryAdmissionFailure = kind/);
assert.match(loader, /phase\.primaryAdmissionFailure \|\|\s*phase\.primaryHttpFailure/);
assert.match(loader, /cove_ssr_primary_\$\{reason\};dur=0/);
// No retry, quota, authority, API handler, database or entitlement changes.
console.log("Protected SSR classifies only exact thrown edge quota/outage vs D1 7429: PASS");

assert.equal(
  safeTiming(
    "cove_ssr_read_catalog;dur=0, cove_ssr_read_transient_service;dur=0, cove_ssr_primary_invalid_bootstrap;dur=0",
  ),
  "cove_ssr_empty;dur=0, cove_ssr_read_catalog;dur=0, cove_ssr_read_transient_service;dur=0, cove_ssr_primary_invalid_bootstrap;dur=0",
);
assert.equal(
  safeTiming(
    'cove_ssr_read_private_sql;dur=0, cove_ssr_read_catalog;dur=1, cove_ssr_read_database;dur=0;desc="private"',
  ),
  "cove_ssr_empty;dur=0",
);
