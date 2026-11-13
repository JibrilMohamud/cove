import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import workerd from "workerd";
import readline from "node:readline";

// Real workerd request lifetimes, synthetic I/O only. The owner returns before
// its pending read completes, after the visitor starts. The visitor must
// retain its OWN read; a handshake avoids timer/scheduler races in CI.
// Node-only Promise tests cannot reproduce workerd's cancellation semantics.
const sql =
  "WITH RECURSIVE active_market AS MATERIALIZED (SELECT 1), " +
  "chosen_locale AS MATERIALIZED (SELECT 1) " +
  "SELECT * FROM active_market m LEFT JOIN chosen_locale l ON 1=1";
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { withInFlightAnonymousMarketReads as wrap } from "./src/features/fore/storefront-inflight-public-metadata";
      let binding, finishOwner;
      export default { async fetch(request, env) {
        binding ??= { prepare: () => ({ bind: () => ({
          all: async () => (await env.SLOW.fetch("https://synthetic.invalid")).json()
        }) }) };
        // Exactly as in serveLeanAnonymousBootstrap: a fresh wrapper per request,
        // even though Cloudflare reuses the native binding across invocations.
        const db = wrap(binding);
        const task = db.prepare(${JSON.stringify(sql)}).bind("US", '["en-US"]').all();
        if (request.url.endsWith("/owner")) {
          void task.catch(() => {});
          await new Promise(resolve => { finishOwner = resolve; });
          return new Response("owner-exited", { status: 504 });
        }
        // The visitor has obtained its metadata promise before the owner ends.
        finishOwner();
        return Promise.race([
          task.then(value => Response.json(value)),
          new Promise(resolve => setTimeout(() => resolve(
            new Response("visitor-timeout", { status: 504 })
          ), 1500))
        ]);
      }};
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
let begin;
const began = new Promise((resolve) => (begin = resolve));
let reads = 0;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cove-worker-lifetime-"));
const slow = http.createServer((_request, response) => {
  reads++;
  begin();
  setTimeout(() => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ presentation: "synthetic" }] }));
  }, 500);
});
slow.listen(0, "127.0.0.1");
await once(slow, "listening");
const slowPort = slow.address().port;
fs.writeFileSync(path.join(directory, "worker.mjs"), outputFiles[0].text);
fs.writeFileSync(
  path.join(directory, "config.capnp"),
  `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = "${workerd.compatibilityDate}",
      bindings = [(name = "SLOW", service = "slow")]
    )),
    (name = "slow", external = (address = "127.0.0.1:${slowPort}", http = ()))
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")]
);
`,
);
// Direct pinned workerd avoids bringing an entire emulator/toolchain into
// the application dependency graph. Both sockets are loopback-only.
const runtime = spawn(
  workerd.default,
  ["serve", path.join(directory, "config.capnp"), "--control-fd=1"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
runtime.stderr.on("data", (data) => {
  stderr = (stderr + data).slice(-2000);
});
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("workerd startup timeout")), 10000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("workerd startup failed: " + stderr));
    };
    runtime.once("error", fail);
    runtime.once("exit", fail);
    const lines = readline.createInterface({ input: runtime.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.event === "listen" && message.socket === "http") {
        clearTimeout(timer);
        runtime.off("error", fail);
        runtime.off("exit", fail);
        lines.close();
        resolve(message.port);
      }
    });
  });
  const fetchWorker = (suffix) =>
    fetch(`http://127.0.0.1:${port}/${suffix}`, {
      signal: AbortSignal.timeout(5000),
    });
  const owner = fetchWorker("owner");
  await Promise.race([
    began,
    owner.then(() => {
      throw new Error("Owner exited before starting the synthetic metadata read");
    }),
  ]);
  const visitor = fetchWorker("visitor");
  const first = await owner;
  assert.equal(first.status, 504);
  assert.equal(await first.text(), "owner-exited");
  const second = await visitor;
  assert.equal(second.status, 200, "Ending another request must not cancel this visitor's read");
  assert.deepEqual(await second.json(), { results: [{ presentation: "synthetic" }] });
  assert.equal(reads, 2, "Independent Worker requests must independently own their I/O");
  console.log(
    "Worker metadata request-lifetime isolation: PASS (owner timeout cannot strand visitor)",
  );
} finally {
  runtime.kill();
  await once(runtime, "exit");
  slow.closeAllConnections();
  await new Promise((resolve) => slow.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
