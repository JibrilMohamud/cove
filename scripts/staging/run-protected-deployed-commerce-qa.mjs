// One-shot, fail-closed, protected browser + Stripe CLI acceptance.
// Production routing, D1 and R2 never change. No public QA URL persists
// after a completed job, regardless of assertions passing or failing.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { provisionDetachedOwner, cleanupDetachedOwner } from "./detached-commerce-owner.mjs";

const qaWorker = "cove-commerce-customer-qa-stage";
const account = "f51e8ccbc394e2d6016ff8c2c303d54b";
const origin = "https://" + qaWorker + ".cove-qa-reads.workers.dev/";
const required = [
  "CLOUDFLARE_API_TOKEN",
  "COVE_CF_QA_D1_MUTATION_TOKEN",
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
  'account_id = "f51e8ccbc394e2d6016ff8c2c303d54b"',
  'database_id = "f9354381-bd9f-496b-bd05-d6f62a32ec0c"',
  'bucket_name = "cove-commerce-detached-media-qa"',
  'COVE_SSR_STAGING = "1"',
  'STRIPE_LIVEMODE = "false"',
  "workers_dev = false",
  "preview_urls = false",
])
  assert.ok(src.includes(invariant), "QA environment invariant absent");
assert.doesNotMatch(src, /^\s*(?:route|routes)\s*=/m);
fs.mkdirSync(".output", { recursive: true });
// Keep this temporary config at the repository root: Wrangler resolves both
// main and assets paths relative to its config file.
const publicConfig = ".wrangler.commerce-qa.temporary.toml";

const wrangler = (args, input) => {
  const p = spawnSync(
    "npm",
    ["exec", "--yes", "--package=wrangler@4.151.0", "--", "wrangler", ...args],
    {
      input,
      encoding: "utf8",
      timeout: 180000,
      env: {
        ...process.env,
        COVE_CF_QA_D1_MUTATION_TOKEN: "",
        COVE_CF_QA_R2_STORAGE_TOKEN: "",
        CLOUDFLARE_SEND_METRICS: "false",
      },
    },
  );
  assert.equal(p.status, 0, "QA Wrangler operation failed; secrets are redacted");
};
const mask = (secret) => {
  console.log("::add-mask::" + secret);
  return secret;
};
const gate = mask(randomBytes(32).toString("hex"));
const browserInstance = randomBytes(16).toString("hex");
const env = {
  ...process.env,
  COVE_QA_DEPLOYED_ORIGIN: origin,
  COVE_QA_STAGE_BEARER: gate,
  COVE_QA_INGRESS_INSTANCE: browserInstance,
  COVE_QA_EPUB_PRODUCT_ID: "prd_qa_owner_v2_ebook",
  COVE_QA_AUDIO_PRODUCT_ID: "prd_qa_owner_v2_audio",
  COVE_QA_AUDIO_PUBLIC_ID: "ca_qa-owner-v2-audio-draft",
  COVE_QA_AUDIO_TRACK_ID: "intro",
};
let opened = false;
let listener;
let relay;
let consoleText = "";
const secretFile = ".output/commerce-qa-temporary-secrets.json";
try {
  const owner = await provisionDetachedOwner(wrangler);
  assert.ok(src.includes('main = ".output/server/index.mjs"'));
  fs.writeFileSync(
    ".output/server/commerce-qa-ingress.mjs",
    'import app from "./index.mjs";\nimport { commerceQaIngress } from "../../src/cloudflare/commerce-qa-ingress.mjs";\nexport default commerceQaIngress(app,' +
      JSON.stringify(browserInstance) +
      ");\n",
  );
  fs.writeFileSync(
    publicConfig,
    owner
      .browserConfig(src)
      .replace(
        'main = ".output/server/index.mjs"',
        'main = ".output/server/commerce-qa-ingress.mjs"',
      ),
  );
  // Obtain the listener signing key before opening the gated QA ingress.
  // Install all fresh credentials together in the serving deployment.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // Forward the original signed bytes to the exact gated hosted ingress.
  // Capture only HTTP status and fixed settlement classifications, not payloads,
  // signatures, provider event IDs, buyer identities or arbitrary error text.
  relay = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/webhook") {
        res.writeHead(404).end();
        return;
      }
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") {
        res.writeHead(400).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_048_576) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const response = await fetch(origin + "api/fore/stripe/webhook", {
        method: "POST",
        headers: {
          authorization: "Bearer " + gate,
          "content-type": "application/json",
          "stripe-signature": signature,
        },
        body: Buffer.concat(chunks),
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      const data = await response.json().catch(() => null);
      const match = /^QA settlement: ([a-z_]{1,80})$/.exec(data?.error || "");
      console.log("QA_STRIPE_WEBHOOK_RESULT", response.status, match?.[1] || "none");
      res.writeHead(response.status).end();
    } catch {
      console.warn("QA_STRIPE_WEBHOOK_TRANSPORT_FAILED");
      res.writeHead(502).end();
    }
  });
  await new Promise((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(0, "127.0.0.1", resolve);
  });
  const relayOrigin = "http://127.0.0.1:" + relay.address().port;
  listener = spawn(
    "stripe",
    [
      "listen",
      "--events",
      "payment_intent.succeeded,payment_intent.payment_failed,refund.created,refund.updated,charge.refunded",
      "--forward-to",
      relayOrigin + "/webhook",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STRIPE_API_KEY: process.env.COVE_SANDBOX_SECRET_KEY },
    },
  );
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
  fs.writeFileSync(
    secretFile,
    JSON.stringify({
      COVE_SSR_STAGING_GATE_KEY: gate,
      COVE_RIGHTS_OWNER_SECRET: owner.secret,
      FORE_OFFLINE_AUDIO_SIGNING_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
      STRIPE_WEBHOOK_SECRET: whsec,
    }),
    { mode: 0o600, flag: "wx" },
  );
  opened = true;
  try {
    wrangler(["deploy", "--config", publicConfig, "--secrets-file", secretFile]);
  } finally {
    fs.rmSync(secretFile, { force: true });
  }
  // Rotating a Worker secret creates a new deployment; a successful Wrangler
  // response is not proof that every ingress colo serves that deployment yet.
  // This is browser QA (not a cold performance sample), so wait for a genuine
  // bearer-gated 200 response before attempting Supabase login and payment.
  let ingressReady = false;
  let cleanWaves = 0;
  const ingressStatuses = new Map();
  for (let attempt = 1; attempt <= 45; attempt++) {
    let waveReady = false;
    try {
      const response = await fetch(origin, {
        headers: { authorization: "Bearer " + gate },
        signal: AbortSignal.timeout(5000),
      });
      const status = response.status;
      ingressStatuses.set(status, (ingressStatuses.get(status) || 0) + 1);
      const htmlReady =
        response.status === 200 &&
        response.headers.get("x-cove-qa-ingress-instance") === browserInstance &&
        (response.headers.get("content-type") || "").includes("text/html");
      await response.body?.cancel();
      // A 200 homepage may be available before the routed application API.
      // Prove the same gated deployment serves its real Supabase auth router
      // before ever attempting credentials, Stripe CLI payment or media.
      if (htmlReady) {
        const api = await fetch(origin + "api/fore/auth/options", {
          headers: { authorization: "Bearer " + gate },
          signal: AbortSignal.timeout(5000),
        });
        const data = api.status === 200 ? await api.json().catch(() => null) : null;
        await api.body?.cancel().catch(() => {});
        if (
          api.status === 200 &&
          data?.available === true &&
          api.headers.get("x-cove-qa-ingress-instance") === browserInstance
        ) {
          const hook = await fetch(origin + "api/fore/stripe/webhook", {
            method: "POST",
            headers: { authorization: "Bearer " + gate, "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(5000),
          });
          const rejected = await hook.json().catch(() => null);
          if (
            hook.status === 400 &&
            rejected?.error === "Invalid Stripe webhook signature." &&
            hook.headers.get("x-cove-qa-ingress-instance") === browserInstance
          ) {
            // A single ready edge can be followed by an unpropagated edge.
            // Require the exact gate denial for both missing and wrong
            // credentials before counting this nonmutating readiness wave.
            const wrongGate = (gate[0] === "0" ? "1" : "0") + gate.slice(1);
            const denials = await Promise.all(
              [{}, { authorization: "Bearer " + wrongGate }].map(async (headers) => {
                const denied = await fetch(origin + "api/fore/auth/options", {
                  headers,
                  redirect: "manual",
                  signal: AbortSignal.timeout(5000),
                });
                const status = denied.status;
                await denied.body?.cancel();
                if (status >= 200 && status < 300)
                  throw new Error("QA_INGRESS_UNAUTHORIZED_SUCCESS");
                return (
                  status === 401 &&
                  denied.headers.get("cache-control")?.includes("no-store") &&
                  denied.headers.get("x-cove-qa-ingress-instance") === browserInstance
                );
              }),
            );
            waveReady = denials.every(Boolean);
          }
          if (!waveReady) console.warn("QA_WEBHOOK_NOT_READY", attempt, hook.status);
        }
        if (!waveReady) console.warn("QA_AUTH_API_NOT_READY", attempt, api.status);
      }
    } catch (error) {
      if (error?.message === "QA_INGRESS_UNAUTHORIZED_SUCCESS") throw error;
      // The next short attempt may see the new secret/version after routing.
    }
    cleanWaves = waveReady ? cleanWaves + 1 : 0;
    if (cleanWaves === 3) {
      console.log("QA_INGRESS_READY", attempt, 200, "three-clean-auth-and-webhook-waves");
      ingressReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log("QA_INGRESS_STATUS_COUNTS", JSON.stringify(Object.fromEntries(ingressStatuses)));
  assert.ok(ingressReady, "QA ingress never reached an authenticated HTML-ready state");
  // A synchronous child blocks this parent's event loop. Stripe CLI's piped
  // stdout/stderr then cannot drain while the browser exercises webhooks,
  // eventually deadlocking the listener and fulfillment/refund verification.
  // Keep the parent asynchronous so the signed webhook listener stays live.
  const result = await new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/staging/check-deployed-commerce-browser.mjs"], {
      env,
      stdio: "inherit",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 650000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 0, "Authenticated deployed browser QA did not pass");
  console.log("PASS: protected QA customer journey ran against real nonproduction Worker.");
} finally {
  // Emit only fixed HTTP statuses, never CLI lines, event IDs or secrets.
  const forwarded = Array.from(consoleText.matchAll(/\[([1-5][0-9]{2})\]\s+POST\s+/g));
  console.log("QA_STRIPE_FORWARD_STATUSES", JSON.stringify(forwarded.map((m) => Number(m[1]))));
  // Stripe CLI sometimes leaves its piped stdout/stderr open after SIGTERM,
  // keeping Actions Node alive even after protected QA ingress is restored.
  // Bound teardown; never leave a webhook listener on the test runner.
  if (listener) {
    const closed = new Promise((resolve) => {
      if (listener.exitCode !== null) return resolve(true);
      const deadline = setTimeout(() => resolve(false), 3000);
      listener.once("close", () => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
    listener.kill("SIGTERM");
    if (!(await closed)) listener.kill("SIGKILL");
    listener.stdout?.destroy();
    listener.stderr?.destroy();
  }
  if (relay) {
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
  }
  if (opened) {
    // Teardown also runs as a separate always() CI step in case Node aborts.
    wrangler(["deploy", "--config", "wrangler.commerce-qa.stage.toml"]);
    console.log("PASS: protected QA workers.dev ingress disabled again.");
  }
  await cleanupDetachedOwner();
}
