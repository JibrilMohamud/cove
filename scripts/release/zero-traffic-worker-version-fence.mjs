import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const WORKER_ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
export const WORKER_NAME = "cove-persistence-backend";
export const PINNED_DEPLOYMENT = "9df84b20-0599-4fe9-a14e-2c11a4f25133";
export const PINNED_VERSION = "401f2af2-6e69-4611-8110-1d127af6eecf";
export const PINNED_VERSION_NUMBER = 451;
export const REVIEWED_BACKEND_SOURCE = "c3c1a68dd239aca018040d3165c44630118ae8af";
export const PRIMARY_D1 = "4bd657ac-8789-403e-a28c-93aba8d0a989";

const sha = (data) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

function deploymentList(value) {
  const list = Array.isArray(value) ? value : value?.deployments;
  assert.ok(Array.isArray(list) && list.length > 0, "Missing production Worker deployments");
  return list;
}

/** This is a pin, not a percentage threshold: no dual-version traffic is permitted. */
export function assertPinnedProductionDeployment(value) {
  const head = deploymentList(value)[0];
  assert.equal(head?.id, PINNED_DEPLOYMENT, "Production deployment changed: STOP");
  assert.equal(head?.versions?.length, 1, "Unexpected production traffic split: STOP");
  assert.equal(head.versions[0]?.version_id, PINNED_VERSION, "Pinned Worker version changed: STOP");
  assert.equal(head.versions[0]?.percentage, 100, "Pinned Worker is not at 100%: STOP");
  return { deploymentId: PINNED_DEPLOYMENT, versionId: PINNED_VERSION, percentage: 100 };
}

export function assertBaselineResources(version) {
  assert.equal(version?.number, PINNED_VERSION_NUMBER, "Version 451 metadata drift");
  assert.equal(
    version?.resources?.script_runtime?.compatibility_date,
    "2026-09-01",
    "Unexpected deployed Worker compatibility date",
  );
  const bindings = version.resources?.bindings;
  assert.ok(Array.isArray(bindings) && bindings.length >= 30, "Incomplete live binding manifest");
  const byName = new Map(bindings.map((b) => [b.name, b]));
  assert.equal(byName.size, bindings.length, "Duplicate deployed Worker binding");
  assert.equal(byName.get("DB")?.database_id, PRIMARY_D1);
  assert.equal(byName.get("DB")?.type, "d1");
  assert.equal(byName.get("LEGAL_AUTHORITY")?.script_name, "cove-legal-authority-production");
  assert.equal(byName.get("OPS_ANALYTICS")?.dataset, "cove_public_http_ops");
  assert.equal(byName.get("FORE_ENVIRONMENT")?.text, "production");
  return bindings.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function bindingDigest(bindings) {
  assert.ok(Array.isArray(bindings), "Worker binding manifest absent");
  const shapes = bindings.map((binding) => {
    assert.ok(typeof binding?.name === "string" && typeof binding?.type === "string");
    // Never compare, retain or log secrets; secret presence/name/type still
    // must match exactly. All other properties are compared by stable digest.
    if (["secret_text", "secret_key"].includes(binding.type))
      return { name: binding.name, type: binding.type };
    return canonicalize(binding);
  });
  shapes.sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(new Set(shapes.map((b) => b.name)).size, shapes.length);
  return sha(shapes);
}

/** Do not print nonsecret plain text values or secret internals to CI logs. */
export function assertExactNonsecretResourceParity(oldVersion, candidate) {
  const count = assertBaselineResources(oldVersion);
  assert.ok(candidate?.number > PINNED_VERSION_NUMBER, "New version number invalid");
  const oldResource = oldVersion.resources;
  const newResource = candidate.resources;
  assert.ok(newResource && oldResource, "Missing Worker resources");
  assert.equal(
    sha(canonicalize(newResource.script_runtime)),
    sha(canonicalize(oldResource.script_runtime)),
    "Worker runtime settings changed: reject candidate",
  );
  assert.equal(
    bindingDigest(newResource.bindings),
    bindingDigest(oldResource.bindings),
    "Worker binding manifest changed: reject candidate",
  );
  assert.equal(newResource.bindings.length, count, "Worker binding count changed");
  return { bindingCount: count, runtimeMatches: true, bindingsMatch: true };
}

export function detectExactlyOneArchivedCandidate(beforeIds, afterItems) {
  assert.ok(Array.isArray(beforeIds) && beforeIds.length > 0, "Missing before versions");
  assert.ok(Array.isArray(afterItems), "Missing after versions");
  assert.equal(new Set(beforeIds).size, beforeIds.length, "Duplicate before-version identity");
  const old = new Set(beforeIds);
  const candidates = afterItems.filter((entry) => !old.has(entry.id));
  assert.equal(candidates.length, 1, "Concurrent/unidentified Worker version upload: STOP");
  assert.ok(typeof candidates[0].id === "string" && candidates[0].id.length > 10);
  assert.ok(candidates[0].number > PINNED_VERSION_NUMBER);
  return candidates[0];
}
