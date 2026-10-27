import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = mkdtempSync(join(tmpdir(), "cove-upstream-cancel-"));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalError = console.error;
const warnings = [];
const errors = [];
try {
  const path = join(directory, "proxy.mjs");
  await build({
    entryPoints: ["src/lib/persistence-backend.ts"],
    outfile: path,
    format: "esm",
    bundle: true,
    platform: "node",
    logLevel: "silent",
  });
  const { proxyPersistenceApi } = await import(pathToFileURL(path).href);
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  console.error = (...args) => errors.push(args.map(String).join(" "));
  const env = {
    VERCEL_ENV: "production",
    FORE_BACKEND_URL: "https://private-worker.example",
    FORE_BACKEND_TOKEN: "synthetic-test-token",
  };
  const url = "https://cove.example/api/fore/storefront/bootstrap";
  // Force an actual pending network request, cancel it from the caller, and
  // verify the gateway closes without inventing an upstream outage report.
  const abort = new AbortController();
  globalThis.fetch = (_target, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Caller cancelled", "AbortError")),
        { once: true },
      );
    });
  const cancelled = proxyPersistenceApi(new Request(url, { signal: abort.signal }), env);
  abort.abort();
  const response = await cancelled;
  assert.equal(response.status, 503, "Cancellation must never fall through to unverified data");
  assert.equal(warnings.length, 0, "Expected hedge cancellation must not masquerade as outage");
  assert.equal(errors.length, 0);

  // Real network failures must remain clearly observable and fail closed.
  globalThis.fetch = async () => {
    throw new TypeError("Synthetic upstream handshake failure");
  };
  const failure = await proxyPersistenceApi(new Request(url), env);
  assert.equal(failure.status, 503);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Persistent backend request failed/);
  assert.equal(warnings.length, 0);
  const catalog = await proxyPersistenceApi(
    new Request("https://cove.example/api/fore/catalog?page=1"),
    env,
  );
  assert.equal(catalog.status, 503);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /production catalog fails closed/);
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.error = originalError;
  rmSync(directory, { recursive: true, force: true });
}
console.log("PASS: hedge cancellation is quiet, genuine backend errors are logged and all failures deny access");
