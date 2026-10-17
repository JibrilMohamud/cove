import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cove-heavy-library-"));
try {
  await fs.cp("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    outfile: path.join(root, "api.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.mjs"));
  const env = localBindings(root),
    at = new Date().toISOString();
  const raw = new DatabaseSync(path.join(root, ".sites-runtime/fore.sqlite"));
  raw.exec("PRAGMA foreign_keys=ON; BEGIN");
  const work = raw.prepare("INSERT INTO works(id,title,created_at,updated_at) VALUES(?,?,?,?)");
  const edition = raw.prepare(
    "INSERT INTO editions(id,work_id,title,created_at,updated_at) VALUES(?,?,?,?,?)",
  );
  const product = raw.prepare(
    "INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,'ebook',?,?,?,?)",
  );
  const entitlement = raw.prepare(
    "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,ends_at,granted_at,updated_at) VALUES(?,'heavy-reader',?,'purchase',?,'isolated-fixture',?,?,?)",
  );
  const state = raw.prepare(
    "INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,updated_at) VALUES('heavy-reader',?,?,1,'reading',?)",
  );
  for (let i = 0; i < 5000; i++) {
    const id = `heavy-${String(i).padStart(5, "0")}`;
    work.run("w-" + id, "Synthetic " + i, at, at);
    edition.run("e-" + id, "w-" + id, "Synthetic " + i, at, at);
    product.run(id, "e-" + id, id, i >= 4998 ? "upload" : "fore", id, at, at);
    entitlement.run(
      "ent-" + id,
      id,
      i === 4996 ? "revoked" : "active",
      i === 4997 ? "2000-01-01T00:00:00.000Z" : null,
      at,
      at,
    );
    state.run(id, id, at);
  }
  raw
    .prepare(
      "INSERT INTO personal_imports(id,user_id,product_id,object_key,created_at) VALUES('own','heavy-reader','heavy-04999','synthetic-own.epub',?)",
    )
    .run(at);
  raw
    .prepare(
      "INSERT INTO personal_imports(id,user_id,product_id,object_key,created_at) VALUES('other','other-reader','heavy-04998','synthetic-other.epub',?)",
    )
    .run(at);
  raw.exec("COMMIT");
  // Compare the same ordered, entitlement-filtered page on this isolated
  // database before/after the additive indexes. Never runs against production.
  const pageSql =
    "SELECT rs.* FROM reading_states rs WHERE rs.user_id=? AND rs.in_library=1 AND EXISTS(SELECT 1 FROM entitlements e WHERE e.user_id=rs.user_id AND e.product_id=rs.product_id AND e.status='active' AND (e.starts_at IS NULL OR e.starts_at<=?) AND (e.ends_at IS NULL OR e.ends_at>?)) ORDER BY rs.updated_at DESC,rs.product_id DESC LIMIT 101";
  const pageArgs = ["heavy-reader", at, at];
  raw.exec(
    "DROP INDEX idx_entitlements_library_access; DROP INDEX idx_reading_states_library_page",
  );
  const beforeStart = performance.now();
  const beforeRows = raw.prepare(pageSql).all(...pageArgs);
  const beforeSqlMs = performance.now() - beforeStart;
  raw.exec(await fs.readFile("drizzle/0073_library_page_query_plan.sql", "utf8"));
  const afterStart = performance.now();
  const afterRows = raw.prepare(pageSql).all(...pageArgs);
  const afterSqlMs = performance.now() - afterStart;
  assert.deepEqual(afterRows, beforeRows, "indexes preserve exact ordered library rows");
  let hydrationQueries = 0;
  const pagePlans = [];
  const measured = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql) => {
            if (/FROM products p JOIN editions e/.test(sql) && /personal_imports pi/.test(sql))
              hydrationQueries++;
            const statement = target.prepare(sql);
            if (/SELECT rs\.\* FROM reading_states rs/.test(sql))
              return new Proxy(statement, {
                get(prepared, key) {
                  if (key === "bind")
                    return (...values) => {
                      pagePlans.push(
                        raw
                          .prepare("EXPLAIN QUERY PLAN " + sql)
                          .all(...values)
                          .map((row) => row.detail),
                      );
                      return prepared.bind(...values);
                    };
                  return Reflect.get(prepared, key);
                },
              });
            return statement;
          };
        return Reflect.get(target, key);
      },
    }),
  };
  const durations = [];
  async function call(route, user = "heavy-reader") {
    hydrationQueries = 0;
    const start = performance.now();
    const response = await handleCoveApi(
      new Request("https://isolated.test/api/fore" + route, {
        headers: {
          "oai-authenticated-user-id": user,
          "oai-authenticated-user-email": user + "@example.test",
        },
      }),
      measured,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.library?.length || body.items?.length)
      assert.ok(hydrationQueries > 0, "nonempty library uses ownership-aware bulk hydration");
    durations.push(performance.now() - start);
    assert.ok(hydrationQueries <= 2, `bounded page used ${hydrationQueries} metadata queries`);
    return body;
  }
  const summary = await call("/account");
  assert.ok(summary.library.length <= 100);
  assert.ok(
    summary.library.some((item) => item.productId === "heavy-04999"),
    "owned private import survives bulk hydration",
  );
  const ids = new Set();
  let offset = 0,
    pages = 0;
  do {
    const page = await call(`/account/collection?kind=library&limit=100&offset=${offset}`);
    assert.ok(page.items.length <= 100);
    for (const item of page.items) {
      assert.ok(
        !ids.has(item.productId),
        "lookahead cannot repeat after an unavailable private row",
      );
      ids.add(item.productId);
    }
    pages++;
    offset = page.hasMore ? page.nextOffset : null;
    assert.ok(pages <= 50);
  } while (offset != null);
  assert.equal(ids.size, 4997);
  assert.ok(pagePlans.length > 0);
  for (const plan of pagePlans) {
    assert.ok(
      plan.some((line) => line.includes("idx_entitlements_library_access")),
      "per-product covering entitlement seek",
    );
    assert.ok(
      plan.some((line) => line.includes("idx_reading_states_library_page")),
      "stable indexed library order",
    );
    assert.ok(
      !plan.some((line) => line.includes("TEMP B-TREE")),
      "no full reader-library sort per page",
    );
  }
  for (const id of ["heavy-04998", "heavy-04997", "heavy-04996"])
    assert.ok(!ids.has(id), "foreign import, expired and revoked entitlements stay excluded");
  assert.equal((await call("/account", "other-reader")).library.length, 0);
  durations.sort((a, b) => a - b);
  console.log(
    "COVE_HEAVY_LIBRARY " +
      JSON.stringify({
        scope: "isolated-local-synthetic-api",
        storedBooks: 5000,
        eligibleBooksReturned: ids.size,
        pages,
        metadataQueriesPerPageMax: 2,
        pageSqlBeforeMs: Math.round(beforeSqlMs * 10) / 10,
        pageSqlAfterMs: Math.round(afterSqlMs * 10) / 10,
        apiP95Ms: Math.round(durations[Math.floor((durations.length - 1) * 0.95)]),
        productionCapacityVerified: false,
      }),
  );
  raw.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
