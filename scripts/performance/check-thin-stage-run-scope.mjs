import assert from "node:assert/strict";
import { thinRunWorkerNames, scopedStageConfigs } from "./thin-stage-run-scope.mjs";
import fs from "node:fs";
import { parseThinConfig, parseBenchmarkConfig } from "./thin-config.mjs";

const first = thinRunWorkerNames("39541802055");
const second = thinRunWorkerNames("39541802056");
assert.equal(first.ingress, "cove-thin-ingress-39541802055");
assert.equal(first.thin, "cove-thin-pilot-39541802055");
assert.equal(new Set([...Object.values(first), ...Object.values(second)]).size, 8);
for (const invalid of ["", "prod", "../main", "39541802055suffix", "1", "39541802055/"])
  assert.throws(() => thinRunWorkerNames(invalid));
const thin = parseThinConfig(fs.readFileSync("wrangler.storefront-thin.jsonc", "utf8"));
const ingress = parseBenchmarkConfig(
  fs.readFileSync("wrangler.storefront-benchmark.jsonc", "utf8"),
);
const expected = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const result = scopedStageConfigs(thin, ingress, first, expected);
assert.equal(result.thin.name, first.thin);
assert.equal(result.thin.services[0].service, first.core);
assert.equal(result.ingress.name, first.ingress);
assert.equal(result.ingress.services.find((x) => x.binding === "THIN").service, first.thin);
assert.equal(result.ingress.services.find((x) => x.binding === "BASELINE").service, first.baseline);
assert.equal(result.thin.d1_databases[0].database_id, expected);
assert.equal(thin.name, "cove-thin-pilot-staging", "Committed config stays unchanged");
assert.equal(ingress.name, "cove-thin-ingress-staging");
assert.throws(() =>
  scopedStageConfigs(
    {
      ...thin,
      d1_databases: [
        { ...thin.d1_databases[0], database_id: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
      ],
    },
    ingress,
    first,
    expected,
  ),
);
assert.throws(() =>
  scopedStageConfigs(thin, { ...ingress, routes: ["*example.org/*"] }, first, expected),
);
assert.throws(() =>
  scopedStageConfigs(
    thin,
    { ...ingress, services: [{ binding: "THIN", service: "cove-production" }] },
    first,
    expected,
  ),
);
console.log(
  "PASS: private run-scoped synthetic Workers; service bindings and destructive cleanup isolated by run ID",
);
