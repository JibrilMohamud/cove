import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const src = readFileSync("src/storefront-strangler/legal-authority.worker.ts", "utf8");
const buildScript = readFileSync("scripts/build-storefront-strangler.mjs", "utf8");
assert.match(src, /__COVE_PRODUCTION_OWNER_BINARY_LOCK__===true\)return false/);
assert.ok(
  (src.match(/qaOwnerLeaseLive\(env\)/g) || []).length >= 2,
  "Both the private entrypoint and the DO must enforce the compiled lock",
);
assert.match(buildScript, /legal-authority\.production-locked\.mjs/);
assert.match(buildScript, /__COVE_PRODUCTION_OWNER_BINARY_LOCK__: "true"/);
const lockedConfig = JSON.parse(
  readFileSync("wrangler.legal-authority.production-locked.jsonc", "utf8"),
);
assert.equal(lockedConfig.name, "cove-legal-authority-production");
assert.equal(
  lockedConfig.main,
  ".output/strangler/legal-authority.production-locked.mjs",
);
const provisioner = readFileSync(
  "scripts/staging/provision-literary-owner-capabilities.mjs",
  "utf8",
);
assert.match(provisioner, /readFileSync\("\.output\/strangler\/legal-authority\.production-locked\.mjs"/);
assert.match(provisioner, /main_module: "legal-authority\.production-locked\.mjs"/);
assert.doesNotMatch(provisioner, /readFileSync\("\.output\/strangler\/legal-authority\.mjs"/);


const dir = mkdtempSync(path.join(tmpdir(), "cove-legal-binary-lock-"));
try {
  async function bundle(binaryLocked) {
    const outfile = path.join(dir, binaryLocked ? "production.mjs" : "qa.mjs");
    await build({
      entryPoints: ["src/storefront-strangler/legal-authority.worker.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      alias: { jszip: "jszip/dist/jszip.min.js" },
      define: { __COVE_PRODUCTION_OWNER_BINARY_LOCK__: String(binaryLocked) },
      plugins: [
        {
          name: "worker-host-standin",
          setup(plugin) {
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "host",
              namespace: "worker-host",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "worker-host" }, () => ({
              contents: "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
            }));
          },
        },
      ],
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  }

  const prod = await bundle(true);
  const qa = await bundle(false);
  const secret = "f".repeat(64);
  let invocations = 0;
  const env = {
    PRIMARY_DB: {
      prepare() {
        throw Error("PRODUCTION_PRIMARY_DB_MUST_NOT_BE_TOUCHED");
      },
    },
    // Deliberately spoof a legal QA ID while the bound DB represents the
    // live production primary. Only a compiled binary lock is authoritative.
    COVE_RIGHTS_OWNER_ENABLED: "1",
    COVE_RIGHTS_OWNER_PRIMARY_ID: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 8 * 60_000),
    COVE_RIGHTS_OWNER_SECRET: secret,
    LEGAL_AUTHORITY: {
      getByName(name) {
        invocations++;
        assert.equal(name, "cove-staged-legal-global-v1");
        return { fetch: async () => new Response(null, { status: 204 }) };
      },
    },
  };
  const request = () =>
    new Request("https://private.invalid/commercial/order/settle", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify({ orderId: "order_qa" }),
    });
  assert.equal((await prod.default.fetch(request(), env)).status, 503);
  assert.equal(invocations, 0, "Production binary must never enter an owner DO");
  assert.equal((await qa.default.fetch(request(), env)).status, 204);
  assert.equal(invocations, 1, "QA binary retains its bounded private test lease");
  for (const invalid of [
    { COVE_RIGHTS_OWNER_ENABLED: "0" },
    { COVE_RIGHTS_OWNER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
    { COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 20 * 60_000) },
    { COVE_RIGHTS_OWNER_SECRET: "" },
  ]) {
    assert.equal((await qa.default.fetch(request(), { ...env, ...invalid })).status, 503);
    assert.equal((await prod.default.fetch(request(), { ...env, ...invalid })).status, 503);
  }
  assert.equal(invocations, 1, "Invalid QA attestations must never invoke an owner");
  console.log(
    "PASS: compiled production authority cannot unlock the synthetic QA owner, even with spoofed primary ID and valid QA lease.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
