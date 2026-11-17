import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectPlacementReadiness,
  summarizePlacementReadiness,
} from "./phase-placement-readiness.mjs";

const service = (status = "SUCCESS") => ({
  default_environment: {
    script: {
      id: "cove-canonical-phase-readonly-staging",
      placement_mode: "smart",
      placement_status: status,
      handlers: ["fetch", "query"],
    },
  },
});

test("only a verified fetch service with SUCCESS is optimized, never release certified", () => {
  const good = summarizePlacementReadiness(service());
  assert.equal(good.optimized, true);
  assert.equal(good.status, "SUCCESS");
  assert.equal(good.releaseCertified, false);
  for (const status of ["INSUFFICIENT_INVOCATIONS", "UNSUPPORTED_APPLICATION", null]) {
    const value = summarizePlacementReadiness(service(status));
    assert.equal(value.optimized, false);
    assert.equal(value.releaseCertified, false);
    assert.equal(value.status, status ?? "NOT_ANALYZED");
  }
});

test("no uploaded configuration, RPC-only code or unknown placement state is enough", () => {
  for (const changed of [
    { placement_mode: "none" },
    { handlers: ["query"] },
    { id: "cove-persistence-backend" },
    { placement_status: "NEVER_VERIFY_ME" },
  ]) {
    const input = service();
    Object.assign(input.default_environment.script, changed);
    assert.throws(() => summarizePlacementReadiness(input));
  }
  assert.throws(() => summarizePlacementReadiness({}));
});

test("read-only request is scoped, provider failures fail closed, no payload leak", async () => {
  const token = "a".repeat(32);
  let calls = 0;
  const result = await inspectPlacementReadiness(token, async (url, opts) => {
    calls++;
    assert.equal(opts.method, "GET");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.headers.authorization, "Bearer " + token);
    assert.equal(
      url,
      "https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/workers/services/cove-canonical-phase-readonly-staging",
    );
    return { ok: true, json: async () => ({ success: true, result: service("INSUFFICIENT_INVOCATIONS") }) };
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "INSUFFICIENT_INVOCATIONS");
  assert.doesNotMatch(JSON.stringify(result), /Bearer|api.cloudflare.com|\ba{32}\b/);
  await assert.rejects(
    inspectPlacementReadiness(token, async () => ({ ok: false })),
    /Protected placement status read failed/,
  );
  await assert.rejects(inspectPlacementReadiness("", async () => {}));
});
