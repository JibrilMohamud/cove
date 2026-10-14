import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cove-offline-epub-client-"));
try {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicOnly = {
    kty: "EC",
    crv: "P-256",
    x: publicKey.x,
    y: publicKey.y,
  };
  const digest = async (value) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const keyId = await digest(JSON.stringify(publicOnly));
  const payloadBytes = new TextEncoder().encode("Encrypted licensed EPUB fixture");
  const device = "test-device" + crypto.randomUUID();
  let owner = "alice";
  let connected = true;
  let entitled = true;
  let networkDownloads = 0;
  const storage = new Map();
  globalThis.window = { location: { origin: "https://cove.test" } };
  globalThis.localStorage = {
    getItem: (name) => (name === "fore.device.key" ? device : null),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      get onLine() {
        return connected;
      },
    },
  });
  const book = { id: "public-id-1", productId: "commercial-product-1", title: "Fixture EPUB" };
  const signing = async () => {
    const issued = Date.now();
    const claims = {
      version: 1,
      audience: "cove-offline-epub",
      keyId,
      userId: owner,
      productId: book.productId,
      assetVersionId: "asset-1",
      deviceKeyHash: await digest(device),
      licenseId: crypto.randomUUID(),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + 7 * 86400000).toISOString(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = Buffer.from(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode("cove-offline-epub:v1\n" + payload),
      ),
    ).toString("base64url");
    return {
      url: "https://cove.test/asset",
      receipt: { payload, signature, keyId },
      assetVersionId: claims.assetVersionId,
      expiresAt: claims.expiresAt,
    };
  };
  globalThis.__coveOfflineTest = {
    storage,
    pinned: [publicOnly],
    get owner() {
      return owner;
    },
    async api(route) {
      if (route === "/offline-epub/verification-key") return { keyId, publicKey: publicOnly };
      if (route === "/offline-epub/license") {
        if (!entitled) throw Error("Publisher rights deny renewal.");
        return signing();
      }
      throw Error("Unexpected endpoint");
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkDownloads++;
    return { ok: true, arrayBuffer: async () => payloadBytes.buffer.slice(0) };
  };
  await build({
    entryPoints: ["src/features/fore/licensed-epub-client.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(temp, "client.mjs"),
    logLevel: "silent",
    plugins: [
      {
        name: "mock-private-browser-state",
        setup(plugin) {
          const mocks = {
            client: "export const api = (...args) => globalThis.__coveOfflineTest.api(...args);",
            offline: `export const getRecord = async (_store,id) => globalThis.__coveOfflineTest.storage.get(id);
export const getRecords = async () => [...globalThis.__coveOfflineTest.storage.values()];
export const putRecord = async (_store,value) => { globalThis.__coveOfflineTest.storage.set(value.id,value); };
export const deleteRecord = async (_store,id) => { globalThis.__coveOfflineTest.storage.delete(id); };
export const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(x=>x.toString(16).padStart(2,"0")).join("");`,
            "offline-account": `export const offlineAccountId = () => globalThis.__coveOfflineTest.owner;
export const putOwnedRecord = async (_store,value) => {
  if(value.ownerId !== globalThis.__coveOfflineTest.owner) throw Error("Account changed");
  globalThis.__coveOfflineTest.storage.set(value.id,value);
};`,
            "offline-epub-pin":
              "export const TRUSTED_OFFLINE_EPUB_PUBLIC_KEYS = globalThis.__coveOfflineTest.pinned;",
          };
          plugin.onResolve(
            { filter: /^\.\/(client|offline|offline-account|offline-epub-pin)$/ },
            (args) =>
              args.importer.endsWith("licensed-epub-client.ts")
                ? { path: args.path.slice(2), namespace: "epub-fixture" }
                : undefined,
          );
          plugin.onLoad({ filter: /.*/, namespace: "epub-fixture" }, (args) => ({
            contents: mocks[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  const client = await import(path.join(temp, "client.mjs"));
  try {
    await client.saveLicensedEpub(book);
    assert.equal(networkDownloads, 1);
    const recordId = "epub:licensed:alice:public-id-1";
    const recorded = storage.get(recordId);
    assert.ok(recorded, "encrypted record persisted");
    assert.equal(recorded.publicKey, undefined, "receipt never supplies a trust anchor");
    assert.equal(storage.get(recorded.assetIds[1]).key.extractable, false);
    assert.notDeepEqual(new Uint8Array(storage.get(recorded.assetIds[0]).ciphertext), payloadBytes);
    connected = false;
    assert.equal(
      new TextDecoder().decode(await client.licensedEpubBytes(book.id)),
      new TextDecoder().decode(payloadBytes),
      "offline reopening decrypts the authorized edition",
    );
    const corrupted = structuredClone(recorded);
    corrupted.receipt.signature = (corrupted.receipt.signature[0] === "A" ? "B" : "A") + corrupted.receipt.signature.slice(1);
    storage.set(recordId, corrupted);
    assert.equal(await client.licensedEpubBytes(book.id), null);
    storage.set(recordId, recorded);
    owner = "bob";
    assert.equal(await client.licensedEpubBytes(book.id), null, "another account cannot reopen it");
    owner = "alice";
    connected = true;
    entitled = false;
    await assert.rejects(() => client.renewLicensedEpub(book.id), /Publisher rights/);
    assert.ok(await client.licensedEpubBytes(book.id), "denied renewal preserves valid content");
    entitled = true;
    assert.equal(await client.renewLicensedEpub(book.id), true);
    assert.equal(networkDownloads, 1, "same-asset renewal avoids a second download");
    const renewed = storage.get(recordId);
    assert.notDeepEqual(renewed.assetIds, recorded.assetIds);
    assert.equal(storage.has(recorded.assetIds[0]), false);
    connected = false;
    assert.ok(await client.licensedEpubBytes(book.id));
    console.log("PASS: encrypted save, offline reopening, tamper isolation and atomic renewal");
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
