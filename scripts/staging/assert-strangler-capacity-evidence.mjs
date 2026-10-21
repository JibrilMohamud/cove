import assert from "node:assert/strict";
import fs from "node:fs";

const file = (name) => "artifacts/strangler-" + name + ".json";
const groups = [
  ...[1, 2, 3].map((trial) => ({
    name: "cold-" + trial,
    file: file("cold-trial-" + trial),
    expected: ["new-deployment-cold-20"],
  })),
  ...["native-fetch", "http2"].map((transport) => ({
    name: "bursts-" + transport,
    file: file("bursts-" + transport),
    expected: [
      "1-concurrent",
      "4-concurrent",
      "8-concurrent",
      "16-concurrent",
      "32-concurrent",
      "25-rps-10s",
      "50-rps-10s",
      "100-rps-10s",
      "transport-control-32",
      "transport-25-rps-10s",
      "real-core-delegation",
    ],
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
  const received = new Set(data.phases?.map((item) => item.name) || []);
  const valid =
    data.phases?.length === group.expected.length &&
    group.expected.every((name) => received.has(name)) &&
    data.phases.every(
      (item) =>
        item.pass === true &&
        item.offered > 0 &&
        item.valid === item.offered &&
        item.delivered === item.offered &&
        item.dropped === 0 &&
        item.maxMs < 800 &&
        item.p95Ms < 650,
    );
  console.log(
    "COVE_CAPACITY_RELEASE_GATE " +
      JSON.stringify({
        name: group.name,
        valid: Boolean(valid),
        phases:
          data.phases?.map((item) => ({
            name: item.name,
            offered: item.offered,
            valid: item.valid,
            p95Ms: item.p95Ms,
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
