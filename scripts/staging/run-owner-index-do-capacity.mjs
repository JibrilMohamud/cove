/* eslint-disable prettier/prettier -- Isolated stage probe; explicit safety guards are audited. */
/**
 * Strict hosted performance driver for the isolated 25-record unified-owner
 * Durable Object. Fake proofs only; NEVER a production release certificate.
 */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const run = process.env.GITHUB_RUN_ID;
assert.match(run || "", /^[0-9]{8,15}$/);
const attempt = process.env.GITHUB_RUN_ATTEMPT;
assert.match(attempt || "", /^[1-9][0-9]{0,2}$/);
const name = "cove-owner-do-capacity-" + run + "-a" + attempt;
const origin = "https://" + name + ".cove-jibrilmohamud.workers.dev";
const secret = JSON.parse(readFileSync(".output/stage-owner-do/secrets.json", "utf8")).COVE_OWNER_DO_GATE;
assert.match(secret, /^[a-f0-9]{64}$/);
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const rounded = (x) => Number.isFinite(x) ? Number(x.toFixed(2)) : null;
const percentile = (xs, q) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.ceil(xs.length * q) - 1];
};
async function probe(path, expectedCount = null) {
  const started = performance.now();
  let responseStatus = 0;
  try {
    const response = await fetch(origin + "/__cove/owner-do/" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + secret },
      signal: AbortSignal.timeout(10000),
    });
    responseStatus = response.status;
    const firstByteMs = performance.now() - started;
    const result = await response.json();
    return {
      valid: response.status === 200 && result.releaseCertified === false &&
        (expectedCount === null ? result.valid === true :
          result.count === expectedCount && result.valid === true &&
          result.fingerprint === "exact-12-free-13-paid"),
      status: response.status,
      ms: rounded(firstByteMs),
      launched: true,
    };
  } catch (error) {
    return {
      valid: false, status: responseStatus, launched: true,
      ms: rounded(performance.now() - started),
      failure: error instanceof Error ? error.name : "unknown",
    };
  }
}
async function command(path) {
  const response = await fetch(origin + "/__cove/owner-do/" + path, {
    method: "POST", headers: { authorization: "Bearer " + secret },
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, "Protected stage command " + path + " returned " + response.status);
  assert.equal(body.releaseCertified, false);
  return body;
}
function strict(x, offered) {
  return x.valid === offered && x.launched === offered && x.dropped === 0 &&
    x.p95 !== null && x.p95 < 600 && x.p99 < 750 && x.max < 800 &&
    (!x.shadow || (x.shadow.valid === 100 && x.shadow.max < 800));
}
async function phase(path, shape, offered, spacing, shadow = false) {
  const begin = performance.now();
  const pending = new Set();
  const shadowPending = new Set();
  const rows = [], controls = [];
  for (let i = 0; i < offered; i++) {
    const target = begin + i * spacing;
    await sleep(target - performance.now());
    const late = performance.now() - target;
    if (late >= 100 || pending.size >= 64) {
      rows.push({ valid: false, launched: false, dropped: true });
      continue;
    }
    const task = probe(path, path === "read" ? 25 : null).then((row) => rows.push(row));
    pending.add(task);
    task.finally(() => pending.delete(task));
    if (shadow && i % 20 === 0) {
      const ctl = probe("noop").then((row) => controls.push(row));
      shadowPending.add(ctl);
      ctl.finally(() => shadowPending.delete(ctl));
    }
  }
  await Promise.allSettled([...pending, ...shadowPending]);
  const times = rows.map((r) => r.ms).filter(Number.isFinite);
  const result = {
    path, shape, offered,
    launched: rows.filter((r) => r.launched).length,
    valid: rows.filter((r) => r.valid).length,
    dropped: rows.filter((r) => r.dropped).length,
    failed: rows.filter((r) => !r.valid).length,
    achievedRps: rounded(1000 * rows.filter((r) => r.valid).length /
      Math.max(1, performance.now() - begin)),
    p95: rounded(percentile(times, 0.95)),
    p99: rounded(percentile(times, 0.99)),
    max: rounded(percentile(times, 1)),
    statusCounts: rows.reduce((acc, r) => {
      const key = String(r.status || 0);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    // Fixed error class only; never log response text, headers, tokens or SQL.
    failureTypes: rows.reduce((acc, r) => {
      if(!r.failure)return acc;
      acc[r.failure]=(acc[r.failure]||0)+1;
      return acc;
    }, {}),
    ...(shadow ? { shadow: {
      offered: controls.length,
      valid: controls.filter((r) => r.valid).length,
      max: rounded(percentile(controls.map((r) => r.ms).filter(Number.isFinite), 1)),
    } } : {}),
    releaseCertified: false,
  };
  results.push(result);
  console.log(JSON.stringify({ event: "cove_stage_owner_do_phase", ...result }));
  return result;
}
/**
 * Verify the owner-only contract tombstone takes effect from its ACK forward
 * while separate clients keep offering 100 legal-authority reads per second.
 * Before ACK either complete state is legal; after ACK only denied is legal.
 * No generated request is retried or silently discarded.
 */
async function withdrawalUnderLoad() {
  const offered = 600, interval = 10, started = performance.now();
  const pending = new Set(), responses = [];
  let ackAt = Number.POSITIVE_INFINITY;
  const withdraw = (async () => {
    await sleep(started + 2800 - performance.now());
    const receipt = await command("deny-contract");
    ackAt = performance.now();
    assert.equal(receipt.count, 24, "Contract owner ACK must reflect revocation");
    return receipt;
  })();
  for (let i = 0; i < offered; i++) {
    const due = started + i * interval;
    await sleep(due - performance.now());
    if (performance.now() - due >= 100 || pending.size >= 64) {
      responses.push({ launched: false, valid: false, dropped: true });
      continue;
    }
    const sentAt = performance.now();
    const task = (async () => {
      try {
        const response = await fetch(origin + "/__cove/owner-do/read-fence", {
          method: "POST",
          headers: { authorization: "Bearer " + secret },
          signal: AbortSignal.timeout(10000),
        });
        const ms = performance.now() - sentAt;
        const body = await response.json();
        responses.push({
          sentAt, ms, launched: true, dropped: false,
          count: body.count, contractDenied: body.contractDenied,
          valid: response.status === 200 && body.valid === true &&
            body.releaseCertified === false && (body.count === 24 || body.count === 25) &&
            body.contractDenied === (body.count === 24),
        });
      } catch {
        responses.push({ sentAt, launched: true, dropped: false, valid: false, count: null });
      }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await withdraw;
  await Promise.allSettled([...pending]);
  const before = responses.filter(r => r.launched && r.sentAt < ackAt);
  const after = responses.filter(r => r.launched && r.sentAt >= ackAt);
  const illegalAfterAck = after.filter(r => r.count !== 24 || r.contractDenied !== true);
  const latencies = responses.map(r => r.ms).filter(Number.isFinite);
  const evidence = {
    offered, launched: responses.filter(r => r.launched).length,
    valid: responses.filter(r => r.valid).length,
    dropped: responses.filter(r => r.dropped).length,
    beforeAck: before.length, afterAck: after.length, illegalAfterAck: illegalAfterAck.length,
    p95: rounded(percentile(latencies, 0.95)),
    p99: rounded(percentile(latencies, 0.99)),
    max: rounded(percentile(latencies, 1)),
    releaseCertified: false,
  };
  results.push({ shape: "100rps-with-live-contract-denial", ...evidence });
  console.log(JSON.stringify({ event: "cove_stage_owner_do_mutation_concurrency", ...evidence }));
  assert.equal(evidence.launched, offered, "Contract race must offer exactly 600 reads");
  assert.equal(evidence.dropped, 0, "No generator drops during contract withdrawal");
  assert.equal(evidence.valid, offered, "Every read must return an exact legal state");
  assert.ok(evidence.beforeAck >= 100 && evidence.afterAck >= 100,
    "Both sides of the owner ACK must have substantial coverage");
  assert.equal(evidence.illegalAfterAck, 0,
    "An acknowledged contract withdrawal must never return the old paid offer");
  assert.ok(evidence.p95 < 600 && evidence.p99 < 750 && evidence.max < 800,
    "Mixed owner read/write race must still satisfy strict latency");
}

let failed = null;
try {
  // Never retry mutations or measured requests. Readiness checks can retry
  // 404 only before the capacity campaign to allow hostname propagation.
  let ready = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const row = await probe("noop");
    if (row.valid) { ready = true; break; }
    await sleep(800);
  }
  assert.ok(ready, "Ephemeral owner stage never became available");
  const unauth = await fetch(origin + "/__cove/owner-do/read", { method: "POST" });
  assert.equal(unauth.status, 404, "Private owner path must require gate");
  const seed = await command("seed");
  assert.equal(seed.valid, true);
  assert.equal(seed.count, 25);
  const single = await probe("read", 25);
  assert.equal(single.valid, true, "Seed must read through actual unified owner SQL");
  for (const count of [1, 4, 8, 16, 32]) {
    const sample = await phase("read", "burst-" + count, count, 0);
    assert.ok(strict(sample, count), "Strict 1/4/8/16/32 owner DO burst failed");
  }
  const control = await phase("noop", "100rps-no-do-control", 2000, 10);
  assert.ok(strict(control, 2000), "No-DO ingress floor failed");
  const half = await phase("read", "50-rps-20s", 1000, 20);
  assert.ok(strict(half, 1000), "Unified owner DO failed strict 50RPS");
  for (let i = 1; i <= 2; i++) {
    const full = await phase("read", "100-rps-20s-phase-" + i, 2000, 10, true);
    assert.ok(strict(full, 2000), "Unified owner DO failed strict 100RPS phase " + i);
  }
  // Real concurrent owner SQL reads and an ACK-fenced contractual revocation:
  // cannot serve the previous price/rights after the legal owner commits.
  await withdrawalUnderLoad();
  // Remaining post-load mutations are serialized and never retried.
  const fencedRead = await command("read-fence");
  assert.equal(fencedRead.count, 24, "Denied contract remains absent after concurrent load");
  assert.equal(fencedRead.valid, true);
  const free = await command("deny-free");
  assert.equal(free.count, 23, "Source-wide denial must immediately remove free offer");
  const stale = await command("stale-regrant");
  assert.equal(stale.stalePositiveRejected, true, "Stale positive must fail");
  assert.equal(stale.count, 23);
  const market = await command("market-deny");
  assert.equal(market.marketDenied, true);
  assert.equal(market.count, 0, "Market tombstone removes all prior offers");
  console.log(JSON.stringify({ event: "cove_stage_owner_do_revocation", passed: true,
    releaseCertified: false }));
  console.log(JSON.stringify({ event: "cove_stage_owner_do_capacity", passed: true,
    releaseCertified: false }));
} catch (error) {
  failed = error instanceof Error ? error.message : "unknown";
  console.error("Owner DO capacity stage failed:", failed);
  process.exitCode = 1;
} finally {
  mkdirSync("artifacts/owner-do-stage", { recursive: true });
  writeFileSync("artifacts/owner-do-stage/evidence.json", JSON.stringify({
    schema: "cove.stage-unified-owner-do-capacity.v1",
    productionModified: false, releaseCertified: false,
    campaignCompleted: failed === null, failure: failed, results,
  }, null, 2) + "\n");
}
