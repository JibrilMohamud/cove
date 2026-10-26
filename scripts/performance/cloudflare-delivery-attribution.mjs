/* eslint-disable prettier/prettier -- Diagnostic report formatting is intentionally compact and auditable. */
/**
 * Strict release-gate attribution: compare each sampled client first-header
 * duration against the very same Cloudflare Ray's Worker wall time.
 * This script never changes, retries, weights, or excludes measured requests.
 * Reports have no visitor IP, TLS random, credentials, or request headers.
 */
import fs from "node:fs";
import assert from "node:assert/strict";

export function classifyDeliverySample(sample, worker) {
  if (!sample || !Number.isFinite(sample.ms)) throw Error("invalid_client_sample");
  const cfWallMs = worker && Number.isFinite(worker.wallTimeMs) ? worker.wallTimeMs : null;
  const workerHandlerMs = Number.isFinite(sample.handlerMs) ? sample.handlerMs : null;
  const workMs = cfWallMs ?? workerHandlerMs;
  const headersMs=Number.isFinite(sample.firstHeadersMs)
    ? sample.firstHeadersMs : sample.ms;
  const bodyMs=Math.max(0,sample.ms-headersMs);
  const outsideMs = workMs === null ? null : Math.max(0, sample.ms - workMs);
  const outsideFirstHeadersMs = workMs === null ? null : Math.max(0,headersMs-workMs);
  return {
    ray: sample.ray,
    colo: sample.colo,
    status: sample.status,
    totalClientResponseMs: sample.ms,
    clientFirstHeadersMs: headersMs,
    clientBodyDeliveryAndDecodeMs: bodyMs,
    outsideWorkerToFirstHeadersMs: outsideFirstHeadersMs,
    workerWallMs: cfWallMs,
    workerHandlerMs,
    outsideWorkerMs: outsideMs,
    sqlMs: Number(/cove_catalog_sql;dur=([0-9.]+)/.exec(sample.timing || "")?.[1] ?? NaN) || null,
    httpProtocol: worker?.httpProtocol || null,
    clientTcpRttMs: worker?.clientTcpRtt ?? null,
    edgeDeliveryRate: worker?.edgeDeliveryRate ?? null,
    sessionId: sample.transportSpan?.sessionId ?? null,
    // This is an attribution hypothesis, NOT proof of packet loss.
    classification: outsideFirstHeadersMs !== null && headersMs >= 800 &&
        outsideFirstHeadersMs > 500 && workMs < 200 ? "edge-or-client-delivery-tail" :
      sample.ms >= 800 && bodyMs > 500 && workMs !== null && workMs < 200
        ? "body-delivery-or-decode-tail" :
      sample.ms >= 800 && workMs !== null && workMs >= 500
        ? "worker-or-data-service-tail" :
      "insufficient-evidence-or-within-gate"
  };
}
if (process.argv.includes("--self-test")) {
  const p=classifyDeliverySample({
    ray:"a506cc8968835756-MSP",colo:"MSP",ms:2083.13,handlerMs:42,
    timing:"cove_catalog_sql;dur=4.4",transportSpan:{sessionId:73}
  },{wallTimeMs:49,clientTcpRtt:11,httpProtocol:"HTTP/2"});
  assert.equal(p.classification,"edge-or-client-delivery-tail");
  assert.equal(p.outsideWorkerMs,2034.13);
  assert.equal(p.sessionId,73);
  assert.equal(p.sqlMs,4.4);
  const bodyTail=classifyDeliverySample({
    ray:"body",ms:1280,firstHeadersMs:80,handlerMs:24,
    transportSpan:{bodyDeliveryMs:1200}
  },null);
  assert.equal(bodyTail.clientBodyDeliveryAndDecodeMs,1200);
  assert.equal(bodyTail.classification,"body-delivery-or-decode-tail");
  assert.equal(classifyDeliverySample({ray:"r",ms:920,handlerMs:850},null).classification,
    "worker-or-data-service-tail");
  console.log("PASS: Cloudflare Ray attribution preserves every failing request");
} else {
  const filename=process.argv[2] || "artifacts/isolated-data-plane/results.json";
  const artifact=JSON.parse(fs.readFileSync(filename,"utf8"));
  const rows=[
    ...(artifact.cold||[]),
    ...(artifact.bursts||[]).flatMap(x=>x.rows||[]),
    ...(artifact.phases||[]).flatMap(x=>x.rows||[])
  ];
  const slow=rows.filter(x=>x?.ray && Number.isFinite(x.ms) && x.ms>=800)
    .sort((a,b)=>b.ms-a.ms);
  const selected=[];
  for(const row of slow) {
    if(selected.some(x=>x.ray===row.ray)) continue;
    selected.push(row);
    if(selected.length>=4) break;
  }
  const output={schema:"cove.cf-ray-delivery-attribution.v1",sha:artifact.sha,
    benchmarkPass:artifact.pass,originalSlowRequestCount:slow.length,
    slowestObservedClientMs:slow[0]?.ms??null,checked:[],errors:[],
    note:"Diagnostic only: hard 800ms gate remains unchanged. Cloudflare wallTime excludes transit."};
  const token=process.env.CLOUDFLARE_API_TOKEN;
  const account=process.env.CLOUDFLARE_ACCOUNT_ID;
  async function inspect(row) {
    const baseId=String(row.ray).split("-")[0];
    if(!/^[a-f0-9]{16,30}$/.test(baseId)||!/^[-A-Z]{3}$/.test(row.colo||"")) throw Error("invalid_ray");
    if(!token || !/^[a-f0-9]{32}$/.test(account||"")) throw Error("cloudflare_credentials_unavailable");
    // Use a narrow time interval anchored at this measured sample; never
    // search users' production traffic or query unrelated services.
    const center=Number.isFinite(row.completedAtUnixMs)?row.completedAtUnixMs:Date.now();
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,{
      method:"POST",
      headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({
        queryId:"cove-pr351-capacity-ray-verification",
        timeframe:{from:center-180000,to:center+180000},view:"events",limit:3,
        parameters:{needle:{value:baseId}}
      }),
      signal:AbortSignal.timeout(20000),
    });
    if(!response.ok) throw Error("cf_telemetry_http_"+response.status);
    const result=await response.json();
    if(!result.success) throw Error("cf_telemetry_no_success");
    const event=(result.result?.events?.events||[]).find(e=>
      e?.$metadata?.rayId===baseId &&
      /^cove-arch-[0-9]+-[0-9]+$/.test(e?.$metadata?.service||""));
    const w=event?.$workers;
    return classifyDeliverySample(row,w?{
      wallTimeMs:w.wallTimeMs,cpuTimeMs:w.cpuTimeMs,
      clientTcpRtt:w.event?.request?.cf?.clientTcpRtt,
      httpProtocol:w.event?.request?.cf?.httpProtocol,
      edgeDeliveryRate:w.event?.request?.cf?.edgeL4?.deliveryRate
    }:null);
  }
  for (const row of selected) {
    try {output.checked.push(await inspect(row));}
    catch(err){output.errors.push({ray:row.ray,reason:String(err?.message||err).slice(0,80)});
      output.checked.push(classifyDeliverySample(row,null));}
  }
  fs.writeFileSync("artifacts/isolated-data-plane/cloudflare-ray-attribution.json",
    JSON.stringify(output,null,2));
  console.log("ARCH_CF_RAY_ATTRIBUTION",JSON.stringify(output));
  // Always exit 0: a missing diagnostic API permission must not replace
  // the original strictly-failing hosted-capacity verdict.
}
