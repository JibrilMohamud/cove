/**
 * Safe cleanup of exactly this run's ephemeral Worker, never any production
 * or shared QA Worker. A failed deletion fails CI; 15m lease remains closed.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const run = process.env.GITHUB_RUN_ID;
assert.match(run || "", /^[0-9]{8,15}$/);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
const name = "cove-owner-do-capacity-" + run;
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const base = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + "/workers/scripts/" + name;
async function call(method, suffix = "") {
  const r = await fetch(base + suffix, {
    method, headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return { missing: true };
  if (!r.ok) throw Error("Isolated owner stage control HTTP " + r.status);
  const data = await r.json();
  if (!data.success) throw Error("Isolated owner stage control returned failure");
  return { missing: false, result: data.result };
}
let removed = false;
try {
  const current = await call("GET", "/settings");
  if (current.missing) {
    removed = true;
  } else {
    const bindings = current.result?.bindings || [];
    assert.ok(bindings.some((b) => b.name === "OWNER_DO" &&
      b.type === "durable_object_namespace" && b.class_name === "StageUnifiedOwner"),
    "Refuse deletion if script is no longer an isolated owner stage");
    assert.ok(bindings.some((b) => b.name === "COVE_OWNER_DO_STAGE" &&
      b.type === "plain_text" && b.text === "1"));
    assert.equal(bindings.some((b) => b.type === "d1" || b.type === "service"), false);
    await call("DELETE");
    for (let i = 0; i < 15; i++) {
      const checked = await call("GET", "/settings");
      if (checked.missing) { removed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert.equal(removed, true, "Ephemeral owner stage Worker remains deployed");
  console.log(JSON.stringify({ event: "cove_owner_do_stage_removed", removed: true,
    releaseCertified: false }));
} finally {
  rmSync(".output/stage-owner-do/secrets.json", { force: true });
  rmSync("wrangler.owner-do-capacity.generated.jsonc", { force: true });
}
