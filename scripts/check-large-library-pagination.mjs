import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-collections-pages-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "api.mjs"),
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.mjs"));
  const env = localBindings(root);
  const accountId = "pagination-alice";
  const instant = "2026-10-14T12:00:00.000Z";
  async function call(route, owner = accountId) {
    const response = await handleCoveApi(
      new Request("https://fore.test/api/fore" + route, {
        headers: owner
          ? {
              "oai-authenticated-user-id": owner,
              "oai-authenticated-user-email": owner + "@example.test",
            }
          : {},
      }),
      env,
    );
    return { status: response.status, value: await response.json() };
  }
  for (let i = 0; i < 237; i++) {
    await env.DB.prepare(
      "INSERT INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "note-" + String(i).padStart(3, "0"),
        accountId,
        i % 2 ? "1342" : "9999",
        "Title",
        "Author",
        "Passage " + i,
        "epubcfi(/6/2!)",
        "Chapter",
        "yellow",
        "Private " + i,
        instant,
        instant,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO definitions(id,user_id,word,phonetic,meaning,part_of_speech,book_id,book_title,cfi,context,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "definition-" + String(i).padStart(3, "0"),
        accountId,
        "word" + i,
        "",
        "meaning",
        "noun",
        "1342",
        "Pride and Prejudice",
        "epubcfi(/6/2!)",
        "context",
        "dictionary",
        instant,
      )
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "other-user-note",
      "pagination-bob",
      "1342",
      "Title",
      "Author",
      "Secret",
      "epubcfi(/6/2!)",
      "Chapter",
      "yellow",
      "Private",
      instant,
      instant,
    )
    .run();
  const initial = await call("/account");
  assert.equal(initial.status, 200, JSON.stringify(initial.value).slice(0, 200));
  assert.equal(initial.value.annotations.length, 100);
  assert.equal(initial.value.definitions.length, 100);
  async function all(kind, pageSize) {
    let offset = 0;
    const found = [];
    for (let page = 0; page < 10; page++) {
      const { status, value } = await call(
        "/account/collection?kind=" + kind + "&limit=" + pageSize + "&offset=" + offset,
      );
      assert.equal(status, 200, JSON.stringify(value).slice(0, 300));
      assert.ok(value.items.length <= pageSize);
      found.push(...value.items);
      if (!value.hasMore) return found;
      assert.equal(value.nextOffset, offset + pageSize);
      offset = value.nextOffset;
    }
    assert.fail("pagination never ended");
  }
  for (const kind of ["annotations", "definitions"]) {
    const rows = await all(kind, 43);
    assert.equal(rows.length, 237, "all " + kind + " loaded");
    assert.equal(new Set(rows.map((x) => x.id)).size, 237, "stable, duplicate-free " + kind);
  }
  const perBook = await call("/account/collection?kind=annotations&bookId=1342&limit=100");
  assert.equal(perBook.status, 200);
  assert.ok(perBook.value.items.every((x) => x.bookId === "1342"));
  assert.equal(perBook.value.items.length, 100);
  assert.equal(perBook.value.hasMore, true);
  const bob = await call("/account/collection?kind=annotations", "pagination-bob");
  assert.equal(bob.status, 200);
  assert.deepEqual(
    bob.value.items.map((x) => x.id),
    ["other-user-note"],
  );
  assert.equal((await call("/account/collection?kind=annotations", "")).status, 401);
  assert.equal((await call("/account/collection?kind=definitions&limit=1001")).status, 400);
  assert.equal((await call("/account/collection?kind=definitions&offset=-5")).status, 400);
  console.log(
    "PASS: bounded account payload, 237-row pagination, filtered note pages, no duplicates, account isolation, invalid-input denials",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
