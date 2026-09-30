import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

await rm("backend-dist", { recursive: true, force: true });
await mkdir("backend-dist", { recursive: true });

await build({
  entryPoints: ["src/persistence-backend.worker.ts"],
  outfile: "backend-dist/worker.js",
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

await cp("drizzle", "backend-dist/migrations", { recursive: true });
await writeFile(
  "backend-dist/README.txt",
  [
    "Cove persistence backend",
    "",
    "worker.js owns the D1/R2-backed Cove API behind the Vercel gateway.",
    "migrations/ contains the ordered SQLite/D1 schema.",
    "Set FORE_BACKEND_TOKEN as a secret on both Vercel and this Worker.",
    "",
  ].join("\n"),
);
console.log("Cove D1/R2 persistence backend staged in backend-dist/.");
