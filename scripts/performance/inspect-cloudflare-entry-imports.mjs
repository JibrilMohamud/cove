// Inspect the built, unminified Cloudflare Worker before any staging deploy.
// Distinguish JS modules that the entry MUST import from dynamic route/API
// modules; built bytes are not proof of first-request CPU initialization.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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
  detail.push({ file: relative, bytes: Buffer.byteLength(content), staticImports: 0, dynamicImports: 0 });
  const current = detail.at(-1);
  // Built Nitro modules use normal static import and re-export syntax.
  const staticPatterns = [
    /(?:^|[\n;])\s*import\s*(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/gm,
    /(?:^|[\n;])\s*export\s*[^;\n]*?\sfrom\s*["']([^"']+)["']/gm,
  ];
  const staticPaths = new Set();
  for (const pattern of staticPatterns) {
    for (const match of content.matchAll(pattern)) staticPaths.add(match[1]);
  }
  for (const match of content.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    current.dynamicImports++;
  }
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
const staticBytes = detail.reduce((n, d) => n + d.bytes, 0);
const allBytes = allFiles.reduce((n, file) => n + fs.statSync(file).size, 0);
const report = {
  entry: "index.mjs",
  checkedAt: new Date().toISOString(),
  boundary: "Static ESM import graph only; dynamic modules may be needed for homepage SSR. Total bytes are not initialization CPU time.",
  entryBytes: fs.statSync(entry).size,
  entryClosureBytes: staticBytes,
  entryClosureModules: detail.length,
  allServerJsBytes: allBytes,
  allServerModules: allFiles.length,
  closureShare: Number((staticBytes / allBytes).toFixed(3)),
  staticImportsUnresolved: errors,
  externalBuiltins: [...external].sort(),
  heaviestStaticModules: detail.sort((a, b) => b.bytes - a.bytes).slice(0, 25),
};
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/cloudflare-entry-import-graph.json", JSON.stringify(report, null, 2));
process.stdout.write("COVE_COLD_IMPORT_GRAPH " + JSON.stringify(report) + "\n");
if (errors.length) process.exitCode = 1;
