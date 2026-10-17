import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-ssr-request-context-"));
try {
  await build({
    entryPoints: ["src/lib/cove-request-env.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "context.mjs"),
    logLevel: "silent",
  });
  const { withCoveRequestEnvironment, currentCoveRequestEnvironment } = await import(
    path.join(root, "context.mjs")
  );
  assert.equal(currentCoveRequestEnvironment(), undefined);
  const firstEnv = { DB: { tenant: "A" }, BUCKET: { name: "first" } };
  const secondEnv = { DB: { tenant: "B" }, BUCKET: { name: "second" } };
  const [first, second] = await Promise.all([
    withCoveRequestEnvironment(firstEnv, async () => {
      await new Promise((resolve) => setTimeout(resolve, 8));
      assert.equal(currentCoveRequestEnvironment(), firstEnv);
      await Promise.resolve();
      return currentCoveRequestEnvironment().DB.tenant;
    }),
    withCoveRequestEnvironment(secondEnv, async () => {
      assert.equal(currentCoveRequestEnvironment(), secondEnv);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return currentCoveRequestEnvironment().DB.tenant;
    }),
  ]);
  assert.deepEqual([first, second], ["A", "B"]);
  assert.equal(currentCoveRequestEnvironment(), undefined);
  const clean = withCoveRequestEnvironment(null, () => currentCoveRequestEnvironment());
  assert.deepEqual(clean, {});
  assert.equal(currentCoveRequestEnvironment(), undefined);
  await build({
    entryPoints: ["src/lib/cloudflare-country.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "country.mjs"),
    logLevel: "silent",
  });
  const { isolateWorkerCountry, trustedWorkerCountry } = await import(
    path.join(root, "country.mjs")
  );
  const attacker = new Request("https://cove.test/", {
    headers: {
      "x-cove-client-country": "US",
      "cf-ipcountry": "US",
      "x-vercel-ip-country": "US",
    },
  });
  Object.defineProperty(attacker, "cf", { value: { country: "CA" } });
  assert.equal(trustedWorkerCountry(attacker), "CA");
  const verified = isolateWorkerCountry(attacker);
  assert.equal(verified.headers.get("x-cove-client-country"), "CA");
  assert.equal(verified.headers.get("cf-ipcountry"), null);
  assert.equal(verified.headers.get("x-vercel-ip-country"), null);
  assert.equal(isolateWorkerCountry(new Request(attacker)), null);
  const unknown = new Request("https://cove.test/", {
    headers: { "x-cove-client-country": "CA" },
  });
  assert.equal(isolateWorkerCountry(unknown), null);
  Object.defineProperty(unknown, "cf", { value: { country: "XX" } });
  assert.equal(isolateWorkerCountry(unknown), null);
  console.log("Isolated concurrent SSR rights bindings: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
