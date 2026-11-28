import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const folder = mkdtempSync(join(tmpdir(), "cove-legal-baseline-"));
let db;
try {
  const artifact = join(folder, "baseline.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/current-legal-owner-baseline.ts"],
    outfile: artifact,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const legal = await import(pathToFileURL(artifact).href);
  const open = () => {
    db = new DatabaseSync(join(folder, "owner.sqlite"));
    return {
      exec(statement, ...args) {
        const prepared = db.prepare(statement);
        const rows = /^\s*SELECT\b/i.test(statement)
          ? prepared.all(...args)
          : (prepared.run(...args), []);
        return { toArray: () => rows };
      },
    };
  };
  let sql = open();
  const transaction = (f) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = f();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  legal.createCurrentLegalBaselineSchema(sql);
  const now = Date.now(),
    primaryId = "4bd657ac-8789-403e-a28c-93aba8d0a989";
  const canonical = (x) =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : x;
  const encoded = (x) => new TextEncoder().encode(JSON.stringify(canonical(x)));
  const keyPair = () =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publisher = await keyPair(),
    reviewer = await keyPair();
  const signer = async (key) => {
    const bytes = Buffer.from(await crypto.subtle.exportKey("spki", key));
    return {
      spkiBase64: bytes.toString("base64"),
      spkiSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const trust = {
    primaryId,
    publisher: await signer(publisher.publicKey),
    reviewer: await signer(reviewer.publicKey),
    maxAgeMs: 900000,
  };
  const sign = async (header, key) =>
    Buffer.from(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoded(header)),
    ).toString("base64url");
  const envelope = async (header) => ({
    header,
    publisherSignature: await sign(header, publisher.privateKey),
    reviewerSignature: await sign(header, reviewer.privateKey),
  });
  const scope = { productId: "product_one", territory: "US", format: "ebook", channel: "retail" };
  const row = {
    ...scope,
    verdict: "allow",
    artifactSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    basisSha256: "c".repeat(64),
    validUntilMs: now + 600000,
  };
  const inventory = {
    inventorySha256: "d".repeat(64),
    productCount: 1,
    ownerEpoch: 0,
    withdrawalSequence: 0,
  };
  const header = {
    schema: "cove.owner-current-baseline.v1",
    primaryId,
    generation: 1,
    ownerEpoch: 0,
    withdrawalSequence: 0,
    inventorySha256: inventory.inventorySha256,
    productCount: 1,
    scopeCount: 1,
    batchSha256: [await legal.hashLegalBaseline([row])],
    observedAtMs: now,
    validUntilMs: now + 600000,
    defaultVerdict: "deny",
  };
  const current = {
    artifactSha256: row.artifactSha256,
    policySha256: row.policySha256,
    canonicalAllowed: true,
    outstandingHold: false,
  };
  assert.equal(legal.readCurrentLegalBaseline(sql, scope, current, now), false);
  const signed = await envelope(header);
  await assert.rejects(() =>
    legal.beginCurrentLegalBaseline(
      sql,
      { ...signed, header: { ...header, scopeCount: 0 } },
      trust,
      inventory,
      now,
    ),
  );
  const rawPoint = Buffer.from(await crypto.subtle.exportKey("raw", publisher.publicKey));
  const compressed = Buffer.concat([
    Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
    Buffer.from([2 + (rawPoint[64] & 1)]),
    rawPoint.subarray(1, 33),
  ]);
  const sameKeyTrust = {
    ...trust,
    reviewer: {
      spkiBase64: compressed.toString("base64"),
      spkiSha256: createHash("sha256").update(compressed).digest("hex"),
    },
  };
  await assert.rejects(
    () =>
      legal.beginCurrentLegalBaseline(
        sql,
        { ...signed, reviewerSignature: signed.publisherSignature },
        sameKeyTrust,
        inventory,
        now,
      ),
    /independent_signatures/,
  );
  transaction(await legal.beginCurrentLegalBaseline(sql, signed, trust, inventory, now));
  assert.equal(
    legal.readCurrentLegalBaseline(sql, scope, current, now),
    false,
    "Pending generation never grants",
  );
  assert.throws(
    () => transaction(() => legal.sealCurrentLegalBaseline(sql, 1, now)),
    /incomplete_partition/,
  );
  const interrupted = await legal.appendCurrentLegalBaselineBatch(sql, 1, 0, [row], now);
  transaction(() => legal.invalidateCurrentLegalBaseline(sql, "withdrawal:first"));
  assert.throws(() => transaction(interrupted), /owner_clock_conflict/);
  assert.throws(() => transaction(() => legal.sealCurrentLegalBaseline(sql, 1, now)), /seal_clock/);
  const clock = legal.baselineClock(sql);
  assert.equal(clock.nextGeneration, 2, "Interrupted generation cannot block future publication");
  const nextHeader = {
    ...header,
    generation: clock.nextGeneration,
    ownerEpoch: clock.ownerEpoch,
    withdrawalSequence: clock.withdrawalSequence,
  };
  const nextInventory = {
    ...inventory,
    ownerEpoch: clock.ownerEpoch,
    withdrawalSequence: clock.withdrawalSequence,
  };
  const nextEnvelope = await envelope(nextHeader);
  transaction(await legal.beginCurrentLegalBaseline(sql, nextEnvelope, trust, nextInventory, now));
  transaction(await legal.appendCurrentLegalBaselineBatch(sql, 2, 0, [row], now));
  transaction(() => legal.sealCurrentLegalBaseline(sql, 2, now));
  transaction(() => legal.sealCurrentLegalBaseline(sql, 2, now));
  assert.equal(legal.readCurrentLegalBaseline(sql, scope, current, now), true);
  assert.equal(
    legal.readCurrentLegalBaseline(sql, { ...scope, channel: "library" }, current, now),
    false,
  );
  assert.equal(
    legal.readCurrentLegalBaseline(sql, scope, { ...current, outstandingHold: true }, now),
    false,
  );
  assert.equal(
    legal.readCurrentLegalBaseline(sql, scope, { ...current, artifactSha256: "e".repeat(64) }, now),
    false,
  );
  assert.equal(legal.readCurrentLegalBaseline(sql, scope, current, now + 600000), false);
  assert.equal(
    legal.currentLegalBaselineQuarantineReady(sql),
    null,
    "Any allowance prohibits quarantine-mode admission",
  );
  db.close();
  sql = open();
  assert.equal(
    legal.readCurrentLegalBaseline(sql, scope, current, now),
    true,
    "Signed generation survives owner restart",
  );
  assert.equal(
    JSON.parse(
      db.prepare("SELECT envelope_json FROM cove_baseline_generations WHERE generation=2").get()
        .envelope_json,
    ).reviewerSignature,
    nextEnvelope.reviewerSignature,
  );
  transaction(() => legal.invalidateCurrentLegalBaseline(sql, "withdrawal:second"));
  const withdrawn = legal.baselineClock(sql);
  transaction(() => legal.invalidateCurrentLegalBaseline(sql, "withdrawal:second"));
  assert.deepEqual(
    legal.baselineClock(sql),
    withdrawn,
    "Exact withdrawal retry cannot advance epoch twice",
  );
  assert.equal(legal.readCurrentLegalBaseline(sql, scope, current, now), false);
  console.log(
    "PASS: independent normalized P256 keys, tampering, complete publication, pending-generation recovery, fresh scope/hold/artifact checks, withdrawal races, exact retries and restart persistence",
  );
} finally {
  db?.close();
  rmSync(folder, { recursive: true, force: true });
}
