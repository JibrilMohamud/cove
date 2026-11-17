import assert from "node:assert/strict";
import { before, test } from "node:test";
import { build } from "esbuild";

let readOwnerNativeFirstPaintQa;
let nativeFirstPaintRequest;
before(async () => {
  const built = await build({
    entryPoints: ["src/storefront-strangler/owner-native-first-paint-qa.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const source = Buffer.from(built.outputFiles[0].contents).toString("base64");
  ({ readOwnerNativeFirstPaintQa, nativeFirstPaintRequest } = await import(
    "data:text/javascript;base64," + source
  ));
});

const free = {
  product_id: "prd_gutenberg_123",
  edition_id: "ed_gutenberg_123",
  product_public_id: "gutenberg-123",
  edition_public_id: "edition-123",
  offer_json: '{"amountMinor":0,"currency":"USD","type":"public-domain"}',
};
const paid = {
  product_id: "prd_commercial_987",
  edition_id: "ed_commercial_987",
  product_public_id: null,
  edition_public_id: null,
  offer_json: '{"amountMinor":1299,"currency":"USD","type":"retail"}',
};
const input = {
  ids: [paid.product_id, free.product_id],
  territory: "US",
  currency: "USD",
};

function ports({
  primary = [free, paid],
  owner = [free, paid],
  primaryOk = true,
  activeMarket = true,
  withdrawn,
} = {}) {
  let calls = 0;
  return {
    readPrimary: async () => ({ rows: primary, servedByPrimary: primaryOk, activeMarket }),
    readOwner: () => owner,
    marketWithdrawn: () => {
      calls++;
      return withdrawn === "always" || (withdrawn === "after-d1" && calls > 1);
    },
  };
}

test("verified native primary and strongly consistent owner return ordered mixed authorized books", async () => {
  const value = await readOwnerNativeFirstPaintQa(input, ports());
  assert.equal(value.schema, "cove.qa.owner-native-first-paint.v1");
  assert.deepEqual(
    value.rows.map((r) => r.product_id),
    input.ids,
  );
});

test("real paid catalog purchase and strong owner retail are equivalent only at the same amount", async () => {
  const canonical = {
    ...paid,
    offer_json: '{"type":"purchase","currency":"USD","amountMinor":1299}',
  };
  const result = await readOwnerNativeFirstPaintQa(input, ports({ primary: [free, canonical] }));
  assert.deepEqual(
    result.rows.map((r) => r.product_id),
    input.ids,
  );
  assert.equal(
    result.rows[0].offer_json,
    paid.offer_json,
    "Return only the owner proof, never catalog offer",
  );
});

test("a primary free offer still requires exact public-domain owner proof", async () => {
  const canonical = { ...free, offer_json: '{"type":"free","currency":"USD","amountMinor":0}' };
  const value = await readOwnerNativeFirstPaintQa(input, ports({ primary: [canonical, paid] }));
  assert.deepEqual(
    value.rows.map((r) => r.product_id),
    input.ids,
  );
});

test("unrecognized retail aliases and mismatched canonical prices always deny", async () => {
  for (const offer of [
    '{"type":"purchase","currency":"USD","amountMinor":1499}',
    '{"type":"subscription","currency":"USD","amountMinor":1299}',
    '{"type":"public-domain","currency":"USD","amountMinor":0}',
    '{"type":"purchase","currency":"CAD","amountMinor":1299}',
  ]) {
    const source = { ...paid, offer_json: offer };
    await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ primary: [free, source] })));
  }
  const invalidOwner = {
    ...paid,
    offer_json: '{"type":"purchase","currency":"USD","amountMinor":1299}',
  };
  await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ owner: [free, invalidOwner] })));
});

test("an absent owner permission never becomes a positive D1-only result", async () => {
  const value = await readOwnerNativeFirstPaintQa(input, ports({ owner: [free] }));
  assert.deepEqual(
    value.rows.map((r) => r.product_id),
    [free.product_id],
  );
});

test("an absent canonical D1 proof never becomes an owner-only allowance", async () => {
  const value = await readOwnerNativeFirstPaintQa(input, ports({ primary: [paid] }));
  assert.deepEqual(
    value.rows.map((r) => r.product_id),
    [paid.product_id],
  );
});

test("owner market withdrawal before or during D1 request vetoes all grants", async () => {
  await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ withdrawn: "always" })));
  await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ withdrawn: "after-d1" })));
});

test("replica or unknown primary evidence must fail closed", async () => {
  await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ primaryOk: false })));
});

test("inactive or unverified storefront market must never inherit a US default currency", async () => {
  await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ activeMarket: false })));
});

test("price, edition or public identity drift rejects the entire positive result", async () => {
  for (const different of [
    { ...paid, offer_json: paid.offer_json.replace("1299", "1499") },
    { ...paid, edition_id: "ed_other" },
    { ...paid, product_public_id: "wrong-id" },
  ])
    await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ primary: [free, different] })));
});

test("malformed, duplicate and unauthorized rows cannot leak across requests", async () => {
  for (const malformed of [
    [paid, paid],
    [{ ...paid, product_id: "prd_unknown_123" }],
    [{ ...paid, offer_json: '{"amountMinor":0,"currency":"USD","type":"public-domain"}' }],
    [{ ...paid, offer_json: '{"amountMinor":1299,"currency":"CAD","type":"retail"}' }],
  ])
    await assert.rejects(readOwnerNativeFirstPaintQa(input, ports({ primary: malformed })));
});

test("only narrow, unique IDs, trusted country and currency are accepted", () => {
  assert.deepEqual(nativeFirstPaintRequest(input), input);
  for (const invalid of [
    { ...input, ids: [] },
    { ...input, ids: [free.product_id, free.product_id] },
    { ...input, ids: [...Array(26)].map((_, n) => "prd_test_" + n) },
    { ...input, territory: "ZZZ" },
    { ...input, currency: "usd" },
    { ...input, ids: ["' OR 1=1 --"] },
    { ...input, sql: "SELECT * FROM rights" },
  ])
    assert.throws(() => nativeFirstPaintRequest(invalid));
});

test("fresh request after a withdrawal does not reuse a previous positive owner decision", async () => {
  let withdrawn = false;
  const port = ports();
  const dynamic = {
    ...port,
    marketWithdrawn: () => withdrawn,
  };
  assert.equal((await readOwnerNativeFirstPaintQa(input, dynamic)).rows.length, 2);
  withdrawn = true;
  await assert.rejects(readOwnerNativeFirstPaintQa(input, dynamic));
});

test("32 independent concurrent requests do not share state or product rights", async () => {
  const reads = await Promise.all(
    Array.from({ length: 32 }, (_, n) => {
      const id = "prd_gutenberg_" + (n + 1);
      const row = {
        ...free,
        product_id: id,
        edition_id: "ed_gutenberg_" + (n + 1),
      };
      return readOwnerNativeFirstPaintQa(
        { ids: [id], territory: "US", currency: "USD" },
        ports({ primary: [row], owner: [row] }),
      );
    }),
  );
  assert.deepEqual(
    reads.map((x) => x.rows[0].product_id),
    Array.from({ length: 32 }, (_, n) => "prd_gutenberg_" + (n + 1)),
  );
});
