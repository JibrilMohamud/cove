import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-offline-epub-client-"));
const store = new Map();
const calls = [];
const ownerId = "alice";
const book = { id: "cove_licensed_1", productId: "product_licensed_1", title: "A Licensed Book" };
const registeredKey = "test-registered-device-key-123";
const keypair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const pub = await crypto.subtle.exportKey("jwk", keypair.publicKey);
const verifyKey = { kty: "EC", crv: "P-256", x: pub.x, y: pub.y };
const hash = async (bytes) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
const keyId = await hash(new TextEncoder().encode(JSON.stringify(verifyKey)));
const ctx = "cove-offline-epub:v1\n";
let now = Date.now();
const realNow = Date.now;
Date.now = () => now;
let allowLicense = true;
let entitlementEnd = Infinity;
let receiptCounter = 0;
const renewal = async () => {
  if (!allowLicense)
    throw Object.assign(new Error("Publisher no longer permits offline access"), { status: 403 });
  const claims = {
    version: 1,
    audience: "cove-offline-epub",
    userId: ownerId,
    productId: book.productId,
    deviceKeyHash: await hash(new TextEncoder().encode(registeredKey)),
    assetVersionId: "asset_v1",
    licenseId: "grant_" + ++receiptCounter,
    issuedAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Math.min(Date.now() + 7 * 86400000, entitlementEnd)).toISOString(),
    keyId,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = Buffer.from(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keypair.privateKey,
      new TextEncoder().encode(ctx + payload),
    ),
  ).toString("base64url");
  return {
    url: "https://fore.test/licensed.epub",
    receipt: { payload, signature, keyId },
    expiresAt: claims.expiresAt,
    assetVersionId: claims.assetVersionId,
  };
};
globalThis.__epubFixture = {
  store,
  ownerId,
  api: async (route, method) => {
    calls.push([route, method]);
    if (route === "/offline-epub/verification-key") return { key: verifyKey, keyId };
    if (route === "/offline-epub/license") return renewal();
    throw Error("Unexpected API: " + route);
  },
};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
globalThis.localStorage = {
  getItem(name) {
    return name === "fore.device.key" ? registeredKey : null;
  },
};
globalThis.fetch = async (url) => {
  assert.equal(url, "https://fore.test/licensed.epub");
  return new Response(new TextEncoder().encode("Protected example EPUB"), { status: 200 });
};
const plugin = {
  name: "isolated-epub-storage",
  setup(builder) {
    const mapping = {
      "./client": `export async function api(...args) {return globalThis.__epubFixture.api(...args)}`,
      "./offline": `
        const name=(store,id)=>store+":"+id;
        export async function getRecord(store,id){return globalThis.__epubFixture.store.get(name(store,id))}
        export async function putRecord(store,item){globalThis.__epubFixture.store.set(name(store,item.id),item)}
        export async function deleteRecord(store,id){globalThis.__epubFixture.store.delete(name(store,id))}
        export async function getRecords(store){return [...globalThis.__epubFixture.store.entries()]
          .filter(([k])=>k.startsWith(store+":")).map(([,v])=>v)}
        export async function sha256(bytes){return Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex")}
      `,
      "./offline-account": `
        export function offlineAccountId(){return globalThis.__epubFixture.ownerId}
        export async function putOwnedRecord(store,item){
          if(item.ownerId!==globalThis.__epubFixture.ownerId) throw Error("Changed account");
          globalThis.__epubFixture.store.set(store+":"+item.id,item)
        }
      `,
    };
    builder.onResolve({ filter: /^\.\/(client|offline|offline-account)$/ }, (args) =>
      args.importer.endsWith("licensed-epub-client.ts")
        ? { path: args.path, namespace: "epub-fixture" }
        : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: "epub-fixture" }, (args) => ({
      contents: mapping[args.path],
      loader: "js",
    }));
  },
};
try {
  await build({
    entryPoints: ["src/features/fore/licensed-epub-client.ts"],
    outfile: path.join(root, "client.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [plugin],
  });
  const client = await import(pathToFileURL(path.join(root, "client.mjs")).href);
  await client.saveLicensedEpub(book);
  const recordId = "epub:licensed:" + ownerId + ":" + book.id;
  const first = store.get("downloads:" + recordId);
  assert.equal(calls.filter(([p]) => p === "/offline-epub/license").length, 1);
  assert.ok(first?.assetIds?.length === 2);
  assert.equal(
    new TextDecoder().decode(await client.licensedEpubBytes(book.id)),
    "Protected example EPUB",
  );
  assert.ok(store.get("assets:epub-verification-key:" + ownerId + ":" + keyId));
  // The untrusted public key embedded in a record must never authorize a forgery.
  const forgedPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const forgedPub = await crypto.subtle.exportKey("jwk", forgedPair.publicKey);
  const forgedKey = { kty: "EC", crv: "P-256", x: forgedPub.x, y: forgedPub.y };
  const altered = { ...first, publicKey: forgedKey };
  store.set("downloads:" + recordId, altered);
  assert.ok(
    await client.licensedEpubRecord(book.id),
    "attacker-provided public key cannot override server-trusted key",
  );
  // A self-signed receipt with an attacker-selected public key must be denied.
  const forgedPayload = first.receipt.payload;
  const forgedSignature = Buffer.from(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      forgedPair.privateKey,
      new TextEncoder().encode(ctx + forgedPayload),
    ),
  ).toString("base64url");
  store.set("downloads:" + recordId, {
    ...first,
    publicKey: forgedKey,
    receipt: { ...first.receipt, signature: forgedSignature },
  });
  assert.equal(
    await client.licensedEpubRecord(book.id),
    null,
    "forged receipt must not be accepted using a public key from the cached record",
  );
  store.set("downloads:" + recordId, first);
  const noTrustId = "assets:epub-verification-key:" + ownerId + ":" + keyId;
  const trusted = store.get(noTrustId);
  store.delete(noTrustId);
  assert.equal(
    await client.licensedEpubRecord(book.id),
    null,
    "receipt with no trusted key must not open",
  );
  store.set(noTrustId, trusted);

  now += 5 * 86400000;
  await client.renewExpiringLicensedEpubs(ownerId);
  assert.equal(receiptCounter, 1, "no renewal before final 24-hour window");
  now += 86400000;
  await Promise.all([
    client.renewExpiringLicensedEpubs(ownerId),
    client.renewExpiringLicensedEpubs(ownerId),
  ]);
  assert.equal(receiptCounter, 2, "concurrent renewals must share one fresh grant");
  const second = store.get("downloads:" + recordId);
  assert.notEqual(second.assetIds[0], first.assetIds[0], "renewal uses new encrypted generation");
  assert.equal(
    store.has("assets:" + first.assetIds[0]),
    false,
    "old encrypted generation cleaned up after swap",
  );
  assert.equal(
    new TextDecoder().decode(await client.licensedEpubBytes(book.id)),
    "Protected example EPUB",
  );

  allowLicense = false;
  now += 6 * 86400000;
  await client.renewExpiringLicensedEpubs(ownerId);
  assert.equal(
    store.get("downloads:" + recordId).receipt.payload,
    second.receipt.payload,
    "failed renewal must not overwrite previously authorized copy",
  );
  assert.equal(
    new TextDecoder().decode(await client.licensedEpubBytes(book.id)),
    "Protected example EPUB",
  );
  now += 86400000;
  assert.equal(
    await client.licensedEpubBytes(book.id),
    null,
    "expired license must not decrypt offline",
  );
  // A shorter, fixed loan end must not trigger new publisher downloads
  // every hour when no amount of renewal can extend the entitlement.
  allowLicense = true;
  entitlementEnd = now + 2 * 86400000;
  await client.saveLicensedEpub(book);
  now += 86400000;
  await client.renewExpiringLicensedEpubs(ownerId);
  const cappedGrantCount = receiptCounter;
  assert.equal(
    Date.parse(store.get("downloads:" + recordId).expiresAt),
    entitlementEnd,
  );
  now += 2 * 3600000;
  await client.renewExpiringLicensedEpubs(ownerId);
  assert.equal(
    receiptCounter,
    cappedGrantCount,
    "a fixed loan end must postpone repeated automatic renewals",
  );
  console.log(
    "PASS: seven-day client renewal, trusted HTTPS key, generation-safe replacement, failed renewal, offline expiry denial, and capped-loan cooldown.",
  );
} finally {
  Date.now = realNow;
  fs.rmSync(root, { recursive: true, force: true });
}
