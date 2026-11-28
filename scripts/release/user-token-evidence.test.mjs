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
    if (path.startsWith("/user/tokens/permission_groups?scope=")) {
      const scope = path.split("?scope=")[1];
      return { result: [ADDITIONAL_READ, WRITE_SPOOF].filter((g) => g.scopes.includes(scope)) };
    }
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
test("provider's documented optional result_info still requires the exact immutable ID and unique read-only name", async () => {
  const t = catalogTransport([{ id: ADDITIONAL_READ.id, name: "Workers KV Storage" }], {
    "Workers KV Storage Read": { result: [ADDITIONAL_READ] },
    "Workers KV Storage Read-Only": { result: [] },
  });
  const receipt = await inspectUserTokenEvidence(t.get, USER_TOKEN);
  assert.deepEqual(receipt, { verified: true, reason: "current_user_inventory_clear" });
  assert.deepEqual(t.lookups, ["Workers KV Storage Read", "Workers KV Storage Read-Only"]);
});
test("a WRITE ID or an unknown ID cannot be declared read-only", async () => {
  for (const [group, detail] of [
    [{ id: WRITE_SPOOF.id, name: "Workers Scripts" }, "read_group_catalog_shape_invalid"],
    [
      { id: "f".repeat(32), name: "Workers KV Storage" },
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
    [
      { result: [ADDITIONAL_READ], result_info: { page: 2, count: 1 } },
      "read_group_catalog_page_invalid",
    ],
    [
      { result: [ADDITIONAL_READ], result_info: { page: 1, count: 0 } },
      "read_group_catalog_page_invalid",
    ],
    [
      {
        result: [{ ...ADDITIONAL_READ, scopes: ["com.cloudflare.api.write"] }],
        result_info: { page: 1, count: 1, total_count: 2000 },
      },
      "read_group_catalog_shape_invalid",
    ],
    [
      {
        result: [{ ...ADDITIONAL_READ, name: "Workers KV Storage Write" }],
        result_info: { page: 1, count: 1, total_count: 2000 },
      },
      "read_group_catalog_shape_invalid",
    ],
    [
      {
        result: [{ ...ADDITIONAL_READ, id: "not-immutable" }],
        result_info: { page: 1, count: 1, total_count: 2000 },
      },
      "read_group_catalog_shape_invalid",
    ],
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

test("cosmetic label drift resolves only by positive immutable ID in fresh fixed-scope provider results", async () => {
  for (const label of ["Unrelated Capability", "Provider: Cosmetic Label"]) {
    const t = catalogTransport([{ id: ADDITIONAL_READ.id, name: label }]);
    let scopeCalls = 0;
    const evidence = await inspectUserTokenEvidence(async (path, key) => {
      if (path.includes("?scope=")) {
        scopeCalls++;
        const result = await t.get(path, key);
        // total_count is global; an incomplete filtered listing can prove a
        // matching ID, but NEVER the safety/absence of an omitted ID.
        return {
          ...result,
          result_info: { page: 1, count: result.result.length, total_count: 9000 },
        };
      }
      return t.get(path, key);
    }, USER_TOKEN);
    assert.deepEqual(evidence, { verified: true, reason: "current_user_inventory_clear" });
    assert.equal(scopeCalls, 4);
    assert.doesNotMatch(JSON.stringify(evidence), /Cosmetic|Capability|dddddd/);
  }
});

test("scope resolver never treats missing ID, write capability, malformed or conflicting provider data as safe", async () => {
  const badScope = "com.cloudflare.api.account";
  const group = { id: ADDITIONAL_READ.id, name: "Unrelated Capability" };
  const cases = [
    [{ result: [] }, "read_group_alias_identifier_mismatch_unrecognized"],
    [
      { result: [{ ...ADDITIONAL_READ, name: "D1 Write" }] },
      "read_group_provider_mutation_capability",
    ],
    [{ result: [ADDITIONAL_READ, ADDITIONAL_READ] }, "read_group_catalog_shape_invalid"],
    [{ result: [{ ...ADDITIONAL_READ, scopes: [] }] }, "read_group_catalog_shape_invalid"],
    [
      { result: [ADDITIONAL_READ], result_info: { page: 1, count: 0 } },
      "read_group_catalog_page_invalid",
    ],
    [{ result: [{ ...ADDITIONAL_READ, id: "bad-id" }] }, "read_group_catalog_shape_invalid"],
    [{ result: "not-an-array" }, "read_group_catalog_shape_invalid"],
  ];
  for (const [payload, detail] of cases) {
    const t = catalogTransport([group]);
    const evidence = await inspectUserTokenEvidence(
      async (path, key) =>
        path === "/user/tokens/permission_groups?scope=" + badScope ? payload : t.get(path, key),
      USER_TOKEN,
    );
    assert.deepEqual(evidence, {
      verified: false,
      reason: "active_user_token_permission_unreviewed",
      detail,
    });
  }
  for (const message of ["writer_audit_http_403", "private provider error"]) {
    const t = catalogTransport([group]);
    const evidence = await inspectUserTokenEvidence(async (path, key) => {
      if (path.includes("?scope=")) throw Error(message);
      return t.get(path, key);
    }, USER_TOKEN);
    assert.equal(evidence.verified, false);
    assert.equal(
      evidence.detail,
      message.endsWith("403")
        ? "read_group_catalog_unauthorized"
        : "read_group_catalog_unavailable",
    );
  }
  const scopes = ["com.cloudflare.api.user", "com.cloudflare.api.account"];
  const t = catalogTransport([group]);
  const evidence = await inspectUserTokenEvidence(async (path, key) => {
    if (path.includes("?scope=")) {
      const scope = path.split("?scope=")[1];
      return {
        result: scopes.includes(scope)
          ? [
              {
                ...ADDITIONAL_READ,
                name: scope === scopes[0] ? "Canonical Read" : "Canonical Write",
                scopes,
              },
            ]
          : [],
      };
    }
    return t.get(path, key);
  }, USER_TOKEN);
  assert.equal(evidence.verified, false);
  assert.equal(evidence.detail, "read_group_catalog_identity_conflict");
});

// These are public canonical provider definitions observed on 2026-11-24,
// not trusted cosmetic labels from a user's token policy.
test("punctuated canonical provider READ names require fresh exact-ID scope proof", async () => {
  for (const name of [
    "Access: Organizations, Identity Providers, and Groups Read",
    "Load Balancing: Monitors and Pools Read",
    "Cloud Email Security: Read",
  ]) {
    const group = { id: ADDITIONAL_READ.id, name: "Provider: Cosmetic Label" };
    const t = catalogTransport([group]);
    let matches = 0;
    const evidence = await inspectUserTokenEvidence(async (path, key) => {
      if (path.includes("?scope=")) {
        const payload = await t.get(path, key);
        return {
          ...payload,
          result: payload.result.map((row) => {
            if (row.id === group.id) {
              matches++;
              return { ...row, name };
            }
            return row;
          }),
        };
      }
      return t.get(path, key);
    }, USER_TOKEN);
    assert.deepEqual(evidence, { verified: true, reason: "current_user_inventory_clear" });
    assert.ok(matches > 0);
    assert.doesNotMatch(JSON.stringify(evidence), /Cosmetic|Access|Balancing|Security|dddddd/);
  }
});
test("punctuation never allows unverified policy labels or provider WRITE/malformed capabilities", async () => {
  const t = catalogTransport([{ id: ADDITIONAL_READ.id, name: "Provider: Cosmetic Label" }]);
  for (const name of [
    "Access: Apps Write",
    "Access: Apps Read\n",
    "Access: Unknown Capability",
    "Access: Apps Read; DELETE",
  ]) {
    const evidence = await inspectUserTokenEvidence(async (path, key) => {
      const payload = await t.get(path, key);
      if (path.includes("?scope="))
        return {
          ...payload,
          result: payload.result.map((row) =>
            row.id === ADDITIONAL_READ.id ? { ...row, name } : row,
          ),
        };
      return payload;
    }, USER_TOKEN);
    assert.equal(evidence.verified, false);
    assert.equal(
      evidence.detail,
      name.endsWith(" Write")
        ? "read_group_provider_mutation_capability"
        : "read_group_provider_capability_not_readonly",
    );
  }
  const unresolved = await inspectUserTokenEvidence(async (path, key) => {
    if (path.includes("?scope=")) return { result: [] };
    return t.get(path, key);
  }, USER_TOKEN);
  assert.equal(unresolved.verified, false);
  assert.equal(unresolved.detail, "read_group_alias_identifier_mismatch_unrecognized");
});

test("alternate provider READ spellings require the reviewed immutable ID and fresh scoped identity", async () => {
  const examples = [
    ["2c627567e4b4465d862e6be258a4bb3f", "Workers Platform Metadata (Read-Only)"],
    ["8f9a2610d2f049a4ad4eb29686b181e9", "Magic Transit (Read-only)"],
    ["de5d07221d374ec28b4dd230a0c6a2f1", "AI Gateway Read Only"],
    ["f15a31fae6c4433abbf43ad868aed734", "Vectorize Readonly"],
    ["d658f06e1bfd4db1b9be75f866671ebb", "Zone Versioning Read (Account-Wide)"],
    ["0a5ddcbf92a5430599aeec18d2a88ce0", "Audit Logs Viewer"],
    ["6795348d3cef44a0be48be200828858b", "Minimal Account Access"],
    ["9ac5632ae4f449938fc2ed64a20af22c", "Analytics"],
    ["2b3124552acd4fe390a35883e20745c2", "Log Share Reader"],
    ["b446806c7314472798f9364be7619455", "Email Security Reporting"],
    ["f4df4017f4334b30a868883046a18a9d", "Administrator Read Only"],
    ["98d2b0c4bd3b4a2c842fcd2a81273ee9", "Domain Administrator Read Only"],
    ["bd837b12789e45cdb2e3867bc4e41377", "Cloudflare One Connector Read and Monitor: cloudflared"],
  ];
  for (const [id, name] of examples) {
    for (const variant of ["exact", "wrong-id", "wrong-name", "missing", "write"]) {
      const group = {
        id: variant === "wrong-id" ? ADDITIONAL_READ.id : id,
        name: "Provider: Cosmetic Label",
      };
      const t = catalogTransport([group]);
      const evidence = await inspectUserTokenEvidence(async (path, key) => {
        if (path.includes("?scope="))
          return {
            result:
              path.endsWith("com.cloudflare.api.account") && variant !== "missing"
                ? [
                    {
                      id: group.id,
                      name:
                        variant === "wrong-name"
                          ? name + " "
                          : variant === "write"
                            ? "D1 Write"
                            : name,
                      scopes: ["com.cloudflare.api.account"],
                    },
                  ]
                : [],
          };
        return t.get(path, key);
      }, USER_TOKEN);
      assert.equal(evidence.verified, variant === "exact", name + ": " + variant);
      if (variant !== "exact")
        assert.equal(evidence.reason, "active_user_token_permission_unreviewed");
    }
  }
});

test("public provider definitions are evidence of semantics, never token authorization or permission from a Read substring", async () => {
  const { readFileSync } = await import("node:fs");
  const review = JSON.parse(
    readFileSync("docs/security/provider-legacy-read-definitions-20261124.json", "utf8"),
  );
  assert.equal(review.releaseApproval, false);
  assert.equal(review.authorizationEvidence, false);
  assert.equal(review.definitions.length, 7);
  assert.equal(new Set(review.definitions.map((x) => x.id)).size, 7);
  for (const definition of [...review.definitions, ...review.explicitlyExcluded]) {
    const t = catalogTransport([{ id: definition.id, name: "Provider: Cosmetic Label" }]);
    const evidence = await inspectUserTokenEvidence(async (path, key) => {
      if (path.includes("?scope="))
        return {
          result: path.endsWith(definition.scope || "com.cloudflare.api.account")
            ? [
                {
                  id: definition.id,
                  name: definition.name,
                  scopes: [definition.scope || "com.cloudflare.api.account"],
                },
              ]
            : [],
        };
      return t.get(path, key);
    }, USER_TOKEN);
    assert.equal(evidence.verified, review.definitions.includes(definition), definition.name);
    assert.doesNotMatch(JSON.stringify(evidence), /Cosmetic|Provider:|redacted/);
  }
});

const CACHE_PURGE = {
  id: "e17beae8b8cb423a99b1730f21238bed",
  name: "Cache Purge",
  scopes: ["com.cloudflare.api.account.zone"],
};
const COVE_ZONE_KEY = "com.cloudflare.api.account.zone.07e218b2e74bc522122e0994b8e37576";
const OTHER_ZONE_KEY = "com.cloudflare.api.account.zone." + "a".repeat(32);
const purgePolicy = (overrides = {}) => ({
  effect: "allow",
  resources: { [OTHER_ZONE_KEY]: "*" },
  permission_groups: [{ id: CACHE_PURGE.id, name: CACHE_PURGE.name }],
  ...overrides,
});
const purgeToken = (...policies) => ({ name: "redacted", status: "active", policies });
function purgeTransport(tokens, catalogResponse = { result: [CACHE_PURGE] }) {
  const aliases = aliasTransport(tokens);
  return async (path, key) => {
    assert.equal(key, USER_TOKEN);
    if (path === "/user/tokens/permission_groups?scope=com.cloudflare.api.account.zone")
      return typeof catalogResponse === "function" ? catalogResponse() : catalogResponse;
    return aliases(path, key);
  };
}

test("exact provider Cache Purge is reported separately as a non-Cove mutation, never as Read", async () => {
  const evidence = await inspectUserTokenEvidence(
    purgeTransport([purgeToken(purgePolicy()), aliasedPolicy(READ_GROUPS[0].id, "API Tokens")]),
    USER_TOKEN,
  );
  assert.deepEqual(evidence, {
    verified: true,
    reason: "current_user_inventory_clear",
    verifiedUnrelatedNonD1Mutations: ["zone_cache_purge"],
  });
  assert.doesNotMatch(JSON.stringify(evidence), /redacted|e17beae8|aaaaaaaa|07e218b2/);
});

test("every Cache Purge policy must explicitly exclude Cove, including misleading Read labels", async () => {
  for (const resources of [
    undefined,
    null,
    {},
    [],
    { [COVE_ZONE_KEY]: "*" },
    { [OTHER_ZONE_KEY]: "*", [COVE_ZONE_KEY]: "*" },
    { "com.cloudflare.api.account.zone.*": "*" },
    { "com.cloudflare.api.account.zone": "*" },
    { "com.cloudflare.api.account.*": "*" },
    { [OTHER_ZONE_KEY]: { "*": "*" } },
    { [OTHER_ZONE_KEY]: "unknown" },
    { [OTHER_ZONE_KEY + ".extra"]: "*" },
  ]) {
    const evidence = await inspectUserTokenEvidence(
      purgeTransport([
        purgeToken(
          purgePolicy(),
          purgePolicy({
            resources,
            permission_groups: [{ id: CACHE_PURGE.id, name: "Cache Purge Read" }],
          }),
        ),
      ]),
      USER_TOKEN,
    );
    assert.equal(evidence.verified, false);
    assert.equal(evidence.detail, "cache_purge_zone_exclusion_unverified");
  }
  for (const effect of [undefined, "deny", "unknown"]) {
    const evidence = await inspectUserTokenEvidence(
      purgeTransport([purgeToken(purgePolicy({ effect }))]),
      USER_TOKEN,
    );
    assert.equal(evidence.verified, false);
    assert.equal(evidence.detail, "cache_purge_zone_exclusion_unverified");
  }
});

test("Cache Purge requires exact ID, exact canonical provider name and exclusively zone scope", async () => {
  for (const result of [
    [],
    [{ ...CACHE_PURGE, id: "f".repeat(32) }],
    [{ ...CACHE_PURGE, name: "Cache Purge Read" }],
    [{ ...CACHE_PURGE, scopes: ["com.cloudflare.api.account"] }],
    [{ ...CACHE_PURGE, scopes: [...CACHE_PURGE.scopes, "com.cloudflare.api.account"] }],
    [CACHE_PURGE, CACHE_PURGE],
  ]) {
    const evidence = await inspectUserTokenEvidence(
      purgeTransport([purgeToken(purgePolicy())], { result }),
      USER_TOKEN,
    );
    assert.equal(evidence.verified, false);
    assert.equal(evidence.detail, "cache_purge_provider_identity_unverified");
  }
  const wrongId = await inspectUserTokenEvidence(
    purgeTransport([
      purgeToken(purgePolicy({ permission_groups: [{ id: "f".repeat(32), name: "Cache Purge" }] })),
    ]),
    USER_TOKEN,
  );
  assert.equal(wrongId.verified, false);
  assert.equal(wrongId.detail, "cache_purge_identifier_mismatch");
  for (const [response, detail] of [
    [{ result: [CACHE_PURGE], result_info: { page: 2, count: 1 } }, "read_group_catalog_page_invalid"],
    [{ result: null }, "read_group_catalog_shape_invalid"],
    [
      () => {
        throw Error("writer_audit_http_403");
      },
      "read_group_catalog_unauthorized",
    ],
  ]) {
    const evidence = await inspectUserTokenEvidence(
      purgeTransport([purgeToken(purgePolicy())], response),
      USER_TOKEN,
    );
    assert.equal(evidence.verified, false);
    assert.equal(evidence.detail, detail);
  }
});

test("verified Cache Purge never exempts companion D1, Worker or token-write privileges", async () => {
  for (const name of ["D1 Write", "Workers Scripts Write", "API Tokens Write", "Workers CI Write"]) {
    const evidence = await inspectUserTokenEvidence(
      purgeTransport([
        purgeToken(
          purgePolicy({
            permission_groups: [{ id: CACHE_PURGE.id, name: CACHE_PURGE.name }, { name }],
          }),
        ),
      ]),
      USER_TOKEN,
    );
    assert.deepEqual(evidence, { verified: false, reason: "active_user_token_mutation_capability" });
  }
  const unknown = await inspectUserTokenEvidence(
    purgeTransport([purgeToken(purgePolicy()), aliasedPolicy(undefined, "Unknown Mutation")]),
    USER_TOKEN,
  );
  assert.equal(unknown.verified, false);
  assert.equal(unknown.detail, "read_group_identifier_missing");
});
