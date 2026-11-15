import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Stage-only executable adapter sanity. The Python SQLite fixture separately
// proves the atomic CAS writer; this test is NOT actual legal policy parity.
const sourcePath = "src/features/fore/owner-positive-retail.stage.ts";
const source = readFileSync(sourcePath, "utf8");
assert.match(source, /import \{ resolveProductRights \} from "\.\/rights\.server"/);
assert.match(source, /await resolveProductRights\(env\.DB, productId, territory,/);
assert.match(source, /salesChannel: "retail"/);
assert.match(source, /COVE_STAGE_OWNER_DB_ID !== EXPECTED_STAGE_DB/);
assert.match(source, /src\.revision=\?/);
assert.match(source, /t\.revision=\?/);
assert.match(source, /owner\.epoch=\?/);
assert.match(source, /EXISTS \(SELECT 1 FROM retail_product_availability_rows rights/);
assert.match(source, /future_offer\.starts_at/);
assert.match(source, /MAX_LEASE_MS = 30_000/);
assert.doesNotMatch(source, /\bK[Vv]\.|\.put\(|\.get\("rights/);

const folder = mkdtempSync(path.join(tmpdir(), "cove-owner-positive-stage-"));
try {
  const outfile = path.join(folder, "owner.mjs");
  await build({
    entryPoints: [sourcePath],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { stageRecomputeOwnerPositiveRetail } = await import(pathToFileURL(outfile).href);
  assert.equal(typeof stageRecomputeOwnerPositiveRetail, "function");
  const fakeDb = {
    prepare: () => ({
      bind: () => ({ first: async () => null }),
    }),
  };
  await assert.rejects(
    () => stageRecomputeOwnerPositiveRetail({ DB: fakeDb }, "perf-synth-000001", "US"),
    /Stage-only canonical owner DB binding/,
  );
  const guarded = {
    DB: fakeDb,
    COVE_STAGE_OWNER_CAS_ONLY: "1",
    COVE_STAGE_OWNER_DB_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
  };
  assert.deepEqual(
    await stageRecomputeOwnerPositiveRetail(guarded, "perf-synth-000001", "US"),
    { published: false, reason: "owner-or-source-unavailable" },
  );
  await assert.rejects(
    () => stageRecomputeOwnerPositiveRetail(guarded, "invalid/book", "US"),
    /Invalid owner projection identity/,
  );
  console.log(
    "PASS: isolated canonical TypeScript resolver adapter compiles, denies production DB bindings, refuses missing owner state and retains version-CAS guards. NOT live legal parity.",
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
