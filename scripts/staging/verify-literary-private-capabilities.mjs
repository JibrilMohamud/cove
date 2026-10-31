import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export const literaryWorkers = {
  handoff: "cove-literary-handoff-draining-20261025",
  prepare: "cove-literary-prepare-draining-20261025",
  infer: "cove-literary-infer-isolated-disabled",
  publisher: "cove-literary-publisher-isolated-disabled",
};
export function assertLiteraryCapabilities(role, bindings) {
  const named = (name) => bindings.find((b) => b.name === name);
  const databases = bindings.filter((b) => b.type === "d1");
  assert.deepEqual(
    databases.map((b) => b.database_id || b.id),
    ["prepare", "infer"].includes(role) ? ["400c3af3-5d40-41fd-83cc-98228e40ddac"] : [],
  );
  const service = (name) => {
    assert.equal(named(name)?.type, "service");
    assert.equal(named(name)?.service, "cove-legal-authority-production");
  };
  const secret = (name) => assert.equal(named(name)?.type, "secret_text");
  if (role !== "handoff") {
    service("LITERARY_PRIMARY_READER");
    secret("COVE_LITERARY_READ_SECRET");
    assert.equal(named("COVE_LITERARY_PRIVATE_READ_ENABLED")?.text, "1");
  }
  if (["handoff", "publisher"].includes(role)) {
    service("LITERARY_CANONICAL_OWNER");
    const scope = role === "handoff" ? "HANDOFF" : "PUBLICATION";
    secret("COVE_LITERARY_" + scope + "_SECRET");
    assert.equal(named("COVE_LITERARY_PRIVATE_" + scope + "_ENABLED")?.text, "1");
    assert.equal(bindings.filter((b) => b.type === "r2_bucket").length, 0);
  }
  if (role === "infer") {
    assert.equal(named("LITERARY_PUBLISHER")?.service, literaryWorkers.publisher);
    assert.equal(named("FORE_CONTENT_BUDGET_MODE")?.text, "isolated");
    secret("FORE_LITERARY_INFERENCE_PUBLISH_TOKEN");
    secret("FORE_LITERARY_INFERENCE_BACKEND_TOKEN");
  }
  if (role === "publisher") {
    secret("FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256");
    secret("FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256");
    assert.equal(named("FORE_LITERARY_INFERENCE_PUBLISH_ENABLED")?.text, "1");
  } else {
    assert.equal(named("FORE_CONTENT_PROCESSOR_ROLE")?.text, "literary-" + role);
    assert.equal(named("FORE_CONTENT_PROCESSOR_ENABLED")?.text, "1");
  }
  return true;
}
async function main() {
  const account = "d26430caa63ec55f6612e32f36aca5e9";
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(token);
  const api = async (path) => {
    const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
      headers: { authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    assert.ok(response.ok);
    const data = await response.json();
    assert.equal(data.success, true);
    return data.result;
  };
  const [domains, routes] = await Promise.all([
    api(`/accounts/${account}/workers/domains`),
    api("/zones/07e218b2e74bc522122e0994b8e37576/workers/routes"),
  ]);
  for (const [role, name] of Object.entries(literaryWorkers)) {
    const base = `/accounts/${account}/workers/scripts/${name}`;
    const [settings, subdomain, schedules, deployments] = await Promise.all([
      api(base + "/settings"),
      api(base + "/subdomain"),
      api(base + "/schedules"),
      api(base + "/deployments"),
    ]);
    assertLiteraryCapabilities(role, settings.bindings);
    assert.equal(subdomain.enabled, false);
    assert.equal(subdomain.previews_enabled, false);
    assert.ok(!domains.some((d) => d.service === name));
    assert.ok(!routes.some((r) => r.script === name));
    assert.deepEqual(
      schedules.schedules.map((s) => s.cron),
      role === "publisher" ? [] : ["* * * * *"],
    );
    assert.equal(deployments.deployments[0].versions.length, 1);
    assert.equal(deployments.deployments[0].versions[0].percentage, 100);
    console.log(
      JSON.stringify({
        role,
        name,
        canonicalD1: false,
        version: deployments.deployments[0].versions[0].version_id,
      }),
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
