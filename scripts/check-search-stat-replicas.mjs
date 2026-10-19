import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-stat-replicas-"));
try {
  for (const role of ["primary", "replica"]) {
    fs.mkdirSync(path.join(root, role));
    fs.cpSync("drizzle", path.join(root, role, "drizzle"), { recursive: true });
  }
  await build({
    stdin: {
      contents:
        fs.readFileSync("src/features/fore/search.server.ts", "utf8") + "\nexport {searchD1};",
      resolveDir: path.resolve("src/features/fore"),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "search.mjs"),
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "api.mjs"),
    logLevel: "silent",
  });
  const { searchD1, parseSearchInput } = await import(path.join(root, "search.mjs"));
  const { handleCoveApi } = await import(path.join(root, "api.mjs"));
  const primary = localBindings(path.join(root, "primary"));
  const replica = localBindings(path.join(root, "replica"));
  for (const env of [primary, replica])
    assert.equal(
      (await handleCoveApi(new Request("https://cove.test/api/fore/storefront/bootstrap"), env))
        .status,
      200,
    );
  const queries = [],
    sessions = [];
  let unavailable = false;
  const db = {
    ...primary.DB,
    prepare(sql) {
      queries.push({ role: "primary", sql });
      return primary.DB.prepare(sql);
    },
    withSession(constraint) {
      assert.equal(constraint, "first-unconstrained");
      const session = {
        ...replica.DB,
        prepare(sql) {
          assert.match(sql, /^\s*(WITH|SELECT)\b/i, "Replica cannot maintain caches or write");
          assert.ok(
            /FROM candidate|SELECT COUNT\(\*\) count FROM/.test(sql),
            "Replica only receives numerical aggregation SQL",
          );
          queries.push({ role: "replica", sql });
          if (unavailable) throw Error("statistics replica unavailable");
          return replica.DB.prepare(sql);
        },
      };
      sessions.push(session);
      return session;
    },
  };
  const input = (query = "") =>
    parseSearchInput(new URL("https://cove.test/catalog?limit=4&" + query));
  const first = await searchD1({ DB: db }, input());
  assert.ok(first.books.length > 0 && first.count > 0);
  assert.equal(sessions.length, 2, "Separate count and facet sessions on a cold browse");
  assert.ok(queries.filter((q) => q.role === "replica").length >= 2);
  assert.ok(
    !queries.some((q) => q.role === "primary" && /SELECT COUNT\(\*\) count FROM/.test(q.sql)),
  );
  const before = sessions.length;
  assert.deepEqual((await searchD1({ DB: db }, input())).books, first.books);
  assert.equal(sessions.length, before, "Warm metadata needs no new replica session");
  queries.length = 0;
  await searchD1({ DB: db }, input("q=pride"));
  assert.ok(
    queries.some((q) => q.role === "primary" && /SELECT COUNT\(\*\) count FROM/.test(q.sql)),
    "FTS totals that drive correction must remain current on primary",
  );
  assert.ok(
    !queries.some((q) => q.role === "replica" && /SELECT COUNT\(\*\) count FROM/.test(q.sql)),
  );
  await primary.DB.prepare("UPDATE rights_grants SET status='revoked' WHERE status='active'").run();
  await primary.DB.prepare("DELETE FROM api_cache").run();
  const revoked = await searchD1({ DB: db }, input("minPrice=0"));
  assert.equal(revoked.books.length, 0, "Fresh primary rights reject every revoked book");
  assert.ok(
    revoked.count > 0 && revoked.facets.categories.length > 0,
    "Intentionally stale replica may only supply display numbers",
  );
  await primary.DB.prepare("DELETE FROM api_cache").run();
  const startSessions = sessions.length;
  await Promise.all([
    searchD1({ DB: db }, input("sort=title")),
    searchD1({ DB: db }, input("sort=popular&minPrice=0")),
  ]);
  assert.equal(sessions.length - startSessions, 4);
  assert.equal(
    new Set(sessions).size,
    sessions.length,
    "Never reuse a session between independent requests",
  );
  await primary.DB.prepare("DELETE FROM api_cache").run();
  unavailable = true;
  await assert.rejects(searchD1({ DB: db }, input()), /statistics replica unavailable/);
  assert.equal(
    Number(
      (
        await primary.DB.prepare(
          "SELECT COUNT(*) n FROM api_cache WHERE key LIKE 'search-page:%' OR key LIKE 'search-counts:%' OR key LIKE 'search-facets:%'",
        ).first()
      ).n,
    ),
    0,
    "A failed numerical read never publishes a partial page or count",
  );
  unavailable = false;
  assert.equal((await searchD1({ DB: db }, input())).books.length, 0);
  console.log(
    "PASS: request-local numerical replica reads, primary cache maintenance, FTS correction, immediate revocation despite stale counts, unavailable replica and recovery",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
