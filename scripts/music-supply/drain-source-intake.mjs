#!/usr/bin/env node
/**
 * Independently parallelizable source-scoped intake consumer. Every source
 * budget and lease is enforced by detached MUSIC_DB, not by this process.
 * No production customer bindings. Fail closed on unauthorized URLs, redirects,
 * mismatched bytes, sha256, expired leases and disabled QA flags.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const host = "cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev";
const origin = process.env.COVE_MUSIC_SUPPLY_QA_URL || "";
const secret = process.env.COVE_MUSIC_SUPPLY_INGEST_TOKEN || "";
const getFlag = (name, fallback) =>
  process.argv.find((v) => v.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback;
const workers = Number(getFlag("workers", "4"));
const maximum = Number(getFlag("max-tracks", "32"));
const minutes = Number(getFlag("max-minutes", "20"));
const execute = process.argv.includes("--execute");
assert.ok(Number.isSafeInteger(workers) && workers >= 1 && workers <= 8);
assert.ok(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 128);
assert.ok(Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 30);
if (!execute) {
  console.log(JSON.stringify({ dryRun: true, workers, maximum, note: "No jobs leased or provider requests issued" }));
  process.exit(0);
}
if (process.env.COVE_MUSIC_EXECUTION_RUNNER_ENABLED !== "1")
  throw Error("Isolated execution requires explicit runner opt-in");
const endpoint = new URL(origin);
if (endpoint.protocol !== "https:" || endpoint.hostname !== host || endpoint.pathname !== "/" ||
    endpoint.search || endpoint.hash || endpoint.username || endpoint.password || endpoint.port)
  throw Error("Untrusted private QA Worker endpoint");
if (secret.length < 40 || secret.length > 256) throw Error("Missing scoped original-master ingest token");

const auth = { authorization: "Bearer " + secret };
const deadline = Date.now() + minutes * 60000;
let reserved = 0, completed = 0, rejected = 0;
async function invoke(route, payload) {
  const response = await fetch(origin + route, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  if (response.status !== 200) throw Error("Private intake operation rejected: " + response.status);
  return response.json();
}
async function perform(job) {
  let directory;
  try {
    const m = job.manifest;
    assert.equal(m.id, job.masterId);
    assert.equal(m.sha256, job.masterSha256);
    assert.ok(/^[0-9a-f]{64}$/.test(m.sha256));
    assert.ok(Number.isSafeInteger(m.bytes) && m.bytes > 128 && m.bytes <= 25 * 1024 * 1024);
    assert.ok(["audio/mpeg", "audio/ogg"].includes(m.mime));
    const url = new URL(m.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.port || /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith("["))
      throw Error("Untrusted original master URL");
    // The source host and pathname were validated against the independently
    // approved contract when the manifest was registered.
    const response = await fetch(url.href, {
      redirect: "manual",
      headers: { "user-agent": "CoveIsolatedLicensedIntake/1" },
      signal: AbortSignal.timeout(120000),
    });
    if (response.status !== 200 || !response.body ||
        (response.headers.get("content-length") && Number(response.headers.get("content-length")) !== m.bytes))
      throw Error("Exact original master unavailable");
    directory = await mkdtemp(path.join(os.tmpdir(), "cove-licensed-intake-"));
    const file = path.join(directory, "original.master");
    let size = 0;
    const digest = createHash("sha256");
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.byteLength;
          if (size > m.bytes) throw Error("Oversized source master");
          digest.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(file, { flags: "wx" }),
    );
    if (size !== m.bytes || digest.digest("hex") !== m.sha256)
      throw Error("Changed source master");
    const uploaded = await fetch(origin + "v1/masters/" + encodeURIComponent(m.id) + "/audio", {
      method: "PUT",
      headers: {
        ...auth,
        "content-type": m.mime,
        "content-length": String(size),
        "x-cove-music-intake-lease": job.leaseToken,
      },
      body: fs.createReadStream(file),
      duplex: "half",
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    if (uploaded.status !== 200) throw Error("Lease-fenced staging failed: " + uploaded.status);
    completed++;
    console.log(JSON.stringify({ masterId: job.masterId, result: "staged", bytes: size }));
  } catch (error) {
    rejected++;
    console.log(JSON.stringify({ masterId: job.masterId, result: "failed", kind: error?.name || "Error" }));
    await invoke("v1/execution/intake/fail", { masterId: job.masterId, leaseToken: job.leaseToken }).catch(() => {});
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
async function worker() {
  while (Date.now() < deadline && reserved < maximum) {
    // Single-process reservation limit protects external provider budgets,
    // while each backend claim atomically enforces per-source global caps.
    if (reserved >= maximum) break;
    reserved++;
    const job = await invoke("v1/execution/intake/claim", {});
    if (job.skipped) return;
    await perform(job);
  }
}
await Promise.all(Array.from({ length: workers }, () => worker()));
console.log(JSON.stringify({ parallelWorkers: workers, claimsAttempted: reserved, staged: completed, failed: rejected }));
if (rejected) process.exitCode = 1;
