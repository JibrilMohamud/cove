import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

await rm("content-dist", { recursive: true, force: true });
await mkdir("content-dist", { recursive: true });
await build({
  entryPoints: ["src/content-processing.worker.ts"],
  outfile: "content-dist/worker.js",
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
console.log("Independent content processing Worker built in content-dist.");
