import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = readFileSync("src/storefront-strangler/publication-owner-routing.server.ts", "utf8");
const server = readFileSync("src/server.ts", "utf8");

// Public homepage SSR never needs to evaluate the 28KB command route and
// validation registry, or the staging-only legal writer lock.
assert.doesNotMatch(source, /import\s*\{\s*dispatchCanonicalOwnerCommand\s*\}\s*from/);
assert.match(source, /await import\("\.\/canonical-owner-command-gateway"\)/);
assert.doesNotMatch(server, /import\s*\{\s*scopeStageLegalWriterEnv\s*\}\s*from/);
assert.match(
  server,
  /COVE_CANONICAL_LEGAL_WRITE_LOCK === "1"[\s\S]{0,130}await import\("\.\/storefront-strangler\/legal-primary-write-lock"\)/,
);

const dir = mkdtempSync(join(tmpdir(), "cove-cold-ssr-owner-"));
try {
  const compiled = await build({
    entryPoints: ["src/storefront-strangler/publication-owner-routing.server.ts"],
    outdir: dir,
    entryNames: "routing",
    chunkNames: "private-[hash]",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    metafile: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const outputs = Object.values(compiled.metafile.outputs);
  const entry = outputs.find((output) =>
    output.entryPoint?.endsWith("publication-owner-routing.server.ts"),
  );
  assert.ok(entry, "Bundler must produce the public-request owner facade");
  const gateway = "src/storefront-strangler/canonical-owner-command-gateway.ts";
  assert.ok(
    !Object.keys(entry.inputs).some((input) => input.endsWith(gateway)),
    "Private command schemas must not be evaluated in a cold public SSR entry",
  );
  assert.ok(
    outputs.some((output) => Object.keys(output.inputs).some((input) => input.endsWith(gateway))),
    "The full private command validator must remain available in a deferred chunk",
  );

  const routing = await import(pathToFileURL(join(dir, "routing.mjs")).href);
  const publicEnv = { COVE_PUBLICATION_COMMANDS_ENABLED: "0", DB: {} };
  assert.equal(routing.scopePublicationOwnerEnv(publicEnv), publicEnv);
  assert.throws(
    () =>
      routing.scopePublicationOwnerEnv({
        ...publicEnv,
        COVE_PUBLICATION_COMMANDS_ENABLED: "1",
        COVE_SSR_STAGING: "0",
      }),
    /publication_owner_cutover_not_certified/,
    "Deferring imports cannot allow production owner activation",
  );
  await assert.rejects(
    routing.dispatchPublicationRecovery({}),
    /Publication owner is not configured/,
    "Unbound private callers must still fail closed",
  );
  console.log(
    "PASS: cold SSR excludes private schemas; owner activation and dispatch remain fenced",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
