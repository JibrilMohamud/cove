// Reproduce #187's sequential failure stampede against an immutable source.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import assert from "node:assert/strict";
import path from "node:path";
const sourcePath = "src/features/fore/taxonomy-counts-cache.server.ts";
const baseline = "bbc57d159d6200467b53cae6f1300d989e6aa48b";
const outcomes = [];
for (const revision of [baseline, "working-tree"]) {
  const source =
    revision === baseline
      ? execFileSync("git", ["show", `${baseline}:${sourcePath}`], { encoding: "utf8" })
      : readFileSync(sourcePath, "utf8");
  const compiled = await build({
    stdin: { contents: source, loader: "ts", resolveDir: path.resolve("src/features/fore") },
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
  });
  const { presentationTaxonomyCounts } = await import(
    "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64")
  );
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE api_cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,expires_at INTEGER NOT NULL)",
  );
  let scans = 0,
    leaseAttempts = 0,
    failures = 0,
    now = Date.now();
  const db = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes("RETURNING body")) leaseAttempts++;
              return stmt.get(...params) ?? null;
            },
            async run() {
              return stmt.run(...params);
            },
          };
        },
      };
    },
    async batch(stmts) {
      for (const s of stmts) await s.run();
    },
  };
  const jobs = [];
  const previousWarn = console.warn;
  console.warn = () => failures++;
  try {
    for (let i = 0; i < 33; i++) {
      const state = { pending: false };
      const result = await presentationTaxonomyCounts(
        db,
        "US",
        "en",
        async () => {
          scans++;
          throw Error("simulated replica outage");
        },
        () => now,
        (p) => jobs.push(p),
        state,
      );
      assert.deepEqual(result, []);
      assert.equal(state.pending, true);
      await Promise.all(jobs.splice(0));
    }
    outcomes.push({
      revision,
      requests: 33,
      failedScans: scans,
      leaseAttempts,
      handledFailures: failures,
    });
    now += 30_001;
    await presentationTaxonomyCounts(
      db,
      "US",
      "en",
      async () => [{ node_id: "fiction", product_count: 7 }],
      () => now,
      (p) => jobs.push(p),
    );
    await Promise.all(jobs.splice(0));
    assert.equal(
      (
        await presentationTaxonomyCounts(
          db,
          "US",
          "en",
          async () => [],
          () => now,
          (p) => jobs.push(p),
        )
      )[0].product_count,
      7,
    );
  } finally {
    console.warn = previousWarn;
    sqlite.close();
  }
}
assert.equal(outcomes[0].failedScans, 33);
assert.equal(outcomes[1].failedScans, 1);
assert.equal(outcomes[1].leaseAttempts, 1);
console.log(
  JSON.stringify(
    { boundary: "Deterministic failure/recovery fixture, not deployed latency", outcomes },
    null,
    2,
  ),
);
