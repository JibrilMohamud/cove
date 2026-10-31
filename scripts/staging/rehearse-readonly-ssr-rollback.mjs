import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  validateHtml,
  visibleServerBookCount,
} from "../check-production-storefront-performance.mjs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const worker = "cove-storefront-ssr-staging";
const origin = "https://" + worker + ".cove-jibrilmohamud.workers.dev";
const base = `/accounts/${account}/workers/scripts/${worker}`;

export function assertProtectedReadonlyStage(settings, deployments) {
  const bindings = settings.bindings;
  assert.ok(Array.isArray(bindings));
  assert.ok(!bindings.some((b) => b.type === "d1"), "Never rehearse with native D1 privileges");
  assert.equal(bindings.find((b) => b.name === "COVE_SSR_STAGING")?.text, "1");
  assert.equal(bindings.find((b) => b.name === "COVE_CANONICAL_READONLY_RPC")?.text, "1");
  assert.equal(bindings.find((b) => b.name === "COVE_SSR_STAGING_GATE_KEY")?.type, "secret_text");
  const read = bindings.find((b) => b.name === "COVE_CANONICAL_READONLY");
  assert.equal(read?.type, "service");
  assert.equal(read.service, "cove-canonical-d1-readonly");
  assert.ok(
    !bindings.some((b) => ["FORE_BACKEND_URL", "FORE_BACKEND_TOKEN"].includes(b.name)),
    "Remote fallback is outside this rehearsal",
  );
  const versions = deployments.deployments[0]?.versions;
  assert.equal(versions?.length, 1);
  assert.equal(versions[0].percentage, 100);
  assert.match(versions[0].version_id, /^[a-f0-9-]{36}$/);
  return versions[0].version_id;
}

export function assertClosedCatalog(response) {
  assert.equal(response.cards, 0, "Outage must not expose a stale or seeded shelf");
  assert.ok([200, 503].includes(response.status), "Expected controlled unavailable response");
  assert.ok(response.noStore, "Outage response must be no-store");
}

async function activeSettings(api) {
  const deployments = await api("GET", base + "/deployments");
  const versions = deployments.deployments[0]?.versions;
  assert.equal(versions?.length, 1);
  assert.equal(versions[0].percentage, 100);
  const version = await api("GET", base + "/versions/" + versions[0].version_id);
  assert.equal(version.id, versions[0].version_id);
  return { settings: version.resources, deployments };
}

export async function verifyRestoration(api, probe, record) {
  const { settings, deployments } = await activeSettings(api);
  assert.equal(assertProtectedReadonlyStage(settings, deployments), record.baselineVersion);
  record.after = await probe(true);
  assert.ok(record.after.status === 200 && record.after.cards > 0 && record.after.noStore);
  assert.equal((await probe(false)).status, 401);
  record.restored = true;
}

// The only mutation is removing the read service from protected SSR staging.
// Restore the pinned, already-read-only version in finally, including when
// the PATCH acknowledgement or outage probe is interrupted by an exception.
export async function rehearseReadonlyRollback(api, probe, record) {
  const { settings, deployments } = await activeSettings(api);
  const version = assertProtectedReadonlyStage(settings, deployments);
  const domains = await api("GET", `/accounts/${account}/workers/domains`);
  const routes = await api("GET", "/zones/07e218b2e74bc522122e0994b8e37576/workers/routes");
  assert.ok(!domains.some((d) => d.service === worker), "Staging has a custom domain");
  assert.ok(!routes.some((r) => r.script === worker), "Staging has an owned-zone route");
  record.baselineVersion = version;
  record.before = await probe(true);
  assert.ok(record.before.cards > 0 && record.before.status === 200 && record.before.noStore);
  assert.equal((await probe(false)).status, 401);
  let attempted = false;
  try {
    attempted = true;
    await api("PATCH", base + "/settings", {
      bindings: settings.bindings
        .filter((b) => b.name !== "COVE_CANONICAL_READONLY")
        .map((b) => ({ name: b.name, type: "inherit" })),
      annotations: {
        "workers/message": "Protected read-service outage rehearsal; restore pinned version",
      },
    });
    const { settings: failed } = await activeSettings(api);
    assert.ok(!failed.bindings.some((b) => b.name === "COVE_CANONICAL_READONLY"));
    assert.ok(!failed.bindings.some((b) => b.type === "d1"));
    record.outage = await probe(true);
    assertClosedCatalog(record.outage);
    assert.equal((await probe(false)).status, 401);
    record.failureClosed = true;
  } finally {
    if (attempted) {
      await api("POST", base + "/deployments", {
        strategy: "percentage",
        versions: [{ version_id: version, percentage: 100 }],
        annotations: {
          "workers/message": "Restore pinned read-only SSR after protected outage rehearsal",
        },
      });
      // /settings is the latest upload, which may be the failed candidate.
      // Inspect every active deployment's immutable version instead.
      await verifyRestoration(api, probe, record);
    }
  }
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const bearer = process.env.COVE_SSR_STAGING_GATE_KEY;
  assert.ok(token);
  assert.match(bearer || "", /^[a-f0-9]{64}$/);
  const record = process.argv.includes("--verify-restoration")
    ? JSON.parse(fs.readFileSync("artifacts/protected-readonly-ssr-rollback.json", "utf8"))
    : {
        schema: "cove.protected-readonly-ssr-rollback.v1",
        observedAt: new Date().toISOString(),
        worker,
        productionRollbackCertified: false,
        paymentSessionContinuityCertified: false,
      };
  const api = async (method, path, body) => {
    const headers = { authorization: "Bearer " + token };
    let payload;
    if (method === "PATCH") {
      payload = new FormData();
      payload.set("settings", new Blob([JSON.stringify(body)], { type: "application/json" }));
    } else if (body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method,
      headers,
      body: payload,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    assert.ok(response.ok && data.success, `Control-plane ${method} failed: ${response.status}`);
    return data.result;
  };
  const probe = async (authenticated) => {
    const response = await fetch(origin + "/", {
      headers: authenticated ? { authorization: "Bearer " + bearer, accept: "text/html" } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    const html = await response.text();
    const cards = visibleServerBookCount(html);
    if (cards) validateHtml(response.status, response.headers.get("content-type") || "", html);
    return {
      status: response.status,
      cards,
      noStore: /\bno-store\b/.test(response.headers.get("cache-control") || ""),
    };
  };
  try {
    if (process.argv.includes("--verify-restoration")) {
      assert.equal(record.schema, "cove.protected-readonly-ssr-rollback.v1");
      assert.equal(record.worker, worker);
      assert.equal(record.failureClosed, true);
      await verifyRestoration(api, probe, record);
      record.restorationVerifiedAt = new Date().toISOString();
    } else await rehearseReadonlyRollback(api, probe, record);
    record.passed = record.failureClosed && record.restored;
  } finally {
    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync(
      "artifacts/protected-readonly-ssr-rollback.json",
      JSON.stringify(record, null, 2) + "\n",
    );
    console.log(JSON.stringify(record));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
