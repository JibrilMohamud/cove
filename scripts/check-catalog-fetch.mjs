import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "cove-catalog-fetch-"));
const originalFetch = globalThis.fetch;
const originalTimeout = globalThis.setTimeout;
const delays = [];
let calls = 0;
const page = { results: [{ id: 1342 }], next: null, count: 1 };
const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new DOMException("Body read timed out", "TimeoutError"));
      },
    }),
  );

try {
  const output = join(directory, "catalog-fetch.mjs");
  await build({
    entryPoints: ["src/features/fore/catalog-fetch.server.ts"],
    outfile: output,
    platform: "node",
    format: "esm",
    bundle: true,
    logLevel: "silent",
  });
  const { fetchCatalogPage } = await import(pathToFileURL(output).href);
  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return originalTimeout(callback, 0, ...args);
  };

  globalThis.fetch = async () => (++calls === 1 ? brokenBody() : Response.json(page));
  assert.deepEqual(await fetchCatalogPage("https://catalog.example/books"), page);
  assert.equal(calls, 2, "body timeouts must retry the same page before returning");
  assert.deepEqual(delays.splice(0), [1000]);

  calls = 0;
  let cancelled = false;
  globalThis.fetch = async () =>
    ++calls === 1
      ? new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 503,
            headers: { "retry-after": "2" },
          },
        )
      : Response.json(page);
  assert.deepEqual(await fetchCatalogPage("https://catalog.example/books"), page);
  assert.equal(calls, 2);
  assert.ok(cancelled, "failed responses must release their body before retrying");
  assert.deepEqual(delays.splice(0), [2000]);

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("missing", { status: 404 });
  };
  await assert.rejects(fetchCatalogPage("https://catalog.example/books"), /returned 404/);
  assert.equal(calls, 1, "permanent HTTP failures must not be retried");
  assert.deepEqual(delays.splice(0), []);

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return brokenBody();
  };
  await assert.rejects(fetchCatalogPage("https://catalog.example/books"), /Body read timed out/);
  assert.equal(calls, 3, "body retries must remain bounded");
  assert.deepEqual(delays.splice(0), [1000, 3000]);

  calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? new Response('{"results":') : Response.json(page);
  assert.deepEqual(await fetchCatalogPage("https://catalog.example/books"), page);
  assert.equal(calls, 2, "truncated JSON must not escape the retry boundary");
  console.log(
    "PASS: catalog body timeout, truncated JSON, transient HTTP recovery, body cleanup, and bounded retries.",
  );
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalTimeout;
  await rm(directory, { recursive: true, force: true });
}
