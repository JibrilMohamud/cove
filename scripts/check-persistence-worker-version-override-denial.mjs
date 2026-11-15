import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(path.join(tmpdir(), "cove-override-denial-"));
try {
  const outfile = path.join(root, "gateway.mjs");
  await build({
    entryPoints: ["src/lib/persistence-backend.ts"],
    outfile,
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
  });
  const { proxyPersistenceApi } = await import(pathToFileURL(outfile).href);
  const env = {
    FORE_BACKEND_URL: "https://cove-persistence-backend.cove-jibrilmohamud.workers.dev",
    FORE_BACKEND_TOKEN: "synthetic-gateway-secret",
    FORE_PUBLIC_URL: "https://www.covereads.com",
    FORE_ENVIRONMENT: "production",
  };
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), headers });
    return Response.json(
      { ok: true },
      {
        headers: { "cache-control": "no-store" },
      },
    );
  };
  try {
    for (const route of [
      "/api/fore/catalog",
      "/api/fore/storefront/bootstrap",
      "/api/fore/books/123/detail",
    ]) {
      const request = new Request("https://www.covereads.com" + route, {
        headers: {
          "Cloudflare-Workers-Version-Overrides":
            'cove-persistence-backend="00000000-0000-0000-0000-000000000001"',
          "Cloudflare-Workers-Version-Key": "force-visitor-version",
          "x-cove-backend-token": "forged-browser-credential",
          "x-fore-request-id": "public-untrusted-request",
        },
      });
      const response = await proxyPersistenceApi(request, env);
      assert.equal(response.status, 200);
      const intercepted = seen.at(-1);
      assert.ok(intercepted.url.endsWith(route));
      assert.equal(intercepted.headers.get("cloudflare-workers-version-overrides"), null);
      assert.equal(intercepted.headers.get("cloudflare-workers-version-key"), null);
      assert.equal(intercepted.headers.get("x-cove-backend-token"), env.FORE_BACKEND_TOKEN);
      assert.equal(intercepted.headers.get("x-fore-request-id"), "public-untrusted-request");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(seen.length, 3);
  console.log(
    "PASS: actual Vercel persistence gateway rejects public Cloudflare version override and affinity headers",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
