import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

// The narrow private query is proven against this exact canonical view. Stop
// deployment if the immutable snapshot or a future policy migration differs.
export async function requireIsolatedMembershipProfile(db) {
  const migration = fs.readFileSync("drizzle/0074_flatten_retail_membership.sql", "utf8");
  const expected = migration.slice(
    migration.indexOf("CREATE VIEW retail_product_availability_rows AS"),
    migration.indexOf("CREATE VIEW retail_product_availability AS"),
  );
  const normalize = (sql) =>
    String(sql || "")
      .trim()
      .replace(/;$/, "")
      .replace(/\s+/g, " ");
  const row = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='view' AND name='retail_product_availability_rows'",
    )
    .first();
  assert.equal(
    normalize(row?.sql),
    normalize(expected),
    "Isolated canonical membership schema does not match the proven policy profile",
  );
  return {
    schema: "cove.isolated-membership-profile.v1",
    viewSha256: createHash("sha256").update(normalize(expected)).digest("hex"),
  };
}
