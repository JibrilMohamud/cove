import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = mkdtempSync(join(tmpdir(), "cove-facet-count-"));
try {
  const output = join(root, "facet.mjs");
  await build({
    entryPoints: ["src/features/fore/count-from-availability-facet.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    logLevel: "silent",
  });
  const { countAvailableCandidatesFromFacet: exact } = await import(pathToFileURL(output).href);
  const available = { query: "", availability: "available" };
  const values = (availability) => ({ availability });
  assert.equal(exact(available, false, values([{ value: "available", count: 42 }])), 42);
  assert.equal(exact(available, false, values([])), 0);
  for (const bad of [
    [available, true, values([{ value: "available", count: 4 }])],
    [{ query: "book", availability: "available" }, false, values([])],
    [{ query: "", availability: "preorder" }, false, values([])],
    [available, false, values([{ value: "available", count: -1 }])],
    [available, false, values([{ value: "available", count: 2.5 }])],
    [available, false, values([{ value: "available", count: Infinity }])],
    [available, false, values([{ value: "preorder", count: 1 }])],
    [
      available,
      false,
      values([
        { value: "available", count: 20 },
        { value: "preorder", count: 3 },
      ]),
    ],
    [available, false, { availability: null }],
  ])
    assert.equal(exact(...bad), null, "Unproven total must use the original live COUNT");
  const source = readFileSync("src/features/fore/search.server.ts", "utf8");
  assert.match(source, /sharedFacetCount \? d1Facets|sharedFacetCount\s*\?\s*d1Facets/);
  assert.match(source, /exact === null \? await runCount\(\) : \{ count: exact \}/);
  assert.match(source, /sharedFacets \|\| d1Facets/);
  assert.match(
    source,
    /\$\{baseCte\} SELECT availability value,COUNT\(\*\) count FROM candidate GROUP BY availability/,
  );
  console.log(
    "PASS: exact rights-scoped first-page facet count reuses one aggregate and all uncertain scopes retain the live count",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
