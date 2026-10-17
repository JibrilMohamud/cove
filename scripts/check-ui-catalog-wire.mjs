import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cove-ui-wire-"));
try {
  const client = await build({
    entryPoints: ["src/features/fore/ui-catalog.ts"],
    outfile: path.join(root, "client.mjs"),
    bundle: true,
    platform: "browser",
    format: "esm",
    metafile: true,
    logLevel: "silent",
  });
  assert.ok(
    !Object.keys(client.metafile.inputs).some((name) => name.includes("/locales/")),
    "client formatter must not ship other readers' languages",
  );
  await build({
    entryPoints: ["src/features/fore/ui-catalog.server.ts"],
    outfile: path.join(root, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { translateUi } = await import(path.join(root, "client.mjs"));
  const { selectedUiCatalog } = await import(path.join(root, "server.mjs"));
  const sizes = {};
  for (const locale of ["en-US", "es-ES", "fr-FR", "de-DE", "ar-SA"]) {
    const source = JSON.parse(
      await fs.readFile(`src/features/fore/locales/${locale}.json`, "utf8"),
    );
    const selected = selectedUiCatalog(locale);
    for (const [key, message] of Object.entries(source))
      assert.equal(translateUi(selected, key), message, `${locale}: ${key}`);
    assert.equal(
      translateUi(selected, "Uncatalogued {label}", { label: "<reader>" }),
      "Uncatalogued <reader>",
    );
    sizes[locale] = Buffer.byteLength(JSON.stringify(selected));
  }
  assert.deepEqual(selectedUiCatalog("unknown"), selectedUiCatalog("en-US"));
  console.log(
    "PASS: every translated phrase survives server selection, unknown-locale fallback and substitutions; no language catalog in client formatter. Selected wire bytes: " +
      JSON.stringify(sizes),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
