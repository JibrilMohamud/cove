import assert from "node:assert/strict";
import {
  transferRuntimeModules,
  TRANSFER_NAMES,
} from "./release/production-owner-secret-transfer.mjs";
import { createRequire } from "node:module";
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.url)(
  process.env.COVE_MINIFLARE_MODULE || "miniflare",
);
const nonce = "a".repeat(64),
  secret = "fixture-existing-shared-secret",
  expiry = String(Date.now() + 500000);
const original = "export default {fetch(){return new Response('original-production-handler')}}";
const code = transferRuntimeModules("original.mjs");
const config = Object.fromEntries(TRANSFER_NAMES.map((n, i) => [n, "test-only-binding-" + i]));
let stored = {},
  writes = 0,
  reject = false;
const base = {
  FORE_ENVIRONMENT: "production",
  COVE_TRANSFER_NONCE: nonce,
  COVE_TRANSFER_EXPIRES: expiry,
  COVE_RIGHTS_OWNER_SECRET: secret,
};
const options = {
  workers: [
    {
      name: "sender",
      compatibilityDate: "2026-09-01",
      modules: [
        { type: "ESModule", path: "sender.mjs", contents: code.sender },
        { type: "ESModule", path: "original.mjs", contents: original },
      ],
      bindings: { ...base, ...config, COVE_TRANSFER_TOKEN: "test-only-provider-authorization" },
      outboundService: async (req) => {
        assert.equal(req.method, "PATCH");
        assert.equal(
          new URL(req.url).pathname,
          "/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/workers/scripts/cove-legal-authority-production/secrets-bulk",
        );
        if (reject) return Response.json({ success: false }, { status: 403 });
        const body = await req.json();
        assert.deepEqual(Object.keys(body.secrets).sort(), [...TRANSFER_NAMES].sort());
        stored = Object.fromEntries(Object.entries(body.secrets).map(([n, v]) => [n, v.text]));
        writes++;
        return Response.json({ success: true });
      },
    },
    {
      name: "receiver",
      compatibilityDate: "2026-10-17",
      modules: [
        { type: "ESModule", path: "receiver.mjs", contents: code.receiver },
        { type: "ESModule", path: "original.mjs", contents: original },
      ],
      bindings: { ...base, ...config },
    },
    {
      name: "probe",
      compatibilityDate: "2026-10-17",
      modules: true,
      script: code.verifier,
      bindings: { COVE_TRANSFER_NONCE: nonce, COVE_TRANSFER_EXPIRES: expiry },
      serviceBindings: {
        BACKEND: { name: "sender", entrypoint: "CoveBackendBindingTransfer" },
        OWNER: { name: "receiver", entrypoint: "CoveOwnerBindingProof" },
      },
    },
    {
      name: "force-copy",
      compatibilityDate: "2026-10-17",
      modules: true,
      script: `export default {async fetch(r,env){try{return Response.json(await env.BACKEND.transfer(r.headers.get("authorization")));}catch{return new Response(null,{status:503});}}}`,
      serviceBindings: { BACKEND: { name: "sender", entrypoint: "CoveBackendBindingTransfer" } },
    },
  ],
};
let runtime = new Miniflare(
  convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options,
);
const invoke = (key = nonce, method = "POST", path = "/transfer") =>
  runtime.getWorker("probe").then((w) =>
    w.fetch("https://verifier.internal" + path, {
      method,
      headers: {
        authorization: "Bearer " + key,
        ...(method === "POST" ? { "content-length": "0" } : {}),
      },
      ...(method === "POST" ? { body: "" } : {}),
    }),
  );
try {
  await runtime.ready;
  assert.equal(
    await (await (await runtime.getWorker("sender")).fetch("https://business.internal")).text(),
    "original-production-handler",
  );
  assert.equal(
    await (await (await runtime.getWorker("receiver")).fetch("https://business.internal")).text(),
    "original-production-handler",
  );
  assert.equal((await invoke("b".repeat(64))).status, 401);
  assert.equal((await invoke(nonce, "GET")).status, 404);
  assert.equal((await invoke(nonce, "POST", "/other")).status, 404);
  let response = await invoke();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).matching, true);
  assert.equal(writes, 0, "Already matching configuration must not be rewritten");
  const sender = await runtime.getWorker("force-copy");
  assert.equal(
    (await sender.fetch("https://test.internal", { headers: { authorization: "b".repeat(64) } }))
      .status,
    503,
  );
  assert.equal(writes, 0);
  assert.equal(
    (await sender.fetch("https://test.internal", { headers: { authorization: nonce } })).status,
    200,
  );
  assert.equal(writes, 1);
  assert.deepEqual(stored, config);
  reject = true;
  assert.equal(
    (await sender.fetch("https://test.internal", { headers: { authorization: nonce } })).status,
    503,
  );
  assert.equal(writes, 1);
  assert.equal(JSON.stringify(await (await invoke()).json()).includes(secret), false);
  await runtime.dispose();
  for (const kind of ["different-existing-secret", "expired", "not-production"]) {
    const modified = {
      ...options,
      workers: options.workers.map((w) => ({ ...w, bindings: { ...w.bindings } })),
    };
    if (kind === "different-existing-secret")
      modified.workers.find((w) => w.name === "receiver").bindings.COVE_RIGHTS_OWNER_SECRET =
        "different-test-only-existing-secret";
    if (kind === "expired")
      for (const w of modified.workers)
        w.bindings.COVE_TRANSFER_EXPIRES = String(Date.now() - 1000);
    if (kind === "not-production")
      modified.workers.find((w) => w.name === "sender").bindings.FORE_ENVIRONMENT = "staging";
    runtime = new Miniflare(
      convertV4MiniflareOptions ? convertV4MiniflareOptions(modified) : modified,
    );
    await runtime.ready;
    assert.equal(
      (await invoke()).status,
      kind === "different-existing-secret" ? 409 : kind === "expired" ? 401 : 503,
    );
    assert.equal(writes, 1, "Rejected proof cannot write configuration");
    await runtime.dispose();
  }
  console.log(
    "PASS: original HTTP handlers, real named bindings, exact secret targets, private proof, unauthorized refusal, idempotent matching configuration and provider denial",
  );
} finally {
  await runtime.dispose();
}
