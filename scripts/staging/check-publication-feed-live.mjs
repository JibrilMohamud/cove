// Real public source -> independent leased ledger -> private R2, using native
// Worker bindings. No source writes, production route, cron or signing keys.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import ts from "typescript";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const ledger = "b299be94-f885-47a5-9d0b-3a3ac494065a";
const source = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const token = process.env.CLOUDFLARE_API_TOKEN,
  run = process.env.GITHUB_RUN_ID;
assert.ok(token);
assert.match(run || "", /^\d+$/);
assert.notEqual(source, ledger);
const dir = "artifacts/publication-feed";
fs.mkdirSync(dir, { recursive: true });
const evidence = {
  sha: process.env.GITHUB_SHA,
  sourceReadOnly: source,
  independentLedger: ledger,
  productionRouted: false,
  cycles: [],
  verify: null,
  pass: false,
  workers: [],
};
const save = () => fs.writeFileSync(dir + "/results.json", JSON.stringify(evidence, null, 2));
async function api(method, path, body) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const b = await r.json();
  assert.ok(
    r.ok && b.success,
    `Cloudflare ${method} ${r.status} ${JSON.stringify(b.errors || []).slice(0, 500)}`,
  );
  return b.result;
}
async function sql(query, params = []) {
  return (
    await api("POST", `/accounts/${account}/d1/database/${ledger}/query`, { sql: query, params })
  )[0];
}
function cli(args, input) {
  const r = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      encoding: "utf8",
      input,
      timeout: 180000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  assert.equal(
    r.status,
    0,
    "Private publication " +
      args[0] +
      " failed: " +
      String(r.stderr)
        .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
        .slice(-600),
  );
}
const names = evidence.workers;
let cleanupPromise;
function cleanup() {
  return (cleanupPromise ||= (async () => {
    for (const name of [...names].reverse()) {
      try {
        await api("DELETE", `/accounts/${account}/workers/scripts/${name}`);
      } catch {
        evidence.cleanupFailed = true;
      }
    }
    save();
  })());
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    evidence.cancelled = true;
    void cleanup().finally(() => process.exit(130));
  });
try {
  const tables = await sql("SELECT name FROM sqlite_master WHERE type='table'");
  if (!tables.results.some((r) => r.name === "discovery_domain_identity")) {
    assert.ok(
      tables.results.every((r) => r.name === "_cf_KV"),
      "Unexpected tables in publication staging domain",
    );
    await sql(fs.readFileSync("infra/discovery/0001_publication_feed.sql", "utf8"));
  }
  const identity = await sql(
    "SELECT domain,schema_version FROM discovery_domain_identity WHERE id=1",
  );
  assert.equal(identity.results[0].domain, "cove-public-presentation");
  assert.ok(
    !tables.results.some((r) =>
      ["products", "rights_grants", "users", "commerce_orders"].includes(r.name),
    ),
  );
  // Rebuild the disposable stage ledger's markets, preserving monotonically
  // increasing generations. Old in-flight ACKs lose their lease fence.
  await sql(
    "UPDATE discovery_publications SET status='delivered',attempts=0,due_at=0,lease_token='',lease_until=0",
  );
  const prefix = `feed/campaign/${run}/`;
  for (const lane of ["export", "publish"]) {
    const fileName = `wrangler.publication-${lane}.stage.jsonc`;
    const parsed = ts.parseConfigFileTextToJson(fileName, fs.readFileSync(fileName, "utf8"));
    assert.ok(!parsed.error, "Invalid publication config");
    const c = parsed.config;
    assert.equal(c.workers_dev, false);
    assert.equal(c.preview_urls, false);
    assert.ok(!c.routes && !c.route && !c.triggers && !c.queues);
    assert.equal(c.vars.COVE_PUBLICATION_ENABLED, "0");
    assert.equal(c.d1_databases.find((x) => x.binding === "DISCOVERY_DB").database_id, ledger);
    if (lane === "export") {
      assert.equal(c.d1_databases.find((x) => x.binding === "SOURCE_DB").database_id, source);
      assert.ok(!c.r2_buckets);
    } else {
      assert.equal(c.d1_databases.length, 1);
      assert.ok(!JSON.stringify(c).includes(source));
    }
    c.name = `cove-pub-${run}-${lane}`;
    names.push(c.name);
    c.vars.COVE_PUBLICATION_ENABLED = "1";
    c.vars.COVE_PRESENTATION_PREFIX = prefix;
    const file = `.output/strangler/live-${lane}.jsonc`;
    c.main = `publication-${lane}.mjs`;
    fs.writeFileSync(file, JSON.stringify(c));
    cli(["deploy", "--config", file]);
  }
  const gate = randomBytes(32).toString("hex");
  const name = `cove-pub-${run}-driver`;
  names.push(name);
  const config = {
    name,
    main: "publication-driver.mjs",
    workers_dev: true,
    preview_urls: false,
    compatibility_date: "2026-10-22",
    compatibility_flags: ["nodejs_compat"],
    services: [
      { binding: "EXPORTER", service: names[0] },
      { binding: "PUBLISHER", service: names[1] },
    ],
    r2_buckets: [
      { binding: "PRESENTATION", bucket_name: "cove-strangler-private-presentation-stage" },
    ],
    vars: { PREFIX: prefix },
  };
  const configPath = ".output/strangler/publication-driver.jsonc";
  fs.writeFileSync(configPath, JSON.stringify(config));
  cli(["deploy", "--config", configPath]);
  cli(["secret", "put", "GATE", "--config", configPath], gate);
  // Propagation only; these are publication control calls, never storefront
  // cold/performance samples. Retry failures are retained in the evidence.
  await new Promise((r) => setTimeout(r, 25000));
  const origin = `https://${name}.cove-jibrilmohamud.workers.dev`;
  async function invoke(path, method = "POST") {
    const r = await fetch(origin + path, {
      method,
      headers: { authorization: "Bearer " + gate },
      signal: AbortSignal.timeout(90000),
    });
    const body = await r.text();
    assert.equal(r.status, 200, body.slice(0, 200));
    return JSON.parse(body);
  }
  for (let cycle = 1; cycle <= 2; cycle++) {
    if (cycle === 2)
      await sql("UPDATE discovery_publications SET due_at=0 WHERE status='delivered'");
    const calls = [];
    for (let turn = 0; turn < 20; turn++) {
      const exported = await invoke("/export");
      const published = await invoke("/publish");
      calls.push({ exported, published });
      const failedExport = exported.results.filter((r) => !r.exported);
      const failedPublish = published.filter((r) => !r.published);
      if (failedExport.length || failedPublish.length)
        evidence.transientFailures = (evidence.transientFailures || 0) +
          failedExport.length + failedPublish.length;
      // The ledger owns bounded retries: a transient transport fault must
      // recover through its lease/backoff, not bypass the fence in CI.
      // Any permanent failure still fails the final all-markets gate.
      const pending = await sql(
        "SELECT COUNT(*) n FROM discovery_publications WHERE active=1 AND (status<>'delivered' OR due_at<=?)",
        [Date.now()],
      );
      if (pending.results[0].n === 0) break;
      if (failedExport.length || failedPublish.length) {
        const retry = await sql(
          "SELECT MIN(lease_until) due FROM discovery_publications WHERE active=1 AND last_error<>'' AND lease_until>?",
          [Date.now()],
        );
        const next = Number(retry.results[0]?.due || 0);
        if (next > Date.now()) {
          const delay = Math.min(45_000, next - Date.now() + 250);
          evidence.retryWaitMs = (evidence.retryWaitMs || 0) + delay;
          assert.ok(evidence.retryWaitMs < 150_000, "Bounded publication retry budget exceeded");
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    const rows = await sql(
      "SELECT country,generation,status,sha256,expires_at,source_metrics,published_at,last_error FROM discovery_publications WHERE active=1 ORDER BY country",
    );
    assert.ok(rows.results.length > 0 && rows.results.length <= 32);
    assert.ok(
      rows.results.every(
        (r) =>
          r.status === "delivered" &&
          r.expires_at > Date.now() &&
          r.published_at > 0 &&
          !r.last_error,
      ),
    );
    if (cycle === 2)
      assert.ok(
        rows.results.every(
          (r) =>
            r.generation > evidence.cycles[0].rows.find((p) => p.country === r.country).generation,
        ),
      );
    evidence.cycles.push({ calls, rows: rows.results });
    save();
    console.log(
      "PUBLICATION_CYCLE",
      JSON.stringify({
        cycle,
        markets: rows.results.length,
        source: calls.map((c) => c.exported.source),
      }),
    );
  }
  evidence.verify = await invoke("/verify", "GET");
  assert.equal(evidence.verify.length, 4);
  assert.ok(
    evidence.verify.every(
      (r) =>
        r.candidates >= 0 &&
        r.candidates <= 128 &&
        r.display >= 0 &&
        r.display <= 128 &&
        r.expires > Date.now(),
    ),
  );
  assert.ok(evidence.verify.find((r) => r.country === "US")?.display > 0);
  // Anonymous callers cannot use the control plane.
  assert.equal((await fetch(origin + "/export", { method: "POST" })).status, 401);
  evidence.pass = true;
  save();
  console.log("PUBLICATION_LIVE_PASS", JSON.stringify(evidence.verify));
} finally {
  await cleanup();
  assert.ok(!evidence.cleanupFailed, "Publication stage cleanup failed");
}
