import assert from "node:assert/strict";

export const CANDIDATE_VERSION = "adc603f1-d82a-44d9-b302-509690dec5bd";
export const CANDIDATE_NUMBER = 454;
export const EXPECTED_PREVIEW_ORIGIN =
  "https://adc603f1-cove-persistence-backend.cove-jibrilmohamud.workers.dev";
export const INVALID_SYNTHETIC_TOKEN = "cove-synthetic-invalid-readonly-auth-454";

export const READ_ONLY_CASES = Object.freeze([
  Object.freeze({ label: "health-no-token", path: "/__cove/health", invalidToken: false }),
  Object.freeze({ label: "health-invalid-token", path: "/__cove/health", invalidToken: true }),
  Object.freeze({
    label: "catalog-no-token",
    path: "/api/fore/storefront/bootstrap",
    invalidToken: false,
  }),
]);

export function assertSafePreviewCase(input) {
  assert.ok(READ_ONLY_CASES.some((x) => x === input), "Unapproved preview request");
  const url = new URL(input.path, EXPECTED_PREVIEW_ORIGIN);
  assert.equal(url.protocol, "https:");
  assert.equal(url.origin, EXPECTED_PREVIEW_ORIGIN);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.ok(url.pathname === input.path && input.path.startsWith("/"));
  return url;
}

export function assertUnauthorizedVersionResponse(response) {
  assert.equal(response.status, 401, "Version URL must deny unauthenticated requests");
  assert.equal(response.redirected, false, "Version URL may not redirect or bypass auth");
  assert.match(
    response.headers.get("cache-control") || "",
    /(?:^|[,\s])no-store(?:$|[,\s])/i,
    "Unauthorized Worker responses must never be cached",
  );
  assert.match(
    response.headers.get("content-type") || "",
    /^application\/json\b/i,
    "Expected the Worker backend's own JSON denial (not an Access page)",
  );
  assert.equal(
    response.headers.get("x-content-type-options"),
    "nosniff",
    "Worker backend must preserve its deny-by-default response headers",
  );
  return true;
}
