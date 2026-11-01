import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const backend = readFileSync("src/persistence-backend.worker.ts", "utf8");
for (const path of [
  "wrangler.backend.production.toml",
  ".github/workflows/deploy-persistence-backend.yml",
]) {
  const config = readFileSync(path, "utf8");
  assert.match(config, /binding = "COVE_CANONICAL_READONLY"/);
  assert.match(config, /service = "cove-canonical-d1-readonly"/);
  assert.doesNotMatch(config, /COVE_BACKEND_HTTP_READONLY_RPC\s*=\s*"1"/);
}

assert.match(backend, /COVE_BACKEND_HTTP_READONLY_RPC\?: string/);
assert.equal(
  (backend.match(/const primary = backendHttpPrimaryReadDb\(env\);/g) || []).length,
  3,
  "Health, SEO, and hosted short-transcript metadata must use the read-only provider",
);
assert.match(backend, /handleSeoDocumentRequest\(request, primary, env\.FORE_PUBLIC_URL\)/);
assert.match(backend, /primary\.prepare\("SELECT 1 ok"\)/);
assert.match(backend, /\.prepare\("SELECT language,tracks_json FROM audio_editions WHERE id=\?"\)/);

const folder = mkdtempSync(path.join(tmpdir(), "cove-http-primary-read-"));
try {
  const outfile = path.join(folder, "reader.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/backend-http-primary-reads.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
  });
  const { backendHttpPrimaryReadDb } = await import(pathToFileURL(outfile).href);
  let nativeCalls = 0;
  const native = {
    prepare() {
      nativeCalls++;
      throw Error("legacy_native_d1_must_not_be_used");
    },
  };
  let providerDown = false;
  let providerCalls = 0;
  const provider = {
    async query(statements) {
      providerCalls++;
      if (providerDown) throw Error("readonly_service_unavailable");
      assert.ok(statements.every((statement) => /^SELECT\b/i.test(statement.sql)));
      return statements.map(() => ({
        success: true,
        results: [{ ok: 1 }],
        meta: { served_by_primary: true },
      }));
    },
  };
  const enabled = {
    DB: native,
    COVE_BACKEND_HTTP_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY_RPC: "1",
    COVE_CANONICAL_READONLY: provider,
  };
  const restricted = backendHttpPrimaryReadDb(enabled);
  assert.equal((await restricted.prepare("SELECT 1 ok").first()).ok, 1);
  await assert.rejects(() => restricted.prepare("UPDATE entitlements SET status='active'").run());
  assert.equal(nativeCalls, 0);
  assert.equal(providerCalls, 1);
  providerDown = true;
  await assert.rejects(
    () => restricted.prepare("SELECT 1 ok").first(),
    /readonly_service_unavailable/,
  );
  assert.equal(nativeCalls, 0, "A provider outage must not re-enable the native D1 binding");
  for (const bad of [
    { COVE_BACKEND_HTTP_READONLY_RPC: "0" },
    { COVE_BACKEND_HTTP_READONLY_RPC: "" },
    { COVE_CANONICAL_READONLY_RPC: "0" },
    { COVE_CANONICAL_READONLY: undefined },
  ])
    assert.throws(
      () => backendHttpPrimaryReadDb({ ...enabled, ...bad }),
      /http_primary_read_owner_unavailable/,
    );
  assert.equal(backendHttpPrimaryReadDb({ DB: native }), native);
  console.log(
    "PASS: backend HTTP health, SEO and short-transcript metadata reads have a strictly fail-closed read-only path.",
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
