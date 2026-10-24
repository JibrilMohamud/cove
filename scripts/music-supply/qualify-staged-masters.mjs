#!/usr/bin/env node
// Independent audio-QA principal: cannot register contracts or ingest files.
// Fully decode staged originals locally and attest the exact immutable master.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { analyzeMusicMaster } from "./audio-quality.mjs";

const allowedHost = "cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev";
const base = process.env.COVE_MUSIC_SUPPLY_QA_URL || "";
const secret = process.env.COVE_MUSIC_SUPPLY_QA_TOKEN || "";
const limit = Number(process.argv.find((x) => x.startsWith("--limit="))?.slice(8) || 4);
const after = process.argv.find((x) => x.startsWith("--after="))?.slice(8) || "";
const commit = process.argv.includes("--commit");
assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 8);
assert.ok(!after || /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/.test(after));
const origin = new URL(base);
assert.ok(origin.protocol === "https:" && origin.hostname === allowedHost &&
  origin.pathname === "/" && !origin.username && !origin.password &&
  !origin.search && !origin.hash);
if (secret.length < 40) throw Error("Missing separately scoped QA identity");
if (commit && process.env.COVE_MUSIC_SUPPLY_QA_WRITES_ENABLED !== "1")
  throw Error("Quality publication requires explicit isolated QA write switch");
const headers = { authorization: "Bearer " + secret };
const feed = await fetch(base + "v1/qa/staged?after=" + encodeURIComponent(after), {
  headers, signal: AbortSignal.timeout(20000),
});
if (feed.status !== 200) throw Error("QA queue not readable under dedicated role");
const listed = await feed.json();
assert.ok(Array.isArray(listed.items));
let checked = 0, qualified = 0, rejected = 0;
for (const item of listed.items.slice(0, limit)) {
  let dir;
  try {
    assert.ok(typeof item.id === "string" && item.id.length <= 120);
    assert.ok(/^[0-9a-f]{64}$/.test(item.sha256));
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes <= 25 * 1024 * 1024);
    const res = await fetch(base + "v1/qa/masters/" + encodeURIComponent(item.id) + "/audio", {
      headers, signal: AbortSignal.timeout(120000), redirect: "manual",
    });
    if (res.status !== 200 || !res.body || Number(res.headers.get("content-length")) !== item.bytes)
      throw Error("QA media unavailable or wrong size");
    dir = await mkdtemp(path.join(os.tmpdir(), "cove-music-independent-qa-"));
    const filepath = path.join(dir, "master");
    const sha1 = createHash("sha1"), sha256 = createHash("sha256");
    let size = 0;
    await pipeline(Readable.fromWeb(res.body), async function* (parts) {
      for await (const piece of parts) {
        size += piece.length;
        if (size > item.bytes) throw Error("Staged media unexpectedly grew");
        sha1.update(piece);
        sha256.update(piece);
        yield piece;
      }
    }, fs.createWriteStream(filepath, { flags: "wx" }));
    if (size !== item.bytes || sha256.digest("hex") !== item.sha256)
      throw Error("Private R2 audio hash mismatch");
    const report = await analyzeMusicMaster(filepath, {
      sha1: sha1.digest("hex"), bytes: item.bytes,
    });
    checked++;
    if (commit) {
      const accepted = await fetch(base + "v1/masters/" + encodeURIComponent(item.id) + "/quality", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(20000),
      });
      if (accepted.status !== 202) throw Error("Audio quality attestation rejected");
      qualified++;
    }
    console.info(JSON.stringify({
      id: item.id, result: commit ? "quality_attested" : "decoded_dry_run",
      durationSeconds: report.durationSeconds,
    }));
  } catch (error) {
    rejected++;
    console.warn(JSON.stringify({
      id: item.id, error: String(error instanceof Error ? error.message : error).slice(0, 130),
    }));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({
  dryRun: !commit, decoded: checked, qualified, rejected,
  nextCursor: listed.nextCursor,
}));
if (rejected) process.exitCode = 1;
