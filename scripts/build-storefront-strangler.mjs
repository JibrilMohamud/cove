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
  platform: "node",
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
const forbidden =
  /(?:^|[/\\])(?:react-dom|@tanstack|@supabase|epubjs|jszip)(?:[/\\]|$)|[/\\]features[/\\]fore[/\\](?:App|Store|api\.server|Reader|Commerce|Publishing|recommendations\.server)\./i;
const leaked = inputs.filter((name) => forbidden.test(name));
if (leaked.length)
  throw Error("Strangler read boundary imports forbidden runtime: " + leaked.join(", "));
const bytes = fs.statSync(outfile).size;
fs.writeFileSync(".output/strangler/metafile.json", JSON.stringify(result.metafile, null, 2));
console.log(
  JSON.stringify({
    service: "strangler-storefront",
    bytes,
    sourceModules: inputs.length,
    frameworkImports: 0,
    productionRouted: false,
  }),
);

await build({
  entryPoints: ["src/storefront-strangler/producer.worker.ts"],
  outfile: ".output/strangler/producer.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});
await build({
  entryPoints: ["src/storefront-strangler/isolated-producer.worker.ts"],
  outfile: ".output/strangler/isolated-producer.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});
await build({
  entryPoints: ["src/storefront-strangler/homepage-presentation.server.ts"],
  outfile: ".output/strangler/presentation.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});
for (const lane of ["capture", "export", "export-stage", "publish", "driver"]) {
  await build({
    entryPoints: [`src/storefront-strangler/publication-${lane}.worker.ts`],
    outfile: `.output/strangler/publication-${lane}.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    conditions: ["workerd", "worker", "browser", "import", "default"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
  });
}

await build({
  entryPoints: ["src/storefront-strangler/sounds-publication.worker.ts"],
  outfile: ".output/strangler/sounds-publication.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});

await build({
  entryPoints: ["src/storefront-strangler/catalog-index-capture.worker.ts"],
  outfile: ".output/strangler/catalog-index-capture.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});

await build({
  entryPoints: ["src/storefront-strangler/catalog-index-query.worker.ts"],
  outfile: ".output/strangler/catalog-index-query.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});

await build({
  entryPoints: ["src/storefront-strangler/catalog-index-verify.worker.ts"],
  outfile: ".output/strangler/catalog-index-verify.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});

await build({
  entryPoints: ["src/storefront-strangler/catalog-normalization-publish.worker.ts"],
  outfile: ".output/strangler/catalog-normalization-publish.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});
