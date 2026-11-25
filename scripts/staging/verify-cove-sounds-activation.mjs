import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const account = "d26430caa63ec55f6612e32f36aca5e9";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.match(process.env.GITHUB_RUN_ID || "", /^[1-9][0-9]{7,14}$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT || "", /^[1-9][0-9]{0,3}$/);
const token = process.env.CLOUDFLARE_API_TOKEN || "";
assert.ok(token.length >= 20);
const name =
  "cove-sounds-observe-" + process.env.GITHUB_RUN_ID + "-" + process.env.GITHUB_RUN_ATTEMPT;
const root = "https://api.cloudflare.com/client/v4/accounts/" + account;
const path = "/workers/scripts/" + name;
async function api(method, suffix, body, missingOk = false) {
  const response = await fetch(root + suffix, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (missingOk && response.status === 404) return null;
  const data = await response.json();
  assert.ok(response.ok && data.success, "Sounds observer control plane rejected");
  return data.result ?? true;
}
async function cleanup() {
  if ((await api("GET", path + "/subdomain", undefined, true)) === null) return;
  await api("POST", path + "/subdomain", { enabled: false, previews_enabled: false });
  await api("DELETE", path + "?force=true", undefined, true);
  assert.equal(await api("GET", path + "/subdomain", undefined, true), null);
}
if (process.argv.includes("--cleanup")) {
  await cleanup();
} else {
  const settings = await api("GET", "/workers/scripts/cove-persistence-backend/settings");
  const binds = settings.bindings || [];
  assert.equal(
    binds.find((b) => b.name === "SOUNDS_PRESENTATION")?.bucket_name,
    "cove-sounds-private-presentation",
  );
  assert.equal(
    binds.find((b) => b.name === "SOUNDS_PRESENTATION_KV")?.namespace_id,
    "544267f3cf604c1d8976f1b06d258e24",
  );
  assert.ok(binds.some((b) => b.name === "SOUNDS_ANALYTICS"));
  const schedule = await api("GET", "/workers/scripts/cove-sounds-publication/schedules");
  assert.deepEqual(
    schedule.schedules.map((s) => s.cron),
    ["11 * * * *"],
  );
  const gate = randomBytes(32).toString("hex");
  console.log("::add-mask::" + gate);
  const metadata = {
    main_module: "observer.mjs",
    compatibility_date: "2026-10-25",
    observability: { enabled: false },
    bindings: [
      {
        type: "r2_bucket",
        name: "SOUNDS_PRESENTATION",
        bucket_name: "cove-sounds-private-presentation",
      },
      {
        type: "kv_namespace",
        name: "SOUNDS_PRESENTATION_KV",
        namespace_id: "544267f3cf604c1d8976f1b06d258e24",
      },
      { type: "secret_text", name: "GATE", text: gate },
      { type: "plain_text", name: "EXPIRES", text: String(Date.now() + 300000) },
    ],
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    "observer.mjs",
    new Blob([readFileSync("scripts/staging/sounds-read-observer.worker.mjs")], {
      type: "application/javascript+module",
    }),
    "observer.mjs",
  );
  await cleanup();
  try {
    await api("PUT", path, form);
    await api("POST", path + "/subdomain", { enabled: true, previews_enabled: false });
    const url = "https://" + name + ".cove-jibrilmohamud.workers.dev/verify";
    let result;
    for (let i = 0; i < 30; i++) {
      const response = await fetch(url, {
        headers: { authorization: "Bearer " + gate },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      }).catch(() => null);
      if (response?.status === 200) {
        result = await response.json();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.equal(result?.rows?.length, 6, "Six fresh R2/KV station pairs required");
    assert.equal(new Set(result.rows.map((r) => r.slug)).size, 6);
    assert.ok(result.rows.reduce((n, row) => n + row.recordings, 0) > 0);
    const anonymous = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(anonymous.status, 401);
    console.log("COVE_SOUNDS_NATIVE_OBSERVATION_PASS", JSON.stringify(result));
  } finally {
    await cleanup();
  }
}
