// Production routing is never touched. Continuous publication QA is composed
// from the default-disabled, nonroutable private Worker templates.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const canonical = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const source = "1825b4a1-0329-408d-9cc2-a40e6a17c822";
const ledger = "34cf996a-830d-4ec3-8071-8cc3ec7b6df9";
const prefix = "feed/qa/continuous/";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token && process.env.CLOUDFLARE_ACCOUNT_ID === account);
assert.equal(new Set([canonical, source, ledger]).size, 3);

function template(lane) {
  const path =
    lane === "capture"
      ? "wrangler.publication-capture.prod-private.jsonc"
      : `wrangler.publication-${lane}.stage.jsonc`;
  const parsed = ts.parseConfigFileTextToJson(path, fs.readFileSync(path, "utf8"));
  assert.ok(!parsed.error, `Unable to read controlled ${lane} template`);
  const config = parsed.config;
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(
    !config.routes && !config.route && (lane === "capture" || !config.triggers) && !config.queues,
  );
  if (lane === "capture") {
    assert.equal(config.vars.COVE_PUBLICATION_CAPTURE_ENABLED, "1");
    assert.ok(
      !config.d1_databases.some((b) => b.binding === "SOURCE_DB" || b.database_id === canonical),
    );
    assert.deepEqual(config.services, [
      { binding: "SOURCE_READER", service: "cove-legal-authority-production" },
    ]);
    assert.equal(
      config.d1_databases.find((b) => b.binding === "PUBLIC_SOURCE_DB").database_id,
      source,
    );
    config.vars.COVE_PUBLICATION_CAPTURE_ENABLED = "1";
  } else {
    assert.equal(config.vars.COVE_PUBLICATION_ENABLED, "0");
    assert.equal(
      config.d1_databases.find((b) => b.binding === "DISCOVERY_DB").database_id,
      "b299be94-f885-47a5-9d0b-3a3ac494065a",
    );
    config.d1_databases.find((b) => b.binding === "DISCOVERY_DB").database_id = ledger;
    config.d1_databases.find((b) => b.binding === "DISCOVERY_DB").database_name =
      "cove-publication-continuous-ledger-qa-20261022";
    if (lane === "export") {
      assert.equal(config.d1_databases.find((b) => b.binding === "SOURCE_DB").database_id, source);
      assert.ok(!config.r2_buckets);
    } else {
      assert.deepEqual(
        config.d1_databases.map((b) => b.binding),
        ["DISCOVERY_DB"],
      );
      assert.equal(
        config.r2_buckets?.[0]?.bucket_name,
        "cove-strangler-private-presentation-stage",
      );
    }
    config.vars.COVE_PUBLICATION_ENABLED = "1";
    config.vars.COVE_PRESENTATION_PREFIX = prefix;
  }
  config.name = `cove-pub-qa-continuous-${lane}`;
  config.main = `publication-${lane}.mjs`;
  config.triggers = { crons: ["* * * * *"] };
  assert.equal(config.observability?.enabled, true);
  assert.ok(!JSON.stringify(config).includes("cove-fast-customer-gateway"));
  return config;
}

async function api(path) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  assert.ok(response.ok && body.success, `Cloudflare QA inspection ${response.status}`);
  return body.result;
}

function deploy(path) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const run = spawnSync(
      "npm",
      ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", "deploy", "--config", path],
      {
        encoding: "utf8",
        timeout: 180000,
        env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
      },
    );
    if (run.status === 0) return;
    const output = (run.stderr || "").replace(/Bearer\\s+\\S+/g, "Bearer [redacted]");
    if (attempt === 3 || !/Worker does not exist|code:\\s*10007/i.test(output))
      throw Error(`Private ${path} deployment failed: ${output.slice(-500)}`);
  }
}

const migrated = await api(`/accounts/${account}/d1/database/${ledger}`);
assert.equal(migrated.name, "cove-publication-continuous-ledger-qa-20261022");
fs.mkdirSync(".output/strangler", { recursive: true });
for (const lane of ["capture", "export", "publish"]) {
  const config = template(lane);
  const path = `.output/strangler/qa-continuous-${lane}.jsonc`;
  fs.writeFileSync(path, JSON.stringify(config));
  deploy(path);
  const settings = await api(`/accounts/${account}/workers/scripts/${config.name}/settings`);
  const schedules = await api(`/accounts/${account}/workers/scripts/${config.name}/schedules`);
  const bindings = settings.bindings || [];
  assert.ok(
    bindings.some(
      (b) =>
        b.name ===
          (lane === "capture" ? "COVE_PUBLICATION_CAPTURE_ENABLED" : "COVE_PUBLICATION_ENABLED") &&
        b.text === "1",
    ),
  );
  assert.ok(schedules.schedules?.some((s) => s.cron === "* * * * *"));
  if (lane === "capture") {
    assert.ok(!bindings.some((b) => b.type === "d1" && (b.id || b.database_id) === canonical));
    assert.ok(
      bindings.some(
        (b) =>
          b.name === "SOURCE_READER" &&
          b.type === "service" &&
          b.service === "cove-legal-authority-production",
      ),
    );
  }
  assert.equal(settings.routes?.length || 0, 0);
  console.log(
    "CONTINUOUS_QA_DEPLOYED",
    JSON.stringify({
      lane,
      worker: config.name,
      cron: "* * * * *",
      workersDev: false,
      productionRouted: false,
    }),
  );
}
console.log(
  "PASS: nonpublic continuous QA capture/export/publish, independent ledger, fenced rights-primary reader.",
);
