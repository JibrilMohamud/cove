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
// The ONLY writes allowed are to the ephemeral, private test authority
// projection. Rights, offers, contracts and products stay read-only here.
function ownerStatement(sql, values = []) {
  return {
    bind: (...v) => ownerStatement(sql, v),
    first: async () => (await rpc({ op: "query", sql, params: values })).results[0] || null,
    all: async () => ({ results: (await rpc({ op: "query", sql, params: values })).results }),
    run: async () => {
      const response = await rpc({ op: "stage_owner_write", sql, params: values });
      return response;
    },
  };
}
const ownerDb = {
  prepare: (sql) => ownerStatement(sql),
  batch: async () => {
    throw new Error("Owner fixture forbids D1 batches");
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
  const ownerOutfile = path.join(folder, "owner.mjs");
  await build({
    entryPoints: ["src/features/fore/owner-positive-retail.stage.ts"],
    outfile: ownerOutfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { stageRecomputeOwnerPositiveRetail } = await import(pathToFileURL(ownerOutfile).href);
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
    ["future-explicit-deny", true, "ACTIVE_GRANT"],
    ["contract-expiry-soon", true, "ACTIVE_GRANT"],
    ["future-competitive-offer", true, "ACTIVE_GRANT"],
    ["invalid-legal-time", true, "ACTIVE_GRANT"],
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
    const writer = await stageRecomputeOwnerPositiveRetail(
      {
        DB: ownerDb,
        COVE_STAGE_OWNER_CAS_ONLY: "1",
        COVE_STAGE_OWNER_DB_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
      },
      "p_fixture",
      "US",
      "USD",
    );
    const publicationExpected = allowed && scenario !== "invalid-legal-time";
    assert.equal(
      writer.published,
      publicationExpected,
      "Owner writer must respect canonical denial and malformed-time fail-closed: " + scenario,
    );
    const row = await db
      .prepare(
        "SELECT product_id,amount_minor,current_offer_id,valid_until FROM cove_stage_owner_retail_authority WHERE product_id=?",
      )
      .bind("p_fixture")
      .first();
    assert.equal(
      Boolean(row),
      publicationExpected,
      "Stored positive disagrees with policy " + scenario,
    );
    if (publicationExpected) {
      assert.equal(row.current_offer_id, "o_fixture");
      assert.equal(row.amount_minor, 599);
      const leaseMs = Date.parse(row.valid_until.replace(" ", "T") + "Z") - Date.now();
      assert.ok(leaseMs > -1000, "Lease must not already be expired");
      const transitionSoon = [
        "future-explicit-deny",
        "contract-expiry-soon",
        "future-competitive-offer",
      ].includes(scenario);
      assert.ok(
        leaseMs <= (transitionSoon ? 6000 : 31000),
        "Positive cannot outlive nearest grant/contract/offer boundary: " + scenario,
      );
    }
  }
  // Simulate an incorrectly skewed Worker clock without giving the public
  // writer a caller-controlled evaluation-time parameter. Primary D1 is the
  // authority on whether the current decision is fresh enough to publish.
  for (const shiftMs of [60_000, -3_000]) {
    await rpc({ op: "scenario", name: "baseline" });
    const OriginalDate = globalThis.Date;
    class SkewedDate extends OriginalDate {
      constructor(...args) {
        super(...(args.length ? args : [OriginalDate.now() + shiftMs]));
      }
      static now() {
        return OriginalDate.now() + shiftMs;
      }
    }
    let result;
    try {
      globalThis.Date = SkewedDate;
      result = await stageRecomputeOwnerPositiveRetail(
        {
          DB: ownerDb,
          COVE_STAGE_OWNER_CAS_ONLY: "1",
          COVE_STAGE_OWNER_DB_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
        },
        "p_fixture",
        "US",
      );
    } finally {
      globalThis.Date = OriginalDate;
    }
    assert.equal(result.published, false, "Skewed canonical policy time must be fenced by D1");
    assert.equal(
      await db.prepare("SELECT COUNT(*) AS n FROM cove_stage_owner_retail_authority").first()
        .then((row) => row.n),
      0,
      "No positive survives future/stale evaluation time",
    );
  }
  console.log(
    "PASS: actual resolveProductRights and guarded owner CAS writer preserve contract/version, explicit-deny, territory, format, channel, DRM, language and future grant/contract/offer time boundaries in isolated SQLite. No production parity claimed.",
  );
} finally {
  lines.close();
  child.stdin.end();
  child.kill("SIGTERM");
  rmSync(folder, { recursive: true, force: true });
}
