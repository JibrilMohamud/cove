import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { userTokenPreflight, inspectUserTokenEvidence } from "./certify-exclusive-primary-d1.mjs";

const token = "synthetic-protected-read-credential";
const env = {
  GITHUB_REPOSITORY: "JibrilMohamud/cove",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  CF_ACCOUNT_ID: "d26430caa63ec55f6612e32f36aca5e9",
  CF_USER_AUDIT_TOKEN: token,
};
const page = (groups) => ({
  result: [
    { name: "PRIVATE_TOKEN_NAME", status: "active", policies: [{ permission_groups: groups }] },
  ],
  result_info: { page: 1, count: 1, total_count: 1 },
});

test("preflight refuses every unprotected context before any request", async () => {
  for (const patch of [
    { GITHUB_REPOSITORY: "other/cove" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/topic" },
    { CF_ACCOUNT_ID: "wrong" },
    { CF_USER_AUDIT_TOKEN: "" },
    { GITHUB_EVENT_NAME: "push", GITHUB_SHA: "a".repeat(40) },
    {
      GITHUB_EVENT_NAME: "push",
      GITHUB_SHA: "a".repeat(40),
      COVE_REVIEWED_USER_TOKEN_PUSH: "b".repeat(40),
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      userTokenPreflight({ ...env, ...patch }, async () => {
        calls++;
      }),
    );
    assert.equal(calls, 0);
  }
});
test("a clear user inventory never certifies principal coverage or release", async () => {
  let calls = 0;
  const result = await userTokenPreflight(env, async (path, key) => {
    calls++;
    assert.equal(path, "/user/tokens");
    assert.equal(key, token);
    return page([{ name: "D1 Read" }]);
  });
  assert.equal(calls, 1);
  assert.equal(result.verified, true);
  assert.equal(result.principalCoverageCertified, false);
  assert.equal(result.releaseCertified, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN_NAME|synthetic-protected/);
});
test("each malformed catalog yields a specific fixed category without provider bodies or identities", async () => {
  const id = "a".repeat(32);
  const good = {
    result: [{ id, name: "API Tokens Read", scopes: ["com.cloudflare.api.user"] }],
    result_info: { page: 1, count: 1 },
  };
  const cases = [
    [undefined, "read_group_catalog_shape_invalid"],
    [{ result: [] }, "read_group_catalog_not_singleton"],
    [
      { ...good, result: [{ ...good.result[0], name: "PRIVATE_PROVIDER_LABEL" }] },
      "read_group_catalog_name_mismatch",
    ],
    [
      { ...good, result: [{ ...good.result[0], id: "bad" }] },
      "read_group_catalog_identifier_invalid",
    ],
    [{ ...good, result: [{ ...good.result[0], scopes: [] }] }, "read_group_catalog_scope_mismatch"],
    [{ ...good, result_info: { page: 2, count: 1 } }, "read_group_catalog_page_invalid"],
  ];
  for (const [response, detail] of cases) {
    let calls = 0;
    const result = await inspectUserTokenEvidence(async (path) => {
      calls++;
      return path === "/user/tokens" ? page([{ id, name: "API Tokens" }]) : response;
    }, token);
    assert.deepEqual(result, {
      verified: false,
      reason: "active_user_token_permission_unreviewed",
      detail,
    });
    assert.equal(calls, 2);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|aaaaaa|synthetic-protected/);
  }
  for (const [message, detail] of [
    ["writer_audit_http_403", "read_group_catalog_unauthorized"],
    ["PRIVATE_PROVIDER_ERROR", "read_group_catalog_unavailable"],
  ]) {
    const result = await inspectUserTokenEvidence(async (path) => {
      if (path === "/user/tokens") return page([{ id, name: "API Tokens" }]);
      throw Error(message);
    }, token);
    assert.equal(result.detail, detail);
    assert.equal(result.verified, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_ERROR|403/);
  }
});
test("workflow keeps new diagnostic separate from full inventory and protects the only live credential", () => {
  const source = readFileSync(".github/workflows/cove-protected-user-token-readonly.yml", "utf8");
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /\n  (schedule|pull_request_target):/);
  assert.match(source, /push:\s+branches: \[main\]/);
  for (const guard of [
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    "inputs.confirm_user_token_metadata_only == true",
    "inputs.reviewed_main_sha == github.sha",
    "environment: cove-production-release-audit",
    "persist-credentials: false",
  ])
    assert.ok(source.includes(guard), guard);
  assert.equal((source.match(/secrets\./g) || []).length, 1);
  assert.match(source, /secrets\.COVE_CF_USER_TOKENS_AUDIT_READ_TOKEN/);
  assert.doesNotMatch(source, /CLOUDFLARE_API_TOKEN|wrangler|CF_WORKERS/);
  assert.match(source, /--user-token-preflight/);
});

test("the reviewed main push runs only the same metadata inventory, with a matching immutable source SHA", async () => {
  const sha = "a".repeat(40);
  let calls = 0;
  const result = await userTokenPreflight(
    { ...env, GITHUB_EVENT_NAME: "push", GITHUB_SHA: sha, COVE_REVIEWED_USER_TOKEN_PUSH: sha },
    async (path) => {
      calls++;
      assert.equal(path, "/user/tokens");
      return page([{ name: "D1 Read" }]);
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.verified, true);
  assert.equal(result.releaseCertified, false);
});
