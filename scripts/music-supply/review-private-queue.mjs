#!/usr/bin/env node
// No public endpoint or production DB. Distinct reviewer/operator credentials.
// Human approvers must play the private original in full before attesting.
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const endpoint = process.env.COVE_MUSIC_SUPPLY_QA_URL || "";
const reviewer = process.env.COVE_MUSIC_ACOUSTIC_REVIEWER_TOKEN || "";
const operator = process.env.COVE_MUSIC_SUPPLY_OPERATOR_TOKEN || "";
const args = process.argv.slice(2);
const listing = args.includes("--list");
const metrics = args.includes("--metrics");
const file = args.find((a) => a.startsWith("--decision="))?.slice("--decision=".length);
const master = args.find((a) => a.startsWith("--audio="))?.slice("--audio=".length);
const output = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);
assert.ok([listing, metrics, Boolean(file), Boolean(master)].filter(Boolean).length === 1,
  "Choose exactly one operation: --list, --metrics, --audio=id --output=filepath, or --decision=review.json");
const url = new URL(endpoint);
if (url.href !== "https://cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev/")
  throw Error("Only isolated Cove music QA host is permitted");
const token = metrics ? operator : reviewer;
if (token.length < 40 || token.length > 256)
  throw Error("Missing distinct, scoped operator or acoustic reviewer identity");

async function request(path, options = {}) {
  const response = await fetch(endpoint + path, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(90000),
    headers: {
      authorization: "Bearer " + token,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (response.status !== (options.method === "POST" ? 202 : 200))
    throw Error("Isolated reviewer operation rejected (HTTP " + response.status + ")");
  return response;
}
if (listing) {
  const result = await (await request("v1/execution/review")).json();
  console.log(JSON.stringify(result, null, 2));
} else if (metrics) {
  const result = await (await request("v1/execution/metrics")).json();
  console.log(JSON.stringify(result, null, 2));
} else if (master) {
  assert.match(master, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/);
  if (!output) throw Error("Provide --output=path to a secure local audio file");
  const result = await request("v1/execution/review/" + encodeURIComponent(master) + "/audio");
  if (!result.body) throw Error("Missing original private audio");
  const bytes = Buffer.from(await result.arrayBuffer());
  if (bytes.length <= 128 || bytes.length > 25 * 1024 * 1024)
    throw Error("Invalid private original byte count");
  // Write with exclusive creation. The reviewer, not the system, must
  // listen to the exact original and provide truthful full-master attestation.
  await fs.writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ masterId: master, bytes: bytes.length, privateLocalPath: output }));
} else if (file) {
  const raw = await fs.readFile(file, "utf8");
  if (Buffer.byteLength(raw) > 2500) throw Error("Review decision over size limit");
  const record = JSON.parse(raw);
  if (typeof record.masterId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/.test(record.masterId))
    throw Error("Invalid master identity");
  const { masterId, ...decision } = record;
  const result = await (await request(
    "v1/execution/review/" + encodeURIComponent(masterId),
    { method: "POST", body: JSON.stringify(decision) },
  )).json();
  console.log(JSON.stringify(result, null, 2));
}
