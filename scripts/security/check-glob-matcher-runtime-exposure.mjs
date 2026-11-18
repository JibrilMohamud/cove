import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SOURCES = ["src", "app", "server"];
const EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const FORBIDDEN = ["picomatch", "tinyglobby", "unplugin"];
const isGlobModule = (value) =>
  typeof value === "string" &&
  FORBIDDEN.some((name) => value === name || value.startsWith(name + "/"));

function scanSource(source, filename) {
  const scriptKind = /\.tsx$/i.test(filename)
    ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(filename)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/i.test(filename)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  assert.equal(file.parseDiagnostics.length, 0, "Unparseable customer-serving source: " + filename);
  const findings = [];
  const collect = (specifier, node) => {
    if (isGlobModule(specifier))
      findings.push({
        file: filename,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        module: specifier,
      });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      collect(node.moduleSpecifier.text, node);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    )
      collect(node.moduleReference.expression.text, node);
    if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      collect(node.arguments[0].text, node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".output" || entry.name === "dist")
      continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(filename);
    else if (entry.isFile() && EXTENSIONS.test(entry.name) && !/\.d\.ts$/i.test(entry.name))
      yield filename;
  }
}

// Negative tests: direct, re-export, dynamic and require imports must all be
// rejected; a lookalike package and ordinary app import must not be rejected.
for (const snippet of [
  'import pm from "picomatch";',
  'export { default } from "picomatch/lib/picomatch";',
  'const g = await import("tinyglobby");',
  'const g = require("unplugin");',
  'import g = require("picomatch");',
]) 
  assert.equal(scanSource(snippet, "src/example.ts").length, 1, snippet);
for (const snippet of [
  'import x from "picomatch-other";',
  'const x = await import("@/lib/public-seo-document-path");',
  'const s = "require(\\"picomatch\\")";',
]) 
  assert.equal(scanSource(snippet, "src/example.ts").length, 0, snippet);

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const packages = lock.packages || {};
const installed = Object.entries(packages)
  .filter(([k]) => /(?:^|\/)node_modules\/picomatch$/.test(k))
  .map(([location, details]) => ({ location, version: details.version || "unknown" }));
const consumers = Object.entries(packages)
  .filter(([, entry]) => Boolean(entry.dependencies?.picomatch))
  .map(([location, entry]) => ({ location, requested: entry.dependencies.picomatch }))
  .sort((a, b) => a.location.localeCompare(b.location));
const violations = [];
let files = 0;
for (const root of SOURCES) {
  for (const filename of walk(root)) {
    files++;
    violations.push(...scanSource(readFileSync(filename, "utf8"), filename));
  }
}
assert.equal(
  violations.length,
  0,
  "Glob parser directly imported by customer-serving source: " + JSON.stringify(violations),
);
assert.ok(files > 0, "No customer-serving code was examined");
console.log(
  JSON.stringify({
    result: "source-only direct-import exposure check passed",
    scannedSourceFiles: files,
    installedPicomatch: installed,
    dependencyConsumers: consumers,
    customerServingDirectGlobImports: violations.length,
  }),
);
console.log(
  "NOT CERTIFIED: indirect runtime reachability, untrusted dependency configuration, ReDoS resistance or supply-chain safety.",
);
