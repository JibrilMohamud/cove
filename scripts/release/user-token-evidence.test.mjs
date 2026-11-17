import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectUserTokenEvidence } from "./certify-exclusive-primary-d1.mjs";

const USER_TOKEN = "redacted-test-token-with-sufficient-length";
const page = (result) => ({
  result,
  result_info: { page: 1, total_pages: 1, count: result.length, total_count: result.length },
});
const token = (name, permission, status = "active") => ({
  name,
  status,
  policies: [{ permission_groups: [{ name: permission }] }],
});

test("user token audit fails closed on 401/403 without disclosing provider response", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const evidence = await inspectUserTokenEvidence(async (path, credential) => {
      calls++;
      assert.equal(path, "/user/tokens");
      assert.equal(credential, USER_TOKEN);
      throw Error("writer_audit_http_" + status);
    }, USER_TOKEN);
    assert.deepEqual(evidence, { verified: false, reason: "user_token_read_unauthorized" });
    assert.equal(calls, 1);
  }
});

test("partial or malformed user token page cannot be mistaken for no tokens", async () => {
  const cases = [
    { result: [], result_info: { page: 1, total_pages: 2, count: 0, total_count: 1 } },
    { result: [], result_info: null },
    {
      result: [token("known", "API Tokens Read")],
      result_info: {
        page: 1,
        total_pages: 1,
        count: 0,
        total_count: 0,
      },
    },
  ];
  for (const value of cases) {
    const evidence = await inspectUserTokenEvidence(async () => value, USER_TOKEN);
    assert.deepEqual(evidence, { verified: false, reason: "user_token_page_incomplete" });
  }
});

test("Cloudflare's documented count-only one-page response is complete", async () => {
  const complete = {
    result: [token("read-only-user", "API Tokens Read")],
    result_info: { page: 1, count: 1, total_count: 1 },
  };
  assert.deepEqual(
    await inspectUserTokenEvidence(async () => complete, USER_TOKEN),
    { verified: true, reason: "current_user_inventory_clear" },
  );
  assert.deepEqual(
    await inspectUserTokenEvidence(
      async () => ({ ...complete, result_info: { page: 1, count: 1, total_count: 2 } }),
      USER_TOKEN,
    ),
    { verified: false, reason: "user_token_page_incomplete" },
  );
});

test("active incomplete policy and privileged token each block user inventory", async () => {
  assert.deepEqual(
    await inspectUserTokenEvidence(
      async () => page([{ name: "unknown", status: "active" }]),
      USER_TOKEN,
    ),
    { verified: false, reason: "user_token_policy_incomplete" },
  );
  assert.deepEqual(
    await inspectUserTokenEvidence(async () => page([token("unsafe", "D1 Write")]), USER_TOKEN),
    { verified: false, reason: "active_user_token_mutation_capability" },
  );
});

test("only complete, current-user safe tokens are accepted; disabled mutation grants do not count", async () => {
  const evidence = await inspectUserTokenEvidence(
    async () => page([token("safe", "D1 Read"), token("disabled", "Workers Admin", "disabled")]),
    USER_TOKEN,
  );
  assert.deepEqual(evidence, { verified: true, reason: "current_user_inventory_clear" });
});

test("unexpected transport failures disclose only an allowlisted category", async () => {
  const secret = "NEVER_LEAK_PRIVATE_USER_OR_BEARER_TOKEN";
  const evidence = await inspectUserTokenEvidence(async () => {
    throw Error(secret);
  }, USER_TOKEN);
  assert.deepEqual(evidence, { verified: false, reason: "user_token_read_unavailable" });
  assert.doesNotMatch(JSON.stringify(evidence), /NEVER_LEAK|Bearer|PRIVATE_USER/);
});
