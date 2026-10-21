import assert from "node:assert/strict";

/** Read Cloudflare's deployment control plane without issuing a Worker fetch.
 * "100%" reports routing intent, not a promise every edge has propagated:
 * require a bounded settle window in addition to that control-plane state.
 */
export function latestSecretDeploymentStatus(payload, rotationStartedMs, nowMs, settleMs = 30_000) {
  const entries = payload?.result?.deployments;
  if (!Array.isArray(entries) || !entries.length) return { ready: false, state: "no-deployment" };
  const latest = entries[0];
  const createdMs = Date.parse(String(latest?.created_on || ""));
  if (!Number.isFinite(createdMs) || createdMs < rotationStartedMs - 3000)
    return { ready: false, state: "prior-deployment" };
  if (latest?.annotations?.["workers/triggered_by"] !== "secret")
    return { ready: false, state: "not-secret-version" };
  if (
    !Array.isArray(latest.versions) ||
    latest.versions.length !== 1 ||
    latest.versions[0].percentage !== 100
  )
    return { ready: false, state: "not-100-percent" };
  if (nowMs - createdMs < settleMs) return { ready: false, state: "settling" };
  return { ready: true, state: "ready" };
}

export async function waitForCloudflareStageDeployment(
  token,
  accountId,
  rotationStartedMs,
  options = {},
) {
  assert.match(accountId || "", /^[a-f0-9]{32}$/);
  assert.ok(Number.isFinite(rotationStartedMs) && rotationStartedMs > 0);
  assert.ok(typeof token === "string" && token.length >= 20);
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const maxWaitMs = options.maxWaitMs ?? 110_000;
  const settleMs = options.settleMs ?? 30_000;
  const deadline = now() + maxWaitMs;
  const workerName = options.workerName ?? "cove-storefront-ssr-staging";
  assert.match(workerName, /^[a-z0-9][a-z0-9-]{0,62}$/);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`;
  while (now() < deadline) {
    const result = await fetcher(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok)
      throw new Error("Cloudflare Worker deployment control-plane query failed: " + result.status);
    const payload = await result.json();
    if (payload.success !== true)
      throw new Error("Cloudflare Worker deployment control-plane response was unsuccessful.");
    const readiness = latestSecretDeploymentStatus(payload, rotationStartedMs, now(), settleMs);
    if (readiness.ready) return;
    await sleep(2000);
  }
  throw new Error("New 100% staging secret deployment never settled without HTTP warming.");
}
