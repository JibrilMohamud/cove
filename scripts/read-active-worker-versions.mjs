import assert from "node:assert/strict";

/** Settings describe the latest upload, which need not be serving traffic.
 * Inspect every serving version and pin its immutable resource metadata. */
export async function readActiveWorkerVersions(get, base) {
  const deployed = await get(base + "/deployments");
  const versions = deployed?.deployments?.[0]?.versions;
  assert.ok(Array.isArray(versions) && versions.length > 0, "Active Worker versions missing");
  assert.equal(
    new Set(versions.map((v) => v.version_id)).size,
    versions.length,
    "Duplicate active Worker version",
  );
  let total = 0;
  for (const version of versions) {
    assert.match(version.version_id || "", /^[a-f0-9-]{36}$/);
    assert.ok(
      Number.isFinite(version.percentage) && version.percentage > 0 && version.percentage <= 100,
      "Invalid serving percentage",
    );
    total += version.percentage;
  }
  assert.ok(Math.abs(total - 100) < 0.000001, "Incomplete active Worker traffic allocation");
  return await Promise.all(
    versions.map(async (version) => {
      const data = await get(base + "/versions/" + version.version_id);
      assert.equal(data?.id, version.version_id, "Worker version identity mismatch");
      assert.ok(Array.isArray(data.resources?.bindings), "Active Worker bindings incomplete");
      return { versionId: version.version_id, percentage: version.percentage, ...data.resources };
    }),
  );
}
