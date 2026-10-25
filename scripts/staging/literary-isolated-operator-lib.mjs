import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
export const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
export const isolated = "400c3af3-5d40-41fd-83cc-98228e40ddac";
export const inferName = "cove-literary-infer-isolated-disabled";
export const publisherName = "cove-literary-publisher-isolated-disabled";
export const earlierInference = "cove-literary-infer-draining-20261025";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, "Protected Cloudflare deployment access required");
const base = "https://api.cloudflare.com/client/v4/accounts/" + account;

export async function api(method, path, payload) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, "Cloudflare request failed " + response.status);
  const result = await response.json();
  assert.equal(result.success, true, "Cloudflare access denied");
  return result.result;
}
export async function query(database, sql) {
  const results = await api("POST", "/d1/database/" + database + "/query", { sql });
  assert.ok(Array.isArray(results) && results.every((part) => part.success));
  return results[0]?.results || [];
}
export async function owner() {
  const rows = await query(
    primary,
    "SELECT key,value FROM cove_runtime_config WHERE key IN " +
      "('literary_processing_owner','literary_budget_domain')",
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
export function artifact(name, body) {
  mkdirSync("artifacts/literary-cutover", { recursive: true });
  writeFileSync(
    "artifacts/literary-cutover/" + name,
    JSON.stringify(body, null, 2) + "\n",
  );
}
export async function worker(name) {
  const [settings, schedule, info] = await Promise.all([
    api("GET", "/workers/scripts/" + name + "/settings"),
    api("GET", "/workers/scripts/" + name + "/schedules"),
    api("GET", "/workers/workers/" + name),
  ]);
  assert.equal(info.subdomain?.enabled, false);
  assert.equal(info.subdomain?.previews_enabled, false);
  assert.equal(settings.routes?.length || 0, 0);
  return { bindings: settings.bindings || [], schedule: schedule.schedules || [] };
}
export function secretNames(bindings) {
  return new Set(bindings.filter((x) => x.type === "secret_text").map((x) => x.name));
}
export function variables(bindings) {
  return Object.fromEntries(
    bindings.filter((x) => x.type === "plain_text").map((x) => [x.name, x.text]),
  );
}
