import assert from "node:assert/strict";
import test from "node:test";
import {
  burstPhases,
  coldPhases,
  validateCapacityEvidence,
} from "./strangler-capacity-evidence.mjs";
import { assertCapacityClosure } from "../staging/verify-strangler-capacity-closure.mjs";

const sha = "a".repeat(40);
function fixture(mode = "bursts", transport = "native-fetch") {
  return {
    schema: "cove.strangler-capacity.v2",
    sha,
    transport,
    mode,
    phases: Object.entries(mode === "cold" ? coldPhases : burstPhases).map(([name, count]) => ({
      name,
      offered: count,
      delivered: count,
      valid: count,
      dropped: 0,
      lateArrivals: 0,
      p95Ms: 100,
      p99Ms: 200,
      maxMs: 300,
      pass: true,
    })),
  };
}
const accepted = (data, mode = "bursts", transport = "native-fetch") =>
  validateCapacityEvidence(data, { sha, mode, transport }).valid;

test("both transports need both complete 2000-arrival sustained phases", () => {
  for (const transport of ["native-fetch", "http2"]) {
    const data = fixture("bursts", transport);
    assert.equal(accepted(data, "bursts", transport), true);
    const second = data.phases.find((p) => p.name === "100-rps-20s-phase-2");
    second.offered = second.delivered = second.valid = 2;
    assert.equal(
      accepted(data, "bursts", transport),
      false,
      "A green two-request phase is insufficient",
    );
  }
});
test("omitted, duplicated, dropped, late and failed phases cannot be hidden", () => {
  for (const mutate of [
    (d) => d.phases.pop(),
    (d) => {
      d.phases[1] = structuredClone(d.phases[0]);
    },
    (d) => {
      d.phases[0].dropped = 1;
    },
    (d) => {
      d.phases[0].lateArrivals = 1;
    },
    (d) => {
      d.phases[0].valid = 0;
    },
    (d) => {
      d.phases[0].pass = false;
    },
  ]) {
    const data = fixture();
    mutate(data);
    assert.equal(accepted(data), false);
  }
});
test("strict maximum and sustained tails reject equality and invalid metrics", () => {
  for (const [field, value] of [
    ["maxMs", 800],
    ["p95Ms", 600],
    ["p99Ms", 750],
    ["maxMs", null],
    ["p95Ms", -1],
  ]) {
    const data = fixture();
    const phase = data.phases.find((p) => p.name === "100-rps-20s-phase-1");
    phase[field] = value;
    if (value === 600 || value === 750) phase.maxMs = 799;
    assert.equal(accepted(data), false);
  }
});
test("stale revision, wrong transport/mode, old schema and short cold trials fail", () => {
  for (const [field, value] of [
    ["sha", "b".repeat(40)],
    ["transport", "http2"],
    ["mode", "cold"],
    ["schema", "v1"],
  ]) {
    const data = fixture();
    data[field] = value;
    assert.equal(accepted(data), false);
  }
  const cold = fixture("cold");
  assert.equal(accepted(cold, "cold"), true);
  cold.phases[0].offered = cold.phases[0].delivered = cold.phases[0].valid = 1;
  assert.equal(accepted(cold, "cold"), false);
});

test("stage closure needs independently closed ingress and restored isolated capabilities", () => {
  const state = () => ({
    subdomain: { enabled: false, previews_enabled: false },
    domains: [],
    routes: [],
    settings: {
      bindings: [
        { type: "d1", database_id: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" },
        { name: "COVE_SSR_STAGING", text: "1" },
        { name: "COVE_STRANGLER_MODE", text: "isolated-evaluation" },
        { name: "COVE_STOREFRONT_READ_LIMITER", simple: { limit: 180 } },
      ],
    },
    deployments: {
      deployments: [
        { versions: [{ version_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", percentage: 100 }] },
      ],
    },
  });
  assert.doesNotThrow(() => assertCapacityClosure(state()));
  for (const mutate of [
    (s) => {
      s.subdomain.enabled = true;
    },
    (s) => {
      s.subdomain.previews_enabled = true;
    },
    (s) => {
      s.domains.push({ service: "cove-strangler-m1-staging" });
    },
    (s) => {
      s.routes.push({ script: "cove-strangler-m1-staging" });
    },
    (s) => {
      s.settings.bindings[0].database_id = "4bd657ac-8789-403e-a28c-93aba8d0a989";
    },
    (s) => {
      s.settings.bindings[1].text = "0";
    },
    (s) => {
      s.settings.bindings[3].simple.limit = 10000;
    },
    (s) => {
      s.settings.bindings.push({ name: "PRESENTATION" });
    },
    (s) => {
      s.deployments.deployments[0].versions[0].percentage = 50;
    },
  ]) {
    const data = state();
    mutate(data);
    assert.throws(() => assertCapacityClosure(data));
  }
});
