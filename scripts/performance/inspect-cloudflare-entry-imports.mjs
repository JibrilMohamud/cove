// Inspect the built, unminified Cloudflare Worker before any staging deploy.
// Distinguish JS modules that the entry MUST import from dynamic route/API
// modules; built bytes are not proof of first-request CPU initialization.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(".output/server");
const entry = path.join(root, "index.mjs");
assert.ok(fs.existsSync(entry), "Build the SSR bundle before auditing it");
const allFiles = [];
const scan = (dir) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) scan(file);
    else if (item.name.endsWith(".mjs")) allFiles.push(file);
  }
};
scan(root);
const seen = new Set();
const detail = [];
const errors = [];
const external = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const content = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file);
  detail.push({
    file: relative,
    bytes: Buffer.byteLength(content),
    staticImports: 0,
    dynamicImports: 0,
  });
  const current = detail.at(-1);
  // Reuse the project's compiler parser: transformed bundles may remove all
  // whitespace between import bindings and "from", defeating text regex.
  const staticPaths = new Set();
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  for (const statement of ast.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      staticPaths.add(statement.moduleSpecifier.text);
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      current.dynamicImports++;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const target of staticPaths) {
    current.staticImports++;
    if (!target.startsWith(".")) {
      external.add(target);
      continue;
    }
    const imported = path.resolve(path.dirname(file), target);
    if (!imported.startsWith(root + path.sep) || !fs.existsSync(imported)) {
      errors.push({ importer: relative, target });
      continue;
    }
    walk(imported);
  }
}
walk(entry);

// For the actual first request, the Nitro/TanStack server entry is imported
// dynamically. Report each entry-triggered dynamic graph separately from the
// warm Worker bootstrap, without assuming all route bundles load.
const dynamicEntrypoints = [];
const scanStaticClosure = (initial) => {
  const modules = new Set();
  const visitStatic = (file) => {
    if (modules.has(file)) return;
    modules.add(file);
    const ast = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.JS,
    );
    for (const statement of ast.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith(".")
      ) {
        const target = path.resolve(path.dirname(file), statement.moduleSpecifier.text);
        if (target.startsWith(root + path.sep) && fs.existsSync(target)) visitStatic(target);
      }
    }
  };
  visitStatic(initial);
  const nestedDynamic = new Set();
  for (const file of modules) {
    const ast = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.JS,
    );
    const inspect = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument) && argument.text.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), argument.text);
          if (resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
            nestedDynamic.add(path.relative(root, resolved));
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  }
  const bySize = [...modules]
    .map((file) => ({ file: path.relative(root, file), bytes: fs.statSync(file).size }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    modules: modules.size,
    bytes: bySize.reduce((n, item) => n + item.bytes, 0),
    heaviest: bySize.slice(0, 12),
    nestedDynamic: [...nestedDynamic].sort(),
  };
};
for (const file of seen) {
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const inspect = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument) && argument.text.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), argument.text);
        if (resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
          dynamicEntrypoints.push({
            importer: path.relative(root, file),
            imported: path.relative(root, resolved),
            staticClosure: scanStaticClosure(resolved),
          });
        }
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(ast);
}
// Two additional import levels reveal the route initialization dependencies.
// These are *potential* load targets, not claims about runtime evaluation.
const secondLevel = [];
for (const entrypoint of dynamicEntrypoints) {
  for (const imported of entrypoint.staticClosure.nestedDynamic) {
    const closure = scanStaticClosure(path.join(root, imported));
    secondLevel.push({ importedFrom: entrypoint.imported, imported, staticClosure: closure });
  }
}
const thirdLevel = [];
for (const parent of secondLevel) {
  for (const imported of parent.staticClosure.nestedDynamic) {
    const closure = scanStaticClosure(path.join(root, imported));
    thirdLevel.push({ importedFrom: parent.imported, imported, staticClosure: closure });
  }
}
// Preserve the strict startup budget but record its exact module graph
// BEFORE asserting; otherwise a failure destroys the evidence needed to
// distinguish an auth SDK import from ordinary TanStack or bundler changes.
const auditedStart = thirdLevel.find((item) => item.imported.startsWith("_ssr/start-"));
const coldAuthBudget = {
  enforced: process.env.COVE_ENFORCE_CLIENT_AUTH_SPLIT === "1",
  startFound: Boolean(auditedStart),
  staticClosureBytes: auditedStart?.staticClosure.bytes ?? null,
  maxExclusiveBytes: 150_000,
  heaviestStaticModules: auditedStart?.staticClosure.heaviest.slice(0, 12) ?? [],
};
const staticBytes = detail.reduce((n, d) => n + d.bytes, 0);
const allBytes = allFiles.reduce((n, file) => n + fs.statSync(file).size, 0);
const report = {
  entry: "index.mjs",
  checkedAt: new Date().toISOString(),
  boundary:
    "Static ESM import graph only; dynamic modules may be needed for homepage SSR. Total bytes are not initialization CPU time.",
  entryBytes: fs.statSync(entry).size,
  entryClosureBytes: staticBytes,
  entryClosureModules: detail.length,
  allServerJsBytes: allBytes,
  allServerModules: allFiles.length,
  closureShare: Number((staticBytes / allBytes).toFixed(3)),
  staticImportsUnresolved: errors,
  externalBuiltins: [...external].sort(),
  heaviestStaticModules: detail.sort((a, b) => b.bytes - a.bytes).slice(0, 25),
  dynamicEntrypoints,
  secondLevel,
  thirdLevel,
  coldAuthBudget,
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/cloudflare-entry-import-graph.json", JSON.stringify(report, null, 2));
process.stdout.write("COVE_COLD_IMPORT_GRAPH " + JSON.stringify(report) + "\n");
if (errors.length) process.exitCode = 1;

if (coldAuthBudget.enforced) {
  assert.ok(coldAuthBudget.startFound, "Cannot verify the built SSR Start module");
  assert.ok(
    coldAuthBudget.staticClosureBytes < coldAuthBudget.maxExclusiveBytes,
    "SSR Start static closure exceeds the auth-boundary budget; see coldAuthBudget evidence",
  );
}
