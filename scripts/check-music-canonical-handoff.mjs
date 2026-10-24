import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-canonical-music-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/lib/music-canonical-handoff.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "handoff.mjs"),
    logLevel: "silent",
  });
  const { applyCanonicalMusicHandoff, handleCanonicalMusicHandoff } = await import(
    path.join(root, "handoff.mjs")
  );
  const env = localBindings(root);
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const secret = "x".repeat(48);
  const config = {
    DB: env.DB,
    FORE_MUSIC_CANONICAL_HANDOFF_ENABLED: "1",
    FORE_MUSIC_CANONICAL_HANDOFF_TOKEN_SHA256: sha(secret),
  };
  const manifest = {
    id: "supplier-master-1",
    contractId: "supplier-contract-1",
    title: "Synthetic master",
    composer: "Test Composer",
    performer: "Test Performer",
    sha256: "a".repeat(64),
    bytes: 8192,
    mime: "audio/ogg",
    territory: ["US"],
    workKey: "synthetic-work",
  };
  const item = (seq, action, master = "supplier-master-1", payload = manifest) => ({
    id: randomUUID(),
    seq,
    contract_id: "supplier-contract-1",
    master_id: master,
    action,
    payload_json: JSON.stringify(payload),
    contract_status: "active",
    contract_expires_at: "2035-01-01T00:00:00.000Z",
    contract_evidence_sha256: "b".repeat(64),
    publishable: action === "master_qualified" ? 1 : 0,
  });
  const qualified = item(1, "master_qualified");
  const req = (body, bearer = secret) =>
    new Request("https://isolated.invalid/__cove/ingestion/music-supply-handoff", {
      method: "POST",
      headers: { "x-cove-music-handoff-token": bearer, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await handleCanonicalMusicHandoff(req(qualified), {
        ...config,
        FORE_MUSIC_CANONICAL_HANDOFF_ENABLED: "0",
      })
    ).status,
    403,
    "Flag remains disabled unless operator explicitly enables",
  );
  assert.equal(
    (await handleCanonicalMusicHandoff(req(qualified, "untrusted"), config)).status,
    401,
  );
  assert.deepEqual(await applyCanonicalMusicHandoff(env.DB, qualified), {
    seq: 1,
    recorded: true,
    status: "private_metadata_only",
  });
  assert.deepEqual(await applyCanonicalMusicHandoff(env.DB, qualified), {
    seq: 1,
    replay: true,
    status: "unchanged",
  });
  const first = await env.DB.prepare(
    "SELECT status,metadata_json FROM music_supply_handoff_masters WHERE master_id=?",
  )
    .bind("supplier-master-1")
    .first();
  assert.equal(first.status, "pending_media");
  // An already-used sequence must never execute a different event's
  // revocation mutation, even when the forged event has a distinct id.
  const conflictingSequence = item(1, "master_revoked", "supplier-master-1", {
    reason: "Attempted revocation under a conflicting event receipt",
  });
  await assert.rejects(
    applyCanonicalMusicHandoff(env.DB, conflictingSequence),
    /music_handoff_conflicting_replay/,
  );
  assert.equal(
    (
      await env.DB.prepare("SELECT status FROM music_supply_handoff_masters WHERE master_id=?")
        .bind("supplier-master-1")
        .first()
    ).status,
    "pending_media",
    "Conflicting receipt must not revoke a legitimate candidate",
  );

  assert.equal(JSON.parse(first.metadata_json).sha256, manifest.sha256);
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) n FROM soundtrack_recordings").first()).n,
    0,
    "Private handoff must not publish customer audio or rights",
  );

  const withdrawn = item(2, "contract_revoked", null, {
    reason: "Fixture contract rights withdrawn permanently",
  });
  withdrawn.contract_status = "revoked";
  assert.equal((await applyCanonicalMusicHandoff(env.DB, withdrawn)).recorded, true);
  assert.equal(
    (
      await env.DB.prepare("SELECT status FROM music_supply_handoff_contracts WHERE contract_id=?")
        .bind("supplier-contract-1")
        .first()
    ).status,
    "revoked",
  );

  const forgedAfterWithdrawal = item(3, "master_qualified", "supplier-master-2", {
    ...manifest,
    id: "supplier-master-2",
  });
  assert.equal((await applyCanonicalMusicHandoff(env.DB, forgedAfterWithdrawal)).recorded, true);
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM music_supply_handoff_masters WHERE master_id='supplier-master-2'",
      ).first()
    ).n,
    0,
    "Even a forged active flag cannot defeat canonical contract tombstone",
  );

  const masterWithdrawn = item(4, "master_revoked", "supplier-master-1", {
    reason: "Specific synthetic original master withdrawn",
  });
  assert.equal((await applyCanonicalMusicHandoff(env.DB, masterWithdrawn)).recorded, true);
  assert.equal(
    (
      await env.DB.prepare("SELECT status FROM music_supply_handoff_masters WHERE master_id=?")
        .bind("supplier-master-1")
        .first()
    ).status,
    "revoked",
  );
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) n FROM music_supply_handoff_events").first()).n,
    4,
    "Each event recorded exactly once",
  );
  await assert.rejects(
    applyCanonicalMusicHandoff(env.DB, {
      ...qualified,
      payload_json: JSON.stringify({
        ...manifest,
        sha256: "c".repeat(64),
      }),
    }),
    /music_handoff_conflicting_replay/,
  );
  const stale = item(5, "master_qualified", "supplier-master-3", {
    ...manifest,
    id: "supplier-master-3",
  });
  stale.contract_status = "revoked";
  stale.publishable = 0;
  assert.equal(
    (await applyCanonicalMusicHandoff(env.DB, stale)).skipped,
    "supplier_rights_inactive",
  );

  const accepted = await handleCanonicalMusicHandoff(req(qualified), config);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).replay, true);
  const servingQuery = fs.readFileSync("src/features/fore/matching-catalog.server.ts", "utf8");
  assert.ok(!servingQuery.includes("music_supply_handoff"), "No customer matching DB reads added");
  const backend = fs.readFileSync("src/persistence-backend.worker.ts", "utf8");
  assert.match(backend, /handleCanonicalMusicHandoff\(request, env\)/);
  assert.match(
    fs.readFileSync("src/lib/music-canonical-handoff.ts", "utf8"),
    /FORE_MUSIC_CANONICAL_HANDOFF_ENABLED !== "1"/,
  );
  console.log(
    "Canonical music metadata handoff: dual credential, atomic idempotency, contract/master tombstones, zero public rights, disabled flag passed.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
