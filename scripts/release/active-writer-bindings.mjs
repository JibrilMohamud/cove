import { readActiveWorkerVersions } from "../read-active-worker-versions.mjs";

// /settings describes the newest upload, not necessarily any serving version.
// Read immutable bindings for EVERY traffic allocation, including a 1% canary.
// Re-read the allocation after fetching bindings; observable drift blocks the
// audit. This is bounded evidence, never a claim of an atomic provider snapshot.
export async function inspectActiveWriterBindings(get, base) {
  let before;
  const read = async (path) => {
    const payload = await get(path);
    if (path === base + "/deployments") before = payload;
    return payload;
  };
  const versions = await readActiveWorkerVersions(read, base);
  const after = await get(base + "/deployments");
  const signature = (payload) => {
    const deployment = payload?.deployments?.[0];
    if (typeof deployment?.id !== "string" || !deployment.id.length)
      throw Error("writer_audit_deployment_identity_missing");
    return JSON.stringify({
      id: deployment.id,
      versions: deployment.versions?.map((v) => [v.version_id, v.percentage]).sort(),
    });
  };
  if (signature(before) !== signature(after))
    throw Error("writer_audit_active_deployment_changed");
  return {
    activeVersionCount: versions.length,
    bindings: versions.flatMap((version) => version.bindings),
  };
}
