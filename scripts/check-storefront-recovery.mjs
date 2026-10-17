import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-ssr-recovery-"));
try {
  await build({
    entryPoints: ["src/features/fore/storefront-bootstrap-fetch.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(dir, "recovery.mjs"),
    logLevel: "silent",
  });
  const { requestStorefrontBootstrap } = await import(path.join(dir, "recovery.mjs"));
  const request = new Request("https://cove.test/api/fore/storefront/bootstrap", {
    headers: { "accept-language": "fr-CA", "x-vercel-ip-country": "CA" },
  });
  const payload = {
    context: { rightsCountry: "CA", locale: "fr-CA", currency: "CAD" },
    catalog: { results: [{ id: "book-1" }] },
    at: Date.now(),
  };
  let attempts = 0;
  const failures = [];
  const recovered = await requestStorefrontBootstrap(
    request,
    async (attempt) => {
      attempts++;
      assert.equal(attempt.headers.get("accept-language"), "fr-CA");
      assert.equal(attempt.headers.get("x-vercel-ip-country"), "CA");
      if (attempts === 1) {
        return await new Promise((resolve, reject) => {
          const onAbort = () => reject(attempt.signal.reason);
          attempt.signal.addEventListener("abort", onAbort, { once: true });
          if (attempt.signal.aborted) onAbort();
        });
      }
      return Response.json(payload);
    },
    { timeoutMs: 400, firstAttemptMs: 20, onFailure: (e) => failures.push(e) },
  );
  assert.equal(attempts, 2, "A cold-start timeout gets one bounded retry");
  assert.deepEqual(JSON.parse(recovered), payload);
  assert.equal(failures[0].kind, "timeout");

  attempts = 0;
  assert.equal(
    await requestStorefrontBootstrap(request, async () => {
      attempts++;
      return new Response("Forbidden", { status: 403 });
    }),
    null,
  );
  assert.equal(attempts, 1, "Do not retry rights or authentication denials");

  attempts = 0;
  assert.equal(
    await requestStorefrontBootstrap(
      request,
      async () => {
        attempts++;
        return Response.json({ ...payload, context: { locale: "fr-CA" } });
      },
      { timeoutMs: 100 },
    ),
    null,
  );
  assert.equal(attempts, 1, "Never repair invalid rights data from another territory");

  attempts = 0;
  const unavailable = await requestStorefrontBootstrap(
    request,
    async () => {
      attempts++;
      return new Response("unavailable", { status: 503 });
    },
    { timeoutMs: 100 },
  );
  assert.equal(unavailable, null);
  assert.equal(attempts, 2, "Unhealthy upstream fails closed after bounded retry");

  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await requestStorefrontBootstrap(
      new Request(request, { signal: controller.signal }),
      async () => {
        throw new Error("Cancelled request must never fetch");
      },
    ),
    null,
  );
  console.log("SSR bootstrap recovery, territory and failure checks passed.");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
