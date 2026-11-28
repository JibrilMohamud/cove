import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

export const primary = "4bd657ac-8789-403e-a28c-93aba8d0a989";
export const isolated = "400c3af3-5d40-41fd-83cc-98228e40ddac";
export const inferName = "cove-literary-infer-isolated-disabled";
export const publisherName = "cove-literary-publisher-isolated-disabled";
export const earlierInference = "cove-literary-infer-draining-20261025";
// The historical transition is complete. Never let its direct REST SQL or
// schedule operator run again, even if invoked outside the retired workflow.
export async function api() {
  throw Error("literary_legacy_publication_operator_retired");
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
  writeFileSync("artifacts/literary-cutover/" + name, JSON.stringify(body, null, 2) + "\n");
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
