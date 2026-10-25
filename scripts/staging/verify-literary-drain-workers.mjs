import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
async function get(path) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + account + path, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(25000),
  });
  assert.ok(response.ok);
  const json = await response.json();
  assert.equal(json.success, true);
  return json.result;
}
for (const role of ["handoff", "prepare"]) {
  const name = "cove-literary-" + role + "-draining-20261025";
  const [settings, schedules, info] = await Promise.all([
    get("/workers/scripts/" + name + "/settings"),
    get("/workers/scripts/" + name + "/schedules"),
    get("/workers/workers/" + name),
  ]);
  assert.equal(info.subdomain?.enabled, false);
  assert.equal(info.subdomain?.previews_enabled, false);
  assert.equal(settings.routes?.length || 0, 0);
  assert.deepEqual(
    schedules.schedules.map((x) => x.cron),
    ["* * * * *"],
  );
  const b = settings.bindings || [];
  const vals = Object.fromEntries(
    b.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
  );
  assert.equal(vals.FORE_CONTENT_PROCESSOR_ENABLED, "1");
  assert.equal(vals.FORE_CONTENT_PREPARE_ENABLED, "1");
  assert.equal(vals.FORE_CONTENT_PROCESSOR_ROLE, "literary-" + role);
  assert.deepEqual(
    b
      .filter((x) => x.type === "d1")
      .map((x) => x.database_id)
      .sort(),
    ["4bd657ac-8789-403e-a28c-93aba8d0a989", "400c3af3-5d40-41fd-83cc-98228e40ddac"].sort(),
  );
  const r2 = b.filter((x) => x.type === "r2_bucket");
  assert.ok(
    r2.some(
      (x) => x.name === "BUCKET" && x.bucket_name === "cove-literary-originals-isolated-20261024",
    ),
  );
  if (role === "prepare") {
    assert.ok(
      r2.some((x) => x.name === "SOURCE_BUCKET" && x.bucket_name === "cove-production-media"),
    );
  } else {
    assert.equal(vals.FORE_CONTENT_HANDOFF_ENABLED, "1");
    assert.equal(vals.FORE_LITERARY_DRAIN_RECONCILE_ENABLED, "1");
  }
}
console.log(
  "LITERARY_DRAIN_WORKERS_DEPLOYED_PASS private source binding, role flags, no routes, bounded cron; canonical owner still checked separately",
);
