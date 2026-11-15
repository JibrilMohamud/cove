/**
 * Private Cloudflare synthetic candidate only. A newly deployed Worker
 * version can appear in /deployments before /versions/{id} is readable.
 * Never allow missing version metadata to bypass stage isolation checks.
 */
export function singleCandidateVersion(deployments) {
  const versions = deployments?.deployments?.[0]?.versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(versions[0]?.version_id || "")
  )
    throw new Error("Candidate must have exactly one 100-percent deployed version");
  return versions[0].version_id;
}

export function attestedCandidateSettings(before, after, settings) {
  const firstVersion = singleCandidateVersion(before);
  const checkedVersion = singleCandidateVersion(after);
  if (firstVersion !== checkedVersion)
    throw new Error("Candidate deployment changed while checking active settings");
  if (
    !settings ||
    !Array.isArray(settings.bindings) ||
    settings.bindings.some((b) => !b || typeof b.name !== "string") ||
    !Number.isSafeInteger(settings.limits?.cpu_ms)
  )
    throw new Error("Candidate active settings cannot be independently verified");
  return {
    version: firstVersion,
    bindings: settings.bindings,
    runtime: { limits: settings.limits },
  };
}
