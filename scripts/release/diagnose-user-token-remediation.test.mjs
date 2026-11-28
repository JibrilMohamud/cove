import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseUserTokenRemediation } from "./diagnose-user-token-remediation.mjs";

const row = (id, name, group) => ({
  id: id.repeat(32),
  name,
  status: "active",
  policies: [{ permission_groups: [{ name: group }] }],
});
const page = (result) => ({
  result,
  result_info: { page: 1, count: result.length, total_count: result.length },
});
test("private report identifies blocked tokens without treating them as safe", async () => {
  const rows = [row("a", "read", "D1 Read"), row("b", "write", "D1 Write")];
  const report = await diagnoseUserTokenRemediation(async (path) => {
    assert.equal(path, "/user/tokens");
    return page(rows);
  }, "fixture");
  assert.equal(report.full.verified, false);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].tokenId, "b".repeat(32));
  assert.equal(report.findings[0].evidence.reason, "active_user_token_mutation_capability");
  assert.equal(report.releaseCertified, false);
  assert.equal(report.mutationPerformed, false);
});
test("incomplete and duplicate token identities fail closed", async () => {
  const token = row("a", "read", "D1 Read");
  for (const inventory of [
    { ...page([token]), result_info: { page: 1, count: 1, total_count: 2 } },
    page([token, token]),
  ]) {
    await assert.rejects(diagnoseUserTokenRemediation(async () => inventory, "fixture"));
  }
});
