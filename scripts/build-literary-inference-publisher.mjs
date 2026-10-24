import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
await rm("literary-publisher-dist", { recursive: true, force: true });
await mkdir("literary-publisher-dist", { recursive: true });
await build({
  entryPoints: ["src/literary-inference-publisher.worker.ts"],
  outfile: "literary-publisher-dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  alias: { jszip: "jszip/dist/jszip.min.js" },
  mainFields: ["browser", "module", "main"],
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  minify: true,
  logLevel: "info",
});
console.log("Dedicated nonpublic literary publisher built.");
