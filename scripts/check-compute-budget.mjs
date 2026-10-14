import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-compute-budget-"));
try {
  fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      "audio-compute-budget.server": "src/features/fore/audio-compute-budget.server.ts",
      "public-document-cache": "src/lib/public-document-cache.ts",
      client: "src/features/fore/client.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: scratch,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { audioComputeAdmission: admit } = await import(
    path.join(scratch, "audio-compute-budget.server.mjs")
  );
  const { cachePublicDocument: cache } = await import(
    path.join(scratch, "public-document-cache.mjs")
  );
  const { findLibraryBook } = await import(path.join(scratch, "client.mjs"));
  const { DB } = localBindings(scratch);
  assert.equal((await admit({ DB }, true)).reason, "paused");
  const env = {
    DB,
    FORE_AUDIO_COMPUTE_MODE: "budgeted",
    FORE_AUDIO_MIN_INTERVAL_SECONDS: "300",
    FORE_AUDIO_MONTHLY_SECONDS: "600",
  };
  const at = new Date("2026-10-01T00:00:00Z");
  const concurrent = await Promise.all([admit(env, true, at), admit(env, true, at)]);
  assert.equal(
    concurrent.filter((x) => x.allowed).length,
    1,
    "only one concurrent run receives admission",
  );
  assert.equal((await admit(env, false, at)).reason, "cooldown");
  assert.equal((await admit(env, true, new Date(at.valueOf() + 300000))).allowed, true);
  assert.equal((await admit(env, false, new Date(at.valueOf() + 600000))).reason, "monthly-budget");
  assert.equal((await admit(env, true, new Date("2026-11-01T00:00:00Z"))).allowed, true);
  assert.equal(
    (await admit({ ...env, FORE_AUDIO_MONTHLY_SECONDS: "invalid" }, true)).allowed,
    false,
  );
  await assert.rejects(
    admit(
      {
        ...env,
        DB: {
          prepare() {
            throw Error("database unavailable");
          },
        },
      },
      true,
    ),
  );
  const document = () =>
    new Response("<html>Public shell</html>", { headers: { "content-type": "text/html" } });
  assert.equal(
    cache(new Request("https://cove.test/"), document()).headers.get("vercel-cdn-cache-control"),
    "public, s-maxage=300",
  );
  for (const url of [
    "/?auth=login",
    "/community?journey=secret",
    "/read/prd_public",
    "/profile",
    "/api/fore/account",
  ])
    assert.equal(
      cache(new Request("https://cove.test" + url), document()).headers.get(
        "vercel-cdn-cache-control",
      ),
      null,
    );
  for (const header of ["cookie", "authorization", "oai-authenticated-user-id"])
    assert.equal(
      cache(
        new Request("https://cove.test/", { headers: { [header]: "private" } }),
        document(),
      ).headers.get("vercel-cdn-cache-control"),
      null,
    );
  const entry = {
    bookId: "1342",
    productId: "prd_internal",
    version: 7,
    book: { id: "prd_public", publicProductId: "prd_public", productId: "prd_internal" },
  };
  for (const id of ["1342", "prd_internal", "prd_public"])
    assert.equal(findLibraryBook([entry], id), entry);
  assert.equal(findLibraryBook([entry], "different"), undefined);
  console.log(
    "PASS: atomic audio admission, cooldown, monthly cap/reset, fail-closed settings, private cache bypass and canonical reader identity.",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
