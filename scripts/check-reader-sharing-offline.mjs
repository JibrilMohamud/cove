import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-reader-integrity-"));
const original = {
  fetch: globalThis.fetch,
  indexedDB: globalThis.indexedDB,
  localStorage: globalThis.localStorage,
};
try {
  fs.cpSync("drizzle", path.join(scratch, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      "api.server",
      "social.server",
      "offline",
      "offline-account",
      "offline-audio-license",
      "offline-audio.server",
      "offline-audio-client",
      "offline-epub-client",
      "audio-client",
      "epub",
    ].map((name) => `src/features/fore/${name}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: scratch,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const api = await import(path.join(scratch, "api.server.mjs"));
  const social = await import(path.join(scratch, "social.server.mjs"));
  const env = localBindings(scratch),
    db = env.DB,
    at = new Date().toISOString();
  const request = (route, method = "GET", body, user = "alice") =>
    new Request(`https://fore.test/api/fore${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": user,
        "oai-authenticated-user-email": `${user}@example.test`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  await api.handleCoveApi(request("/catalog?q=pride"), env);
  for (const user of ["alice", "bob", "charlie"]) {
    await db
      .prepare(
        "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(user, user, `${user}@example.test`, user, at)
      .run();
    await social.handleSocial(request("/social/me"), env, "/social/me", user);
  }
  await db
    .prepare("UPDATE social_profiles SET activity_visibility='public' WHERE user_id='alice'")
    .run();
  for (const follower of ["bob", "charlie"])
    await db
      .prepare(
        "INSERT INTO social_follows(follower_user_id,followed_user_id,created_at) VALUES(?,'alice',?)",
      )
      .bind(follower, at)
      .run();
  const product = await db
    .prepare("SELECT id FROM products WHERE source_external_id='1342'")
    .first();
  await db
    .prepare(
      "INSERT INTO reading_states(user_id,product_id,external_book_id,progress,cfi,updated_at) VALUES('bob',?,'1342',1,'',?)",
    )
    .bind(product.id, at)
    .run();
  const made = await api.handleCoveApi(
    request("/annotations", "POST", {
      bookId: "1342",
      quote: "A private test passage",
      cfi: "epubcfi(/6/2!/4/2)",
      chapter: "Chapter 1",
      color: "yellow",
      note: "A private test note",
      progress: 0.1,
    }),
    env,
  );
  assert.equal(made.status, 201);
  const annotation = await made.json(),
    sharePath = `/social/highlights/${annotation.id}/share`;
  const share = async (visibility = "public", options = {}) =>
    social.handleSocial(
      request(sharePath, "POST", {
        visibility,
        shareNote: true,
        expectedAnnotationVersion: (
          await db.prepare("SELECT version FROM annotations WHERE id=?").bind(annotation.id).first()
        ).version,
        audienceConfirmed: true,
        ...options,
      }),
      env,
      sharePath,
      "alice",
    );
  const feed = async (user = "bob") =>
    (await (await social.handleSocial(request("/social/feed"), env, "/social/feed", user)).json())
      .items;
  const margin = async () =>
    (
      await (
        await social.handleSocial(
          request("/social/reader/1342?mode=public&progress=1"),
          env,
          "/social/reader/1342",
          "bob",
        )
      ).json()
    ).indicators;
  await share();
  assert.equal((await margin())[0].highlights[0].note, "A private test note");
  assert.ok((await feed()).some((event) => event.entity_id === annotation.id));
  const deleted = await api.handleCoveApi(
    request(`/annotations/${annotation.id}`, "DELETE", { expectedVersion: 1 }),
    env,
  );
  assert.equal(deleted.status, 200);
  assert.equal((await margin()).length, 0, "deleted notes cannot remain in the margin");
  assert.equal((await feed()).length, 0, "deletion atomically removes feed copies");
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM social_annotation_shares WHERE annotation_id=?")
        .bind(annotation.id)
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT payload_json FROM social_events WHERE entity_id=?")
        .bind(annotation.id)
        .first()
    ).payload_json,
    "{}",
  );
  assert.equal(
    (await social.handleSocial(request(sharePath, "DELETE"), env, sharePath, "alice")).status,
    200,
    "owner can unshare after deletion",
  );
  await assert.rejects(share(), /Highlight not found/);
  await assert.rejects(
    social.handleSocial(request(sharePath, "DELETE"), env, sharePath, "bob"),
    /Highlight not found/,
  );

  // Restoring a tombstone here simulates old writer/race paths; the new API never restores deleted notes.
  await db.prepare("UPDATE annotations SET deleted_at=NULL WHERE id=?").bind(annotation.id).run();
  await share();
  await social.handleSocial(request(sharePath, "DELETE"), env, sharePath, "alice");
  assert.equal((await feed()).length, 0, "unshare removes the historical quoted payload");
  await share();
  const publicPublication = await (
    await social.handleSocial(request(sharePath), env, sharePath, "alice")
  ).json();
  const currentPublicShare = publicPublication?.shares?.find(
    (item) => item.visibility === "public",
  );
  assert.ok(currentPublicShare, "public publication can be managed independently");
  await share("friends", {
    shareId: currentPublicShare.id,
    expectedVersion: currentPublicShare.version,
  });
  assert.equal(
    (await feed()).length,
    0,
    "changing the selected public audience withdraws its feed copy",
  );
  await share();
  assert.ok((await feed()).length, "resharing in the same minute creates a fresh event");
  await db
    .prepare("UPDATE social_profiles SET activity_visibility='private' WHERE user_id='alice'")
    .run();
  assert.equal((await feed()).length, 0, "live privacy applies to older highlight events");
  await db.prepare("UPDATE annotations SET deleted_at=? WHERE id=?").bind(at, annotation.id).run();
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO social_annotation_shares(id,annotation_id,user_id,product_id,visibility,share_key,passage_hash,created_at,updated_at) VALUES('invalid-share',?,'alice','prd_gutenberg_1342','public','public','hash',?,?)",
      )
      .bind(annotation.id, at, at)
      .run(),
    /deleted/,
  );
  assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);

  // Structured-clone IndexedDB adapter: records are copied and transaction completion is asynchronous.
  const stores = new Map(["assets", "downloads", "outbox"].map((name) => [name, new Map()]));
  let afterWrite = null;
  let storageFailed = false;
  globalThis.indexedDB = {
    open() {
      const opening = {
        result: {
          transaction(name) {
            if (storageFailed) throw new Error("Storage unavailable");
            const map = stores.get(name);
            const tx = {
              objectStore() {
                return {
                  get(key) {
                    const r = {};
                    queueMicrotask(() => {
                      r.result = structuredClone(map.get(key));
                      r.onsuccess?.();
                    });
                    return r;
                  },
                  getAll() {
                    const r = {};
                    queueMicrotask(() => {
                      r.result = structuredClone([...map.values()]);
                      r.onsuccess?.();
                    });
                    return r;
                  },
                  put(value) {
                    map.set(value.id, structuredClone(value));
                    queueMicrotask(() => {
                      afterWrite?.();
                      tx.oncomplete?.();
                    });
                  },
                  delete(key) {
                    map.delete(key);
                    queueMicrotask(() => tx.oncomplete?.());
                  },
                };
              },
            };
            return tx;
          },
        },
      };
      queueMicrotask(() => opening.onsuccess?.());
      return opening;
    },
  };
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const offline = await import(path.join(scratch, "offline.mjs"));
  const account = await import(path.join(scratch, "offline-account.mjs"));
  const audio = await import(path.join(scratch, "audio-client.mjs"));
  const protectedAudio = await import(path.join(scratch, "offline-audio-client.mjs"));
  const licenseProtocol = await import(path.join(scratch, "offline-audio-license.mjs"));
  const issuer = await import(path.join(scratch, "offline-audio.server.mjs"));
  const epub = await import(path.join(scratch, "epub.mjs"));
  const publicEpub = await import(path.join(scratch, "offline-epub-client.mjs"));
  const book = {
    id: "prd_d34da79fe147c7c6998b0ea8cacbc391",
    publicProductId: "prd_d34da79fe147c7c6998b0ea8cacbc391",
    sourceExternalId: "1342",
    sourceName: "gutenberg",
    uploaded: false,
    title: "Pride and Prejudice",
  };
  const epubBytes = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]).buffer;
  await publicEpub.savePublicEpub(book, epubBytes);
  globalThis.fetch = async () => {
    throw new TypeError("Offline");
  };
  for (const ref of [book.id, "1342"]) {
    assert.deepEqual(await epub.epubBytes(ref), epubBytes);
    assert.equal((await epub.loadBookMetadata(ref)).id, book.id);
  }
  await offline.putRecord("assets", { id: `epub:${book.id}`, blob: new Blob([epubBytes]) });
  assert.deepEqual(
    await publicEpub.publicEpubBytes(book.id),
    epubBytes,
    "legacy public Blob records remain readable",
  );
  await account.setOfflineAccount("bob");
  assert.deepEqual(
    await epub.epubBytes(book.id),
    epubBytes,
    "public EPUB remains readable after account change",
  );
  await account.setOfflineAccount(null);
  assert.deepEqual(
    await epub.epubBytes(book.id),
    epubBytes,
    "public EPUB remains readable for guests",
  );
  await assert.rejects(
    epub.epubBytes(book.id, true),
    /Offline/,
    "samples never use the full-book cache",
  );
  const privateBook = {
    ...book,
    id: "prd_11111111111111111111111111111111",
    sourceName: "publisher",
  };
  await offline.putRecord("assets", { id: `epub:${privateBook.id}`, blob: new Blob([epubBytes]) });
  await offline.putRecord("downloads", {
    id: `epub:${privateBook.id}`,
    kind: "epub",
    complete: true,
    book: privateBook,
    assetIds: [`epub:${privateBook.id}`],
  });
  await assert.rejects(
    epub.epubBytes(privateBook.id),
    /Offline/,
    "canonical private files cannot masquerade as public downloads",
  );
  globalThis.fetch = async () => Response.json({ error: "Denied" }, { status: 403 });
  await assert.rejects(
    epub.loadBookMetadata(book.id),
    /Denied/,
    "authoritative errors cannot be hidden by metadata cache",
  );

  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const signingEnv = {
    FORE_OFFLINE_AUDIO_SIGNING_JWK: JSON.stringify(
      await crypto.subtle.exportKey("jwk", keyPair.privateKey),
    ),
  };
  const deviceKey = "local-test-device-identity-for-offline-audio";
  storage.set("fore.device.key", deviceKey);
  await account.setOfflineAccount("alice");
  const audioBytes = new TextEncoder().encode("licensed audio test bytes").buffer;
  const edition = {
    id: "ca_test",
    commercial: true,
    hasAccess: true,
    offlineEligible: true,
    productId: "audio-product",
    title: "Licensed recording",
    tracks: [{ id: "track-1", sha256: await offline.sha256(audioBytes), mime: "audio/mpeg" }],
  };
  const token = "local-test-license-token-" + crypto.randomUUID();
  const claims = {
    licenseId: "lic-test",
    userId: "alice",
    productId: edition.productId,
    editionId: edition.id,
    deviceId: "device-test",
    deviceKeyHash: await licenseProtocol.hashText(deviceKey),
    tokenHash: await licenseProtocol.hashText(token),
    manifestHash: await licenseProtocol.audioManifestHash(edition),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const signed = await issuer.signOfflineAudioLicense(signingEnv, claims);
  await assert.rejects(issuer.signOfflineAudioLicense({}, claims), /signing is not configured/);
  await db
    .prepare(
      "INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) SELECT 'audio-product',edition_id,'local-audio-sku','audiobook','publisher','local-audio-ref',?,? FROM products WHERE id='prd_gutenberg_1342'",
    )
    .bind(at, at)
    .run();
  await db
    .prepare(
      "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES('offline-purchase-test','alice','audio-product','purchase','active','local-test',?,?)",
    )
    .bind(at, at)
    .run();
  await db
    .prepare(
      "INSERT INTO devices(id,user_id,device_key,last_seen_at,created_at) VALUES('device-test','alice',?,?,?)",
    )
    .bind(deviceKey, at, at)
    .run();
  await db
    .prepare(
      "INSERT INTO audio_offline_licenses(id,user_id,product_id,entitlement_id,device_id,token_hash,manifest_hash,issued_at,expires_at,last_refreshed_at) VALUES('lic-test','alice','audio-product','offline-purchase-test','device-test',?,?,?,?,?)",
    )
    .bind(claims.tokenHash, claims.manifestHash, claims.issuedAt, claims.expiresAt, at)
    .run();
  const checkStored = (user = "alice", candidate = token, manifest = claims.manifestHash) =>
    issuer.verifyStoredAudioLicense(env, user, "audio-product", "lic-test", candidate, manifest);
  assert.equal((await checkStored()).valid, true);
  await assert.rejects(checkStored("bob"), /no longer active/);
  await assert.rejects(checkStored("alice", "wrong-token"), /no longer active/);
  await assert.rejects(checkStored("alice", token, "different-manifest"), /no longer active/);
  for (const [deny, restore] of [
    [
      "UPDATE devices SET revoked_at='2026-01-01' WHERE id='device-test'",
      "UPDATE devices SET revoked_at=NULL WHERE id='device-test'",
    ],
    [
      "UPDATE entitlements SET ends_at='2000-01-01' WHERE id='offline-purchase-test'",
      "UPDATE entitlements SET ends_at=NULL WHERE id='offline-purchase-test'",
    ],
  ]) {
    await db.prepare(deny).run();
    await assert.rejects(checkStored(), /no longer active/);
    await db.prepare(restore).run();
  }
  // Revoked offline license IDs are terminal. The actual refresh route revokes
  // the old ID and creates a new token instead of reactivating its old hash.
  await db.prepare("UPDATE audio_offline_licenses SET status='revoked' WHERE id='lic-test'").run();
  await assert.rejects(checkStored(), /no longer active/);
  await assert.rejects(
    db.prepare("UPDATE audio_offline_licenses SET status='active' WHERE id='lic-test'").run(),
    /requires a newly issued token/,
  );
  // Purchase revocation is separately terminal. Neither state can be revived
  // by a stale queue retry to restore a previously valid offline receipt.
  await db.prepare("UPDATE entitlements SET status='revoked' WHERE id='offline-purchase-test'").run();
  await assert.rejects(checkStored(), /no longer active/);
  await assert.rejects(
    db
      .prepare("UPDATE entitlements SET status='active' WHERE id='offline-purchase-test'")
      .run(),
    /fresh independently authorized purchase/,
  );
  const license = {
    licenseId: claims.licenseId,
    token,
    expiresAt: claims.expiresAt,
    manifestHash: claims.manifestHash,
    ...signed,
  };
  await licenseProtocol.verifyOfflineAudioLicense(license, signed.verificationKey, {
    userId: "alice",
    deviceKey,
    edition,
  });
  assert.equal(
    "d" in signed.verificationKey,
    false,
    "private signing material never reaches the client",
  );
  for (const invalid of [
    { ...license, token: "forged" },
    { ...license, expiresAt: "2099-01-01T00:00:00Z" },
    { ...license, receipt: { ...license.receipt, signature: "AAAA" } },
  ])
    await assert.rejects(
      licenseProtocol.verifyOfflineAudioLicense(invalid, signed.verificationKey, {
        userId: "alice",
        deviceKey,
        edition,
      }),
    );
  for (const expected of [
    { userId: "bob", deviceKey, edition },
    { userId: "alice", deviceKey: "different-device", edition },
    {
      userId: "alice",
      deviceKey,
      edition: { ...edition, tracks: [{ ...edition.tracks[0], sha256: "bad" }] },
    },
    { userId: "alice", deviceKey, edition, nowMs: Date.now() + 2 * 86400000 },
  ])
    await assert.rejects(
      licenseProtocol.verifyOfflineAudioLicense(license, signed.verificationKey, expected),
    );
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/device/register")) return Response.json({ id: claims.deviceId });
    if (String(url).endsWith("/offline-license")) return Response.json(license);
    if (String(url).includes("/tracks/"))
      return new Response(audioBytes, { headers: { "content-type": "audio/mpeg" } });
    throw new Error("Unexpected request: " + url);
  };
  await audio.saveCommercialAudioOffline(edition, new AbortController().signal, () => {});
  const record = await protectedAudio.storedLicensedAudio(edition.id, "alice");
  assert.equal(record.complete, true);
  const encrypted = await offline.getRecord(
    "assets",
    audio.audioAssetKey(edition, edition.tracks[0], "alice"),
  );
  assert.equal("blob" in encrypted, false, "private audio is not stored as a plaintext blob");
  assert.equal((await offline.getRecord("assets", record.keyId)).key.extractable, false);
  globalThis.fetch = async () => {
    throw new TypeError("Offline");
  };
  assert.equal((await audio.loadEdition(edition.id, "alice")).id, edition.id);
  assert.deepEqual(await (await audio.audioBlob(edition, "track-1")).arrayBuffer(), audioBytes);
  await assert.rejects(audio.loadEdition(edition.id, "bob"), /account|copy|access/);
  // Encrypted bytes, signatures, account identity and device identity all fail closed.
  const altered = { ...encrypted, ciphertext: new Uint8Array([1, 2, 3]).buffer };
  await offline.putRecord("assets", altered);
  await assert.rejects(protectedAudio.licensedAudioBlob(edition, edition.tracks[0], "alice"));
  assert.equal(await protectedAudio.storedLicensedAudio(edition.id, "alice"), null);
  // A genuine encrypted copy must be removed after a live authorization denial.
  const downloadFetch = async (url) => {
    if (String(url).endsWith("/device/register")) return Response.json({ id: claims.deviceId });
    if (String(url).endsWith("/offline-license")) return Response.json(license);
    if (String(url).includes("/tracks/"))
      return new Response(audioBytes, { headers: { "content-type": "audio/mpeg" } });
    return Response.json(edition);
  };
  globalThis.fetch = downloadFetch;
  await audio.saveCommercialAudioOffline(edition, new AbortController().signal, () => {});
  globalThis.fetch = async () =>
    Response.json({ error: "Authorization withdrawn" }, { status: 403 });
  await assert.rejects(audio.loadEdition(edition.id, "alice"), /Authorization withdrawn/);
  assert.equal(await protectedAudio.storedLicensedAudio(edition.id, "alice"), null);
  globalThis.fetch = downloadFetch;
  await audio.saveCommercialAudioOffline(edition, new AbortController().signal, () => {});
  globalThis.fetch = async (url) =>
    String(url).endsWith("/offline-license/verify")
      ? Response.json({ error: "Device revoked" }, { status: 403 })
      : Response.json(edition);
  assert.equal(
    (await audio.loadEdition(edition.id, "alice")).hasAccess,
    true,
    "online purchase access still permits streaming after offline device revocation",
  );
  assert.equal(
    await protectedAudio.storedLicensedAudio(edition.id, "alice"),
    null,
    "online license denial removes decrypted-offline eligibility",
  );
  globalThis.fetch = async () => {
    throw new TypeError("Offline");
  };
  // Legacy authorization flags cannot be used as a replacement for a signed receipt.
  await offline.putRecord("downloads", {
    id: `audio:${edition.id}`,
    edition,
    commercialLicense: { expiresAt: claims.expiresAt },
  });
  await assert.rejects(audio.loadEdition(edition.id, "alice"), /No licensed offline copy/);
  globalThis.fetch = async () =>
    Response.json({ error: "Authorization withdrawn" }, { status: 401 });
  await assert.rejects(audio.loadEdition(edition.id, "alice"), /Authorization withdrawn/);
  globalThis.fetch = downloadFetch;
  await audio.saveCommercialAudioOffline(edition, new AbortController().signal, () => {});
  await account.setOfflineAccount("bob");
  assert.equal(
    await protectedAudio.storedLicensedAudio(edition.id, "alice"),
    null,
    "account switching removes genuine private downloads and their decryption keys",
  );
  assert.equal(
    await offline.getRecord("downloads", `audio:${edition.id}`),
    undefined,
    "switching accounts removes legacy unscoped private downloads",
  );
  afterWrite = () => storage.set("cove:offline-account:v1", "charlie");
  await assert.rejects(
    account.putOwnedRecord("assets", { id: "race-asset", ownerId: "bob", value: "private" }),
    /account changed/,
  );
  afterWrite = null;
  assert.equal(await offline.getRecord("assets", "race-asset"), undefined);
  await account.setOfflineAccount(null);
  assert.deepEqual(await epub.epubBytes(book.id), epubBytes);
  storageFailed = true;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/epub") ? new Response(epubBytes) : Response.json(edition);
  assert.deepEqual(
    await epub.epubBytes(book.id),
    epubBytes,
    "unavailable storage must not break online EPUB reads",
  );
  assert.equal(
    (await audio.loadEdition(edition.id)).id,
    edition.id,
    "unavailable storage must not break authoritative online metadata",
  );
  storageFailed = false;

  // Render actual components under a real memory router, without browser globals.
  await build({
    stdin: {
      contents: `import React from "react"; import {renderToString} from "react-dom/server"; import {QueryClient,QueryClientProvider} from "@tanstack/react-query"; import {createRouter,createRootRoute,createRoute,createMemoryHistory,RouterProvider,Outlet} from "@tanstack/react-router"; import {ReaderPage} from "./src/features/fore/Reader"; import {CommunityPage} from "./src/features/fore/Community"; import {CoveProvider} from "./src/features/fore/App"; export async function renderPage(kind,search="") { const root=createRootRoute({component:Outlet}); const route=createRoute({getParentRoute:()=>root,path:"/",component:()=>kind==="reader"?React.createElement(ReaderPage,{id:"1342"}):React.createElement(CommunityPage)}); const router=createRouter({routeTree:root.addChildren([route]),history:createMemoryHistory({initialEntries:["/"+search]})}); await router.load(); return renderToString(React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(CoveProvider,null,React.createElement(RouterProvider,{router})))); }`,
      resolveDir: process.cwd(),
      sourcefile: "reader-ssr-test.tsx",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(scratch, "ssr.mjs"),
    loader: { ".css": "empty" },
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  const { renderPage } = await import(path.join(scratch, "ssr.mjs"));
  for (const [kind, search] of [
    ["reader", ""],
    ["reader", "?preview=1"],
    ["community", ""],
    ["community", "?tab=sharing"],
    ["community", "?tab=received"],
    ["community", "?profile=bob"],
    ["community", "?journey=test"],
    ["community", "?club=test"],
    ["community", "?list=test"],
  ]) {
    const html = await renderPage(kind, search);
    assert.ok(html.length > 20, `${kind}${search} must render a meaningful shell`);
    assert.doesNotMatch(
      html,
      /window is not defined|location is not defined|This page didn.t load/,
    );
  }
  console.log(
    "PASS: actual SSR routes, atomic share withdrawal and audience changes, canonical EPUB offline reads, signed/device/account-bound encrypted audio, authoritative denials, tamper rejection, and account-change fencing.",
  );
} finally {
  Object.assign(globalThis, original);
  fs.rmSync(scratch, { recursive: true, force: true });
}
