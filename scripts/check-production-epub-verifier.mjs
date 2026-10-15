import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// This is a read-only, public-key-only deployment smoke test.
// It never requests or displays the sensitive private signing secret.
const url = new URL(
  "/api/fore/offline-epub/verification-key",
  process.env.COVE_PUBLIC_URL || "https://cove-puce-theta.vercel.app",
);
assert.equal(url.protocol, "https:", "Production verification requires HTTPS");

const pins = readFileSync("src/features/fore/offline-epub-pin.ts", "utf8");
const expected = [
  ...pins.matchAll(
    /\{\s*kty:\s*"EC",\s*crv:\s*"P-256",\s*x:\s*"([A-Za-z0-9_-]+)",\s*y:\s*"([A-Za-z0-9_-]+)"/g,
  ),
].map((match) => ({ kty: "EC", crv: "P-256", x: match[1], y: match[2] }));
assert.ok(expected.length, "No independently pinned public verifier in Cove's bundle");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 12_000);
try {
  const response = await fetch(url, {
    cache: "no-store",
    signal: controller.signal,
    redirect: "error",
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200, "Production verifier endpoint must return 200");
  assert.match(response.headers.get("content-type") || "", /application\/json/i);
  const data = await response.json();
  const publicKey = data.publicKey;
  assert.ok(publicKey && typeof publicKey === "object", "Missing verifier");
  assert.ok(!("d" in publicKey), "Private signing component must never be exposed");
  assert.deepEqual(Object.keys(publicKey).sort(), ["crv", "kty", "x", "y"]);
  assert.ok(
    expected.some((key) => key.x === publicKey.x && key.y === publicKey.y),
    "The production signer is not in the independently pinned verifier set",
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y }))
    .digest("hex");
  assert.equal(data.keyId, fingerprint, "Public verifier fingerprint mismatch");
  console.log("PASS: HTTPS production offline-EPUB verifier matches signed application pin");
} finally {
  clearTimeout(timeout);
}
