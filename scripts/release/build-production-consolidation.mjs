import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync(".output/production-consolidation", { recursive: true });
for (const [entry, out] of [
  ["production-consolidated-owner.worker.ts", "owner.mjs"],
  ["production-consolidated-gateway.worker.ts", "gateway.mjs"],
  ["production-biosync-ingress.worker.ts", "biosync-ingress.mjs"],
]) {
  await build({
    entryPoints: ["src/storefront-strangler/" + entry],
    outfile: ".output/production-consolidation/" + out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    alias: { jszip: "jszip/dist/jszip.min.js" },
    conditions: ["workerd", "worker", "browser", "import", "default"],
    mainFields: ["browser", "module", "main"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "warning",
  });
}
