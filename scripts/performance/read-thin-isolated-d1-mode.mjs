import assert from "node:assert/strict";

const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
const id = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
assert.match(account, /^[0-9a-f]{32}$/);
assert.ok(token.length >= 20);
const response = await fetch(
  "https://api.cloudflare.com/client/v4/accounts/" + account + "/d1/database/" + id,
  { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000) },
);
if (!response.ok) throw Error("Synthetic D1 inspection refused: " + response.status);
const body = await response.json();
const row = body.result;
if (body.success !== true || row?.uuid !== id)
  throw Error("Synthetic D1 identity mismatch; refuse to infer replica availability");
const mode = row.read_replication?.mode || "unspecified";
const primary = row.primary_location_hint || row.location || "unspecified";
console.log(
  "COVE_THIN_D1_READ_CAPACITY " +
    JSON.stringify({
      syntheticOnly: true,
      mode,
      primaryLocation: primary,
      inventoryOnly: true,
    }),
);
if (!["auto", "disabled", "unspecified"].includes(mode))
  throw Error("Unexpected synthetic D1 replication configuration");
