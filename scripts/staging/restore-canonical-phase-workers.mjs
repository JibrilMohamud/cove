import assert from "node:assert/strict";
import {
  PARKED_READER_VERSION,
  PARKED_SSR_VERSION,
} from "./phase-stage-control-plane.mjs";

// These are one-time provisioned, nonroutable deny-all Workers. Production
// workers can NEVER be targeted by this path. The fixed version IDs came
// from independently verified 401-only, no-binding Cloudflare uploads.
const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + "/workers/scripts/";
const SSR = "cove-storefront-phase-staging";
const READER = "cove-canonical-phase-readonly-staging";

export function ownedStageParkPlan(env) {
  assert.equal(env.COVE_PHASE_STAGE_PREFLIGHT_PASSED, "1", "Parked-stage preflight required");
  const reader = env.COVE_PHASE_READER_CREATE_ATTEMPTED ?? "0";
  const frontend = env.COVE_PHASE_SSR_CREATE_ATTEMPTED ?? "0";
  for (const v of [reader, frontend])
    assert.ok(v === "0" || v === "1", "Invalid stage deployment marker");
  return [
    ...(frontend === "1" ? [{ name: SSR, version: PARKED_SSR_VERSION }] : []),
    ...(reader === "1" ? [{ name: READER, version: PARKED_READER_VERSION }] : []),
  ];
}

async function putJson(request, url, token, body) {
  const response = await request(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  assert.ok(response.ok, "Stage parked version/subdomain restoration denied");
  // Cloudflare returns success:true for these mutations; a 2xx HTTP error
  // envelope is not sufficient to certify a parked safety baseline.
  const payload = await response.json();
  assert.equal(payload?.success, true, "Stage parked control-plane restoration failed");
}

export async function restoreOwnedStageWorkers(env, request = fetch) {
  const plan = ownedStageParkPlan(env);
  if (!plan.length) return { parked: 0 };
  const token = env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN;
  assert.ok(typeof token === "string" && token.length >= 20, "Scoped stage Editor token absent");
  let parked = 0;
  for (const { name, version } of plan) {
    // Keep the previous deny-only code as the only deployed version. A
    // historical staging secret on an undeployed version is not legal access.
    await putJson(request, API + name + "/deployments", token, {
      strategy: "percentage",
      versions: [{ version_id: version, percentage: 100 }],
    });
    // Disable HTTP ingress and preview ingress even after a partial upload.
    await putJson(request, API + name + "/subdomain", token, {
      enabled: false,
      previews_enabled: false,
    });
    parked++;
  }
  return { parked };
}

if (process.argv[1]?.endsWith("restore-canonical-phase-workers.mjs")) {
  restoreOwnedStageWorkers(process.env)
    .then(({ parked }) => console.log("PHASE_STAGE_DENY_ONLY_RESTORED=" + parked))
    .catch(() => {
      console.error("Protected stage denial-only restoration failed closed");
      process.exitCode = 1;
    });
}
