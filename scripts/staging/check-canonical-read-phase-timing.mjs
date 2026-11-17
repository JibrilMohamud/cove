import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, transform } from "esbuild";

const metric = await transform(readFileSync("src/lib/readonly-transport-metric.ts", "utf8"), {
  loader: "ts",
  format: "esm",
});
const { boundedReadonlyPhaseMs, verifiedReadonlyPhaseMs } = await import(
  "data:text/javascript;base64," + Buffer.from(metric.code).toString("base64")
);
assert.equal(boundedReadonlyPhaseMs(10, 10.55), 0.6);
assert.equal(boundedReadonlyPhaseMs(10, 12010), 12000);
for (const [from, to] of [
  [20, 10],
  [10, 12011],
  [NaN, 40],
]) {
  assert.equal(boundedReadonlyPhaseMs(from, to), undefined);
}
assert.equal(verifiedReadonlyPhaseMs(3.1), 3.1);
for (const value of ["3.1", -1, NaN, Infinity, 12001, null]) {
  assert.equal(verifiedReadonlyPhaseMs(value), undefined);
}

const worker = readFileSync("infra/canonical-readonly/worker.ts", "utf8");
const bootstrap = readFileSync(
  "src/features/fore/storefront-anonymous-bootstrap.server.ts",
  "utf8",
);
const catalog = readFileSync("src/features/fore/catalog-model.server.ts", "utf8");
const sanitizer = readFileSync("src/features/fore/storefront-hedged-fetch.ts", "utf8");
for (const name of ["cove_read_headers_ms", "cove_read_body_ms", "cove_read_decode_ms"]) {
  assert.ok(worker.includes(name + ": boundedReadonlyPhaseMs("));
  assert.ok(catalog.includes("verifiedReadonlyPhaseMs(meta?." + name + ")"));
}
assert.ok(worker.includes("r.meta?.served_by_primary !== true"));
assert.ok(worker.includes("meta: { ...row.meta, ...phases }"));
assert.ok(bootstrap.includes('if (env.COVE_SSR_STAGING === "1")'));
assert.ok(catalog.includes("verifiedReadonlyPhaseMs(meta?.cove_rpc_wall_ms)"));
for (const name of [
  "catalog_rpc",
  "catalog_rest_headers",
  "catalog_rest_body",
  "catalog_rest_decode",
]) {
  assert.ok(bootstrap.includes(name + ": d1Metrics."));
  assert.ok(sanitizer.includes('"' + name + '"'));
}
assert.ok(bootstrap.includes("Number.isFinite(ms) && ms >= 0 && ms <= 12_000"));

const root = mkdtempSync(path.join(tmpdir(), "cove-stage-read-phase-"));
try {
  // The actual Cloudflare RPC service must still bundle after adding the
  // shared pure timing module; the platform import remains external to esbuild.
  await build({
    entryPoints: ["infra/canonical-readonly/worker.ts"],
    bundle: true,
    platform: "neutral",
    format: "esm",
    external: ["cloudflare:workers"],
    outfile: path.join(root, "worker.mjs"),
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/lib/canonical-readonly-d1.server.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(root, "client.mjs"),
    logLevel: "silent",
  });
  const { canonicalReadonlyD1 } = await import(pathToFileURL(path.join(root, "client.mjs")).href);
  const calls = [];
  const db = canonicalReadonlyD1({
    async query(queries) {
      calls.push(queries);
      return queries.map(() => ({
        success: true,
        results: [{ value: 1 }],
        meta: {
          served_by_primary: true,
          timings: { sql_duration_ms: 2.5 },
          cove_read_headers_ms: 8.2,
          cove_read_body_ms: 3.1,
          cove_read_decode_ms: 0.6,
        },
      }));
    },
  });
  const first = await db.prepare("SELECT ?").bind(1).all();
  assert.equal(first.results[0].value, 1);
  assert.equal(first.meta.served_by_primary, true);
  assert.equal(first.meta.cove_read_headers_ms, 8.2);
  assert.ok(first.meta.cove_rpc_wall_ms >= 0 && first.meta.cove_rpc_wall_ms <= 12000);
  const rows = await db.batch([db.prepare("SELECT ?").bind(1), db.prepare("SELECT ?").bind(2)]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    calls[1].map((item) => item.params),
    [[1], [2]],
  );
  await assert.rejects(db.prepare("DELETE FROM rights").run(), /read-only/);
  const incomplete = canonicalReadonlyD1({ query: async () => [] });
  await assert.rejects(incomplete.prepare("SELECT 1").all(), /Incomplete canonical read/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(
  "PASS: staging RPC/REST phases are numeric, bounded, tied to verified reads and never authorize writes",
);
