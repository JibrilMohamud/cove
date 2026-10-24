#!/usr/bin/env node
/**
 * Parallel full-FFmpeg, full-decode, exact-master QA. Unlike a candidate scan,
 * each worker claims its own fenced MUSIC_DB job before receiving private R2
 * bytes. Never operates against the bookstore or customer D1.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { analyzeMusicMaster } from "./audio-quality.mjs";

const expected = "https://cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev/";
const host = process.env.COVE_MUSIC_SUPPLY_QA_URL || "";
const token = process.env.COVE_MUSIC_SUPPLY_QA_TOKEN || "";
const flag = (name, fallback) => Number(
  process.argv.find((v) => v.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback,
);
const workers = flag("workers", 4);
const maximum = flag("max-tracks", 32);
const minutes = flag("max-minutes", 20);
const execute = process.argv.includes("--execute");
assert.ok(Number.isSafeInteger(workers) && workers >= 1 && workers <= 8);
assert.ok(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 128);
assert.ok(Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 30);
if (!execute) {
  console.log(JSON.stringify({ dryRun: true, workers, maximum, note: "No FFmpeg or QA lease calls" }));
  process.exit(0);
}
if (process.env.COVE_MUSIC_EXECUTION_RUNNER_ENABLED !== "1")
  throw Error("Explicit isolated QA runner approval required");
if (host !== expected) throw Error("Invalid isolated QA Worker host");
if (token.length < 40 || token.length > 256) throw Error("Missing scoped independent audio-QA identity");
const auth = { authorization: "Bearer " + token };
let claims = 0, passed = 0, failed = 0;
const deadline = Date.now() + 60000 * minutes;
async function post(route, data, lease) {
  const response = await fetch(host + route, {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      ...(lease ? { "x-cove-music-qa-lease": lease } : {}),
    },
    body: JSON.stringify(data),
    redirect: "manual",
    signal: AbortSignal.timeout(25000),
  });
  if (![200, 202].includes(response.status))
    throw Error("QA stage rejected: HTTP " + response.status);
  return response.json();
}
async function perform(job) {
  let tmp;
  try {
    assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/.test(job.masterId));
    assert.ok(/^[0-9a-f]{64}$/.test(job.masterSha256));
    assert.ok(Number.isSafeInteger(job.bytes) && job.bytes > 128 && job.bytes <= 25 * 1024 * 1024);
    const res = await fetch(
      host + "v1/qa/masters/" + encodeURIComponent(job.masterId) + "/audio",
      {
        headers: { ...auth, "x-cove-music-qa-lease": job.leaseToken },
        redirect: "manual",
        signal: AbortSignal.timeout(120000),
      },
    );
    if (res.status !== 200 || !res.body || Number(res.headers.get("content-length")) !== job.bytes)
      throw Error("Private leased QA media unavailable");
    const sha1 = createHash("sha1");
    const sha256 = createHash("sha256");
    tmp = await mkdtemp(path.join(os.tmpdir(), "cove-isolated-full-decode-"));
    const file = path.join(tmp, "original.master");
    let size = 0;
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (chunks) {
        for await (const part of chunks) {
          size += part.byteLength;
          if (size > job.bytes) throw Error("Master exceeds manifest");
          sha1.update(part);
          sha256.update(part);
          yield part;
        }
      },
      fs.createWriteStream(file, { flags: "wx" }),
    );
    if (size !== job.bytes || sha256.digest("hex") !== job.masterSha256)
      throw Error("Private R2 master bytes changed");
    const report = await analyzeMusicMaster(file, {
      sha1: sha1.digest("hex"),
      bytes: job.bytes,
    });
    const saved = await post(
      "v1/masters/" + encodeURIComponent(job.masterId) + "/quality",
      report,
      job.leaseToken,
    );
    assert.equal(saved.status, "quality_passed");
    passed++;
    console.log(JSON.stringify({ masterId: job.masterId, result: "quality_passed", durationSeconds: report.durationSeconds }));
  } catch (error) {
    failed++;
    console.log(JSON.stringify({ masterId: job.masterId, result: "failed", errorType: error?.name || "Error" }));
    await post("v1/execution/qa/fail", {
      masterId: job.masterId,
      leaseToken: job.leaseToken,
    }).catch(() => {});
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
async function worker() {
  while (Date.now() < deadline && claims < maximum) {
    // JavaScript's single-threaded counter increment prevents overlapping
    // reservations within this process; D1 enforces cross-host source limits.
    claims++;
    const job = await post("v1/execution/qa/claim", {});
    if (job.skipped) break;
    await perform(job);
  }
}
await Promise.all(Array.from({ length: workers }, () => worker()));
console.log(JSON.stringify({ claimsAttempted: claims, qualityPassed: passed, failed }));
if (failed) process.exitCode = 1;
