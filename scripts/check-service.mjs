import os from "node:os";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { localBindings } from "./local-api.mjs";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fore-service-"));
fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
await build({
  entryPoints: ["src/features/fore/api.server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(scratch, "api.mjs"),
  logLevel: "silent",
});
const { handleCoveApi } = await import(path.join(scratch, "api.mjs"));
const env = localBindings(scratch);
async function req(path, method = "GET", body, user = "test-reader-a") {
  const headers = { "Content-Type": "application/json", Origin: "https://fore.test" };
  if (user) {
    headers["oai-authenticated-user-id"] = user;
    headers["oai-authenticated-user-email"] = user + "@example.test";
  }
  const r = await handleCoveApi(
    new Request("https://fore.test/api/fore" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: r.status, data: await r.json() };
}
assert.equal((await req("/account", "GET", undefined, null)).data.user, null);
assert.equal((await req("/library", "POST", { bookId: "1342" }, null)).status, 401);
assert.equal((await req("/profile", "POST", { name: "Test Reader" })).status, 200);
assert.equal(
  (
    await req("/library", "POST", {
      bookId: "1342",
      status: "reading",
      cfi: "epubcfi(/6/4!/4/2:1)",
      progress: 0.25,
      shelves: ["Classics"],
    })
  ).status,
  200,
);
const canonicalBook = await req("/books/1342");
assert.equal(canonicalBook.status, 200);
assert.equal(canonicalBook.data.productId, "prd_gutenberg_1342");
assert.equal(canonicalBook.data.editionId, "ed_gutenberg_1342");
assert.equal(canonicalBook.data.workId, "wrk_gutenberg_1342");
assert.equal(canonicalBook.data.offer.amountMinor, 0);
assert.equal(
  (await env.DB.prepare("SELECT entitlement_type FROM entitlements WHERE user_id=? AND product_id=? AND status='active'").bind("test-reader-a", "prd_gutenberg_1342").first()).entitlement_type,
  "public-domain",
);
assert.equal(
  await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library'").first(),
  null,
);
const added = await req("/annotations", "POST", {
  bookId: "1342",
  quote: "It is a truth universally acknowledged",
  cfi: "epubcfi(/6/4!/4/2:1)",
  chapter: "Chapter I",
  color: "yellow",
  note: "Test passage note",
});
assert.equal(added.status, 201);
assert.equal(
  (
    await req(
      "/annotations/" + added.data.id,
      "PATCH",
      { note: "Revised note", color: "blue" },
      "test-reader-b",
    )
  ).status,
  404,
);
assert.equal(
  (
    await req("/definitions", "POST", {
      word: "acknowledged",
      meaning: "Recognized as true.",
      bookId: "1342",
      cfi: "epubcfi(/6/4!/4/2:1)",
    })
  ).status,
  201,
);
let a = (await req("/account")).data;
assert.equal(a.library[0].progress, 0.25);
assert.deepEqual(a.library[0].shelves, ["Classics"]);
assert.equal(a.annotations.length, 1);
assert.equal(a.definitions.length, 1);
assert.equal((await req("/account", "GET", undefined, "test-reader-b")).data.annotations.length, 0);
assert.equal(
  (await req("/annotations/" + added.data.id, "PATCH", { note: "Revised note", color: "blue" }))
    .status,
  200,
);
assert.equal((await req("/account")).data.annotations[0].note, "Revised note");
assert.equal((await req("/library", "POST", { bookId: "1342", progress: 2 })).status, 400);
const csrf = await handleCoveApi(
  new Request("https://fore.test/api/fore/profile", {
    method: "POST",
    headers: {
      origin: "https://evil.test",
      "content-type": "application/json",
      "oai-authenticated-user-id": "test-reader-a",
    },
    body: '{"name":"Bad"}',
  }),
  env,
);
assert.equal(csrf.status, 403);
const ephemeral = localBindings(scratch);
assert.equal(
  (
    await handleCoveApi(
      new Request("https://fore.test/api/fore/account", {
        headers: { "oai-authenticated-user-id": "test-reader-a" },
      }),
      ephemeral,
    )
  ).status,
  200,
);
await req("/annotations/" + added.data.id, "DELETE", {});
assert.equal((await req("/account")).data.annotations.length, 0);
assert.equal((await req("/library/1342", "DELETE", {})).status, 200);
assert.equal((await req("/account")).data.library.length, 0);
assert.equal(
  (await env.DB.prepare("SELECT status FROM entitlements WHERE user_id=? AND product_id=?").bind("test-reader-a", "prd_gutenberg_1342").first()).status,
  "active",
);
assert.equal((await req("/library", "POST", { bookId: "1342" })).status, 200);
console.log(
  "PASS: anonymous reads, authentication gates, persistent profiles/library/notes/definitions, ownership isolation, input limits, cross-origin rejection, and annotation lifecycle.",
);

fs.rmSync(scratch, { recursive: true, force: true });
