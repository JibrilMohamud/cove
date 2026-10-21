import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

// No production frontend, persistence backend, or routes are modified.
// Avoid pulling the entire TanStack/React/account/reader runtime into the
// dedicated anonymous read worker. Fail build on a dependency regression.
const outfile = ".output/strangler/index.mjs";
fs.mkdirSync(path.dirname(outfile), { recursive: true });
const result = await build({
  entryPoints: ["src/storefront-strangler/worker.ts"],
  outfile,
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  mainFields: ["browser", "module", "main"],
  external: ["node:*", "cloudflare:*"],
  metafile: true,
  logLevel: "silent",
});
const inputs = Object.entries(result.metafile.outputs).flatMap(([, output]) =>
  Object.entries(output.inputs)
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([name]) => name),
);
const forbidden = /(?:^|[/\\])(?:react-dom|@tanstack|@supabase|epubjs|jszip)(?:[/\\]|$)|[/\\]features[/\\]fore[/\\](?:App|Store|api\.server|Reader|Commerce|Publishing|recommendations\.server)\./i;
const leaked = inputs.filter((name) => forbidden.test(name));
if (leaked.length) throw Error("Strangler read boundary imports forbidden runtime: " + leaked.join(", "));
const bytes = fs.statSync(outfile).size;
fs.writeFileSync(".output/strangler/metafile.json", JSON.stringify(result.metafile, null, 2));
console.log(JSON.stringify({service:"strangler-storefront",bytes,sourceModules:inputs.length,frameworkImports:0,productionRouted:false}));
