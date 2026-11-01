import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const backend = readFileSync("src/persistence-backend.worker.ts", "utf8");
const owner = readFileSync("src/storefront-strangler/legal-authority.worker.ts", "utf8");
const gateway = readFileSync("src/storefront-strangler/canonical-owner-command-gateway.ts", "utf8");
assert.match(backend, /COVE_AUTHOR_SOCIAL_OWNER_QA === undefined/);
assert.match(backend, /dispatchPrivateAuthorSocialFanout\(env, 10, 250\)/);
assert.match(backend, /processAuthorSocialFanoutJobs\(env\.DB, 10, 250\)/);
assert.match(owner, /"\/social\/private-author-fanout"/);
assert.match(owner, /processAuthorSocialFanoutJobs\(\s*env\.PRIMARY_DB/);
assert.match(owner, /if\s*\(!qaOwnerLeaseLive\(env\)\)/);
assert.match(owner, /__COVE_PRODUCTION_OWNER_BINARY_LOCK__===true\)return false/);
assert.match(gateway, /"social\.process-author-fanout"/);
for (const file of [
  "wrangler.backend.production.toml",
  ".github/workflows/deploy-persistence-backend.yml",
  "wrangler.legal-authority.production-locked.jsonc",
]) {
  assert.doesNotMatch(readFileSync(file, "utf8"), /COVE_AUTHOR_SOCIAL_OWNER_QA\s*[:=]\s*["']1["']/);
}

const dir = mkdtempSync(path.join(tmpdir(), "cove-owner-social-fanout-"));
try {
  const outfile = path.join(dir, "social.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/backend-author-social-owner.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { dispatchPrivateAuthorSocialFanout } = await import(pathToFileURL(outfile).href);
  const calls = [];
  let mode = "success";
  const env = {
    DB: {
      prepare() {
        throw Error("canonical_caller_d1_must_not_be_touched");
      },
    },
    COVE_AUTHOR_SOCIAL_OWNER_QA: "1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED: "1",
    COVE_SSR_STAGING: "1",
    COVE_LEGAL_WRITER_PRIMARY_ID: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_SECRET: "f".repeat(64),
    LEGAL_AUTHORITY: {
      getByName(name) {
        assert.equal(name, "cove-staged-legal-global-v1");
        return {
          async fetch(request) {
            assert.equal(new URL(request.url).pathname, "/social/private-author-fanout");
            assert.equal(request.method, "POST");
            assert.equal(request.headers.get("authorization"), "Bearer " + "f".repeat(64));
            const body = await request.json();
            assert.deepEqual(Object.keys(body).sort(), ["batchSize", "limit", "operationId"]);
            assert.equal(body.limit, 10);
            assert.equal(body.batchSize, 250);
            calls.push(body.operationId);
            if (mode === "down") throw Error("private_owner_unavailable");
            if (mode === "wrong")
              return Response.json({
                schema: "cove.owner-author-social-fanout.v1",
                ownerFirst: true,
                operationId: "forged-operation",
                processed: 1,
                delivered: 1,
                failed: 0,
              });
            if (mode === "overcount")
              return Response.json({
                schema: "cove.owner-author-social-fanout.v1",
                ownerFirst: true,
                operationId: body.operationId,
                processed: 11,
                delivered: 0,
                failed: 0,
              });
            return Response.json({
              schema: "cove.owner-author-social-fanout.v1",
              ownerFirst: true,
              operationId: body.operationId,
              processed: 2,
              delivered: 24,
              failed: 0,
            });
          },
        };
      },
    },
  };
  assert.deepEqual(await dispatchPrivateAuthorSocialFanout(env, 10, 250), {
    processed: 2,
    delivered: 24,
    failed: 0,
  });
  assert.equal(calls.length, 1);
  mode = "wrong";
  await assert.rejects(() => dispatchPrivateAuthorSocialFanout(env, 10, 250), /receipt_mismatch/);
  mode = "overcount";
  await assert.rejects(() => dispatchPrivateAuthorSocialFanout(env, 10, 250), /receipt_mismatch/);
  mode = "down";
  await assert.rejects(
    () => dispatchPrivateAuthorSocialFanout(env, 10, 250),
    /private_owner_unavailable/,
  );
  for (const invalid of [
    { COVE_AUTHOR_SOCIAL_OWNER_QA: "0" },
    { COVE_LEGAL_CONSUMER_STAGE_ENABLED: "0" },
    { COVE_SSR_STAGING: "0" },
    { COVE_LEGAL_WRITER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
    { COVE_RIGHTS_OWNER_SECRET: "" },
    { LEGAL_AUTHORITY: undefined },
  ]) {
    await assert.rejects(
      () => dispatchPrivateAuthorSocialFanout({ ...env, ...invalid }, 10, 250),
      /author_social_private_owner_not_enrolled/,
    );
  }
  await assert.rejects(
    () => dispatchPrivateAuthorSocialFanout(env, 11, 250),
    /author_social_private_owner_not_enrolled/,
  );
  assert.equal(calls.length, 4, "No invalid enrollment may contact the owner.");
  console.log(
    "PASS: scheduled author fanout is bounded, owner-first, QA-only and fails without caller D1 fallback.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
