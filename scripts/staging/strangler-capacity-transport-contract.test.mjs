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

test("100RPS campaign validates every decompressed response off the runner's header event loop",()=>{
  for(const name of ["brotliDecompress","gunzip","inflate"])
    assert.match(transport,new RegExp("promisify\\("+name+"\\)"));
  assert.doesNotMatch(transport,/(?:brotliDecompressSync|gunzipSync|inflateSync)/,
    "Synchronous body inflation starves concurrent TTFB event-loop measurements");
  assert.match(transport,/await decodeBrotli\(encoded, options\)/);
  assert.match(transport,/await decodeGzip\(encoded, options\)/);
  assert.match(transport,/await decodeDeflate\(encoded, options\)/);
  assert.match(transport,/maxOutputLength: 4 \* 1024 \* 1024/,
    "Decoded bodies must still obey the original strict 4 MiB byte bound");
  assert.match(transport,/bodyResolve\(decoded\.toString\("utf8"\)\)/,
    "Every full HTML response still must be decoded and checked");
  assert.match(harness,/const html = await resp\.text\(\)/);
  assert.match(harness,/\/data-product=\"\//,
    "Canonical product marker must still be required from the real HTML body");
  assert.match(harness,/monitorEventLoopDelay\(\{ resolution: 20 \}\)/);
  assert.match(harness,/runnerEventLoopMaxMs/);
  assert.match(harness,/runnerEventLoopP99Ms/);
  for(const phase of ["cove_limit","cove_presentation","cove_context","cove_catalog","cove_catalog_sql"])
    assert.ok(harness.includes(phase),"Worst samples must retain the numeric "+phase+" Worker phase");
});
