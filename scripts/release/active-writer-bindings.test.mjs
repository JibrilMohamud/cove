import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectActiveWriterBindings } from "./active-writer-bindings.mjs";
import { evaluatePhysicalWriterInventory } from "./certify-exclusive-primary-d1.mjs";

const BASE = "/accounts/d26430caa63ec55f6612e32f36aca5e9/workers/scripts/outsider";
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const DB = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const allocation = (versions, id = "deployment-1") => ({ deployments: [{ id, versions }] });
const version = (version_id, percentage = 100) => ({ version_id, percentage });
const bindings = [{ name: "DB", type: "d1", id: DB }];

test("an uploaded safe /settings cannot hide the 1% serving writer", async () => {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.endsWith("/deployments")) return allocation([version(A, 99), version(B, 1)]);
    if (path.endsWith("/versions/" + A)) return { id: A, resources: { bindings: [] } };
    if (path.endsWith("/versions/" + B)) return { id: B, resources: { bindings } };
    if (path.endsWith("/settings")) return { bindings: [] };
    throw Error("unexpected");
  };
  const evidence = await inspectActiveWriterBindings(get, BASE);
  assert.equal(evidence.activeVersionCount, 2);
  assert.deepEqual(evidence.bindings, bindings);
  assert.equal(calls.filter((p) => p.endsWith("/deployments")).length, 2);
  assert.ok(calls.every((p) => !p.endsWith("/settings")));
  const report = evaluatePhysicalWriterInventory({
    workers: [{ name: "outsider", ...evidence }],
    tokens: [],
    userTokensVerified: true,
    userPrincipalCoverageVerified: true,
  });
  assert.ok(report.problems.includes("nonowner_primary_d1_binding"));
});

test("unserved upload with a D1 binding is never mistaken for serving evidence", async () => {
  const evidence = await inspectActiveWriterBindings(async (path) => {
    if (path.endsWith("/deployments")) return allocation([version(A)]);
    if (path.endsWith("/versions/" + A)) return { id: A, resources: { bindings: [] } };
    throw Error("must not inspect settings");
  }, BASE);
  assert.deepEqual(evidence, { activeVersionCount: 1, bindings: [] });
});

test("deployment drift, including identical allocations with a new deployment, blocks evidence", async () => {
  for (const changed of [allocation([version(B)]), allocation([version(A)], "deployment-2")]) {
    let reads = 0;
    await assert.rejects(
      inspectActiveWriterBindings(async (path) => {
        if (path.endsWith("/deployments"))
          return ++reads === 1 ? allocation([version(A)]) : changed;
        return { id: A, resources: { bindings: [] } };
      }, BASE),
      /active_deployment_changed/,
    );
  }
});

test("missing, duplicate, incomplete and unproved immutable metadata fail closed", async () => {
  const cases = [
    allocation([]),
    allocation([version(A, 99)]),
    allocation([version(A, 50), version(A, 50)]),
    allocation([version(A, 0), version(B, 100)]),
    allocation([version("not-a-version")]),
  ];
  for (const data of cases) {
    await assert.rejects(
      inspectActiveWriterBindings(
        async (path) =>
          path.endsWith("/deployments") ? data : { id: A, resources: { bindings: [] } },
        BASE,
      ),
    );
  }
  for (const data of [
    { id: B, resources: { bindings: [] } },
    { id: A },
    { id: A, resources: {} },
  ]) {
    await assert.rejects(
      inspectActiveWriterBindings(
        async (path) => (path.endsWith("/deployments") ? allocation([version(A)]) : data),
        BASE,
      ),
    );
  }
});

test("mixed production owner versions cannot certify exclusivity", () => {
  const report = evaluatePhysicalWriterInventory({
    workers: [{ name: "cove-legal-authority-production", activeVersionCount: 2, bindings: [] }],
    tokens: [],
    userTokensVerified: true,
    userPrincipalCoverageVerified: true,
  });
  assert.equal(report.certified, false);
  assert.ok(report.problems.includes("production_owner_active_version_ambiguous"));
});
