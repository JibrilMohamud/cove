import assert from "node:assert/strict";
import fs from "node:fs";
import { validateCapacityEvidence } from "../performance/strangler-capacity-evidence.mjs";

const file = (name) => "artifacts/strangler-" + name + ".json";
const groups = [
  ...[1, 2, 3].map((trial) => ({
    name: "cold-" + trial,
    file: file("cold-trial-" + trial),
    mode: "cold",
    transport: "native-fetch",
  })),
  ...["native-fetch", "http2"].map((transport) => ({
    name: "bursts-" + transport,
    file: file("bursts-" + transport),
    mode: "bursts",
    transport,
  })),
];
let failures = 0;
for (const group of groups) {
  if (!fs.existsSync(group.file)) {
    console.error("COVE_CAPACITY_RELEASE_GATE " + group.name + ": missing artifact");
    failures++;
    continue;
  }
  const data = JSON.parse(fs.readFileSync(group.file, "utf8"));
  const { valid, failures: reasons } = validateCapacityEvidence(data, {
    sha: process.env.GITHUB_SHA,
    mode: group.mode,
    transport: group.transport,
  });
  console.log(
    "COVE_CAPACITY_RELEASE_GATE " +
      JSON.stringify({
        name: group.name,
        valid,
        reasons,
        phases:
          data.phases?.map((item) => ({
            name: item.name,
            offered: item.offered,
            valid: item.valid,
            p95Ms: item.p95Ms,
            p99Ms: item.p99Ms,
            maxMs: item.maxMs,
            pass: item.pass,
            bootstrapP95Ms: item.bootstrapP95Ms,
            residualP95Ms: item.residualP95Ms,
          })) || [],
      }),
  );
  if (!valid) failures++;
}
assert.equal(failures, 0, "Cove architecture release capacity evidence is not yet green");
