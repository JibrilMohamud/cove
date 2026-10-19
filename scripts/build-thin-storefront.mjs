import { build } from "esbuild";
import fs from "node:fs";
const result = await build({ entryPoints: ["src/storefront-thin/worker.ts"], bundle: true, platform: "node", format: "esm", target: "es2022", conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["node:*", "cloudflare:*"], outfile: ".output/thin/index.mjs", metafile: true, minify: false });
const forbidden = /(?:react-dom|@tanstack\/|\/features\/fore\/(?:App|Store|api\.server|reader|recommendations\.server)\.|supabase|epubjs)/;
const leaked = Object.entries(result.metafile.outputs).flatMap(([, output]) => Object.entries(output.inputs).filter(([file, contribution]) => contribution.bytesInOutput > 0 && forbidden.test(file)).map(([file]) => file));
if (leaked.length) throw new Error("Thin entry imported application runtime: " + leaked.join(", "));
fs.writeFileSync(".output/thin/metafile.json", JSON.stringify(result.metafile, null, 2));
console.log(`Thin storefront: ${fs.statSync(".output/thin/index.mjs").size} bytes; framework/account/reader runtime absent.`);
await build({ entryPoints: { client: "src/storefront-thin/synthetic-client.ts", gate: "src/lib/cloudflare-ssr-stage-gate.server.ts" }, bundle: true, platform: "node", format: "esm", outdir: ".output/thin", outExtension: { ".js": ".mjs" } });
// Same authenticated synthetic-client adapter surrounds both cohorts. All
// application source is unchanged; CORE still has its own staging gate.
fs.writeFileSync(".output/thin/core.mjs", `import full from '../server/index.mjs';
import { syntheticClient } from './client.mjs';
import { rejectUnauthenticatedStagingRequest } from './gate.mjs';
export default { async fetch(request,env,ctx) {
 const rejected=await rejectUnauthenticatedStagingRequest(request,env);
 if(rejected) return rejected;
 return full.fetch(syntheticClient(request,env),env,ctx);
} };\n`);
