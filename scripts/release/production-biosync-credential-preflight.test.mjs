import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyProductionBioSyncCredentials } from "./production-biosync-credential-preflight.mjs";

const account = "d26430caa63ec55f6612e32f36aca5e9";
const env = {
  COVE_BIOSYNC_PROD_D1_READ_TOKEN: "d".repeat(32),
  COVE_BIOSYNC_PROD_R2_TOKEN: "r".repeat(32),
  COVE_BIOSYNC_PROD_CLIENT_SECRET: "a".repeat(64),
  COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN: "i".repeat(32),
};
const ids = ["ba59697e28231d3ee460f382aff95454", "8b44b8edebf071ba96ee47e9b34e95bc"];
const r2Scope = "com.cloudflare.edge.r2.bucket." + account + "_default_cove-production-media";
function fixture(change = (x) => x, calls = []) {
  return async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    const bearer = options.headers.authorization.slice(7);
    let result;
    let info;
    if (url.endsWith("/tokens/verify")) {
      result = {
        id: ids[bearer === env.COVE_BIOSYNC_PROD_D1_READ_TOKEN ? 0 : 1],
        status: "active",
      };
    } else if (url.endsWith("/tokens?per_page=50&page=1")) {
      assert.equal(bearer, env.COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN);
      result = [
        {
          id: ids[0],
          status: "active",
          policies: [
            {
              effect: "allow",
              permission_groups: [{ name: "D1 Read" }],
              resources: { ["com.cloudflare.api.account." + account]: "*" },
            },
          ],
        },
        {
          id: ids[1],
          status: "active",
          policies: [
            {
              effect: "allow",
              permission_groups: [{ name: "Workers R2 Storage Bucket Item Write" }],
              resources: {
                [r2Scope]: "*",
              },
            },
          ],
        },
      ];
      info = { page: 1, total_pages: 1, count: 2, total_count: 2 };
      result = change(result);
    } else if (url.endsWith("/query")) {
      assert.equal(bearer, env.COVE_BIOSYNC_PROD_D1_READ_TOKEN);
      assert.deepEqual(JSON.parse(options.body), { sql: "SELECT 1 AS ok", params: [] });
      result = [{ success: true, results: [{ ok: 1 }] }];
    } else {
      assert.equal(bearer, env.COVE_BIOSYNC_PROD_R2_TOKEN);
      assert.equal(options.method, "GET");
      assert.match(url, /cove-production-media\/objects\?prefix=biosync%2Ftext%2F&per_page=1$/);
      result = [];
    }
    return Response.json({ success: true, result, ...(info ? { result_info: info } : {}) });
  };
}
test("checks actual identity, exact independent scopes and only read operations", async () => {
  const calls = [];
  const r = await verifyProductionBioSyncCredentials(env, fixture(undefined, calls), () => true);
  assert.equal(r.exactD1ReadScope, true);
  assert.equal(r.exactR2BucketScope, true);
  assert.equal(r.ownerPublicationProven, false);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((x) => x.method === "POST").length, 1);
});
test("rejects elevated D1 access, account-wide R2 access and token reuse", async () => {
  await assert.rejects(
    verifyProductionBioSyncCredentials(
      env,
      fixture((rows) => {
        rows[0].policies[0].permission_groups.push({ name: "D1 Write" });
        return rows;
      }),
    ),
    /token_scope/,
  );
  await assert.rejects(
    verifyProductionBioSyncCredentials(
      env,
      fixture((rows) => {
        rows[1].policies[0].resources = { ["com.cloudflare.api.account." + account]: "*" };
        return rows;
      }),
    ),
    /token_scope/,
  );
  await assert.rejects(
    verifyProductionBioSyncCredentials({ ...env, CLOUDFLARE_API_TOKEN: "broad" }, fixture()),
    /credentials_missing/,
  );
  await assert.rejects(
    verifyProductionBioSyncCredentials(
      { ...env, COVE_BIOSYNC_PROD_R2_TOKEN: env.COVE_BIOSYNC_PROD_D1_READ_TOKEN },
      fixture(),
    ),
    /credentials_missing/,
  );
});

test("S3 failure is not accepted as a scoped credential pass", async () => {
  await assert.rejects(
    verifyProductionBioSyncCredentials(env, fixture(), () => false),
    /r2_s3_read_failed/,
  );
  await assert.rejects(
    verifyProductionBioSyncCredentials(env, async () => new Response(null, { status: 403 })),
    /(?:d1_identity|token_inventory)_http_403/,
  );
});
