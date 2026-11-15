import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cove-stage-rights-cursor-"));
try {
  await build({
    entryPoints: ["src/features/fore/synthetic-stage-rights-cursor.ts"],
    outfile: path.join(folder, "cursor.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const {
    signSyntheticStageCursor,
    verifySyntheticStageCursor,
    syntheticSnapshotSha256,
  } = await import(path.join(folder, "cursor.mjs"));

  const now = 2_000_000_000_000;
  const gate = "a".repeat(64);
  const snapshot = '{"schema":"stage","items":["first","second"]}';
  const digest = await syntheticSnapshotSha256(snapshot);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, await syntheticSnapshotSha256(snapshot + " "));
  const scope = { digest, revision: "1", expiresAt: now + 110_000 };
  const anchor = { position: 23, productId: "perf-synth-23" };
  const cursor = await signSyntheticStageCursor(anchor, scope, gate, now);
  assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(cursor.length < 768);
  assert.deepEqual(await verifySyntheticStageCursor(cursor, scope, gate, now), anchor);
  assert.deepEqual(await verifySyntheticStageCursor(cursor, scope, gate, now + 109_999), anchor);

  const bad = [
    "",
    cursor + ".extra",
    "bad",
    cursor.replace(".", ".."),
    cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A"),
    cursor.slice(0, cursor.indexOf(".")) + ".AA",
    "x".repeat(769),
  ];
  for (const forged of bad)
    assert.equal(await verifySyntheticStageCursor(forged, scope, gate, now), null);
  assert.equal(await verifySyntheticStageCursor(cursor, scope, "b".repeat(64), now), null);
  assert.equal(
    await verifySyntheticStageCursor(cursor, { ...scope, revision: "2" }, gate, now),
    null,
  );
  assert.equal(
    await verifySyntheticStageCursor(cursor, { ...scope, digest: "c".repeat(64) }, gate, now),
    null,
  );
  assert.equal(
    await verifySyntheticStageCursor(cursor, { ...scope, expiresAt: scope.expiresAt + 1 }, gate, now),
    null,
  );
  assert.equal(
    await verifySyntheticStageCursor(cursor, scope, gate, scope.expiresAt),
    null,
  );
  await assert.rejects(
    () => signSyntheticStageCursor({ ...anchor, position: -1 }, scope, gate, now),
    /Unsafe/,
  );
  await assert.rejects(
    () => signSyntheticStageCursor({ ...anchor, position: 95 }, scope, gate, now),
    /Unsafe/,
  );
  await assert.rejects(
    () => signSyntheticStageCursor({ ...anchor, productId: "bad%id" }, scope, gate, now),
    /Unsafe/,
  );
  await assert.rejects(
    () => signSyntheticStageCursor(anchor, scope, "not-a-hex-secret", now),
    /cursor key/,
  );
  console.log("PASS: isolated HMAC cursor signature, expiry, immutable manifest digest, metadata revision, tampering and strict anchors");
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
