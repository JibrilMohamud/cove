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
const graph = new Map();
function imports(file) {
  if (graph.has(file)) return graph.get(file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const links = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
    links.push({ file: path.resolve(path.dirname(file), specifier.text), dynamic: false });
  }
  function dynamicImports(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith("."))
        links.push({ file: path.resolve(path.dirname(file), specifier.text), dynamic: true });
    }
    ts.forEachChild(node, dynamicImports);
  }
  dynamicImports(source);
  graph.set(file, links);
  return links;
}
function closure(file, dynamic = false, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const link of imports(file)) if (dynamic || !link.dynamic) closure(link.file, dynamic, seen);
  return seen;
}
const entry = path.resolve(".output/server/_ssr/ssr.mjs");
const eager = closure(entry);
const deployedGraph = closure(workerFile, true);
const leanEntries = [...closure(entry, true)].filter((file) =>
  path.basename(file).startsWith("storefront-anonymous-bootstrap.server-"),
);
assert.equal(leanEntries.length, 1, "Must locate the reachable anonymous bootstrap artifact");
const lean = closure(leanEntries[0]);
for (const files of [eager, lean])
  for (const file of files)
    assert.doesNotMatch(
      path.basename(file),
      /epubjs|jszip|xmldom|supabase/i,
      "Entry and anonymous bootstrap must not eagerly load reader or account dependencies",
    );
console.log(
  JSON.stringify({
    pilot: "build-only",
    workerBytes: fs.statSync(workerFile).size,
    staticAssetsPresent: true,
    publicRoutesEnabled: false,
    eagerEntryModules: eager.size,
    eagerEntryBytes: [...eager].reduce((sum, file) => sum + fs.statSync(file).size, 0),
    anonymousBootstrapBytes: [...lean].reduce((sum, file) => sum + fs.statSync(file).size, 0),
    reachableWorkerBytes: [...deployedGraph].reduce((sum, file) => sum + fs.statSync(file).size, 0),
  }),
);
