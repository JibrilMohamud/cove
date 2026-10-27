/* eslint-disable prettier/prettier -- Isolated sandbox fixtures preserve explicit security assertions and synthetic input construction. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

// Runs entirely in a disposable local DB/R2 domain. No Stripe, production D1,
// customer identities, publisher media or external audio recordings are used.
function originalWave() {
  const sampleRate = 8000;
  const samples = 4000;
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const taper = Math.min(1, i / 400, (samples - i) / 400);
    const value = Math.round(
      3500 * Math.max(0, taper) * Math.sin((i * 2 * Math.PI * 440) / sampleRate),
    );
    out.writeInt16LE(value, 44 + i * 2);
  }
  return out;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-original-audio-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  const moduleFile = path.join(root, "commercial-audio-fixture.mjs");
  const original = fs.readFileSync("src/features/fore/commercial-audio.server.ts", "utf8");
  // Expose an otherwise private storage primitive exclusively inside the
  // throwaway test bundle. The real production module is never modified.
  await build({
    stdin: {
      contents: original + "\nexport { serveStoredAudio };\n",
      sourcefile: "commercial-audio-qa.ts",
      resolveDir: path.resolve("src/features/fore"),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: moduleFile,
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "api.mjs"),
    logLevel: "silent",
  });
  const audio = await import(moduleFile);
  const api = await import(path.join(root, "api.mjs"));
  const env = localBindings(root);
  await api.handleCoveApi(new Request("https://cove.qa/api/fore/catalog"), env);
  const product = await env.DB.prepare(
    "SELECT id FROM products WHERE source_external_id='1342'",
  ).first();
  assert.ok(product, "fixture must seed a known local catalog product");
  const userId = "qa_original_audio_" + randomUUID();
  const otherId = "qa_other_reader_" + randomUUID();
  const objectKey = "qa/synthetic/original-tone.wav";
  const bytes = originalWave();
  await env.BUCKET.put(objectKey, bytes);
  const asset = {
    object_key: objectKey,
    mime_type: "audio/wav",
    size_bytes: bytes.length,
  };
  const route = "https://cove.qa/api/fore/audio/qa-original/tracks/intro";
  async function protectedRead(user, range) {
    if (!(await audio.hasAudioAccess(env.DB, user, product.id, "US"))) {
      throw Error("protected_audio_access_denied");
    }
    await audio.assertCommercialAudioRiskAccess(env.DB, user, product.id);
    return audio.serveStoredAudio(
      new Request(route, { headers: range ? { range } : undefined }),
      env,
      asset,
      "private, no-store",
    );
  }
  await assert.rejects(protectedRead(userId), /protected_audio_access_denied/);
  await assert.rejects(protectedRead(otherId), /protected_audio_access_denied/);
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'purchase','active','qa-original-fixture',?,?)",
  )
    .bind("ent_qa_" + randomUUID(), userId, product.id, stamp, stamp)
    .run();
  assert.equal(await audio.hasAudioAccess(env.DB, userId, product.id, "US"), true);
  assert.equal(await audio.hasAudioAccess(env.DB, otherId, product.id, "US"), false);
  const streamed = await protectedRead(userId);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get("content-type"), "audio/wav");
  assert.equal(streamed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), bytes);
  const partial = await protectedRead(userId, "bytes=0-63");
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-63/${bytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 64));
  await assert.rejects(protectedRead(otherId), /protected_audio_access_denied/);
  await env.DB.prepare("UPDATE entitlements SET status='revoked',updated_at=? WHERE user_id=?")
    .bind(new Date().toISOString(), userId)
    .run();
  await assert.rejects(protectedRead(userId), /protected_audio_access_denied/);
  // Exercise the actual published commercial-audio HTTP handler, not just the
  // storage primitive. Only the publisher/manifest lookup is fixture-backed:
  // entitlements, risk holds, live territorial rights and R2 reads all use the
  // real disposable Cove database. This is not a deployed-browser certification.
  const publishedUser = "qa_http_audio_" + randomUUID();
  const publishedId = "qa-original-published";
  const publishedRow = {
    edition_id: publishedId,
    product_id: product.id,
    title: "Cove original synthetic sound",
    language: "en",
    library_permitted: 0,
    source_external_id: "qa-original-published",
    authors_json: "[]",
  };
  const frozen = {
    profile: {
      performanceRightsBasis: "Synthetic original test recording",
      territoryScope: { mode: "worldwide" },
      subscriptionEligible: false,
      offlineEligible: false,
    },
    narrators: [{ id: "narrator_qa", displayName: "Synthetic QA", narrationType: "synthetic" }],
    agreements: [
      {
        id: "agreement_qa",
        narrator_id: "narrator_qa",
        status: "active",
        permittedUses: ["retail", "preview"],
        territories: ["WORLD"],
      },
    ],
    chapters: [
      {
        id: "intro",
        title: "Synthetic test tone",
        duration_ms: 500,
        object_key: objectKey,
        mime_type: "audio/wav",
        size_bytes: bytes.length,
        sha256: "synthetic-fixture",
      },
    ],
  };
  const fixtureEnv = {
    ...env,
    DB: {
      ...env.DB,
      prepare(sql) {
        const plain = String(sql);
        if (plain.includes("FROM commercial_audio_profiles cap JOIN publishing_edition_drafts")) {
          return {
            bind(id) {
              assert.equal(id, publishedId);
              return { first: async () => publishedRow };
            },
          };
        }
        if (plain.includes("FROM publishing_publications pp")) {
          return {
            bind(id) {
              assert.equal(id, publishedRow.product_id);
              return {
                first: async () => ({
                  manifest_json: JSON.stringify({ sourceSnapshot: { commercialAudio: frozen } }),
                }),
              };
            },
          };
        }
        if (plain.includes("FROM narration_agreement_terminations")) {
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        }
        return env.DB.prepare(sql);
      },
    },
  };
  const trackPath = "/audio/ca_" + publishedId + "/tracks/intro";
  const trackRequest = (range) =>
    new Request("https://cove.qa/api/fore" + trackPath, {
      headers: range ? { range } : undefined,
    });
  const callTrack = (reader, range) =>
    audio.handleCommercialAudio(trackRequest(range), fixtureEnv, trackPath, reader, "US");
  await assert.rejects(callTrack(null), /entitlement|purchase|subscription/i);
  await assert.rejects(callTrack(publishedUser), /entitlement|purchase|subscription/i);
  const grantedAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'purchase','active','qa-http-original-fixture',?,?)",
  )
    .bind("ent_http_" + randomUUID(), publishedUser, product.id, grantedAt, grantedAt)
    .run();
  const published200 = await callTrack(publishedUser);
  assert.equal(published200.status, 200);
  assert.equal(published200.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await published200.arrayBuffer()), bytes);
  const published206 = await callTrack(publishedUser, "bytes=0-63");
  assert.equal(published206.status, 206);
  assert.deepEqual(Buffer.from(await published206.arrayBuffer()), bytes.subarray(0, 64));
  const invalidRange = await callTrack(publishedUser, "bytes=999999-");
  assert.equal(invalidRange.status, 416);
  await assert.rejects(callTrack(otherId), /entitlement|purchase|subscription/i);
  await env.DB.prepare("UPDATE entitlements SET status='revoked',updated_at=? WHERE user_id=?")
    .bind(new Date().toISOString(), publishedUser)
    .run();
  await assert.rejects(callTrack(publishedUser), /entitlement|purchase|subscription/i);
  // A commercial, rather than Gutenberg-namespaced, copy of the fixture
  // exercises the REAL audio HTTP handler's mandatory staged paid-owner
  // authorization immediately before serving protected R2 bytes. This is a
  // disposable local proof of the consumer integration; the separate deployed
  // legal-owner test certifies its real Durable Object implementation.
  const commercialId = "prd_commercial_audioqa_" + randomUUID().replaceAll("-", "");
  const fields = (await env.DB.prepare("PRAGMA table_info(products)").all()).results;
  assert.ok(fields.some((field) => field.name === "id"));
  const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
  const columns = fields.map((field) => field.name);
  const replaced = [];
  const projection = columns.map((column) => {
    if (column === "id") { replaced.push(commercialId); return "?"; }
    if (column === "sku") { replaced.push("sku-" + commercialId); return "?"; }
    if (column === "source_name") { replaced.push("publisher"); return "?"; }
    if (column === "source_external_id") { replaced.push("qa-audio-" + commercialId); return "?"; }
    if (column === "public_id" || column === "slug") { replaced.push(commercialId); return "?"; }
    return quote(column);
  });
  await env.DB.prepare(
    "INSERT INTO products (" + columns.map(quote).join(",") + ") SELECT " +
      projection.join(",") + " FROM products WHERE id=?",
  ).bind(...replaced, product.id).run();
  const ownerBuyer = "qa_owned_media_" + randomUUID();
  const ownedEntitlement = "ent_qa_owned_" + randomUUID().replaceAll("-", "");
  const issued = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'purchase','active','commerce',?,?)",
  ).bind(ownedEntitlement, ownerBuyer, commercialId, issued, issued).run();
  publishedRow.product_id = commercialId;
  let ownerEnabled = false, ownerOutage = false, ownerReads = 0;
  const staged = {
    ...fixtureEnv,
    COVE_SSR_STAGING: "1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK: "1",
    COVE_LEGAL_CONSUMER_STAGE_ENABLED: "1",
    COVE_LEGAL_WRITER_PRIMARY_ID: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_SECRET: "a".repeat(64),
    LEGAL_AUTHORITY: {
      getByName(name) {
        assert.equal(name, "cove-staged-legal-global-v1");
        return { async fetch(request) {
          ownerReads++;
          if (ownerOutage) throw Error("synthetic_legal_owner_offline");
          assert.equal(request.headers.get("authorization"), "Bearer " + "a".repeat(64));
          assert.equal(new URL(request.url).pathname, "/commercial/entitlement/authorize");
          const input = await request.json();
          assert.deepEqual(input, {
            entitlementId: ownedEntitlement,
            userId: ownerBuyer,
            productId: commercialId,
            territory: "US",
            channel: "retail",
          });
          return Response.json(ownerEnabled ? {
            schema: "cove.paid-access.v1",
            allowed: true,
            proof: {
              entitlement_id: ownedEntitlement,
              user_id: ownerBuyer,
              product_id: commercialId,
              territory: "US",
              channel: "retail",
              order_id: "order_synthetic_audio_20261027",
              edition_id: "ed_synthetic_audio_20261027",
              grant_id: "grant_synthetic_audio_20261027",
              contract_id: "contract_synthetic_audio_20261027",
              contract_version_id: "rcv_synthetic_audio_20261027",
              product_epoch: 1,
              entitlement_epoch: 1,
              valid_until: new Date(Date.now() + 60000).toISOString(),
            },
          } : { schema: "cove.paid-access.v1", allowed: false });
        }};
      },
    },
  };
  const ownedTrack = (range) =>
    audio.handleCommercialAudio(trackRequest(range), staged, trackPath, ownerBuyer, "US");
  await assert.rejects(ownedTrack(), (e) => e.status === 451,
    "An active canonical entitlement cannot bypass a missing strong owner grant");
  ownerEnabled = true;
  const owned200 = await ownedTrack();
  assert.equal(owned200.status, 200);
  assert.deepEqual(Buffer.from(await owned200.arrayBuffer()), bytes,
    "The actual commercial-audio HTTP route serves only owner-authorized bytes");
  const owned206 = await ownedTrack("bytes=0-63");
  assert.equal(owned206.status, 206);
  assert.deepEqual(Buffer.from(await owned206.arrayBuffer()), bytes.subarray(0, 64));
  // The same actual HTTP handler must reauthorize offline issuance AND
  // verification. Generate a one-test-only P-256 signing key; no production
  // key, person, media or Cloudflare storage participates.
  frozen.profile.offlineEligible = true;
  frozen.agreements[0].permittedUses.push("offline");
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  staged.FORE_OFFLINE_AUDIO_SIGNING_JWK = JSON.stringify(
    await crypto.subtle.exportKey("jwk", keyPair.privateKey),
  );
  const deviceId = "device_audio_qa_" + randomUUID().replaceAll("-", "");
  const deviceAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO devices(id,user_id,device_key,name,platform,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?)",
  ).bind(deviceId, ownerBuyer, "qa-test-device-key-" + deviceId,
    "QA offline audio device", "test", deviceAt, deviceAt).run();
  const offlinePath = "/audio/ca_" + publishedId + "/offline-license";
  const offline = (route, payload) => audio.handleCommercialAudio(
    new Request("https://cove.qa/api/fore" + route, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    staged, route, ownerBuyer, "US",
  );
  const issuedOffline = await offline(offlinePath, { deviceId, protocolVersion: 1 });
  assert.equal(issuedOffline.status, 200);
  const issuedLicense = await issuedOffline.json();
  assert.ok(issuedLicense.licenseId && issuedLicense.token && issuedLicense.receipt?.signature);
  const maxLeaseMs = 7 * 86400000;
  const lifeMs = Date.parse(issuedLicense.expiresAt) - Date.now();
  assert.ok(lifeMs > 0 && lifeMs <= maxLeaseMs,
    "The actual signed commercial audio license must expire within seven days");
  const persisted = await env.DB.prepare(
    "SELECT status,expires_at FROM audio_offline_licenses WHERE id=?",
  ).bind(issuedLicense.licenseId).first();
  assert.equal(persisted.status, "active");
  const verification = () => offline(offlinePath + "/verify", {
    licenseId: issuedLicense.licenseId, token: issuedLicense.token,
  });
  const verifiedOffline = await verification();
  assert.equal(verifiedOffline.status, 200);
  assert.equal((await verifiedOffline.json()).valid, true);
  ownerOutage = true;
  await assert.rejects(verification(), (e) => e.status === 503,
    "Even an unexpired signed license cannot renew or verify during an owner outage");
  ownerOutage = false;
  ownerEnabled = false;
  await assert.rejects(verification(), (e) => e.status === 451,
    "Immediate owner withdrawal must deny online offline-license verification");
  assert.equal((await env.DB.prepare(
    "SELECT status FROM audio_offline_licenses WHERE id=?",
  ).bind(issuedLicense.licenseId).first()).status, "active",
    "Denial must not depend on eventual canonical license reconciliation");
  ownerEnabled = true;
  ownerOutage = true;
  await assert.rejects(offline(offlinePath, { deviceId, protocolVersion: 1 }),
    (e) => e.status === 503,
    "Offline-license issuance must fail closed before signing on an owner outage");
  ownerOutage = false;
  ownerEnabled = true;
  ownerOutage = true;
  await assert.rejects(ownedTrack(), (e) => e.status === 503,
    "A legal-owner outage must halt previously authorized audiobook delivery");
  ownerOutage = false;
  ownerEnabled = false;
  await assert.rejects(ownedTrack(), (e) => e.status === 451,
    "Withdrawal must deny the actual audio route even while D1 entitlement is active");
  assert.ok(ownerReads >= 5, "Every protected audio request must recheck authority");
  console.log(
    "PASS: original audio 200/206 bytes, real commercial HTTP handler, 7-day signed offline audio issue/verify, owner proof/denial, outage fail-closed, cross-user isolation and immediate withdrawal (disposable QA).",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
