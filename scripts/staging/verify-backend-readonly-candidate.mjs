import assert from "node:assert/strict";
import { readActiveWorkerVersions } from "../read-active-worker-versions.mjs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const name = "cove-persistence-backend-readonly-candidate";
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(apiToken, "Read-only Cloudflare inspector credential required");
const root = "https://api.cloudflare.com/client/v4/accounts/" + account + "/";
async function read(path) {
  const url = path.startsWith("https://") ? path : root + path;
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + apiToken },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw Error("Read-only backend audit HTTP " + response.status);
  const data = await response.json();
  assert.equal(data.success, true, "Read-only backend audit denied");
  assert.ok(Array.isArray(data.errors) && data.errors.length === 0);
  return data.result;
}
const script = "workers/scripts/" + name;
const versions = await readActiveWorkerVersions(read, script);
assert.equal(versions.length, 1, "Candidate cannot have a mixed-version rollout");
assert.equal(versions[0].percentage, 100);
const bindings = versions[0].bindings;
assert.ok(
  !bindings.some((b) =>
    ["d1", "r2_bucket", "kv_namespace", "durable_object_namespace"].includes(b.type),
  ),
);
assert.deepEqual(
  bindings.map((b) => b.name).sort(),
  [
    "COVE_BACKEND_READONLY_CANDIDATE",
    "COVE_BACKEND_TOKEN_HASH_ONLY",
    "COVE_CANONICAL_READONLY",
    "COVE_CANONICAL_READONLY_RPC",
    "FORE_BACKEND_TOKEN_SHA256",
    "FORE_ENVIRONMENT",
    "FORE_PUBLIC_URL",
  ].sort(),
);
function binding(name) {
  return bindings.find((b) => b.name === name);
}
assert.equal(binding("COVE_BACKEND_READONLY_CANDIDATE").text, "1");
assert.equal(binding("COVE_BACKEND_TOKEN_HASH_ONLY").text, "1");
assert.equal(binding("COVE_CANONICAL_READONLY_RPC").text, "1");
assert.equal(binding("FORE_ENVIRONMENT").text, "staging");
assert.equal(binding("FORE_BACKEND_TOKEN_SHA256").type, "secret_text");
assert.equal(binding("COVE_CANONICAL_READONLY").type, "service");
assert.equal(binding("COVE_CANONICAL_READONLY").service, "cove-canonical-d1-readonly");
const subdomain = await read(script + "/subdomain");
assert.equal(subdomain.enabled, false);
assert.equal(subdomain.previews_enabled, false);
const schedules = await read(script + "/schedules");
assert.deepEqual(schedules.schedules, []);
const domains = await read("workers/domains");
assert.ok(!domains.some((d) => d.service === name), "Candidate has public custom domain");
const routes = await read(
  "https://api.cloudflare.com/client/v4/zones/07e218b2e74bc522122e0994b8e37576/workers/routes",
);
assert.ok(Array.isArray(routes), "Owned zone route inventory incomplete");
assert.ok(!routes.some((r) => r.script === name), "Candidate has public zone route");
console.log(
  "PASS: deployed candidate is private, health-only, provider-read-only and has no cron, native D1 or public ingress.",
);
