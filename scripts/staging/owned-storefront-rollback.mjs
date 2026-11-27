import assert from "node:assert/strict";
import fs from "node:fs";

const names = [
  "cove-owned-homepage-authority",
  "cove-owned-homepage-stage",
  "cove-asset-auth-stage",
  "cove-asset-auth-gateway",
];
const account = "d26430caa63ec55f6612e32f36aca5e9";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.match(process.env.GITHUB_SHA || "", /^[a-f0-9]{40}$/);
assert.match(process.env.GITHUB_RUN_ID || "", /^[1-9][0-9]+$/);
assert.match(process.env.COVE_OWNED_ROLLBACK_GATE_KEY || "", /^[a-f0-9]{64}$/);
const phase = process.argv[2];
assert.ok(["capture", "restore"].includes(phase));
const file = ".owned-rollback.json";
async function api(name, method, suffix, body) {
  assert.ok(names.includes(name));
  assert.ok(
    method === "GET" || (phase === "restore" && method === "POST" && suffix === "/deployments"),
  );
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}${suffix}${method === "POST" ? "?force=true" : ""}`,
    {
      method,
      headers: {
        authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    },
  );
  const payload = await r.json().catch(() => null);
  const codes = (payload?.errors || []).map((error) => error.code).filter(Number.isSafeInteger);
  assert.ok(
    r.ok && payload?.success === true,
    `Isolated rollback control-plane request failed: status=${r.status} codes=${codes.join(",")}`,
  );
  return payload.result;
}
if (phase === "capture") {
  const versions = [];
  for (const name of names) {
    const deployment = (await api(name, "GET", "/deployments")).deployments[0];
    assert.equal(deployment.versions.length, 1);
    const v = deployment.versions[0];
    assert.equal(v.percentage, 100);
    assert.match(v.version_id, /^[a-f0-9-]{36}$/);
    versions.push({ name, id: v.version_id });
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, versions }),
    {
      mode: 0o600,
    },
  );
  console.log("Captured all four isolated serving versions for protected rollback");
} else {
  const captured = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(captured.sha, process.env.GITHUB_SHA);
  assert.equal(captured.runId, process.env.GITHUB_RUN_ID);
  assert.deepEqual(
    captured.versions.map((v) => v.name),
    names,
  );
  // Cold trials deliberately rotate secrets. Cloudflare requires force for
  // restoring a captured version across those secret changes. This capability
  // is confined to the four exact isolated QA scripts and same-run SHA pins.
  for (const v of captured.versions) assert.match(v.id, /^[a-f0-9-]{36}$/);
  for (const v of captured.versions) {
    await api(v.name, "POST", "/deployments", {
      strategy: "percentage",
      versions: [{ version_id: v.id, percentage: 100 }],
    });
  }
  for (const v of captured.versions) {
    const deployment = (await api(v.name, "GET", "/deployments")).deployments[0];
    assert.deepEqual(deployment.versions, [{ version_id: v.id, percentage: 100 }]);
  }
  // Deployment settling is not a benchmark retry or a cold observation.
  const deadline = Date.now() + 150000;
  let passed = false;
  while (Date.now() < deadline) {
    const responses = await Promise.all([
      fetch("https://ssr-canary.covereads.com/", {
        headers: { authorization: "Bearer " + process.env.COVE_OWNED_ROLLBACK_GATE_KEY },
        signal: AbortSignal.timeout(12000),
      }),
      fetch("https://ssr-canary.covereads.com/covers/1.jpg", {
        signal: AbortSignal.timeout(12000),
      }),
    ]).catch(() => []);
    if (
      responses.length === 2 &&
      responses[0].status === 200 &&
      responses[1].status === 401 &&
      responses[0].headers.get("x-cove-homepage-authority") === "isolated-canonical-primary" &&
      /class="book-card"/.test(await responses[0].text())
    ) {
      passed = true;
      break;
    }
    for (const response of responses) await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.equal(passed, true, "Restored serving path or asset-denial gate did not recover");
  fs.writeFileSync(
    "artifacts/owned-storefront/rollback.json",
    JSON.stringify(
      { sha: captured.sha, versions: captured.versions, passed, productionModified: false },
      null,
      2,
    ),
  );
  console.log(
    "PASS: pinned four-service rollback restores prepared catalog and denies anonymous assets",
  );
}
