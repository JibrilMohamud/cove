// Real public source -> independent leased ledger -> private R2, using native
// Worker bindings. No source writes, production route, cron or signing keys.
import { preparePublicationExport } from "./publication-source-readiness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import {
  freshCaptureCoverage,
  CAPTURE_SOURCE,
  verifyPinnedCapture,
} from "./verify-pinned-publication-capture.mjs";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const ledger = "b299be94-f885-47a5-9d0b-3a3ac494065a";
const source = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const token = process.env.CLOUDFLARE_API_TOKEN,
  readToken = process.env.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN,
  run = process.env.GITHUB_RUN_ID;
const metadataToken = process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN;
assert.ok(token && readToken && metadataToken);
assert.equal(new Set([token, readToken, metadataToken]).size, 3);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.match(run || "", /^[1-9][0-9]{7,14}$/);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
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
  if (path.includes("/d1/database/")) {
    assert.equal(method, "POST");
    assert.match(body?.sql || "", /^SELECT\b/i);
    assert.ok(
      [ledger, "1825b4a1-0329-408d-9cc2-a40e6a17c822"].some(
        (id) => path === `/accounts/${account}/d1/database/${id}/query`,
      ),
    );
  }
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + (path.includes("/d1/database/") ? readToken : token),
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (method === "DELETE" && r.status === 404) return null;
  const b = await r.json();
  assert.ok(
    r.ok && b.success,
    `Cloudflare ${method} ${r.status} ${JSON.stringify(b.errors || []).slice(0, 500)}`,
  );
  return b.result;
}
async function sql(query, params = []) {
  assert.match(query.trim(), /^SELECT\b/i);
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
// Some freshly provisioned Workers are briefly absent from Cloudflare's
// versions API (10007). Retry only this pre-traffic provisioning race. No
// benchmark request or app error is replayed or ignored.
async function deployStage(config) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cli(["deploy", "--config", config]);
      return;
    } catch (error) {
      if (attempt === 3 || !/Worker does not exist|code:\s*10007/i.test(String(error))) throw error;
      console.warn("Stage Worker provisioning delayed; retry " + attempt);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
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
  assert.ok(
    tables.results.some((r) => r.name === "discovery_domain_identity"),
    "Existing reviewed isolated ledger migration required",
  );
  const identity = await sql(
    "SELECT domain,schema_version FROM discovery_domain_identity WHERE id=1",
  );
  assert.equal(identity.results[0].domain, "cove-public-presentation");
  assert.ok(
    !tables.results.some((r) =>
      ["products", "rights_grants", "users", "commerce_orders"].includes(r.name),
    ),
  );
  // Rebuild only the disposable stage ledger after checking no live leases.
  // Preserve monotonic generations; never steal an in-flight writer lease.
  const prefix = `feed/campaign/${run}/`;
  // Preserve the working immutable capture. The disposable campaign owns
  // only its export, publish and driver Workers, never the capture itself.
  evidence.captureDependency = await verifyPinnedCapture(metadataToken);
  async function captureGenerations() {
    return (
      await api("POST", `/accounts/${account}/d1/database/${CAPTURE_SOURCE}/query`, {
        sql: "SELECT country,generation,expires_at FROM cove_publication_source_snapshots ORDER BY country",
      })
    )[0].results;
  }
  const initial = new Map((await captureGenerations()).map((r) => [r.country, r.generation]));
  async function readSourceState() {
    return (
      await api("POST", "/accounts/" + account + "/d1/database/" + CAPTURE_SOURCE + "/query", {
        sql: "SELECT (SELECT COUNT(*) FROM cove_publication_source_snapshots) available,(SELECT expected_markets FROM cove_publication_source_progress WHERE id=1) expected,(SELECT last_synced_at FROM cove_publication_source_identity WHERE id=1) last_synced",
      })
    )[0].results[0];
  }
  // The immutable typed owner capture is cron-driven. Observe a complete
  // new rotation through read-only D1, never an unsupported HTTP route.
  let sourceRow;
  let freshGenerationCoverage = false;
  for (let turn = 0; turn < 38; turn++) {
    const fresh = await captureGenerations();
    sourceRow = await readSourceState();
    freshGenerationCoverage = freshCaptureCoverage(initial, fresh, sourceRow, Date.now());
    if (freshGenerationCoverage) break;
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  assert.ok(freshGenerationCoverage, "Every market must advance beyond its initial generation");
  evidence.captureRotation = {
    initialMarkets: initial.size,
    markets: sourceRow.expected,
    scheduled: true,
  };
  save();
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
      assert.equal(
        c.d1_databases.find((x) => x.binding === "SOURCE_DB").database_id,
        "1825b4a1-0329-408d-9cc2-a40e6a17c822",
      );
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
    await deployStage(file);
  }
  const gate = randomBytes(32).toString("hex");
  console.log("::add-mask::" + gate);
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
    d1_databases: [
      {
        binding: "DISCOVERY_DB",
        database_name: "cove-discovery-publication-stage-20261022",
        database_id: ledger,
      },
    ],
    r2_buckets: [
      { binding: "PRESENTATION", bucket_name: "cove-strangler-private-presentation-stage" },
    ],
    vars: { PREFIX: prefix, COVE_QA_EXPIRES: String(Date.now() + 20 * 60_000) },
  };
  const configPath = ".output/strangler/publication-driver.jsonc";
  fs.writeFileSync(configPath, JSON.stringify(config));
  await deployStage(configPath);
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
    let receipt;
    try {
      receipt = JSON.parse(body);
    } catch {
      receipt = null;
    }
    const safeError =
      typeof receipt?.error === "string" &&
      /^(?:capture_[a-z_]+|canonical_primary_read_unavailable|Canonical read unavailable: HTTP [0-9]{3} code [0-9]+)$/.test(
        receipt.error,
      )
        ? receipt.error
        : "unclassified";
    assert.equal(r.status, 200, path + ": " + safeError);
    return receipt;
  }
  // Backfill and refresh are separate and bounded: the SOURCE_DB bound to
  // export is physically independent of the authoritative rights/catalog D1.
  // The capture worker alone reads public presentation source fields.
  assert.deepEqual(await invoke("/reset-ledger"), { ok: true });
  console.log("PUBLICATION_SOURCE_CAPTURE_PASS", JSON.stringify(evidence.captureRotation));
  for (let cycle = 1; cycle <= 2; cycle++) {
    if (cycle === 2) {
      // Capture continues independently on its pinned schedule.
      const fresh = await captureGenerations();
      assert.ok(freshCaptureCoverage(initial, fresh, await readSourceState(), Date.now()));
      assert.deepEqual(await invoke("/refresh-ledger"), { ok: true });
    }
    const calls = [];
    for (let turn = 0; turn < 20; turn++) {
      const prepared = await preparePublicationExport({
        initial,
        read: async () => ({ rows: await captureGenerations(), state: await readSourceState() }),
      });
      evidence.exportPreparations ||= [];
      evidence.exportPreparations.push({ cycle, turn, ...prepared });
      save();
      const exported = await invoke("/export");
      const published = await invoke("/publish");
      calls.push({ exported, published });
      const failedExport = exported.results.filter((r) => !r.exported);
      const failedPublish = published.filter((r) => !r.published);
      if (failedExport.length || failedPublish.length)
        evidence.transientFailures =
          (evidence.transientFailures || 0) + failedExport.length + failedPublish.length;
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
    assert.equal(rows.results.length, sourceRow.expected, "Incomplete all-market publication");
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
    assert.ok(
      calls.every(
        (x) =>
          !x.exported.source ||
          x.exported.source.statements ===
            x.exported.source.primary + x.exported.source.replica + x.exported.source.unknown,
      ),
      "Publication source routing metrics incomplete",
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
  assert.deepEqual(await verifyPinnedCapture(metadataToken), evidence.captureDependency);
  evidence.pass = true;
  save();
  console.log("PUBLICATION_LIVE_PASS", JSON.stringify(evidence.verify));
} finally {
  await cleanup();
  assert.ok(!evidence.cleanupFailed, "Publication stage cleanup failed");
}
