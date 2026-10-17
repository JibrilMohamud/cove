import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cove-diagnostic-latency-"));
try {
  await fs.cp("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    outfile: path.join(root, "api.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.mjs"));
  const env = localBindings(root);
  let release;
  let gate;
  const hold = () => {
    gate = new Promise((resolve) => {
      release = resolve;
    });
  };
  hold();
  function prepare(sql, values = []) {
    const original = env.DB.prepare(sql).bind(...values);
    return {
      bind: (...next) => prepare(sql, next),
      first: () => original.first(),
      all: () => original.all(),
      run: () =>
        sql.includes("INSERT INTO storefront_context_events")
          ? gate.then(() => original.run())
          : original.run(),
    };
  }
  const held = {
    ...env,
    DB: { prepare, batch: (statements) => gate.then(() => env.DB.batch(statements)) },
  };
  const request = (path) => new Request("https://isolated.test/api/fore" + path);
  const tasks = [];
  const execution = { waitUntil: (work) => tasks.push(work) };
  // A deterministic held write, rather than a flaky millisecond threshold,
  // proves the response is independent of diagnostic persistence.
  const response = await handleCoveApi(request("/account"), held, execution);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user, null);
  assert.equal(tasks.length, 1);
  assert.match(response.headers.get("server-timing"), /cove_log_queued/);
  assert.doesNotMatch(response.headers.get("server-timing"), /cove_log;/);
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) count FROM ops_http_requests").first()).count,
    0,
  );
  release();
  await Promise.all(tasks.splice(0));
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) count FROM ops_http_requests").first()).count,
    1,
    "retained work persists after response",
  );

  hold();
  const contextResponse = await handleCoveApi(request("/storefront/context"), held, execution);
  assert.equal(contextResponse.status, 200);
  assert.equal(
    tasks.length,
    2,
    "both storefront diagnostics and request log retain their lifetime",
  );
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) count FROM storefront_context_events").first()).count,
    0,
  );
  release();
  await Promise.all(tasks.splice(0));
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) count FROM storefront_context_events").first()).count,
    1,
  );

  hold();
  let returned = false;
  const fallback = handleCoveApi(request("/account"), held).then((value) => {
    returned = true;
    return value;
  });
  await new Promise(setImmediate);
  assert.equal(returned, false, "runtimes without retention still await diagnostics");
  release();
  assert.equal((await fallback).status, 200);
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) count FROM ops_http_requests").first()).count,
    3,
  );
  console.log(
    "PASS: held diagnostic writes cannot block retained Worker responses, finish after response, and remain awaited without a runtime lifetime mechanism.",
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
