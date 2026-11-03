import { DurableObject } from "cloudflare:workers";
import {
  audioDispatchKey,
  payloadForAudioPath,
  runtimeEnabled,
  validAudioMessage,
} from "./contracts.mjs";

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const ONE_HOUR = 3_600_000;
const LEASE_MS = 9 * 60_000;
const RESERVED_MS = 8 * 60_000;
const COMPLETED_MS = 48 * ONE_HOUR;
const containerName = "audio-executor-singleton";

function compareSecret(provided, expected) {
  if (typeof expected !== "string" || expected.length < 32 ||
      typeof provided !== "string" || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

async function ledger(env, key, operation) {
  const stub = env.AUDIO_IDEMPOTENCY.getByName(key);
  const r = await stub.fetch(
    new Request("https://audio-ledger.internal/" + operation, { method: "POST" }),
  );
  if (!r.ok) throw Error("Audio idempotency ledger unavailable");
  return r.json();
}

export class CoveAudioIdempotency extends DurableObject {
  async fetch(request) {
    const operation = new URL(request.url).pathname;
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const now = Date.now();
    const previous = await this.ctx.storage.get("state");
    const state = previous && previous.expires > now ? previous : null;

    if (operation === "/producer-claim") {
      if (state) return json({ admit: false });
      await this.ctx.storage.put("state", { status: "dispatching", expires: now + RESERVED_MS });
      return json({ admit: true });
    }
    if (operation === "/producer-commit") {
      if (state?.status === "dispatching") {
        await this.ctx.storage.put("state", { status: "queued", expires: now + ONE_HOUR });
      }
      return json({ ok: true });
    }
    if (operation === "/producer-abort") {
      if (state?.status === "dispatching") await this.ctx.storage.delete("state");
      return json({ ok: true });
    }
    if (operation === "/worker-claim") {
      if (state?.status === "done") return json({ decision: "already-done" });
      if (state?.status === "processing") return json({ decision: "retry" });
      await this.ctx.storage.put("state", { status: "processing", expires: now + LEASE_MS });
      return json({ decision: "execute" });
    }
    if (operation === "/worker-complete") {
      if (state?.status !== "processing") return json({ error: "missing-lease" }, 409);
      await this.ctx.storage.put("state", { status: "done", expires: now + COMPLETED_MS });
      return json({ ok: true });
    }
    if (operation === "/worker-release") {
      if (state?.status === "processing") await this.ctx.storage.delete("state");
      return json({ ok: true });
    }
    return json({ error: "unknown-ledger-operation" }, 404);
  }
}

export class CoveAudioContainer extends DurableObject {
  starting;
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return json({ error: "unknown-container-operation" }, 404);
    }
    this.starting ??= this.startAndWait().finally(() => { this.starting = undefined; });
    await this.starting;
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    // Container is private to this DO; the secret is injected only by the queue handler.
    return this.ctx.container.getTcpPort(8080).fetch(forwarded);
  }

  async startAndWait() {
    const c = this.ctx.container;
    if (!c) throw Error("Cloudflare Container capability unavailable");
    if (!c.running) {
      const env = this.env;
      if (!env.FORE_BACKEND_URL?.startsWith("https://") ||
          !env.FORE_BACKEND_TOKEN || env.FORE_BACKEND_TOKEN.length < 24 ||
          !env.FORE_SERVICE_TOKEN || env.FORE_SERVICE_TOKEN.length < 24 ||
          !env.COVE_AUDIO_EXECUTION_SECRET || env.COVE_AUDIO_EXECUTION_SECRET.length < 32) {
        throw Error("Cloudflare audio container credentials unavailable");
      }
      c.start({
        image: c.images.base,
        instance: "standard-2",
        enableInternet: true,
        env: {
          FORE_BACKEND_URL: env.FORE_BACKEND_URL,
          FORE_BACKEND_TOKEN: env.FORE_BACKEND_TOKEN,
          FORE_SERVICE_TOKEN: env.FORE_SERVICE_TOKEN,
          COVE_AUDIO_EXECUTION_SECRET: env.COVE_AUDIO_EXECUTION_SECRET,
          FORE_BIOSYNC_ASR: "hosted",
          HF_HUB_DISABLE_XET: "1",
        },
      });
    }
    await c.setInactivityTimeout(10 * 60_000);
    const port = c.getTcpPort(8080);
    for (let n = 0; n < 100; n++) {
      try {
        const ready = await port.fetch("http://container/health", {
          signal: AbortSignal.timeout(1000),
        });
        await ready.body?.cancel();
        if (ready.ok) return;
      } catch {}
      await scheduler.wait(200);
    }
    throw Error("Cloudflare audio Container failed readiness");
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST" ||
        new URL(request.url).pathname !== "/internal/dispatch") {
      return json({ error: "not_found" }, 404);
    }
    if (!compareSecret(request.headers.get("x-cove-audio-dispatch-secret"), env.COVE_AUDIO_DISPATCH_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!runtimeEnabled(env) || !env.AUDIO_QUEUE) {
      return json({ error: "cloudflare_audio_disabled" }, 503);
    }
    const incoming = await request.json().catch(() => null);
    const path = incoming?.path;
    const payload = payloadForAudioPath(path);
    if (!payload) return json({ error: "invalid_audio_path" }, 400);
    const key = await audioDispatchKey(path);
    const claim = await ledger(env, key, "producer-claim");
    if (!claim.admit) return json({ ok: true, queued: true, duplicate: true, messageId: key });
    const message = { v: 1, path, request: payload, key };
    try {
      await env.AUDIO_QUEUE.send(message, { contentType: "json" });
      await ledger(env, key, "producer-commit");
      return json({ ok: true, queued: true, messageId: key }, 202);
    } catch (error) {
      // A crash between send and commit can cause a duplicate. The consumer
      // ledger plus backend's authoritative job leases handle at-least-once delivery.
      await ledger(env, key, "producer-abort").catch(() => {});
      console.error("Cloudflare audio queue send failed", error);
      return json({ error: "audio_queue_unavailable" }, 503);
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      if (!runtimeEnabled(env)) {
        message.retry({ delaySeconds: 300 });
        continue;
      }
      if (!validAudioMessage(message.body)) {
        console.error("Invalid Cloudflare audio message quarantined", message.id);
        // Invalid data is not executable; retain DLQ evidence by retry policy.
        message.retry({ delaySeconds: 300 });
        continue;
      }
      const { key, request } = message.body;
      try {
        const claim = await ledger(env, key, "worker-claim");
        if (claim.decision === "already-done") {
          message.ack();
          continue;
        }
        if (claim.decision !== "execute") {
          message.retry({ delaySeconds: 60 });
          continue;
        }
        const result = await env.AUDIO_CONTAINER.getByName(containerName).fetch(
          new Request("https://private-audio-container.internal/run", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-cove-execution-secret": env.COVE_AUDIO_EXECUTION_SECRET || "",
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(420_000),
          }),
        );
        if (!result.ok) throw Error("Audio Container returned HTTP " + result.status);
        const outcome = await result.json();
        if (!outcome.ok || outcome.executed !== true) {
          await ledger(env, key, "worker-release");
          message.retry({ delaySeconds: 300 });
          continue;
        }
        await ledger(env, key, "worker-complete");
        message.ack();
      } catch (error) {
        console.error("Cloudflare audio processing failed", message.id, error);
        await ledger(env, key, "worker-release").catch(() => {});
        message.retry({ delaySeconds: 90 });
      }
    }
  },
};
