import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tmp = mkdtempSync(path.join(tmpdir(), "cove-seo-real-owner-source-qa-"));
try {
  await build({
    entryPoints: [
      "src/storefront-strangler/seo-owner-source-denial-qa.ts",
      "src/storefront-strangler/legal-authority-core.ts",
      "src/storefront-strangler/seo-owner-denial-epoch.ts",
    ],
    outdir: tmp,
    entryNames: "[name]",
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const load = async (name) => import(pathToFileURL(path.join(tmp, name + ".mjs")).href);
  const { createAuthoritySchema, applyAuthorityCommand } = await load("legal-authority-core");
  const { readSeoOwnerDenialEpoch } = await load("seo-owner-denial-epoch");
  const { withSeoQaSourceDenialEpoch, qaSourceDenialCurrent } = await load(
    "seo-owner-source-denial-qa",
  );
  function fixture() {
    const db = new DatabaseSync(":memory:");
    const sql = {
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        const rows =
          /^\s*SELECT\b/i.test(query) || /^\s*UPDATE\b[\s\S]*\bRETURNING\b/i.test(query)
            ? statement.all(...bindings)
            : (statement.run(...bindings), []);
        return { toArray: () => rows };
      },
    };
    const tx = (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    createAuthoritySchema(sql);
    return { db, sql, tx };
  }

  const a = fixture();
  try {
    const first = { sourceId: "2701", territory: "*", operationId: "seo-qa-withdraw-1" };
    assert.equal(qaSourceDenialCurrent(a.sql, first), false);
    const initial = withSeoQaSourceDenialEpoch(a.sql, a.tx, first);
    assert.equal(initial.applied, true);
    assert.equal(initial.replayed, false);
    assert.equal(initial.revision, 1);
    assert.equal(initial.ownerDenialEpoch, 1);
    assert.equal(initial.state.allowed, false);
    assert.equal(readSeoOwnerDenialEpoch(a.sql), 1);
    assert.equal(qaSourceDenialCurrent(a.sql, first), true);

    const replay = withSeoQaSourceDenialEpoch(a.sql, a.tx, first);
    assert.equal(replay.applied, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 1);
    assert.equal(replay.ownerDenialEpoch, 1);
    assert.equal(readSeoOwnerDenialEpoch(a.sql), 1);

    // A newer allow in one territory supersedes the earlier global denial.
    assert.equal(
      applyAuthorityCommand(a.sql, {
        sourceId: "2701",
        territory: "US",
        revision: 2,
        action: "allow",
      }).applied,
      true,
    );
    assert.equal(qaSourceDenialCurrent(a.sql, first), false);
    assert.throws(
      () => withSeoQaSourceDenialEpoch(a.sql, a.tx, first),
      /seo_owner_denial_replay_not_current/,
    );
    assert.equal(readSeoOwnerDenialEpoch(a.sql), 1);

    const second = { ...first, operationId: "seo-qa-withdraw-2" };
    const next = withSeoQaSourceDenialEpoch(a.sql, a.tx, second);
    assert.equal(next.applied, true);
    assert.equal(next.revision, 3);
    assert.equal(next.ownerDenialEpoch, 2);
    assert.equal(next.state.allowed, false);
    assert.equal(readSeoOwnerDenialEpoch(a.sql), 2);
    assert.throws(
      () =>
        withSeoQaSourceDenialEpoch(a.sql, a.tx, {
          ...second,
          sourceId: "2702",
        }),
      /seo_owner_denial_replay_not_current/,
    );
    assert.equal(readSeoOwnerDenialEpoch(a.sql), 2);

    for (const wrong of [
      { sourceId: "2701", territory: "*", operationId: "not valid spaces" },
      { sourceId: "2701", territory: "*", operationId: "bad", extra: true },
      { sourceId: "2701", territory: "XXZ", operationId: "bad" },
    ]) {
      assert.throws(() => withSeoQaSourceDenialEpoch(a.sql, a.tx, wrong));
    }
    assert.equal(readSeoOwnerDenialEpoch(a.sql), 2);
  } finally {
    a.db.close();
  }

  const existing = fixture();
  try {
    assert.equal(
      applyAuthorityCommand(existing.sql, {
        sourceId: "2701",
        territory: "*",
        revision: 1,
        action: "deny",
      }).applied,
      true,
    );
    assert.throws(
      () =>
        withSeoQaSourceDenialEpoch(existing.sql, existing.tx, {
          sourceId: "2701",
          territory: "*",
          operationId: "legacy-state-not-enrolled",
        }),
      /seo_qa_epoch_nonvirgin/,
    );
    assert.equal(
      existing.sql
        .exec("SELECT name FROM sqlite_master WHERE name='cove_seo_owner_denial_epoch'")
        .toArray().length,
      0,
      "An existing owner cannot be silently initialized at epoch 0",
    );
  } finally {
    existing.db.close();
  }

  const worker = readFileSync("src/storefront-strangler/legal-authority.worker.ts", "utf8");
  assert.match(worker, /if \(!qaOwnerLeaseLive\(env\)\)/);
  assert.match(worker, /COVE_SEO_OWNER_DENIAL_EPOCH_QA==="1"/);
  assert.match(worker, /route!=="\/deny-next" && route!=="\/verify"/);
  assert.match(worker, /withSeoQaSourceDenialEpoch\(sql,/);
  assert.ok(
    worker.indexOf("if (!qaOwnerLeaseLive(env))") <
      worker.indexOf('if(env.COVE_SEO_OWNER_DENIAL_EPOCH_QA==="1" &&'),
    "No QA SEO epoch code runs before the protected owner QA lease",
  );
  assert.ok(
    !worker.includes('"/seo/denial-epoch"'),
    "Production-facing SEO proof route must remain unavailable",
  );
  console.log(
    "PASS: real owner QA source denial bridge; exact replay, rollback, bootstrap and nonauthorizing route guard",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
