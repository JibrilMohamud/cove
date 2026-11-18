import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Mock-only behavioral test. Never contacts a real Vercel, Cloudflare, D1
// or Stripe environment. No credentials or remote hostnames are loaded.
const temp = mkdtempSync(path.join(tmpdir(), "cove-proxy-503-enum-"));
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const nativeWarn = console.warn;
const nativeError = console.error;
try {
  await build({
    entryPoints: ["src/lib/persistence-backend.ts"],
    outdir: temp,
    platform: "node",
    bundle: true,
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { proxyPersistenceApi } = await import(
    pathToFileURL(path.join(temp, "persistence-backend.mjs")).href
  );
  const env = {
    FORE_BACKEND_URL: "https://isolated-proxy.invalid",
    FORE_BACKEND_TOKEN: "PRIVATE_TOKEN_MUST_NOT_BE_LOGGED",
    FORE_ENVIRONMENT: "production",
  };
  const messages = [];
  console.warn = (...args) => messages.push({ level: "warn", args });
  console.error = (...args) => messages.push({ level: "error", args });

  const request = (signal) =>
    new Request("https://isolated-customer.invalid/api/fore/storefront/bootstrap", {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
  const checked = async (result) => {
    assert.equal(result?.status, 503, "No production fallback on backend failures");
    assert.equal(result.headers.get("cache-control"), "no-store");
    const text = await result.text();
    assert.match(text, /temporarily unavailable/i);
    assert.doesNotMatch(text, /PRIVATE_TOKEN|sensitive|secret-identity|isolated-proxy/);
  };
  const assertMessagesPrivate = () => {
    for (const { args } of messages) {
      assert.equal(args.length, 1, "Vercel must expose one complete low-cardinality message");
      assert.equal(typeof args[0], "string");
      assert.doesNotMatch(args[0], /PRIVATE_TOKEN|sensitive|secret-identity|isolated-proxy|Error:/);
      assert.ok(args[0].length < 270);
    }
  };

  // A network exception is an upstream transport failure, not a generic
  // unknown backend 503 or a reason to reveal the failed destination.
  globalThis.fetch = async () => {
    throw Error("sensitive network body PRIVATE_TOKEN secret-identity");
  };
  messages.length = 0;
  await checked(await proxyPersistenceApi(request(), env));
  assert.deepEqual(messages, [
    {
      level: "error",
      args: ["Persistent backend request failed; production bootstrap fails closed cause=upstream-transport"],
    },
  ]);
  assertMessagesPrivate();

  // A real Worker response must produce EXACT fixed source, phase, stage and
  // error category in the first Vercel-visible argument. The raw body is
  // discarded after bounded classification, never served to a visitor.
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.get("x-cove-backend-token"), env.FORE_BACKEND_TOKEN);
    return new Response(
      JSON.stringify({
        error: "This content could not be loaded. Please try again.",
        privateIdentity: "secret-identity",
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-cove-persistence": "d1-r2",
          "x-cove-backend-cache": "MISS",
          "server-timing": "cove_api;dur=1,cove_auth;dur=1,cove_fault_pre_auth;dur=1",
        },
      },
    );
  };
  messages.length = 0;
  await checked(await proxyPersistenceApi(request(), env));
  assert.deepEqual(messages, [
    {
      level: "warn",
      args: [
        "Persistent backend unavailable; production catalog fails closed status=503 source=worker-api phase=pre-context stage=pre-auth category=handler-exception",
      ],
    },
  ]);
  assertMessagesPrivate();

  // Untrusted edge-generated response body, headers and strings can never
  // influence the whitelist or enter logs, even when upstream says 504.
  globalThis.fetch = async () =>
    new Response("secret-identity upstream error", {
      status: 504,
      headers: { "x-secret-identity": "sensitive" },
    });
  messages.length = 0;
  await checked(await proxyPersistenceApi(request(), env));
  assert.deepEqual(messages, [
    {
      level: "warn",
      args: [
        "Persistent backend unavailable; production catalog fails closed status=504 source=edge-or-runtime phase=untraced stage=unknown category=other",
      ],
    },
  ]);
  assertMessagesPrivate();

  const abortingFetch = async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      if (init.signal.aborted) return reject(Error("sensitive abort detail"));
      init.signal.addEventListener("abort", () => reject(Error("sensitive abort detail")), {
        once: true,
      });
    });
  };
  globalThis.fetch = abortingFetch;
  globalThis.setTimeout = (fn, ms, ...args) =>
    nativeSetTimeout(fn, ms === 30_000 ? 1 : ms, ...args);
  messages.length = 0;
  await checked(await proxyPersistenceApi(request(), env));
  assert.deepEqual(messages, [
    {
      level: "error",
      args: ["Persistent backend request failed; production bootstrap fails closed cause=backend-deadline"],
    },
  ]);
  assertMessagesPrivate();
  globalThis.setTimeout = nativeSetTimeout;

  // The deliberately cancelled *losing* bootstrap request is not evidence
  // that Cloudflare failed. It still fails closed but emits no outage log.
  globalThis.fetch = abortingFetch;
  const controller = new AbortController();
  messages.length = 0;
  const cancelled = proxyPersistenceApi(request(controller.signal), env);
  controller.abort("sensitive losing-hedge cause");
  await checked(await cancelled);
  assert.equal(messages.length, 0, "Caller abort must not poison backend outage metrics");

  // Invalid endpoint settings do not leak the URL or original exception.
  messages.length = 0;
  const misconfigured = await proxyPersistenceApi(request(), {
    ...env,
    FORE_BACKEND_URL: "http://secret-identity.invalid",
  });
  assert.equal(misconfigured?.status, 503);
  assert.equal(misconfigured.headers.get("cache-control"), "no-store");
  assert.match(await misconfigured.text(), /misconfigured/);
  assert.deepEqual(messages, [
    {
      level: "error",
      args: ["Invalid persistence backend configuration"],
    },
  ]);
  assertMessagesPrivate();

  process.stdout.write(
    "PASS: isolated upstream HTTP 503/504, transport, timeout and caller cancellation are fail-closed, low-cardinality and privacy-safe\\n",
  );
} finally {
  globalThis.fetch = nativeFetch;
  globalThis.setTimeout = nativeSetTimeout;
  console.warn = nativeWarn;
  console.error = nativeError;
  rmTemp();
}
function rmTemp() {
  rmSync(temp, { recursive: true, force: true });
}
