import { build } from "esbuild";
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";

if (process.env.VERCEL) {
  console.log("Vercel build detected; keeping Nitro Vercel output and skipping Sites Worker staging.");
} else {
await rm("dist",{recursive:true,force:true});
await mkdir("dist/server", { recursive: true });
await mkdir("dist/client", { recursive: true });
await build({
  stdin: {
    contents: `import app from './.output/server/index.mjs'; import {handleCoveApi,kickCatalogIngestion,runCatalogIngestion,runRecommendationMaintenance,runPublishingReleaseMaintenance} from './src/features/fore/api.server.ts'; export default {async fetch(request,env,ctx){const response=await handleCoveApi(request,env);if(response){if(new URL(request.url).pathname==='/api/fore/catalog')ctx?.waitUntil?.(kickCatalogIngestion(env));return response;}return app.fetch(request,env,ctx);},async scheduled(controller,env,ctx){ctx?.waitUntil?.(Promise.allSettled([runCatalogIngestion(env,1),runRecommendationMaintenance(env),runPublishingReleaseMaintenance(env)]).then(results=>{const labels=['Scheduled catalog ingestion failed','Scheduled recommendation maintenance failed','Scheduled publishing release maintenance failed'];for(const [i,result] of results.entries())if(result.status==='rejected')console.warn(labels[i]||'Scheduled maintenance failed',result.reason);}));}};`,
    resolveDir: process.cwd(),
    sourcefile: "fore-worker.ts",
  },
  outfile: "dist/server/index.js",
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
await cp(".output/public", "dist/client", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await cp(".openai/hosting.json", "dist/.openai/hosting.json");
await cp("drizzle", "dist/.openai/drizzle", { recursive: true });
console.log("Cove Worker, assets, and D1 migrations staged.");
}
