import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-seven-day-epub-"));
try {
  const deliveryStub = {
    name: "offline-epub-rights-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/delivery\.server$/ }, (args) =>
        args.importer.endsWith("offline-epub.server.ts")
          ? { path: "delivery", namespace: "rights-fixture" }
          : undefined,
      );
      builder.onLoad({ filter: /.*/, namespace: "rights-fixture" }, () => ({
        contents: `export async function issueCommercialEpubGrant(env, userId, details) {
          env.grants.push({ userId, details });
          if (!env.allowed) throw Object.assign(new Error("Publisher offline access denied"), {status:403});
          return {
            grantId: "grant_" + env.grants.length,
            assetVersionId: env.assetVersion || "asset_v1",
            url: "https://fore.test/epub",
          };
        }`,
        loader: "js",
      }));
    },
  };
  await build({
    entryPoints: [
      "src/features/fore/offline-epub.server.ts",
      "src/features/fore/offline-epub-policy.ts",
    ],
    outdir: root,
    outExtension: { ".js": ".mjs" },
    format: "esm",
    platform: "node",
    bundle: true,
    logLevel: "silent",
    plugins: [deliveryStub],
  });
  const { issueOfflineEpubLicense, offlineEpubVerificationKey } = await import(
    pathToFileURL(path.join(root, "offline-epub.server.mjs")).href
  );
  const policy = await import(pathToFileURL(path.join(root, "offline-epub-policy.mjs")).href);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const fixtures = {
    allowed: true,
    device: { id: "device1" },
    drm: { drm_status: "none" },
    entitlement: { ends_at: null },
    grants: [],
    FORE_OFFLINE_AUDIO_SIGNING_JWK: JSON.stringify(privateJwk),
    DB: {
      prepare(statement) {
        return {
          bind() {
            return {
              async first() {
                if (statement.includes("FROM devices")) return fixtures.device;
                if (statement.includes("FROM asset_versions")) return fixtures.drm;
                if (statement.includes("FROM commercial_delivery_grants"))
                  return fixtures.entitlement;
                throw new Error("Unrecognized query: " + statement);
              },
            };
          },
        };
      },
    },
  };
  const raw = { productId: "cove-product1", deviceKey: "registered-device-key-12345" };
  const request = new Request("https://fore.test/api/fore/offline-epub/license");
  const verify = async (license) => {
    const { key, keyId } = await offlineEpubVerificationKey(fixtures);
    assert.equal(license.receipt.keyId, keyId);
    const pub = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = Buffer.from(
      license.receipt.signature.replace(/-/g, "+").replace(/_/g, "/"),
      "base64url",
    );
    assert.equal(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pub,
        signature,
        new TextEncoder().encode(policy.OFFLINE_EPUB_CONTEXT + license.receipt.payload),
      ),
      true,
    );
    assert.equal(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pub,
        signature,
        new TextEncoder().encode("tampered-context" + license.receipt.payload),
      ),
      false,
    );
    return JSON.parse(Buffer.from(license.receipt.payload, "base64url").toString("utf8"));
  };
  const first = await issueOfflineEpubLicense(fixtures, "alice", raw, request);
  const claims = await verify(first);
  const issued = Date.parse(claims.issuedAt);
  const expiry = Date.parse(claims.expiresAt);
  assert.equal(expiry - issued, policy.OFFLINE_EPUB_LICENSE_MS);
  assert.equal(expiry - issued, 7 * 24 * 60 * 60 * 1000);
  assert.equal(policy.validOfflineEpubWindow(issued, expiry, issued), true);
  assert.equal(policy.validOfflineEpubWindow(issued, expiry, expiry - 1), true);
  assert.equal(policy.validOfflineEpubWindow(issued, expiry, expiry), false);
  assert.equal(policy.validOfflineEpubWindow(issued, expiry + 1, issued), false);
  assert.equal(policy.validOfflineEpubWindow(issued, expiry, issued - 60_001), false);
  assert.equal(policy.shouldRenewOfflineEpub(expiry, expiry - 24 * 60 * 60 * 1000 - 1), false);
  assert.equal(policy.shouldRenewOfflineEpub(expiry, expiry - 24 * 60 * 60 * 1000), true);

  fixtures.entitlement = { ends_at: new Date(issued + 2 * 24 * 60 * 60 * 1000).toISOString() };
  const shortened = await issueOfflineEpubLicense(fixtures, "alice", raw, request);
  const shortenedClaims = await verify(shortened);
  assert.equal(Date.parse(shortenedClaims.expiresAt), Date.parse(fixtures.entitlement.ends_at));
  fixtures.entitlement = { ends_at: new Date(issued - 1000).toISOString() };
  await assert.rejects(
    () => issueOfflineEpubLicense(fixtures, "alice", raw, request),
    (error) => error.status === 403,
  );
  fixtures.entitlement = { ends_at: null };
  fixtures.allowed = false;
  await assert.rejects(
    () => issueOfflineEpubLicense(fixtures, "alice", raw, request),
    (error) => error.status === 403,
  );
  fixtures.allowed = true;
  fixtures.device = null;
  await assert.rejects(
    () => issueOfflineEpubLicense(fixtures, "alice", raw, request),
    (error) => error.status === 428,
  );
  fixtures.device = { id: "device1" };
  fixtures.drm = { drm_status: "adobe-drm" };
  await assert.rejects(
    () => issueOfflineEpubLicense(fixtures, "alice", raw, request),
    (error) => error.status === 403,
  );
  fixtures.drm = { drm_status: "none" };
  fixtures.FORE_OFFLINE_AUDIO_SIGNING_JWK = "";
  await assert.rejects(
    () => issueOfflineEpubLicense(fixtures, "alice", raw, request),
    (error) => error.status === 503,
  );
  assert.ok(fixtures.grants.length >= 4, "renewal must seek a new rights-checked grant");
  console.log(
    "PASS: 7-day expiry, last-day renewal window, signed receipt, entitlement truncation, publisher denial, device/DRM rejection and missing signing key.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
