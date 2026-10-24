#!/usr/bin/env node
// Operator-run isolated audio QA. Dry-run unless BOTH --commit and a separate
// write flag are set; refuses non-QA endpoints. Never approves content rights.
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { analyzeMusicMaster, MAX_MUSIC_QA_BYTES } from "./music-qa-analyzer.mjs";

const countArg = process.argv.find((x) => /^--limit=\d+$/.test(x));
const limit = Math.min(8, Math.max(1, Number(countArg?.slice(8) || 4)));
const commit = process.argv.includes("--commit");
if (commit && process.env.COVE_MUSIC_QA_WRITES_ENABLED !== "1")
  throw Error("Commit requires independent explicit operator write flag");
const endpoint = process.env.COVE_MUSIC_QA_BASE_URL || "";
const auth = process.env.COVE_MUSIC_QA_SERVICE_TOKEN || "";
if (!endpoint || !auth) throw Error("Missing QA backend endpoint or dedicated service token");
const origin = new URL(endpoint);
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  !/(?:^|[-.])(qa|staging)(?:[-.]|$)/i.test(origin.hostname)
)
  throw Error("Only an explicitly named QA/staging HTTPS origin is permitted");
const base = origin.origin + "/api/fore";
const headers = { authorization: "Bearer " + auth };
const status = await fetch(
  base + "/admin/soundtracks?status=pending_review&automation=1&limit=" + limit,
  {
    headers,
    signal: AbortSignal.timeout(30000),
  },
);
if (!status.ok) throw Error("QA staff candidate listing denied (" + status.status + ")");
const rows = (await status.json()).records;
if (!Array.isArray(rows)) throw Error("Invalid QA candidate list");
let analyzed = 0,
  accepted = 0,
  declined = 0,
  invalid = 0;
for (const r of rows.slice(0, limit)) {
  if (
    r.status !== "pending_review" ||
    r.quality_status !== "pending" ||
    r.automated_triage_reason ||
    !/^cm_\d{1,15}$/.test(r.id) ||
    !Number.isInteger(r.review_version)
  )
    continue;
  let source;
  try {
    source = new URL(r.source_file_url);
    if (
      source.protocol !== "https:" ||
      source.hostname !== "upload.wikimedia.org" ||
      !source.pathname.startsWith("/wikipedia/commons/") ||
      source.username ||
      source.password ||
      source.search ||
      source.hash ||
      !["audio/ogg", "application/ogg", "audio/mpeg"].includes(r.mime) ||
      !Number.isInteger(r.source_size) ||
      r.source_size <= 0 ||
      r.source_size > MAX_MUSIC_QA_BYTES ||
      !/^[0-9a-f]{40}$/.test(r.source_sha1)
    )
      throw Error("Untrusted or oversized source");
    const dir = await mkdtemp(path.join(tmpdir(), "cove-music-qa-"));
    const filepath = path.join(dir, "original.master");
    try {
      const response = await fetch(source.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(120000),
        headers: { "User-Agent": "CoveMusicQA/1.0 (+https://github.com/JibrilMohamud/cove)" },
      });
      if (
        !response.ok ||
        !response.body ||
        (response.headers.get("content-length") &&
          Number(response.headers.get("content-length")) !== r.source_size)
      )
        throw Error("Source unavailable or exact size changed");
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (stream) {
          for await (const chunk of stream) {
            bytes += chunk.length;
            if (bytes > MAX_MUSIC_QA_BYTES || bytes > r.source_size)
              throw Error("Source exceeds exact declared size");
            yield chunk;
          }
        },
        createWriteStream(filepath, { flags: "wx" }),
      );
      if (bytes !== r.source_size) throw Error("Incomplete source download");
      const quality = await analyzeMusicMaster(filepath, {
        sha1: r.source_sha1,
        bytes: r.source_size,
      });
      analyzed++;
      const passes =
        quality.integratedLufs >= -40 &&
        quality.integratedLufs <= -8 &&
        quality.truePeakDbfs <= 0 &&
        quality.clippedSampleRatio < 0.001 &&
        quality.silenceRatio < 0.25;
      if (passes) accepted++;
      else declined++;
      if (commit) {
        const saved = await fetch(base + "/admin/soundtracks/recordings/" + r.id, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ action: "quality", version: r.review_version, report: quality }),
          signal: AbortSignal.timeout(20000),
        });
        if (!saved.ok)
          throw Error("QA status write rejected for " + r.id + " (" + saved.status + ")");
      }
      console.info(JSON.stringify({ id: r.id, accepted: passes, written: commit }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    invalid++;
    // No upstream URL, secret, media bytes or error response bodies are logged.
    console.warn(JSON.stringify({ id: r.id, skipped: String(error).slice(0, 180) }));
  }
}
console.log(
  JSON.stringify({ dryRun: !commit, scanned: rows.length, analyzed, accepted, declined, invalid }),
);
