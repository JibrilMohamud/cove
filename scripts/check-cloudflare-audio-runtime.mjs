/* eslint-disable prettier/prettier -- Explicit mocked Cloudflare Durable Object/Queue contract. */
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/cloudflare-audio/worker.mjs"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
  plugins: [{
    name: "test-cloudflare-durable-object",
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
        namespace: "do-test",
        path: "cloudflare:workers",
      }));
      builder.onLoad({ filter: /.*/, namespace: "do-test" }, () => ({
        contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        loader: "js",
      }));
    },
  }],
});
const source = bundled.outputFiles[0].text;
const { default: audioWorker, CoveAudioIdempotency } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

const secret = "cove-audio-test-secret-" + "x".repeat(40);
const executed = [];
const sent = [];
const storageByKey = new Map();
function memoryStorage() {
  const data = new Map();
  return {
    async get(k) { return data.get(k); },
    async put(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
  };
}
const env = {
  COVE_AUDIO_QUEUE_ENABLED: "1",
  COVE_AUDIO_DISPATCH_SECRET: secret,
  COVE_AUDIO_EXECUTION_SECRET: secret,
  AUDIO_QUEUE: {
    async send(value) { sent.push(value); },
  },
  AUDIO_IDEMPOTENCY: {
    getByName(key) {
      if (!storageByKey.has(key)) {
        storageByKey.set(key, new CoveAudioIdempotency({ storage: memoryStorage() }, env));
      }
      return storageByKey.get(key);
    },
  },
  AUDIO_CONTAINER: {
    getByName() {
      return {
        async fetch(request) {
          executed.push(await request.json());
          return new Response(JSON.stringify({ ok: true, executed: true }), { status: 200 });
        },
      };
    },
  },
};

function dispatch(path, token = secret) {
  return audioWorker.fetch(new Request("https://audio.private/internal/dispatch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cove-audio-dispatch-secret": token,
    },
    body: JSON.stringify({ path }),
  }), env);
}
function delivered(body) {
  return {
    id: "test-queue-message",
    body,
    acked: false,
    retries: [],
    ack() { this.acked = true; },
    retry(options) { this.retries.push(options); },
  };
}

assert.equal((await dispatch("/api/fore/internal/ingestion/audio-track", "wrong")).status, 401);
assert.equal((await dispatch("/api/fore/internal/ingestion/audio-unknown")).status, 400);
assert.equal((await audioWorker.fetch(new Request("https://audio.private/"), env)).status, 404);
assert.equal(sent.length, 0);
env.COVE_AUDIO_QUEUE_ENABLED = "0";
assert.equal((await dispatch("/api/fore/internal/ingestion/audio-track")).status, 503);
env.COVE_AUDIO_QUEUE_ENABLED = "1";

let queued = await dispatch("/api/fore/internal/ingestion/audio-track");
assert.equal(queued.status, 202);
assert.equal((await queued.json()).queued, true);
assert.equal(sent.length, 1);
const duplicated = await dispatch("/api/fore/internal/ingestion/audio-track");
assert.equal((await duplicated.json()).duplicate, true);
assert.equal(sent.length, 1, "Five-minute producer dedupe");
const original = delivered(sent[0]);
await audioWorker.queue({ messages: [original] }, env);
assert.equal(original.acked, true);
assert.equal(original.retries.length, 0);
assert.equal(executed.length, 1);
assert.equal(executed[0].kind, "track");
const redelivery = delivered(sent[0]);
await audioWorker.queue({ messages: [redelivery] }, env);
assert.equal(redelivery.acked, true);
assert.equal(executed.length, 1, "A duplicate Queue delivery must not rerun the Python engine");

// A genuine backend/model failure releases the ledger and retries the delivery.
queued = await dispatch("/api/fore/internal/ingestion/audio-align");
assert.equal(queued.status, 202);
env.AUDIO_CONTAINER.getByName = () => ({
  async fetch() { throw Error("Container offline"); },
});
const unavailable = delivered(sent[1]);
const priorError = console.error;
console.error = () => {};
try { await audioWorker.queue({ messages: [unavailable] }, env); }
finally { console.error = priorError; }
assert.equal(unavailable.acked, false);
assert.equal(unavailable.retries.length, 1);
env.AUDIO_CONTAINER.getByName = () => ({
  async fetch(request) {
    executed.push(await request.json());
    return new Response(JSON.stringify({ ok: true, executed: false }), { status: 200 });
  },
});
const deferred = delivered(sent[1]);
await audioWorker.queue({ messages: [deferred] }, env);
assert.equal(deferred.acked, true, "Budget deferral is a completed scheduling attempt");
assert.equal(deferred.retries.length, 0, "Admission deferral must not waste 36 retries");
const deferredDuplicate = delivered(sent[1]);
await audioWorker.queue({ messages: [deferredDuplicate] }, env);
assert.equal(deferredDuplicate.acked, true);
assert.equal(executed.length, 2, "Do not execute deferred message twice");

// Bad/poisoned messages cannot reach the Container and must enter retry/DLQ.
const invalid = delivered({ v: 1, key: "wrong", path: "bad" });
const oldError = console.error;
console.error = () => {};
try { await audioWorker.queue({ messages: [invalid] }, env); }
finally { console.error = oldError; }
assert.equal(invalid.acked, false);
assert.equal(invalid.retries.length, 1);
env.COVE_AUDIO_QUEUE_ENABLED = "0";
const disabled = delivered(sent[0]);
await audioWorker.queue({ messages: [disabled] }, env);
assert.equal(disabled.acked, false);
assert.equal(disabled.retries[0].delaySeconds, 300);

console.log("PASS: Cloudflare private auth, producer/consumer deduplication, accepted jobs, retries, budget deferral, poison data and paused-mode denial.");
