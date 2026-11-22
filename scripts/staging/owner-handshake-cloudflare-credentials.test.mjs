import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COVE_ACCOUNT,
  checkedOwnerHandshakeTokens,
  ownerHandshakeTokenFor,
} from "./owner-handshake-cloudflare-credentials.mjs";

const read = "meta-read-test-token-" + "m".repeat(32);
const write = "scripts-write-test-token-" + "w".repeat(32);
const worker = "cove-owner-handshake-0123456789abcdef";
const base = `/accounts/${COVE_ACCOUNT}/workers/scripts/`;
const credentials = { read, write };

test("metadata and script mutations require distinct scoped principals", () => {
  assert.deepEqual(
    checkedOwnerHandshakeTokens({
      COVE_CF_WORKERS_METADATA_READ_TOKEN: read,
      COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: write,
    }),
    credentials,
  );
  for (const env of [
    {},
    {
      COVE_CF_WORKERS_METADATA_READ_TOKEN: read,
      COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN: read,
    },
    { COVE_CF_WORKERS_METADATA_READ_TOKEN: read },
  ]) {
    assert.throws(
      () => checkedOwnerHandshakeTokens(env),
      /scoped_cloudflare_credentials_required/,
    );
  }
});

test("the protected audit cannot use D1 or mutate production owner", () => {
  const good = [
    ["GET", base + "cove-legal-authority-production/settings", read],
    ["GET", base + "cove-persistence-backend/settings", read],
    ["GET", base + worker + "/settings", read],
    ["GET", `/accounts/${COVE_ACCOUNT}/workers/subdomain`, write],
    ["PUT", base + worker, write],
    ["POST", base + worker + "/subdomain", write],
    ["DELETE", base + worker, write],
  ];
  for (const [method, path, expected] of good)
    assert.equal(ownerHandshakeTokenFor(method, path, worker, credentials), expected);
  for (const [method, path] of [
    ["PUT", base + "cove-legal-authority-production"],
    ["DELETE", base + "cove-persistence-backend"],
    ["PATCH", base + worker + "/settings"],
    [
      "POST",
      `/accounts/${COVE_ACCOUNT}/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query`,
    ],
    ["GET", `/accounts/${COVE_ACCOUNT}/tokens`],
    ["GET", base + "cove-legal-authority-production/script"],
    ["POST", base + worker],
    ["PUT", base + "cove-owner-handshake-forged"],
  ])
    assert.throws(
      () => ownerHandshakeTokenFor(method, path, worker, credentials),
      /operation_not_reviewed/,
    );
  assert.throws(
    () =>
      ownerHandshakeTokenFor(
        "GET",
        base + worker + "/settings",
        "cove-legal-authority-production",
        credentials,
      ),
    /ephemeral_worker_invalid/,
  );
});

test("source and protected workflow never reference the legacy broad secret", () => {
  const workflow = readFileSync(
    ".github/workflows/verify-production-disabled-owner-handshake.yml",
    "utf8",
  );
  const script = readFileSync("scripts/prove-production-owner-handshake.mjs", "utf8");
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(script, /process\.env\.CLOUDFLARE_API_TOKEN/);
  for (const token of ["COVE_CF_WORKERS_METADATA_READ_TOKEN", "COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"])
    assert.match(workflow, new RegExp("secrets\\." + token));
  assert.match(workflow, /environment: cove-production-release-audit/);
  assert.match(workflow, /inputs\.reviewed_main_sha == github\.sha/);
  assert.match(workflow, /needs: offline-credential-boundary/);
  assert.match(script, /ownerHandshakeTokenFor/);
});
