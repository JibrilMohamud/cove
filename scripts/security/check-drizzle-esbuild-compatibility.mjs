import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Local compiler/schema generation only. No apply/push/migrate command,
// credentials, remote database, Worker, or production config is loaded.
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve("@esbuild-kit/core-utils"));
const kitEntry = require.resolve("drizzle-kit");
const kitRequire = createRequire(kitEntry);
assert.equal(coreRequire("esbuild/package.json").version, "0.25.12");
assert.equal(kitRequire("esbuild/package.json").version, "0.25.12");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!name.endsWith("/esbuild")) continue;
  const [major, minor] = entry.version.split(".").map(Number);
  assert.ok(major > 0 || minor >= 25, `vulnerable esbuild remains installed: ${name}`);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\/esbuild\/-\/esbuild-/);
  assert.match(entry.integrity, /^sha512-/);
}

const temp = mkdtempSync(path.join(process.cwd(), ".cove-drizzle-security-"));
try {
  const { transform, transformSync } = require("@esbuild-kit/core-utils");
  const source = "enum Kind { Book = 7 }; export const value: number = Kind.Book;";
  const commonjs = transformSync(source, path.join(temp, "sample.ts"));
  const cjsFile = path.join(temp, "sample.cjs");
  writeFileSync(cjsFile, commonjs.code);
  assert.equal(require(cjsFile).value, 7);
  assert.equal(commonjs.map.version, 3);
  const esm = await transform(source, path.join(temp, "sample.mts"));
  const esmFile = path.join(temp, "sample.mjs");
  writeFileSync(esmFile, esm.code);
  assert.equal((await import(pathToFileURL(esmFile))).value, 7);
  assert.equal(esm.map.version, 3);

  const schema = path.join(temp, "schema.ts");
  const config = path.join(temp, "drizzle.config.ts");
  const output = path.join(temp, "migrations");
  writeFileSync(
    schema,
    `import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
export const books = sqliteTable("security_fixture_books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
}, (table) => [index("security_fixture_title_idx").on(table.title)]);
`,
  );
  writeFileSync(
    config,
    `import { defineConfig } from "drizzle-kit";
export default defineConfig(${JSON.stringify({ dialect: "sqlite", schema, out: output })});
`,
  );
  const cli = path.join(path.dirname(kitEntry), "bin.cjs");
  const generated = spawnSync(process.execPath, [cli, "generate", "--config", config], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ESBK_DISABLE_CACHE: "1" },
  });
  assert.equal(generated.error, undefined, "isolated schema compiler must finish within deadline");
  assert.equal(generated.status, 0, "drizzle-kit generate failed: " + generated.stderr);
  const sqlFiles = readdirSync(output).filter((name) => name.endsWith(".sql"));
  assert.equal(sqlFiles.length, 1);
  const sql = readFileSync(path.join(output, sqlFiles[0]), "utf8");
  assert.match(sql, /CREATE TABLE `security_fixture_books`/);
  assert.match(sql, /`id` text PRIMARY KEY NOT NULL/);
  assert.match(sql, /`title` text NOT NULL/);
  assert.match(sql, /`active` integer DEFAULT false NOT NULL/);
  assert.match(sql, /CREATE INDEX `security_fixture_title_idx`/);
  console.log(
    "PASS: patched nested esbuild, real core-utils CJS/ESM transforms and isolated Drizzle SQLite generation",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
