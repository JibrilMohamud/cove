import assert from "node:assert/strict";
import {
  runMusicHandoff,
  validateMusicHandoffOperator,
} from "./music-supply/replay-music-supply-handoff.mjs";

let calls = 0;
assert.deepEqual(
  await runMusicHandoff(
    { execute: false },
    {
      send: () => {
        calls++;
        throw Error("network");
      },
    },
  ),
  {
    dryRun: true,
    attempted: 0,
    applied: 0,
    skipped: 0,
    nextCursor: "0",
  },
);
assert.equal(calls, 0, "Dry run never touches isolated or primary D1");
const c = {
  execute: true,
  enabled: "1",
  supplierUrl: "https://cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev/",
  canonicalUrl: "https://cove-persistence-backend-staging-qa.cove-jibrilmohamud.workers.dev/",
  operatorToken: "a".repeat(48),
  backendToken: "b".repeat(48),
  handoffToken: "c".repeat(48),
  after: "0",
  limit: 2,
  maxBatches: 3,
};
for (const bad of [
  { ...c, canonicalUrl: "https://cove-persistence-backend.cove-jibrilmohamud.workers.dev/" },
  { ...c, supplierUrl: "http://cove-music-supply-isolated-qa.cove-jibrilmohamud.workers.dev/" },
  { ...c, enabled: "0" },
  { ...c, handoffToken: c.backendToken },
  { ...c, limit: 40 },
])
  assert.throws(() => validateMusicHandoffOperator(bad));
const e1 = { seq: 1, id: "d".repeat(36), action: "master_qualified", publishable: 1 };
const e2 = { seq: 2, id: "e".repeat(36), action: "contract_revoked", publishable: 0 };
let received = [];
const send = async (url, options) => {
  received.push({ url, method: options.method, headers: options.headers });
  if (options.method === "GET") {
    assert.match(url, /\/v1\/operator\/outbox/);
    assert.equal(options.redirect, "manual");
    if (url.includes("after=0")) return Response.json({ items: [e1, e2], nextCursor: "2" });
    if (url.includes("after=2")) return Response.json({ items: [], nextCursor: "2" });
    throw Error("bad cursor");
  }
  assert.equal(options.headers["x-cove-music-handoff-token"], c.handoffToken);
  assert.equal(options.headers["x-cove-backend-token"], c.backendToken);
  assert.equal(options.redirect, "manual");
  return Response.json({ seq: JSON.parse(options.body).seq, recorded: true });
};
const r = await runMusicHandoff(c, { send });
assert.deepEqual(r, {
  dryRun: false,
  attempted: 2,
  applied: 2,
  skipped: 0,
  batches: 1,
  nextCursor: "2",
});
assert.equal(received.length, 4, "One scoped source poll, two canonical updates and one end poll");
const replay = await runMusicHandoff({ ...c, after: "2" }, { send });
assert.equal(replay.attempted, 0);
const expired = await runMusicHandoff(
  { ...c, maxBatches: 1 },
  {
    send: async (url, options) => {
      if (options.method === "GET")
        return Response.json({ items: [{ ...e1, publishable: 0 }], nextCursor: "1" });
      throw Error("A rights-invalid historical event cannot be sent to canonical");
    },
  },
);
assert.equal(expired.applied, 0);
assert.equal(expired.skipped, 1);
await assert.rejects(
  runMusicHandoff(
    { ...c, maxBatches: 1 },
    {
      send: async (url, options) => {
        if (options.method === "GET") return Response.json({ items: [e1], nextCursor: "1" });
        return new Response("Forbidden", { status: 403 });
      },
    },
  ),
  /failed closed/,
);
console.log(
  "Bounded isolated source-to-canonical QA replay, dry-run/network isolation, auth, rights skips and failure abort passed.",
);
