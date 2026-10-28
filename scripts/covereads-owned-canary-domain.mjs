import assert from "node:assert/strict";

// Owned-zone ingress to an *ephemeral*, assets-less, authentication Worker.
// This program MUST NEVER manipulate www.covereads.com or the zone apex.
const mode = process.argv[2];
assert.ok(["attach", "detach"].includes(mode), "Expected attach|detach");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const zone = "07e218b2e74bc522122e0994b8e37576";
const hostname = "ssr-canary.covereads.com";
const service = "cove-asset-auth-gateway";
assert.equal(account, "d26430caa63ec55f6612e32f36aca5e9");
assert.ok(typeof token === "string" && token.length > 20, "Missing scoped Cloudflare token");
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains`;
async function call(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true)
    throw Error("Cloudflare canary-domain management failed (HTTP " + response.status + ")");
  return payload.result;
}
const existing = (await call(endpoint)).find((d) => d.hostname === hostname);
if (mode === "attach") {
  assert.equal(existing, undefined, "Owned canary domain must not be assigned before the isolated test");
  const created = await call(endpoint, {
    method: "PUT",
    body: JSON.stringify({
      hostname,
      service,
      zone_id: zone,
      previews_enabled: false,
      enabled: true,
    }),
  });
  assert.equal(created.hostname, hostname);
  assert.equal(created.service, service);
  assert.equal(created.zone_id, zone);
  console.log("PASS: protected owned canary assigned only to ephemeral assets-less auth gateway");
} else {
  if (existing === undefined) {
    console.log("PASS: protected owned canary domain already detached");
  } else {
    assert.equal(existing.service, service, "Refusing to detach a different Worker from canary domain");
    assert.equal(existing.zone_id, zone, "Refusing to detach a different DNS zone");
    assert.match(existing.id || "", /^[a-f0-9]{32}$/);
    await call(endpoint + "/" + existing.id, { method: "DELETE" });
    const after = (await call(endpoint)).find((d) => d.hostname === hostname);
    assert.equal(after, undefined, "Canary domain detach was not complete");
    console.log("PASS: owned canary detached; no customer traffic was rerouted");
  }
}
