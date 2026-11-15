import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cove-one-read-reference-"));
try {
  await build({
    entryPoints: ["src/features/fore/single-authority-probe.stage.ts"],
    outfile: path.join(directory, "stage-probe.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { handlePrivateAuthorityStageProbe, isPrivateAuthorityStageProbeAuthorized } =
    await import(path.join(directory, "stage-probe.mjs"));

  const base =
    "https://cove-presentation-r2-proof-20261114.cove-jibrilmohamud.workers.dev/api/fore/__perf/private-authority";
  const token = "a".repeat(64);
  const mockRow = (i) => ({
    product_id: "perf-synth-" + i,
    edition_id: "stage-edition-" + i,
    work_id: "stage-work-" + i,
    product_public_id: "stage-book-" + i,
    edition_public_id: "stage-edition-" + i,
    title: "Synthetic test book " + i,
    source_name: "gutenberg",
    source_external_id: String(i),
    release_status: "available",
    drm_status: "none",
    downloadable: 0,
  });
  let rows = Array.from({ length: 25 }, (_, i) => mockRow(i));
  let sql = "";
  let sqlCalls = 0;
  const db = {
    prepare(statement) {
      sql = statement;
      sqlCalls++;
      return {
        bind(...binds) {
          assert.deepEqual(binds, ["available", "US", "USD", 25]);
          return {
            all: async () => ({ results: rows }),
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    FORE_GUEST_COMPACT_STAGE: "1",
    FORE_GUEST_COMPACT_SYNTHETIC_D1_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    FORE_BACKEND_TOKEN: token,
    COVE_PUBLIC_PRESENTATION_CACHE: {},
  };
  const req = (url = base, headers = {}) =>
    new Request(url, {
      headers: { "x-cove-backend-token": token, "x-cove-client-country": "US", ...headers },
    });
  assert.equal(isPrivateAuthorityStageProbeAuthorized(req(), env), true);
  const response = await handlePrivateAuthorityStageProbe(req(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-cove-persistence"), "d1-only-synthetic");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(sqlCalls, 1, "Full-shape current rights must use only one D1 operation");
  assert.match(sql, /FROM eligible selected CROSS JOIN products p/);
  assert.match(sql, /FROM offers o WHERE o.product_id=p.id/);
  assert.match(sql, /retail_product_availability_rows/);
  assert.match(sql, /LIMIT 96/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|REPLACE)\s+(?:INTO|FROM|[A-Za-z])/i);
  const data = await response.json();
  assert.equal(data.results.length, 24);
  assert.deepEqual(
    data.results.map((r) => r.productId),
    Array.from({ length: 24 }, (_, i) => "perf-synth-" + i),
  );
  assert.equal(data.releaseCertified, false);

  const denied = [
    [req("https://covereads.com/api/fore/__perf/private-authority"), env],
    [req("https://ssr-canary.covereads.com/api/fore/__perf/private-authority"), env],
    [req(base, { cookie: "session=private" }), env],
    [req(base, { authorization: "Bearer private" }), env],
    [req(base, { "x-fore-authenticated-user-id": "private-user" }), env],
    [req(base, { "x-cove-client-country": "GB" }), env],
    [req(base, { "x-cove-backend-token": "b".repeat(64) }), env],
    [req(), { ...env, FORE_GUEST_COMPACT_STAGE: "0" }],
    [req(), { ...env, FORE_GUEST_COMPACT_SYNTHETIC_D1_ID: "production" }],
    [req(), { ...env, COVE_PUBLIC_PRESENTATION_CACHE: null }],
    [req(), { ...env, DB: null }],
  ];
  for (const [request, settings] of denied) {
    assert.equal(isPrivateAuthorityStageProbeAuthorized(request, settings), false);
    assert.equal((await handlePrivateAuthorityStageProbe(request, settings)).status, 404);
  }
  assert.equal(sqlCalls, 1, "Invalid host, identity, fixture, flags and secret cannot reach D1");
  assert.equal(
    await handlePrivateAuthorityStageProbe(
      req("https://covereads.com/api/fore/catalog"),
      env,
    ),
    null,
    "Existing public storefront must never use the diagnostic route",
  );

  rows = rows.slice(0, 24);
  const withdrawn = await handlePrivateAuthorityStageProbe(req(), env);
  assert.equal(withdrawn.status, 503, "A missing 25th rights witness must fail closed");
  assert.equal(await withdrawn.text(), "", "Fail closed without disclosing book IDs");
  const outage = {
    ...env,
    DB: { prepare() { throw Error("secret SQL credential must never be exposed"); } },
  };
  const rejected = await handlePrivateAuthorityStageProbe(req(), outage);
  assert.equal(rejected.status, 503);
  assert.equal(await rejected.text(), "");

  const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
  assert.match(api, /const privateAuthorityProbe = await handlePrivateAuthorityStageProbe\(request, env\)/);
  assert.ok(
    api.indexOf("const privateAuthorityProbe = await handlePrivateAuthorityStageProbe") <
      api.indexOf("const trace = beginRequestTrace(request)"),
    "Stage-only D1 control must not include legacy audit or auth",
  );
  for (const config of [
    "wrangler.backend.production.toml",
    "wrangler.backend.presentation-stage.toml",
  ]) {
    const contents = fs.readFileSync(config, "utf8");
    assert.doesNotMatch(contents, /FORE_GUEST_COMPACT_STAGE|__perf\/private-authority/);
  }
  console.log("PASS: isolated one-D1 full catalog reference, fresh retail-rights 25th witness, no production exposure, and zero authorization leakage");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
