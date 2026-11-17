import assert from "node:assert/strict";
import { safeQaHttpResponseEvidence } from "./staging/safe-qa-http-response-evidence.mjs";

const legit = new Headers({
  "cf-ray": "0123456789abcdef-ORD",
  "x-cove-qa-ingress-colo": "ORD",
  "x-cove-qa-unavailable-layer": "caller",
  "cf-placement": "remote-IAD",
  "set-cookie": "private-session-do-not-expose",
  authorization: "Bearer must-never-leak",
});
const exact = safeQaHttpResponseEvidence(legit);
assert.deepEqual(exact, {
  ray: "0123456789abcdef-ORD",
  ingressColo: "ORD",
  unavailableLayer: "caller",
  cfPlacement: "remote-IAD",
});
assert.doesNotMatch(JSON.stringify(exact), /private-session|Bearer/);
for (const [key, invalid] of [
  ["cf-ray", "request-identifier-private"],
  ["cf-ray", "0123456789abcdef-ORD\r\nAuthorization: Bearer private"],
  ["x-cove-qa-ingress-colo", "A-1"],
  ["x-cove-qa-unavailable-layer", "authorization-secret"],
  ["cf-placement", "hello-world"],
]) {
  const candidate = new Headers(legit);
  candidate.set(key, invalid);
  const projected = safeQaHttpResponseEvidence(candidate);
  assert.ok(!JSON.stringify(projected).includes(invalid));
  if (key === "cf-ray") assert.equal(projected.ray, null);
  if (key === "x-cove-qa-ingress-colo") assert.equal(projected.ingressColo, null);
  if (key === "x-cove-qa-unavailable-layer") assert.equal(projected.unavailableLayer, null);
  if (key === "cf-placement") assert.equal(projected.cfPlacement, null);
}
assert.deepEqual(safeQaHttpResponseEvidence(new Headers()), {
  ray: null,
  ingressColo: null,
  unavailableLayer: null,
  cfPlacement: null,
});
console.log("PASS QA 404 evidence: only validated Ray/colo/enum, never secrets or raw headers");
