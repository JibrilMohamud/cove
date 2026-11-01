import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const worker = readFileSync("src/persistence-backend.worker.ts", "utf8");
const owner = readFileSync("src/storefront-strangler/legal-authority.worker.ts", "utf8");
assert.match(worker, /dispatchPrivateAuthorReleaseAlerts\(env, 50\)/);
assert.match(worker, /COVE_AUTHOR_SOCIAL_OWNER_QA !== undefined/);
assert.match(owner, /"\/social\/private-author-release-alerts"/);
assert.match(owner, /queueAuthorReleaseAlerts\(env\.PRIMARY_DB\)/);
assert.match(owner, /processAuthorReleaseAlerts\(env\.PRIMARY_DB,Number\(q\.limit\)\)/);
assert.match(owner, /__COVE_PRODUCTION_OWNER_BINARY_LOCK__===true\)return false/);
for (const config of [
  "wrangler.backend.production.toml",
  ".github/workflows/deploy-persistence-backend.yml",
  "wrangler.legal-authority.production-locked.jsonc",
]) {
  assert.doesNotMatch(
    readFileSync(config, "utf8"),
    /COVE_AUTHOR_SOCIAL_OWNER_QA\s*[:=]\s*["']1["']/,
  );
}

const dir = mkdtempSync(path.join(tmpdir(), "cove-owner-author-alerts-"));
try {
  const file = path.join(dir, "owner.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/backend-author-social-owner.ts"],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { dispatchPrivateAuthorReleaseAlerts } = await import(pathToFileURL(file).href);
  let requests = 0;
  let reply = "good";
  const env = {
    DB: {
      prepare() {
        throw Error("caller_must_not_touch_canonical_d1");
      },
    },
    COVE_AUTHOR_SOCIAL_OWNER_QA: "1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED: "1",
    COVE_SSR_STAGING: "1",
    COVE_LEGAL_WRITER_PRIMARY_ID: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_SECRET: "a".repeat(64),
    LEGAL_AUTHORITY: {
      getByName(name) {
        assert.equal(name, "cove-staged-legal-global-v1");
        return {
          async fetch(request) {
            requests++;
            assert.equal(new URL(request.url).pathname, "/social/private-author-release-alerts");
            assert.equal(request.method, "POST");
            assert.equal(request.headers.get("authorization"), "Bearer " + "a".repeat(64));
            const body = await request.json();
            assert.deepEqual(Object.keys(body).sort(), ["limit", "operationId"]);
            assert.equal(body.limit, 50);
            if (reply === "outage") throw Error("owner_service_unavailable");
            return Response.json({
              schema: "cove.owner-author-release-alerts.v1",
              ownerFirst: true,
              operationId: reply === "forged" ? "wrong" : body.operationId,
              queued: 8,
              processed: reply === "overcount" ? 51 : 3,
              notifications: reply === "overdelivery" ? 50001 : 48,
            });
          },
        };
      },
    },
  };
  assert.deepEqual(await dispatchPrivateAuthorReleaseAlerts(env), {
    queued: 8,
    processed: 3,
    notifications: 48,
  });
  for (const mode of ["forged", "overcount", "overdelivery", "outage"]) {
    reply = mode;
    await assert.rejects(
      () => dispatchPrivateAuthorReleaseAlerts(env),
      /canonical_command_receipt_mismatch|owner_service_unavailable/,
    );
  }
  const afterFailure = requests;
  for (const invalid of [
    { COVE_AUTHOR_SOCIAL_OWNER_QA: undefined },
    { COVE_AUTHOR_SOCIAL_OWNER_QA: "0" },
    { COVE_LEGAL_CONSUMER_STAGE_ENABLED: undefined },
    { COVE_SSR_STAGING: undefined },
    { COVE_LEGAL_WRITER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
    { COVE_RIGHTS_OWNER_SECRET: "" },
    { LEGAL_AUTHORITY: undefined },
  ]) {
    await assert.rejects(
      () => dispatchPrivateAuthorReleaseAlerts({ ...env, ...invalid }),
      /author_release_private_owner_not_enrolled/,
    );
  }
  await assert.rejects(
    () => dispatchPrivateAuthorReleaseAlerts(env, 51),
    /author_release_private_owner_not_enrolled/,
  );
  assert.equal(requests, afterFailure, "A rejected enrollment must not contact the owner.");
  console.log(
    "PASS: author release scan/delivery executes only on QA private owner with bounded, verified receipts.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
