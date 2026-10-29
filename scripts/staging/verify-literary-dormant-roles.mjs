import assert from "node:assert/strict";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const contentDb = "400c3af3-5d40-41fd-83cc-98228e40ddac";
const privateBucket = "cove-literary-originals-isolated-20261024";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.ok(token);
async function get(path) {
  const result = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(20000),
  });
  const data = await result.json();
  assert.ok(result.ok && data.success, "Dormant role settings not available");
  return data.result;
}
const roles = [
  {
    name: "cove-literary-prepare-isolated-disabled",
    role: "literary-prepare",
    flags: ["FORE_CONTENT_PROCESSOR_ENABLED", "FORE_CONTENT_PREPARE_ENABLED"],
  },
  {
    name: "cove-literary-infer-isolated-disabled",
    role: "literary-infer",
    flags: [
      "FORE_CONTENT_PROCESSOR_ENABLED",
      "FORE_CONTENT_PREPARE_ENABLED",
      "FORE_CONTENT_INFERENCE_ENABLED",
    ],
  },
];
for (const role of roles) {
  let verified = false;
  for (let attempt = 0; attempt < 9; attempt++) {
    const [settings, schedules, worker] = await Promise.all([
      get(`/accounts/${account}/workers/scripts/${role.name}/settings`),
      get(`/accounts/${account}/workers/scripts/${role.name}/schedules`),
      get(`/accounts/${account}/workers/workers/${role.name}`),
    ]);
    const b = settings.bindings || [];
    const values = Object.fromEntries(
      b.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
    );
    const db = b.filter((x) => x.type === "d1").map((x) => x.database_id);
    const buckets = b.filter((x) => x.type === "r2_bucket").map((x) => x.bucket_name);
    verified =
      db.length === (role.role === "literary-prepare" ? 1 : 2) &&
      (role.role !== "literary-prepare" || !db.includes(primary)) &&
      (role.role !== "literary-infer" || db.includes(primary)) &&
      db.includes(contentDb) &&
      buckets.length === (role.role === "literary-prepare" ? 2 : 1) &&
      buckets.includes(privateBucket) &&
      (role.role !== "literary-prepare" ||
        b.some(
          (x) =>
            x.type === "r2_bucket" &&
            x.name === "SOURCE_BUCKET" &&
            x.bucket_name === "cove-production-media",
        )) &&
      values.FORE_CONTENT_PROCESSOR_ROLE === role.role &&
      role.flags.every((key) => values[key] === "0") &&
      !(schedules.schedules || []).length &&
      !(settings.routes || []).length &&
      !worker.subdomain?.enabled &&
      !worker.subdomain?.previews_enabled &&
      (role.role !== "literary-infer" ||
        (b.some((x) => x.type === "ai" && x.name === "AI") &&
          b.some(
            (x) =>
              x.type === "service" &&
              x.name === "LITERARY_PUBLISHER" &&
              x.service === "cove-literary-publisher-isolated-disabled",
          )));
    if (verified) break;
    await new Promise((resolve) => setTimeout(resolve, 1600));
  }
  assert.ok(verified, "Dormant " + role.role + " Worker did not converge to safe bindings");
}
console.log(
  "LITERARY_PREPARE_INFER_DORMANT_PASS no routes, crons or execution; isolated CONTENT_DB and private R2",
);
