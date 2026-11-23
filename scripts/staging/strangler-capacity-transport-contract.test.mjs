/* eslint-disable prettier/prettier -- Strict source assertions over the protected hosted campaign. */
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";

const harness=readFileSync("scripts/staging/check-strangler-live-capacity.mjs","utf8");
const transport=readFileSync("scripts/staging/strangler-http-transport.mjs","utf8");
const workflow=readFileSync(".github/workflows/strangler-hosted-capacity-evaluation.yml","utf8");
test("all protected hosted samples retain their unchanged hard-zero-drop release criteria",()=>{
  for(const regex of [
    /const strictMaximumMs = 800;/,
    /const p95MaximumMs = 600;/,
    /const p99MaximumMs = 750;/,
    /dropped === 0/,
    /rows\.length === offered/,
    /valid === offered/,
    /maxMs < strictMaximumMs/,
    /p95Ms < p95MaximumMs/,
    /p99Ms < p99MaximumMs/,
    /for \(const size of \[1, 4, 8, 16, 32\]\)/,
    /for \(const rate of \[25, 50, 100\]\)/,
    /rate === 100 \? 20 : 10/,
    /if \(!results\.phases\.every\(\(phase\) => phase\.pass\)\) process\.exitCode = 1;/
  ])assert.match(harness,regex,"An acceptance requirement or nonzero-drop gate was changed");
});
test("HTTP2 load-client connection setup cannot replay requests or warm production Worker application state",()=>{
  assert.match(transport,/const sessionPool = Array\.from\(\{ length: 16 \}/);
  assert.match(transport,/export async function primeStageTransportConnections\(\)/);
  const begin=transport.indexOf("export async function primeStageTransportConnections()");
  const end=transport.indexOf("export async function stageFetch(",begin);
  assert.ok(begin>=0&&end>begin);
  const prime=transport.slice(begin,end);
  assert.match(prime,/sessionPool\.map\(\(slot\) => getSession\(slot\)\)/);
  assert.doesNotMatch(prime,/\.request\(|\.fetch\(|POST|\.prepare\(|\.put\(/,
    "Session warmup must NOT send any HTTP/D1/R2 request");
  assert.match(harness,/await primeStageTransportConnections\(\)/);
  assert.match(transport,/if \(!client\.closed && !client\.destroyed\) throw error/);
  assert.match(transport,/stream\.once\("error"/);
  assert.match(transport,/bodyReject\(error\)/);
  assert.match(workflow,/Strict HTTP2 1\/4\/8\/16\/32 plus 25\/50\/100 RPS gate/);
  assert.match(workflow,/Repeat three independently rotated cold deployment suites/);
});
test("safe client classes, every invalid response and independent Worker/transport phases remain visible",()=>{
  for(const pattern of [
    /invalidStatusCounts/,
    /clientFailureClasses/,
    /invalidSamples/,
    /transportWaitMs/,
    /transportWireMs/,
    /worstSamples/,
    /bootstrapMaxMs/,
    /residualMaxMs/,
    /edgeRay/,
    /return pass;/
  ])assert.match(harness,pattern);
  assert.match(harness,/closeStageTransport\(\)/);
});
