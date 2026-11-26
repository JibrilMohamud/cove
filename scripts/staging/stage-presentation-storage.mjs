import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const bucket = "cove-strangler-private-presentation-stage";
const namespace = "8245d5f2116a445d9571405b41b7c8c3";

function coordinates(mode, purpose = "publish") {
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.match(process.env.GITHUB_RUN_ID || "", /^[1-9][0-9]{7,14}$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT || "", /^[1-9][0-9]{0,3}$/);
  assert.ok(["real", "synthetic"].includes(mode));
  assert.ok(["publish", "cleanup"].includes(purpose));
  const deploy = process.env.CLOUDFLARE_API_TOKEN || "";
  const read = process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN || "";
  assert.ok(deploy.length >= 20 && read.length >= 20 && deploy !== read);
  const run = process.env.GITHUB_RUN_ID;
  const base = "cove-stage-presentation-" + run + "-" + process.env.GITHUB_RUN_ATTEMPT + "-" + mode;
  const name = purpose === "cleanup" ? base + "-cleanup" : base;
  return {
    deploy,
    run,
    name,
    root: "https://api.cloudflare.com/client/v4/accounts/" + account + "/workers/scripts/" + name,
  };
}
async function provider(c, method, suffix = "", body, missingOk = false) {
  const response = await fetch(c.root + suffix, {
    method,
    headers: {
      authorization: "Bearer " + c.deploy,
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (missingOk && response.status === 404) return null;
  const data = await response.json();
  assert.ok(
    response.ok && data.success,
    "Stage storage Worker " + method + " rejected: " + response.status,
  );
  return data.result ?? true;
}
export async function removeStagePresentationWorker(mode, purpose = "publish") {
  const c = coordinates(mode, purpose);
  const existing = await provider(c, "GET", "/subdomain", undefined, true);
  if (existing === null) return;
  await provider(c, "POST", "/subdomain", { enabled: false, previews_enabled: false });
  await provider(c, "DELETE", "?force=true", undefined, true);
  assert.equal(
    await provider(c, "GET", "/subdomain", undefined, true),
    null,
    "Ephemeral storage Worker still exists",
  );
}
export async function withStagePresentationStore(mode, operation, purpose = "publish") {
  const c = coordinates(mode, purpose);
  const instance = randomBytes(16).toString("hex");
  const gate = randomBytes(32).toString("hex");
  console.log("::add-mask::" + gate);
  // Unique run/attempt name, fixed stage storage, no D1 or owner binding.
  const metadata = {
    main_module: "worker.mjs",
    compatibility_date: "2026-10-19",
    observability: { enabled: false },
    bindings: [
      { type: "r2_bucket", name: "PRESENTATION", bucket_name: bucket },
      { type: "kv_namespace", name: "PRESENTATION_KV", namespace_id: namespace },
      { type: "plain_text", name: "RUN", text: c.run },
      { type: "plain_text", name: "MODE", text: mode },
      { type: "plain_text", name: "INSTANCE", text: instance },
      { type: "plain_text", name: "PURPOSE", text: purpose },
      { type: "plain_text", name: "EXPIRES", text: String(Date.now() + 15 * 60_000) },
      { type: "secret_text", name: "GATE", text: gate },
    ],
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    "worker.mjs",
    new Blob([readFileSync("scripts/staging/stage-presentation-storage.worker.mjs")], {
      type: "application/javascript+module",
    }),
    "worker.mjs",
  );
  // A previous aborted operation may leave this exact run/attempt helper.
  // Close it before provisioning the next operation with a fresh bearer.
  await removeStagePresentationWorker(mode, purpose);
  try {
    await provider(c, "PUT", "", form);
    await provider(c, "POST", "/subdomain", { enabled: true, previews_enabled: false });
    const origin = "https://" + c.name + ".cove-jibrilmohamud.workers.dev/presentation";
    const call = async (method, country, body) => {
      assert.match(country, /^[A-Z]{2}$/);
      const response = await fetch(origin, {
        method,
        headers: { authorization: "Bearer " + gate, "x-cove-country": country },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 404 && !response.headers.has("x-cove-stage-storage-instance")) {
        throw Object.assign(new Error("Stage storage route not propagated"), {
          actual: 404,
          routePending: true,
        });
      }
      assert.equal(
        response.status,
        method === "GET" ? 200 : 204,
        "Stage storage operation rejected",
      );
      assert.equal(response.headers.get("x-cove-stage-storage-instance"), instance);
      return method === "GET" ? Buffer.from(await response.arrayBuffer()) : undefined;
    };
    // Wait for the new version without using customer ingress or mutating storage.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const response = await fetch(origin, {
        method: "POST",
        headers: { authorization: "Bearer " + gate, "x-cove-country": "US" },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      }).catch(() => null);
      if (
        response?.status === 405 &&
        response.headers.get("x-cove-stage-storage-instance") === instance
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.ok(ready, "Stage storage Worker did not become ready");
    return await operation({
      async put(country, body) {
        await call("PUT", country, body);
        assert.ok(
          (await call("GET", country)).equals(Buffer.from(body)),
          "Stage R2 readback mismatch",
        );
      },
      async delete(country) {
        // Run-prefix DELETE is idempotent. Never retry an authorization denial.
        for (let attempt = 1; ; attempt++) {
          try {
            await call("DELETE", country);
            return;
          } catch (error) {
            const retryable =
              error.routePending === true ||
              [429, 500, 502, 503, 504].includes(error.actual) ||
              error.name === "TimeoutError" ||
              error.name === "TypeError";
            if (!retryable || attempt === 8) throw error;
            await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
          }
        }
      },
    });
  } finally {
    await removeStagePresentationWorker(mode, purpose);
  }
}
if (process.argv[2] === "--cleanup") {
  await removeStagePresentationWorker(process.argv[3], "publish");
  await removeStagePresentationWorker(process.argv[3], "cleanup");
}
