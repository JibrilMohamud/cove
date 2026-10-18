import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const workerFile = path.resolve(".output/server/index.mjs");
const assets = path.resolve(".output/public");
const config = fs.readFileSync("wrangler.frontend.pilot.toml", "utf8");
assert.match(config, /^main\s*=\s*"\.output\/server\/index\.mjs"$/m);
assert.match(config, /^workers_dev\s*=\s*false$/m);
assert.doesNotMatch(config, /^route(?:s)?\s*=/m);
assert.match(config, /^binding\s*=\s*"DB"$/m);
assert.match(config, /^binding\s*=\s*"BUCKET"$/m);
assert.ok(fs.existsSync(workerFile), "Cloudflare module server entry must exist");
assert.ok(fs.statSync(workerFile).size > 0, "Cloudflare module must not be empty");
assert.ok(fs.existsSync(assets) && fs.statSync(assets).isDirectory(), "SSR public assets required");
// Inspect the actual generated graph: a harmless global polyfill can merge
// with a reader chunk and silently make it eager before cove_total begins.
const eager = new Set();
function visit(file) {
  if (eager.has(file)) return;
  eager.add(file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
    visit(path.resolve(path.dirname(file), specifier.text));
  }
}
visit(path.resolve(".output/server/_ssr/ssr.mjs"));
for (const file of eager)
  assert.doesNotMatch(
    path.basename(file),
    /epubjs|jszip|xmldom|supabase/i,
    "Worker entry must not eagerly load reader or account dependencies before request timing",
  );
console.log(
  JSON.stringify({
    pilot: "build-only",
    workerBytes: fs.statSync(workerFile).size,
    staticAssetsPresent: true,
    publicRoutesEnabled: false,
    eagerEntryModules: eager.size,
    eagerEntryBytes: [...eager].reduce((sum, file) => sum + fs.statSync(file).size, 0),
  }),
);
