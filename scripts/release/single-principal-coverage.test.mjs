import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectSinglePrincipalCoverage } from "./single-principal-coverage.mjs";
const ID = "a".repeat(32);
const OTHER = "b".repeat(32);
const TOKEN = "not-a-real-user-credential";
const ACCOUNT_TOKEN = "not-a-real-account-credential";
const row = (id = ID, status = "accepted") => ({ status, user: { id } });
const page = (rows = [row()]) => ({
  result: rows, result_info: { page: 1, count: rows.length, total_count: rows.length },
});

test("only stable complete singleton membership plus independent issuing-user identity proves coverage", async () => {
  const calls = [];
  const result = await inspectSinglePrincipalCoverage(async (path, token) => {
    calls.push(path);
    if (path === "/user") { assert.equal(token, TOKEN); return { result: { id: ID } }; }
    assert.equal(token, ACCOUNT_TOKEN);
    assert.equal(path, "/accounts/d26430caa63ec55f6612e32f36aca5e9/members");
    return page();
  }, ACCOUNT_TOKEN, TOKEN);
  assert.deepEqual(result, { verified: true, reason: "single_member_identity_matched" });
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(result).includes(ID), false);
});

test("multiple, pending, empty, partial, duplicate or malformed membership is not all-principal coverage", async () => {
  for (const data of [
    page([]), page([row(), row(OTHER)]), page([row(), row()]), page([row(ID, "pending")]),
    page([row("bad-id")]), { result: [row()] },
    { ...page(), result_info: { page: 1, count: 1, total_count: 2 } },
    { ...page(), result_info: { page: 2, count: 1, total_count: 1 } },
    { ...page(), result_info: { page: 1, count: 1, total_count: 1, total_pages: 2 } },
  ]) {
    const result = await inspectSinglePrincipalCoverage(async () => data, ACCOUNT_TOKEN, TOKEN);
    assert.deepEqual(result, { verified: false, reason: "principal_membership_not_single_complete" });
  }
});

test("another issuing user's token or a changed account membership cannot prove coverage", async () => {
  for (const identity of [OTHER, undefined, "invalid"]) {
    const result = await inspectSinglePrincipalCoverage(async (path) =>
      path === "/user" ? { result: { id: identity } } : page(), ACCOUNT_TOKEN, TOKEN);
    assert.deepEqual(result, { verified: false, reason: "principal_identity_mismatch" });
  }
  let reads = 0;
  assert.deepEqual(await inspectSinglePrincipalCoverage(async (path) => {
    if (path === "/user") return { result: { id: ID } };
    return ++reads === 1 ? page() : page([row(OTHER)]);
  }, ACCOUNT_TOKEN, TOKEN), { verified: false, reason: "principal_membership_changed" });
});

test("scope failures expose only fixed local reason codes", async () => {
  for (const target of ["members", "user"]) {
    for (const failure of ["writer_audit_http_403", "PRIVATE_USER_TOKEN_PROVIDER_BODY"]) {
      const result = await inspectSinglePrincipalCoverage(async (path) => {
        if ((target === "user") === (path === "/user")) throw Error(failure);
        return page();
      }, ACCOUNT_TOKEN, TOKEN);
      assert.equal(result.verified, false);
      assert.equal(result.reason, (target === "user" ? "user_identity_read_" : "account_members_read_") +
        (failure.endsWith("403") ? "unauthorized" : "unavailable"));
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_USER|PROVIDER_BODY/);
    }
  }
});
