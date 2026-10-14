import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cove-epub-receipts-"));
try {
  await build({
    entryPoints: ["src/features/fore/offline-epub-crypto.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(directory, "crypto.mjs"),
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/features/fore/offline-audio-license.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(directory, "audio.mjs"),
    logLevel: "silent",
  });
  const verifier = await import(path.join(directory, "crypto.mjs"));
  const { audioKeyId, base64Url, hashText } = await import(path.join(directory, "audio.mjs"));
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const deviceKey = crypto.randomUUID() + crypto.randomUUID();
  const issued = Date.now();
  const account = "account-a";
  const productId = "commercial-test-product";
  const assetVersionId = "asset-version-one";
  async function createReceipt(overrides = {}, signingKey = pair.privateKey) {
    const claims = {
      version: 1,
      audience: "cove-offline-epub",
      userId: account,
      productId,
      assetVersionId,
      deviceKeyHash: await hashText(deviceKey),
      licenseId: crypto.randomUUID(),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + verifier.OFFLINE_EPUB_MAX_MS).toISOString(),
      keyId: await audioKeyId(publicKey),
      ...overrides,
    };
    const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
    const signature = base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          signingKey,
          new TextEncoder().encode(verifier.OFFLINE_EPUB_CONTEXT + payload),
        ),
      ),
    );
    return { receipt: { payload, signature, keyId: claims.keyId }, claims };
  }
  const { receipt, claims } = await createReceipt();
  const subject = {
    userId: account,
    productId,
    assetVersionId,
    deviceKey,
    expiresAt: claims.expiresAt,
    nowMs: issued + verifier.OFFLINE_EPUB_MAX_MS - 1,
  };
  assert.equal(verifier.OFFLINE_EPUB_MAX_MS, 7 * 86400000);
  await verifier.verifyOfflineEpubReceipt(receipt, publicKey, subject);
  await assert.rejects(
    () =>
      verifier.verifyOfflineEpubReceipt(receipt, publicKey, {
        ...subject,
        nowMs: issued + verifier.OFFLINE_EPUB_MAX_MS,
      }),
    /invalid or expired/,
    "expiry must be enforced at the seven-day boundary",
  );
  for (const mismatch of [
    { userId: "another-account" },
    { productId: "another-product" },
    { assetVersionId: "another-asset" },
    { deviceKey: "another-device" },
  ]) {
    await assert.rejects(
      () => verifier.verifyOfflineEpubReceipt(receipt, publicKey, { ...subject, ...mismatch }),
      /invalid or expired/,
    );
  }
  const tooLong = await createReceipt({
    expiresAt: new Date(issued + verifier.OFFLINE_EPUB_MAX_MS + 1).toISOString(),
  });
  await assert.rejects(
    () =>
      verifier.verifyOfflineEpubReceipt(tooLong.receipt, publicKey, {
        ...subject,
        expiresAt: tooLong.claims.expiresAt,
        nowMs: issued + 2000,
      }),
    /invalid or expired/,
  );
  await assert.rejects(
    () =>
      verifier.verifyOfflineEpubReceipt(receipt, publicKey, {
        ...subject,
        nowMs: issued + 1000,
        previousValidatedAt: issued + 61001,
      }),
    /invalid or expired/,
    "clock rollback must fail closed",
  );
  await assert.rejects(
    () =>
      verifier.verifyOfflineEpubReceipt(
        { ...receipt, payload: receipt.payload.slice(0, -2) + "AA" },
        publicKey,
        subject,
      ),
    /invalid or expired/,
    "tampered payload must be rejected",
  );
  const attackerPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const attacker = await createReceipt({}, attackerPair.privateKey);
  await assert.rejects(
    () => verifier.verifyOfflineEpubReceipt(attacker.receipt, publicKey, subject),
    /invalid or expired/,
    "untrusted signer cannot authorize a cached EPUB",
  );
  const forgedKey = await crypto.subtle.exportKey("jwk", attackerPair.publicKey);
  await assert.rejects(
    () => verifier.verifyOfflineEpubReceipt(receipt, forgedKey, subject),
    /invalid or expired/,
  );
  console.log(
    "PASS: seven-day expiry, receipt tampering, untrusted keys, account, device and asset binding",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
