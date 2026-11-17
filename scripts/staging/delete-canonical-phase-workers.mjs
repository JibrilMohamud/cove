import assert from "node:assert/strict";

// Protected preflight proves both exact names were ABSENT before this job.
// Direct Worker DELETE avoids Wrangler's unrelated KV-list permission.
// Never use force=true: the reader must not be deleted while referenced.
const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const READER = "cove-canonical-phase-readonly-staging";
const FRONTEND = "cove-storefront-phase-staging";
const API = "https://api.cloudflare.com/client/v4";

export function ownedPhaseWorkerNames(env) {
  assert.equal(env.COVE_PHASE_STAGE_PREFLIGHT_PASSED, "1", "Absent-stage preflight required");
  const reader = env.COVE_PHASE_READER_CREATE_ATTEMPTED ?? "0";
  const frontend = env.COVE_PHASE_SSR_CREATE_ATTEMPTED ?? "0";
  for (const value of [reader, frontend])
    assert.ok(value === "0" || value === "1", "Invalid stage creation marker");
  // Delete consumer first; do not force-delete the provider while referenced.
  return [frontend === "1" ? FRONTEND : null, reader === "1" ? READER : null].filter(
    Boolean,
  );
}

export async function deleteOwnedPhaseWorkers(env, request = fetch) {
  const names = ownedPhaseWorkerNames(env);
  if (names.length === 0) return { deletedOrAbsent: 0 };
  const token = env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN;
  assert.ok(typeof token === "string" && token.length >= 20, "Scoped stage deploy token absent");
  let deletedOrAbsent = 0;
  for (const name of names) {
    const response = await request(API + "/accounts/" + ACCOUNT + "/workers/scripts/" + name, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    // HTTP 404 is idempotent for a script proven absent before this run.
    // Other API failures remain fatal. Never log a provider response body.
    if (response.status !== 404) {
      // Cloudflare may return HTTP 200 or 204 with no response body.
      assert.ok(response.ok, "Scoped stage Worker DELETE was denied");
    }
    deletedOrAbsent += 1;
  }
  return { deletedOrAbsent };
}

if (process.argv[1]?.endsWith("delete-canonical-phase-workers.mjs")) {
  deleteOwnedPhaseWorkers(process.env)
    .then(({ deletedOrAbsent }) =>
      console.log("PHASE_STAGE_SCOPED_DELETE_COMPLETE=" + deletedOrAbsent),
    )
    .catch(() => {
      console.error("Protected phase-stage cleanup failed closed");
      process.exitCode = 1;
    });
}
