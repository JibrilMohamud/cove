import assert from "node:assert/strict";
import { test } from "node:test";
import {
  transferVersion,
  codeModule,
  assertOriginalModules,
} from "./production-owner-secret-transfer.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const version = {
  id,
  main_module: "worker.js",
  modules: [codeModule("worker.js", "export default {fetch(){return new Response('original')}}")],
  bindings: [
    { name: "DB", type: "d1", id: "original" },
    { name: "SECRET", type: "secret_text" },
  ],
  compatibility_date: "2026-09-01",
  limits: { cpu_ms: 300000 },
  env: { SECRET: { type: "secret_text" } },
};
test("pin every original binding to its exact active version, never a newer archived version", () => {
  const extra = { name: "COVE_TRANSFER_NONCE", type: "secret_text", text: "test-only" };
  const result = transferVersion(
    version,
    "transfer.mjs",
    [extra],
    [codeModule("transfer.mjs", "export * from './worker.js'")],
  );
  assert.deepEqual(
    result.bindings.slice(0, 2),
    version.bindings.map((b) => ({ name: b.name, type: "inherit", version_id: id })),
  );
  assert.equal(result.modules[0], version.modules[0]);
  assert.equal(result.limits, version.limits);
  assert.equal(result.env, undefined);
  assert.equal(result.id, undefined);
  assertOriginalModules(version, result, "transfer.mjs");
  assert.throws(() => transferVersion({ ...version, id: "latest" }, "worker.js"), /exact_version/);
  assert.throws(() => transferVersion(version, "worker.js", [{ name: "DB" }]), /duplicate/);
  assert.throws(() => transferVersion(version, "missing.js"), /modules/);
  assert.throws(
    () =>
      assertOriginalModules(
        version,
        { ...result, modules: [codeModule("worker.js", "changed")] },
        "transfer.mjs",
      ),
    /module_drift/,
  );
});
