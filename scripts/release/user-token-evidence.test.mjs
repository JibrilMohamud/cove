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
  assert.deepEqual(await inspectUserTokenEvidence(async () => complete, USER_TOKEN), {
    verified: true,
    reason: "current_user_inventory_clear",
  });
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

test("new or unreviewed Cloudflare permission names cannot certify user-token safety", async () => {
  for (const group of ["Workers Direct Change", "D1 Mutation", "API Tokens Manage"]) {
    const evidence = await inspectUserTokenEvidence(
      async () => page([token("unreviewed", group)]),
      USER_TOKEN,
    );
    assert.equal(evidence.verified, false);
    assert.equal(evidence.reason, "active_user_token_permission_unreviewed");
    assert.match(
      evidence.detail,
      /^read_group_(identifier_missing|alias_identifier_mismatch_(api_tokens|user_details|account_analytics|unrecognized))$/,
    );
  }
  // Unknown privileges are ignored only if the token is independently inactive.
  assert.deepEqual(
    await inspectUserTokenEvidence(
      async () => page([token("disabled-unknown", "Workers Direct Change", "disabled")]),
      USER_TOKEN,
    ),
    { verified: true, reason: "current_user_inventory_clear" },
  );
});

test("scoped Individual Worker Content Read-Only token remains certified as read-only", async () => {
  assert.deepEqual(
    await inspectUserTokenEvidence(
      async () => page([token("read-only", "Individual Workers Content Read-Only")]),
      USER_TOKEN,
    ),
    { verified: true, reason: "current_user_inventory_clear" },
  );
});

test("unexpected transport failures disclose only an allowlisted category", async () => {
  const secret = "NEVER_LEAK_PRIVATE_USER_OR_BEARER_TOKEN";
  const evidence = await inspectUserTokenEvidence(async () => {
    throw Error(secret);
  }, USER_TOKEN);
  assert.deepEqual(evidence, { verified: false, reason: "user_token_read_unavailable" });
  assert.doesNotMatch(JSON.stringify(evidence), /NEVER_LEAK|Bearer|PRIVATE_USER/);
});

const READ_GROUPS = [
  { name: "API Tokens Read", scope: "com.cloudflare.api.user", id: "a".repeat(32) },
  { name: "User Details Read", scope: "com.cloudflare.api.user", id: "b".repeat(32) },
  { name: "Account Analytics Read", scope: "com.cloudflare.api.account", id: "c".repeat(32) },
];
const groupLookup = (name) => "/user/tokens/permission_groups?name=" + encodeURIComponent(name);
const catalog = (entry) => ({
  result: [{ id: entry.id, name: entry.name, scopes: [entry.scope] }],
  result_info: { page: 1, count: 1, total_count: 2000 },
});
const aliasedPolicy = (id, name) => ({
  name: "redacted",
  status: "active",
  policies: [{ permission_groups: [{ id, name }] }],
});
const aliasTransport = (userRows, override) => async (path, credential) => {
  assert.equal(credential, USER_TOKEN);
  if (path === "/user/tokens") return page(userRows);
  const entry = READ_GROUPS.find((v) => groupLookup(v.name) === path);
  assert.ok(entry, "unexpected catalog path");
  return override ? override(entry) : catalog(entry);
};

test("only provider-confirmed stable IDs resolve cosmetic labels for three documented Read permissions", async () => {
  const labels = ["API Tokens", "User Details", "Account Analytics"];
  const tokens = READ_GROUPS.map((v, i) => aliasedPolicy(v.id, labels[i]));
  let calls = 0;
  const get = aliasTransport(tokens);
  const evidence = await inspectUserTokenEvidence(async (...args) => {
    calls++;
    return get(...args);
  }, USER_TOKEN);
  assert.deepEqual(evidence, { verified: true, reason: "current_user_inventory_clear" });
  assert.equal(calls, 4);
});

test("alias with a mutation ID, missing ID, or unknown permission remains release-blocked", async () => {
  for (const item of [
    aliasedPolicy("d".repeat(32), "Account Analytics"),
    aliasedPolicy(undefined, "Account Analytics"),
    aliasedPolicy("c".repeat(32), "Workers Arbitrary Change"),
  ]) {
    const evidence = await inspectUserTokenEvidence(aliasTransport([item]), USER_TOKEN);
    assert.deepEqual(evidence, {
      verified: false,
      reason: "active_user_token_permission_unreviewed",
      detail:
        item.policies[0].permission_groups[0].id === undefined
          ? "read_group_identifier_missing"
          : item.policies[0].permission_groups[0].name === "Account Analytics"
            ? "read_group_alias_identifier_mismatch_account_analytics"
            : "read_group_alias_identifier_mismatch_unrecognized",
    });
  }
  const explicitWrite = aliasedPolicy("c".repeat(32), "Workers Scripts Write");
  assert.deepEqual(await inspectUserTokenEvidence(aliasTransport([explicitWrite]), USER_TOKEN), {
    verified: false,
    reason: "active_user_token_mutation_capability",
  });
});

test("spoofed or unavailable permission-group catalog cannot certify an alias", async () => {
  const unknown = [aliasedPolicy("c".repeat(32), "Account Analytics")];
  for (const override of [
    () => {
      throw Error("writer_audit_http_403");
    },
    (entry) => ({
      ...catalog(entry),
      result: [{ ...catalog(entry).result[0], name: "Account Analytics Write" }],
    }),
    (entry) => ({
      ...catalog(entry),
      result: [{ ...catalog(entry).result[0], scopes: ["com.cloudflare.edge.r2.bucket"] }],
    }),
    (entry) => ({ ...catalog(entry), result: [] }),
    (entry) => ({ ...catalog(entry), result_info: { page: 2, count: 1, total_count: 2000 } }),
  ]) {
    const evidence = await inspectUserTokenEvidence(aliasTransport(unknown, override), USER_TOKEN);
    assert.equal(evidence.verified, false);
    assert.equal(evidence.reason, "active_user_token_permission_unreviewed");
    assert.match(
      evidence.detail,
      /^read_group_catalog_(unauthorized|name_mismatch|scope_mismatch|not_singleton|page_invalid)$/,
    );
  }
});

const ADDITIONAL_READ = {
  id: "d".repeat(32),
  name: "Workers KV Storage Read",
  scopes: ["com.cloudflare.api.account"],
};
const WRITE_SPOOF = {
  id: "e".repeat(32),
  name: "Workers Scripts Write",
  scopes: ["com.cloudflare.api.account"],
};
function catalogTransport(groups, overrides = {}) {
  const known = aliasTransport([]);
  const lookups = [];
  const get = async (path, credential) => {
    assert.equal(credential, USER_TOKEN);
    if (path === "/user/tokens")
      return page([
        { name: "redacted", status: "active", policies: [{ permission_groups: groups }] },
      ]);
    if (path.startsWith("/user/tokens/permission_groups?name=")) {
      const name = decodeURIComponent(path.split("?name=")[1]);
      if (name === "Workers KV Storage Read" || name === "Workers KV Storage Read-Only") {
        lookups.push(name);
        if (overrides[name]) return overrides[name];
        const rows = name === "Workers KV Storage Read" ? [ADDITIONAL_READ] : [];
        return { result: rows, result_info: { page: 1, count: rows.length, total_count: 2000 } };
      }
      if (name === "Workers Scripts Read" || name === "Workers Scripts Read-Only") {
        lookups.push(name);
        const rows = name === "Workers Scripts Read" ? [WRITE_SPOOF] : [];
        return { result: rows, result_info: { page: 1, count: rows.length, total_count: 2000 } };
      }
      if (name === "Unrelated Capability Read" || name === "Unrelated Capability Read-Only") {
        lookups.push(name);
        return { result: [], result_info: { page: 1, count: 0, total_count: 2000 } };
      }
    }
    return known(path, credential);
  };
  return { get, lookups };
}
test("only a filtered live canonical Read group with matching immutable ID and scope clears a new alias", async () => {
  const t = catalogTransport([{ id: ADDITIONAL_READ.id, name: "Workers KV Storage" }]);
  const receipt = await inspectUserTokenEvidence(t.get, USER_TOKEN);
  assert.deepEqual(receipt, { verified: true, reason: "current_user_inventory_clear" });
  assert.deepEqual(t.lookups, ["Workers KV Storage Read", "Workers KV Storage Read-Only"]);
});
test("filtered name catalog counts only matches, never demands provider global total_count equals one", async () => {
  const t = catalogTransport([{ id: ADDITIONAL_READ.id, name: "Workers KV Storage" }]);
  const receipt = await inspectUserTokenEvidence(t.get, USER_TOKEN);
  assert.equal(receipt.verified, true);
  assert.equal(t.lookups.length, 2);
});
test("a WRITE ID, unknown ID, or unrelated alias cannot be declared read-only", async () => {
  for (const [group, detail] of [
    [{ id: WRITE_SPOOF.id, name: "Workers Scripts" }, "read_group_catalog_shape_invalid"],
    [
      { id: "f".repeat(32), name: "Workers KV Storage" },
      "read_group_alias_identifier_mismatch_unrecognized",
    ],
    [
      { id: ADDITIONAL_READ.id, name: "Unrelated Capability" },
      "read_group_alias_identifier_mismatch_unrecognized",
    ],
  ]) {
    const t = catalogTransport([group]);
    const evidence = await inspectUserTokenEvidence(t.get, USER_TOKEN);
    assert.deepEqual(evidence, {
      verified: false,
      reason: "active_user_token_permission_unreviewed",
      detail,
    });
  }
});
test("malformed, multiple, changed-label and cross-scope name-filtered catalog proofs block", async () => {
  const group = { id: ADDITIONAL_READ.id, name: "Workers KV Storage" };
  const expected = "Workers KV Storage Read";
  const cases = [
    [{ result: [ADDITIONAL_READ, ADDITIONAL_READ] }, "read_group_catalog_shape_invalid"],
    [{ result: [ADDITIONAL_READ] }, "read_group_catalog_page_invalid"],
    [
      { result: [ADDITIONAL_READ], result_info: { page: 2, count: 1 } },
      "read_group_catalog_page_invalid",
    ],
    [
      { result: [ADDITIONAL_READ], result_info: { page: 1, count: 0 } },
      "read_group_catalog_page_invalid",
    ],
    [
      { result: [{ ...ADDITIONAL_READ, scopes: ["com.cloudflare.api.write"] }] },
      "read_group_catalog_shape_invalid",
    ],
    [
      { result: [{ ...ADDITIONAL_READ, name: "Workers KV Storage Write" }] },
      "read_group_catalog_shape_invalid",
    ],
    [{ result: [{ ...ADDITIONAL_READ, id: "not-immutable" }] }, "read_group_catalog_shape_invalid"],
  ];
  for (const [response, detail] of cases) {
    const t = catalogTransport([group], { [expected]: response });
    const evidence = await inspectUserTokenEvidence(t.get, USER_TOKEN);
    assert.deepEqual(evidence, {
      verified: false,
      reason: "active_user_token_permission_unreviewed",
      detail,
    });
  }
});
test("at most six unknown cosmetic groups may trigger at most twelve filtered READ requests", async () => {
  const groups = Array.from({ length: 7 }, (_, i) => ({
    id: i.toString(16).padStart(32, "0"),
    name: "Unknown Group " + i,
  }));
  const t = catalogTransport(groups);
  const evidence = await inspectUserTokenEvidence(t.get, USER_TOKEN);
  assert.equal(evidence.verified, false);
  assert.equal(evidence.detail, "read_group_alias_budget_exceeded");
  assert.deepEqual(t.lookups, []);
});
test("filtered canonical group lookup outages fail closed and never disclose credential or token names", async () => {
  const group = { id: ADDITIONAL_READ.id, name: "Workers KV Storage" };
  const key = "Workers KV Storage Read";
  for (const [error, detail] of [
    ["writer_audit_http_403", "read_group_catalog_unauthorized"],
    ["private upstream incident", "read_group_catalog_unavailable"],
  ]) {
    const t = catalogTransport([group]);
    const get = async (path, credential) => {
      if (path === "/user/tokens/permission_groups?name=" + encodeURIComponent(key))
        throw Error(error);
      return t.get(path, credential);
    };
    const evidence = await inspectUserTokenEvidence(get, USER_TOKEN);
    assert.deepEqual(evidence, {
      verified: false,
      reason: "active_user_token_permission_unreviewed",
      detail,
    });
    assert.doesNotMatch(JSON.stringify(evidence), /private|upstream|redacted|Bearer/);
  }
});
