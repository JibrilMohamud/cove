import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const zone = "07e218b2e74bc522122e0994b8e37576";
const worker = "cove-strangler-m1-staging";
const isolatedDb = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";

/** A successful deploy command alone is not evidence that ingress closed. */
export function assertCapacityClosure({ subdomain, domains, routes, settings, deployments }) {
  assert.equal(subdomain.enabled, false, "Capacity Worker workers.dev ingress remains open");
  assert.equal(subdomain.previews_enabled, false, "Capacity preview ingress remains open");
  assert.ok(!domains.some((d) => d.service === worker), "Capacity Worker has a custom domain");
  assert.ok(!routes.some((r) => r.script === worker), "Capacity Worker has a zone route");
  const dbs = settings.bindings.filter((b) => b.type === "d1");
  assert.equal(dbs.length, 1);
  assert.equal(dbs[0].database_id || dbs[0].id, isolatedDb);
  const value = (name) => settings.bindings.find((b) => b.name === name)?.text;
  assert.equal(value("COVE_SSR_STAGING"), "1");
  assert.equal(value("COVE_STRANGLER_MODE"), "isolated-evaluation");
  const limiter = settings.bindings.find((b) => b.name === "COVE_STOREFRONT_READ_LIMITER");
  assert.equal(limiter?.simple?.limit, 180, "Temporary load limit was not restored");
  assert.ok(
    !settings.bindings.some((b) => b.name === "PRESENTATION"),
    "Temporary R2 binding remains",
  );
  const versions = deployments.deployments[0]?.versions;
  assert.equal(versions?.length, 1, "Closed stage must have one deployment at 100%");
  assert.equal(versions[0].percentage, 100);
  assert.match(versions[0].version_id, /^[a-f0-9-]{36}$/);
  return versions[0].version_id;
}

async function main() {
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(token && token.length > 20);
  const api = async (resource) => {
    const response = await fetch("https://api.cloudflare.com/client/v4" + resource, {
      headers: { authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.ok, true, "Closure control-plane read failed: " + response.status);
    const result = await response.json();
    assert.equal(result.success, true);
    return result.result;
  };
  const base = `/accounts/${account}/workers/scripts/${worker}`;
  const [subdomain, domains, routes, settings, deployments] = await Promise.all([
    api(base + "/subdomain"),
    api(`/accounts/${account}/workers/domains`),
    api(`/zones/${zone}/workers/routes`),
    api(base + "/settings"),
    api(base + "/deployments"),
  ]);
  const version = assertCapacityClosure({ subdomain, domains, routes, settings, deployments });
  const evidence = {
    schema: "cove.protected-capacity-closure.v1",
    observedAt: new Date().toISOString(),
    sha: process.env.GITHUB_SHA || null,
    worker,
    version,
    closed: true,
    canonicalD1Bound: false,
    temporaryLoadLimitRestored: true,
    productionRollbackCertified: false,
    scope: "Independent control-plane verification of isolated capacity-stage closure only",
  };
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync(
    "artifacts/strangler-capacity-closure.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
