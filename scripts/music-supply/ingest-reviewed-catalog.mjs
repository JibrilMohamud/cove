#!/usr/bin/env node
// Supply contract is activated independently. This operator only uploads
// approved exact-master candidates to isolated QA, never authorizes playback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const allowedHost = "cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev";
const base = process.env.COVE_MUSIC_SUPPLY_QA_URL || "";
const key = process.env.COVE_MUSIC_SUPPLY_INGEST_TOKEN || "";
const file = process.argv.find((x) => x.startsWith("--manifest="))?.slice(11);
const start = Number(process.argv.find((x) => x.startsWith("--start="))?.slice(8) || 0);
const limit = Number(process.argv.find((x) => x.startsWith("--limit="))?.slice(8) || 4);
const commit = process.argv.includes("--commit");
if (
  !file ||
  !Number.isSafeInteger(start) ||
  start < 0 ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 8
)
  throw Error("Require --manifest, nonnegative --start and --limit=1..8");
if (commit && process.env.COVE_MUSIC_SUPPLY_QA_WRITES_ENABLED !== "1")
  throw Error("Explicit isolated QA write switch required");
const url = new URL(base);
if (
  url.protocol !== "https:" ||
  url.hostname !== allowedHost ||
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  url.username ||
  url.password
)
  throw Error("Only Cove's dedicated isolated QA Worker origin is supported");
if (commit && key.length < 40) throw Error("Missing dedicated ingestion credential");
const manifest = JSON.parse(await readFile(file, "utf8"));
assert.ok(Array.isArray(manifest.masters) && manifest.masters.length <= 100000);
assert.ok(typeof manifest.licensedOrigin === "string");
const licensedOrigin = new URL(manifest.licensedOrigin);
assert.equal(licensedOrigin.protocol, "https:");
assert.ok(!licensedOrigin.username && !licensedOrigin.password);
const selected = manifest.masters.slice(start, start + limit);
let done = 0,
  failed = 0;
for (const master of selected) {
  let dir;
  try {
    assert.ok(
      typeof master.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/.test(master.id),
    );
    assert.ok(/^[0-9a-f]{64}$/.test(master.sha256));
    assert.ok(
      Number.isSafeInteger(master.bytes) && master.bytes > 128 && master.bytes <= 25 * 1024 * 1024,
    );
    const source = new URL(master.sourceUrl);
    assert.equal(source.protocol, "https:");
    assert.equal(source.hostname, licensedOrigin.hostname);
    assert.ok(source.pathname.startsWith(licensedOrigin.pathname));
    assert.ok(!source.username && !source.password && !source.search && !source.hash);
    if (!commit) {
      console.log(JSON.stringify({ id: master.id, result: "validated_dry_run" }));
      done++;
      continue;
    }
    const staged = await fetch(base + "v1/masters", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(master),
      signal: AbortSignal.timeout(20000),
    });
    if (staged.status !== 201) throw Error("Manifest was not accepted by reviewed contract");
    dir = await mkdtemp(path.join(os.tmpdir(), "cove-supply-upload-"));
    const output = path.join(dir, "original.master");
    const upstream = await fetch(source.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
      headers: { "User-Agent": "CoveMusicSupply/1.0 (original source manifest)" },
    });
    if (
      upstream.status !== 200 ||
      !upstream.body ||
      (upstream.headers.get("content-length") &&
        Number(upstream.headers.get("content-length")) !== master.bytes)
    )
      throw Error("Exact source unavailable or moved");
    const digest = createHash("sha256");
    let received = 0;
    await pipeline(
      Readable.fromWeb(upstream.body),
      async function* (parts) {
        for await (const part of parts) {
          received += part.length;
          if (received > master.bytes) throw Error("Media exceeds original manifest");
          digest.update(part);
          yield part;
        }
      },
      fs.createWriteStream(output, { flags: "wx" }),
    );
    if (received !== master.bytes || digest.digest("hex") !== master.sha256)
      throw Error("Source checksum changed");
    const uploaded = await fetch(base + "v1/masters/" + encodeURIComponent(master.id) + "/audio", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + key,
        "content-length": String(master.bytes),
        "content-type": master.mime,
      },
      body: fs.createReadStream(output),
      duplex: "half",
      signal: AbortSignal.timeout(120000),
    });
    if (uploaded.status !== 200) throw Error("Checksum-verified R2 stage rejected");
    console.log(JSON.stringify({ id: master.id, result: "staged_for_independent_qa" }));
    done++;
  } catch (e) {
    failed++;
    console.warn(
      JSON.stringify({
        id: typeof master?.id === "string" ? master.id : "invalid",
        error: String(e instanceof Error ? e.message : e).slice(0, 130),
      }),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    dryRun: !commit,
    start,
    scanned: selected.length,
    staged: done,
    failures: failed,
  }),
);
if (failed) process.exitCode = 1;
