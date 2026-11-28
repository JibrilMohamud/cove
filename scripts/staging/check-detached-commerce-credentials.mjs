import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const account = "f51e8ccbc394e2d6016ff8c2c303d54b";
const database = "f9354381-bd9f-496b-bd05-d6f62a32ec0c";
const bucket = "cove-commerce-detached-media-qa";
const names = [
  "CLOUDFLARE_API_TOKEN",
  "COVE_CF_QA_D1_MUTATION_TOKEN",
  "COVE_CF_QA_R2_STORAGE_TOKEN",
];
function publicKey(key) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const parts = key.split(".");
    return parts.length === 3 && JSON.parse(Buffer.from(parts[1], "base64url")).role === "anon";
  } catch {
    return false;
  }
}
function verify(env) {
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, account);
  const tokens = names.map((name) => env[name]);
  assert.ok(tokens.every((x) => typeof x === "string" && x.length >= 20));
  assert.equal(new Set(tokens).size, 3, "Three distinct QA principals required");
}
const config = readFileSync("wrangler.commerce-qa.stage.toml", "utf8");
assert.ok(config.includes('account_id = "' + account + '"'));
assert.ok(config.includes('database_id = "' + database + '"'));
assert.ok(config.includes('bucket_name = "' + bucket + '"'));
assert.ok(config.includes("workers_dev = false"));
assert.ok(config.includes("preview_urls = false"));
assert.doesNotMatch(config, /4bd657ac-8789-403e-a28c-93aba8d0a989|cove-production-media/);
if (process.argv.includes("--offline")) {
  for (const name of ["cove-commerce-private-qa-deploy", "deployed-commerce-browser-acceptance"]) {
    const workflow = readFileSync(".github/workflows/" + name + ".yml", "utf8");
    assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
    assert.ok(workflow.includes("CLOUDFLARE_ACCOUNT_ID: " + account));
    for (const token of [
      "COVE_CF_QA_WORKERS_DEPLOY_TOKEN",
      "COVE_CF_QA_D1_MUTATION_TOKEN",
      "COVE_CF_QA_R2_STORAGE_TOKEN",
    ])
      assert.ok(workflow.includes("secrets." + token));
  }
  const env = { CLOUDFLARE_ACCOUNT_ID: account };
  for (const [i, name] of names.entries()) env[name] = String(i).repeat(32);
  verify(env);
  assert.throws(() => verify({ ...env, CLOUDFLARE_ACCOUNT_ID: "production" }));
  assert.throws(() => verify({ ...env, CLOUDFLARE_API_TOKEN: env[names[1]] }));
  assert.ok(publicKey("sb_publishable_fixture"));
  assert.ok(!publicKey("sb_secret_fixture"));
  const jwt = (role) => "x." + Buffer.from(JSON.stringify({ role })).toString("base64url") + ".x";
  assert.ok(publicKey(jwt("anon")));
  assert.ok(!publicKey(jwt("service_role")));
  console.log(
    "PASS: detached commerce account, distinct credentials, public-only authentication key",
  );
} else {
  verify(process.env);
  if (process.argv.includes("--supabase"))
    assert.ok(
      publicKey(process.env.QA_SUPABASE_PUBLIC || ""),
      "Protected Supabase public key required",
    );
  console.log("PASS: exact detached commerce account and independent QA credentials");
}
