import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-paging-"));
try {
  fs.cpSync("drizzle", path.join(dir, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(dir, "api.mjs"),
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(dir, "api.mjs"));
  const env = localBindings(dir);
  async function call(who, route) {
    const response = await handleCoveApi(
      new Request("https://fore.test/api/fore" + route, {
        headers: {
          "oai-authenticated-user-id": who,
          "oai-authenticated-user-email": who + "@example.test",
        },
      }),
      env,
    );
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  const a = "paging-alice", b = "paging-bob";
  await call(a, "/account");
  await call(b, "/account");
  const at = new Date("2026-10-14T12:00:00.000Z").toISOString();
  const insertNote = env.DB.prepare(
    "INSERT INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertDefinition = env.DB.prepare(
    "INSERT INTO definitions(id,user_id,word,phonetic,meaning,part_of_speech,book_id,book_title,cfi,context,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 225; i++) {
    const rowId = "note-" + String(i).padStart(3, "0");
    const bookId = i % 2 ? "1342" : "84";
    await insertNote.bind(
      rowId, a, bookId, "A test title", "Author",
      "Test quote " + i, "epubcfi(/6/2!)", "Chapter One",
      "yellow", "Private note " + i, at, at,
    ).run();
    await insertDefinition.bind(
      "definition-" + String(i).padStart(3, "0"),
      a, "word" + i, "", "Meaning " + i, "noun",
      bookId, "A test title", "epubcfi(/6/2!)", "Context", "reader", at,
    ).run();
  }
  await insertNote.bind(
    "bob-private", b, "1342", "A test title", "Author",
    "Bob only", "epubcfi(/6/2!)", "Chapter One",
    "yellow", "PRIVATE", at, at,
  ).run();
  const summary = await call(a, "/account");
  assert.equal(summary.annotations.length, 100, "account bootstrap must be bounded");
  assert.equal(summary.definitions.length, 100);
  for (const kind of ["annotations", "definitions"]) {
    const seen = new Set();
    const sizes = [];
    for (const offset of [0, 100, 200]) {
      const response = await call(a, `/account/collection?kind=${kind}&offset=${offset}`);
      sizes.push(response.items.length);
      assert.equal(response.hasMore, offset < 200);
      for (const item of response.items) {
        assert.equal(seen.has(item.id), false, "pagination must not duplicate records");
        seen.add(item.id);
      }
    }
    assert.deepEqual(sizes, [100, 100, 25]);
    assert.equal(seen.size, 225, "all private rows remain reachable");
  }
  const filtered = await call(
    a, "/account/collection?kind=annotations&bookId=1342&limit=100",
  );
  assert.equal(filtered.items.length, 100);
  assert.ok(filtered.items.every((row) => row.bookId === "1342"));
  assert.equal(filtered.hasMore, true);
  const bob = await call(b, "/account/collection?kind=annotations");
  assert.equal(bob.items.length, 1);
  assert.equal(bob.items[0].id, "bob-private");
  const guest = await handleCoveApi(
    new Request("https://fore.test/api/fore/account/collection?kind=annotations"),
    env,
  );
  assert.equal(guest.status, 401, "guests cannot page private annotations");
  console.log("PASS: 225-row paging, per-book filtering, 100-row bootstrap, no duplicates, account isolation");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
