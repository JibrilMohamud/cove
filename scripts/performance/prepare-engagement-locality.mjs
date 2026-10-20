// One isolated resource, created from the actual load generator's network.
// D1 region hints are broad; record the observed location rather than assuming colocation.
import assert from "node:assert/strict";
import fs from "node:fs";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const name = "cove-engagement-generator-local-20261020";
assert.equal(process.env.GITHUB_ACTIONS, "true", "Run only from the controlled CI generator");
assert.ok(process.env.CLOUDFLARE_API_TOKEN);
async function api(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  assert.ok(
    response.ok && data.success,
    `Locality resource ${method} failed: HTTP ${response.status}`,
  );
  return { data: data.result, ingress: response.headers.get("cf-ray")?.split("-").at(-1) || null };
}
const listed = (await api("GET", `/d1/database?name=${name}`)).data.filter(
  (db) => db.name === name,
);
assert.ok(listed.length <= 1);
const resource = listed.length
  ? { data: listed[0], ingress: null }
  : await api("POST", "/d1/database", {
      name,
      read_replication: { mode: "disabled" },
    });
assert.equal(resource.data.name, name);
const id = resource.data.uuid;
assert.match(id, /^[0-9a-f-]{36}$/);
assert.ok(
  ![
    "4bd657ac-8789-403e-a28c-93aba8d0a989",
    "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    "86915082-bfa5-478e-a8c4-90d05f01e62c",
  ].includes(id),
);
const observed = await api("POST", `/d1/database/${id}/query`, { sql: "SELECT 1 n" });
const evidence = {
  sha: process.env.GITHUB_SHA,
  name,
  id,
  created: !listed.length,
  creationIngress: resource.ingress,
  observedColo: observed.data[0].meta?.served_by_colo || null,
  observedRegion: observed.data[0].meta?.served_by_region || null,
  productionData: false,
  usedForLoad: false,
};
fs.mkdirSync("artifacts/engagement-locality", { recursive: true });
fs.writeFileSync("artifacts/engagement-locality/resource.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
