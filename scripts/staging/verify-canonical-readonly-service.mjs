import assert from "node:assert/strict";
import { readActiveWorkerVersions } from "../read-active-worker-versions.mjs";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Cloudflare credential required");
async function get(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/` + path, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  assert.ok(response.ok && data.success, "Read-only service audit failed: " + path);
  return data.result;
}
const base = "workers/scripts/cove-canonical-d1-readonly";
const versions = await readActiveWorkerVersions(get, base);
assert.equal(versions.length, 1);
const settings = versions[0];
assert.ok(!settings.bindings.some((b) => b.type === "d1"), "Read service cannot have native D1");
assert.deepEqual(settings.bindings.map((b) => b.name).sort(), [
  "D1_READ_API_TOKEN",
  "D1_READ_TOKEN_ID",
]);
assert.equal(settings.bindings.find((b) => b.name === "D1_READ_API_TOKEN").type, "secret_text");
const tokenId = settings.bindings.find((b) => b.name === "D1_READ_TOKEN_ID").text;
const credential = await get("tokens/" + tokenId);
assert.equal(credential.status, "active");
assert.equal(credential.policies.length, 1);
assert.equal(credential.policies[0].effect, "allow");
assert.deepEqual(
  credential.policies[0].permission_groups.map((p) => p.id),
  ["192192df92ee43ac90f2aeeffce67e35"],
);
assert.deepEqual(credential.policies[0].resources, {
  ["com.cloudflare.api.account." + account]: "*",
});
const subdomain = await get(base + "/subdomain");
assert.equal(subdomain.enabled, false);
assert.equal(subdomain.previews_enabled, false);
const domains = await get("workers/domains");
assert.ok(!domains.some((d) => d.service === "cove-canonical-d1-readonly"));
const deploy = await get(base + "/deployments");
assert.equal(deploy.deployments[0].versions.length, 1);
assert.equal(deploy.deployments[0].versions[0].percentage, 100);
console.log(
  "PASS: private canonical read service, no native D1, exact provider D1 Read policy, one version at 100%",
);
if (process.argv.includes("--ssr")) {
  const active = await readActiveWorkerVersions(get, "workers/scripts/cove-storefront-ssr-staging");
  assert.equal(active.length, 1);
  const ssr = active[0];
  assert.ok(!ssr.bindings.some((b) => b.type === "d1"), "SSR must not retain native D1");
  assert.ok(
    ssr.bindings.some(
      (b) =>
        b.name === "COVE_CANONICAL_READONLY" &&
        b.type === "service" &&
        b.service === "cove-canonical-d1-readonly",
    ),
  );
  assert.ok(ssr.bindings.some((b) => b.name === "COVE_CANONICAL_READONLY_RPC" && b.text === "1"));
  assert.ok(ssr.bindings.some((b) => b.name === "COVE_SSR_STAGING" && b.text === "1"));
  console.log(
    "PASS: SSR binding has provider-enforced read-only capability and retains staging authentication",
  );
}

if (process.argv.includes("--sounds")) {
  // Inspect active immutable versions; /settings alone can describe an
  // unserved upload and hide a mixed 50/50 production-D1 deployment.
  const soundsBase = "workers/scripts/cove-sounds-publication";
  const active = await readActiveWorkerVersions(get, soundsBase);
  assert.equal(active.length, 1, "Sounds may only serve one pinned private version");
  const sound = active[0];
  assert.equal(sound.percentage, 100);
  assert.ok(!sound.bindings.some((b) => b.type === "d1"), "Sounds must not retain native D1");
  assert.ok(
    sound.bindings.some(
      (b) =>
        b.name === "COVE_CANONICAL_READONLY" &&
        b.type === "service" &&
        b.service === "cove-canonical-d1-readonly",
    ),
    "Sounds must use the provider D1 Read service",
  );
  assert.ok(
    sound.bindings.some((b) => b.name === "COVE_CANONICAL_READONLY_RPC" && b.text === "1"),
    "Sounds read-only mode must be enabled",
  );
  assert.ok(
    sound.bindings.some((b) => b.name === "COVE_SOUNDS_PUBLICATION_ENABLED" && b.text === "1"),
    "Hourly Sounds publication must remain enabled after successful deployment",
  );
  const ingress = await get(soundsBase + "/subdomain");
  assert.equal(ingress.enabled, false);
  assert.equal(ingress.previews_enabled, false);
  assert.ok(!domains.some((d) => d.service === "cove-sounds-publication"));
  console.log(
    "PASS: active private Sounds publisher has zero native D1; one provider D1 Read RPC, publication enabled and no public ingress",
  );
}
