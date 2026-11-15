import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// No network, no D1 and no secrets; the REAL canonical TypeScript resolver
// issues unchanged queries into an in-memory SQLite fixture.
const folder = mkdtempSync(path.join(tmpdir(), "cove-real-contract-fixture-"));
const child = spawn("python3", ["-u", "scripts/staging/rights-resolver-sqlite-fixture.py"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let serial = 0;
let stderr = "";
child.stderr.on("data", (buffer) => {
  stderr += String(buffer).slice(0, 400);
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    for (const promise of pending.values()) promise.reject(new Error("Invalid fixture RPC"));
    pending.clear();
    return;
  }
  const task = pending.get(data.id);
  if (!task) return;
  pending.delete(data.id);
  if (data.ok) task.resolve(data);
  else task.reject(new Error("Fixture SQL failure: " + String(data.error || "").slice(0, 150)));
});
child.on("exit", () => {
  for (const task of pending.values()) task.reject(new Error("Isolated SQLite fixture stopped"));
  pending.clear();
});
function rpc(data) {
  if (child.exitCode !== null) return Promise.reject(new Error("Fixture process stopped"));
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, ...data }) + "\n");
  });
}
function statement(sql, values = []) {
  return {
    bind: (...v) => statement(sql, v),
    first: async () => (await rpc({ op: "query", sql, params: values })).results[0] || null,
    all: async () => ({ results: (await rpc({ op: "query", sql, params: values })).results }),
    run: async () => {
      throw new Error("Real-rights fixture is read-only");
    },
  };
}
const db = {
  prepare: (sql) => statement(sql),
  batch: async () => {
    throw new Error("Real-rights fixture is read-only");
  },
};

try {
  const outfile = path.join(folder, "rights.mjs");
  await build({
    entryPoints: ["src/features/fore/rights.server.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { resolveProductRights } = await import(pathToFileURL(outfile).href);
  assert.equal(typeof resolveProductRights, "function");
  const scenarios = [
    ["baseline", true, "ACTIVE_GRANT"],
    ["explicit-deny", false, "EXPLICIT_DENY"],
    ["version-inactive", false, "CONTRACT_VERSION_INACTIVE"],
    ["contract-inactive", false, "CONTRACT_INACTIVE"],
    ["contract-expired", false, "CONTRACT_EXPIRED"],
    ["grant-expired", false, "NO_ACTIVE_GRANT"],
    ["format-denied", false, "CONTRACT_FORMAT_DENIED"],
    ["territory-denied", false, "CONTRACT_TERRITORY_DENIED"],
    ["channel-denied", false, "CONTRACT_CHANNEL_DENIED"],
    ["drm-required", false, "CONTRACT_DRM_REQUIREMENT_UNMET"],
    ["language-denied", false, "LANGUAGE_EXPLICIT_DENY"],
    ["language-allow-mismatch", false, "LANGUAGE_RIGHTS_UNAVAILABLE"],
    ["product-disabled", false, "PRODUCT_INACTIVE"],
  ];
  for (const [scenario, allowed, reason] of scenarios) {
    await rpc({ op: "scenario", name: scenario });
    const resolved = await resolveProductRights(db, "p_fixture", "US", {
      salesChannel: "retail",
      at: "2026-11-15T15:00:00.000Z",
      persist: false,
    });
    assert.equal(resolved.allowed, allowed, "Policy branch " + scenario + " was misclassified");
    assert.equal(resolved.reasonCode, reason, "Wrong deny-first code for " + scenario);
    assert.equal(resolved.salesChannel, "retail");
    assert.equal(resolved.territory, "US");
    assert.equal(resolved.productId, "p_fixture");
  }
  console.log(
    "PASS: actual resolveProductRights SQL through isolated SQLite: active contract, explicit deny, inactive/versioned contract, territory, format, channel, DRM, languages, grant expiry and disabled product. No production parity claimed.",
  );
} finally {
  lines.close();
  child.stdin.end();
  child.kill("SIGTERM");
  rmSync(folder, { recursive: true, force: true });
}
