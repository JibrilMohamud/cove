// Protected detached QA only. The owner itself has no public ingress.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { verifyDetachedBridge, publishDetachedBridge } from "./verify-detached-commerce-bridge.mjs";

const account = "f51e8ccbc394e2d6016ff8c2c303d54b";
const primary = "f9354381-bd9f-496b-bd05-d6f62a32ec0c";
function names() {
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.match(process.env.GITHUB_RUN_ID || "", /^\d+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT || "", /^\d+$/);
  const suffix = process.env.GITHUB_RUN_ID + "-" + process.env.GITHUB_RUN_ATTEMPT;
  return { owner: "cove-detached-owner-" + suffix, bridge: "cove-detached-bridge-" + suffix };
}

async function remove(name) {
  assert.ok(Object.values(names()).includes(name));
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/workers/scripts/" + name,
    {
      method: "DELETE",
      headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 404) return;
  const body = await response.json();
  assert.ok(response.ok && body.success, "Detached QA Worker deletion failed: " + response.status);
}

export async function cleanupDetachedOwner() {
  const { owner, bridge } = names();
  await remove(bridge);
  await remove(owner);
}

function deploy(wrangler, name, config, secrets) {
  const configPath = ".wrangler." + name + ".json";
  const secretPath = ".wrangler." + name + ".secrets.json";
  try {
    fs.writeFileSync(configPath, JSON.stringify(config), { flag: "wx" });
    fs.writeFileSync(secretPath, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
    wrangler(["deploy", "--config", configPath, "--secrets-file", secretPath]);
  } finally {
    fs.rmSync(secretPath, { force: true });
    fs.rmSync(configPath, { force: true });
  }
}

export async function provisionDetachedOwner(wrangler) {
  const { owner, bridge } = names();
  const stripe = process.env.COVE_SANDBOX_SECRET_KEY;
  assert.match(stripe || "", /^(sk|rk|rkcs)_test_/);
  const secret = randomBytes(32).toString("hex");
  const gate = randomBytes(32).toString("hex");
  const instance = randomBytes(16).toString("hex");
  console.log("::add-mask::" + secret);
  console.log("::add-mask::" + gate);
  const expires = String(Date.now() + 14 * 60_000);
  const config = JSON.parse(fs.readFileSync("wrangler.legal-paid-authority.example.jsonc", "utf8"));
  config.name = owner;
  config.account_id = account;
  config.d1_databases = [
    {
      binding: "PRIMARY_DB",
      database_id: primary,
      database_name: "cove-commerce-customer-detached-qa",
    },
  ];
  config.vars = {
    COVE_RIGHTS_OWNER_ENABLED: "1",
    COVE_RIGHTS_OWNER_PRIMARY_ID: primary,
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: expires,
    STRIPE_LIVEMODE: "false",
    STRIPE_TAX_ENABLED: "false",
  };
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  deploy(wrangler, owner, config, { COVE_RIGHTS_OWNER_SECRET: secret, STRIPE_SECRET_KEY: stripe });
  deploy(
    wrangler,
    bridge,
    {
      name: bridge,
      account_id: account,
      main: "scripts/staging/detached-commerce-owner-bridge.mjs",
      compatibility_date: "2026-10-25",
      workers_dev: true,
      preview_urls: false,
      routes: [],
      services: [{ binding: "LEGAL_PRIVATE", service: owner }],
      vars: { EXPIRES: expires, BRIDGE_INSTANCE: instance },
    },
    { GATE: gate, OWNER_SECRET: secret },
  );
  const origin = "https://" + bridge + ".cove-qa-reads.workers.dev";
  const observations = await verifyDetachedBridge({ origin, gate, instance });
  console.log(
    "PASS: exact detached bridge readiness and anonymous/invalid bearer denial",
    JSON.stringify(observations),
  );
  const publication = await publishDetachedBridge({ origin, gate, instance });
  console.log("PASS: exact detached owner rights and offer readback", JSON.stringify(publication));
  await remove(bridge);
  return {
    secret,
    browserConfig(src) {
      assert.ok(src.includes('database_id = "' + primary + '"'));
      assert.ok(src.includes('account_id = "' + account + '"'));
      assert.ok(src.includes("workers_dev = false"));
      return (
        src.replace("workers_dev = false", "workers_dev = true") +
        '\nCOVE_LEGAL_CONSUMER_STAGE_ENABLED = "1"\n' +
        'COVE_CANONICAL_LEGAL_WRITE_LOCK = "1"\n' +
        'COVE_PUBLICATION_COMMANDS_ENABLED = "1"\n' +
        'COVE_LEGAL_WRITER_PRIMARY_ID = "' +
        primary +
        '"\n' +
        'COVE_PUBLICATION_COMMAND_TERRITORY = "US"\n' +
        'COVE_PUBLICATION_COMMAND_CURRENCY = "USD"\n' +
        '\n[[durable_objects.bindings]]\nname = "LEGAL_AUTHORITY"\n' +
        'class_name = "CoveLegalAuthority"\nscript_name = "' +
        owner +
        '"\n'
      );
    },
  };
}

if (process.argv.includes("--cleanup")) await cleanupDetachedOwner();
