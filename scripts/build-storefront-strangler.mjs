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

// Legal authority remains isolated QA-only. This compiles disabled private
// Workers, not a route or a production rights-owner binding.
for (const lane of [
  ["legal-authority.worker.ts", "legal-authority.mjs"],
  ["legal-quarantine-qa.writer.ts", "legal-quarantine-qa-writer.mjs"],
]) {
  await build({
    entryPoints: [`src/storefront-strangler/${lane[0]}`],
    alias: { jszip: "jszip/dist/jszip.min.js" },
    outfile: `.output/strangler/${lane[1]}`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    conditions: ["workerd", "worker", "browser", "import", "default"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
  });
}

// Compile only as a separate short-lived private-QA service. This Worker is
// absent from production routing and has no default public hostname.
await build({
  entryPoints: ["src/storefront-strangler/legal-authority-qa-caller.worker.ts"],
  outfile: ".output/strangler/legal-authority-qa-caller.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});

// Build the isolated signed-Stripe TEST customer probe separately. No
// production route, Worker binding or billing credential is affected.
await build({
  entryPoints: ["src/storefront-strangler/paid-settlement-stage-qa.worker.ts"],
  outfile: ".output/strangler/paid-settlement-stage-qa.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["node:*", "cloudflare:*"],
  logLevel: "silent",
});
