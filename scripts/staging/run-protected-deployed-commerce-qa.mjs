// One-shot, fail-closed, protected browser + Stripe CLI acceptance.
// Production routing, D1 and R2 never change. No public QA URL persists
// after a completed job, regardless of assertions passing or failing.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const qaWorker = "cove-commerce-customer-qa-stage";
const account = "d26430caa63ec55f6612e32f36aca5e9";
const origin = "https://" + qaWorker + ".cove-jibrilmohamud.workers.dev/";
const required = [
  "CLOUDFLARE_API_TOKEN",
  "COVE_QA_BUYER_EMAIL",
  "COVE_QA_BUYER_PASSWORD",
  "COVE_QA_OUTSIDER_EMAIL",
  "COVE_QA_OUTSIDER_PASSWORD",
  "COVE_SANDBOX_SECRET_KEY",
];
assert.equal(
  required.filter((name) => !process.env[name]).length,
  0,
  "Protected QA browser credentials or Cloudflare/Stripe TEST keys missing. No ingress opened.",
);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
assert.match(process.env.COVE_SANDBOX_SECRET_KEY, /^(sk|rk|rkcs)_test_/);
assert.notEqual(
  process.env.COVE_QA_BUYER_EMAIL.toLowerCase(),
  process.env.COVE_QA_OUTSIDER_EMAIL.toLowerCase(),
);

const src = fs.readFileSync("wrangler.commerce-qa.stage.toml", "utf8");
for (const invariant of [
  'name = "cove-commerce-customer-qa-stage"',
  'database_id = "5be15110-44a6-4090-b0a1-36599d809b28"',
  'bucket_name = "cove-commerce-original-media-qa-20261022"',
  'COVE_SSR_STAGING = "1"',
  'STRIPE_LIVEMODE = "false"',
  'workers_dev = false',
  'preview_urls = false',
])
  assert.ok(src.includes(invariant), "QA environment invariant absent");
assert.doesNotMatch(src, /^\s*(?:route|routes)\s*=/m);
fs.mkdirSync(".output", { recursive: true });
// Keep this temporary config at the repository root: Wrangler resolves both
// main and assets paths relative to its config file.
const publicConfig = ".wrangler.commerce-qa.temporary.toml";
fs.writeFileSync(publicConfig, src.replace("workers_dev = false", "workers_dev = true"));
const wrangler = (args, input) => {
  const p = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      input,
      encoding: "utf8",
      timeout: 180000,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
    },
  );
  assert.equal(p.status, 0, "QA Wrangler operation failed; secrets are redacted");
};
const mask = (secret) => {
  console.log("::add-mask::" + secret);
  return secret;
};
const gate = mask(randomBytes(32).toString("hex"));
const env = {
  ...process.env,
  COVE_QA_DEPLOYED_ORIGIN: origin,
  COVE_QA_STAGE_BEARER: gate,
  COVE_QA_EPUB_PRODUCT_ID: "qa-original-ebook-product",
  COVE_QA_AUDIO_PRODUCT_ID: "qa-original-audio-product",
  COVE_QA_AUDIO_PUBLIC_ID: "ca_qa-original-audio-draft",
  COVE_QA_AUDIO_TRACK_ID: "intro",
};
let opened = false;
let listener;
try {
  wrangler(["deploy", "--config", publicConfig]);
  opened = true;
  wrangler(["secret", "put", "COVE_SSR_STAGING_GATE_KEY", "--config", publicConfig], gate);
  listener = spawn(
    "stripe",
    [
      "listen",
      "--events",
      "payment_intent.succeeded,payment_intent.payment_failed,charge.refunded",
      "--forward-to",
      origin + "api/fore/stripe/webhook",
      "--headers",
      "Authorization:Bearer " + gate,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STRIPE_API_KEY: process.env.COVE_SANDBOX_SECRET_KEY },
    },
  );
  let consoleText = "";
  for (const stream of [listener.stdout, listener.stderr])
    stream.on("data", (chunk) => {
      consoleText = (consoleText + String(chunk)).slice(-15000);
    });
  listener.on("error", (err) => {
    consoleText += String(err.message);
  });
  let whsec = null;
  for (let attempt = 0; attempt < 240; attempt++) {
    const found = /whsec_[A-Za-z0-9]+/.exec(consoleText);
    if (found) {
      whsec = mask(found[0]);
      break;
    }
    if (listener.exitCode !== null) throw Error("QA Stripe CLI listener exited before signing key");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(whsec, "Stripe TEST CLI never supplied its webhook signing secret");
  wrangler(["secret", "put", "STRIPE_WEBHOOK_SECRET", "--config", publicConfig], whsec);
  const run = spawnSync("node", ["scripts/staging/check-deployed-commerce-browser.mjs"], {
    env,
    stdio: "inherit",
    timeout: 650000,
  });
  assert.equal(run.status, 0, "Authenticated deployed browser QA did not pass");
  console.log("PASS: protected QA customer journey ran against real nonproduction Worker.");
} finally {
  listener?.kill("SIGTERM");
  if (opened) {
    // Teardown also runs as a separate always() CI step in case Node aborts.
    wrangler(["deploy", "--config", "wrangler.commerce-qa.stage.toml"]);
    console.log("PASS: protected QA workers.dev ingress disabled again.");
  }
}
