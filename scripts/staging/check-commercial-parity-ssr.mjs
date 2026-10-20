import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { validateHtml, percentile } from "../check-production-storefront-performance.mjs";

const origin="https://cove-commercial-parity-ssr-staging-20261020.cove-jibrilmohamud.workers.dev";
const key=process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(key||"",/^[a-f0-9]{64}$/,"A temporary 256-bit staging bearer is mandatory");
const headers={
  Authorization:"Bearer "+key,
  Accept:"text/html",
  "Cache-Control":"no-store",
};
const traceContext=new AsyncLocalStorage();
const requests=new WeakMap();
channel("undici:request:create").subscribe(({request})=>{
  const span=traceContext.getStore();
  if(span&&request?.origin===origin){
    span.created=performance.now();
    requests.set(request,span);
  }
});
channel("undici:client:sendHeaders").subscribe(({request})=>{
  const span=requests.get(request);
  if(span)span.sent=performance.now();
});
channel("undici:request:headers").subscribe(({request})=>{
  const span=requests.get(request);
  if(span)span.received=performance.now();
});
const elapsed=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,Math.round(a-b)):null;
const serverDuration=(header,key)=>{
  const m=header.match(new RegExp("(?:^|,)\\s*"+key+";dur=(\\d+(?:\\.\\d+)?)"));
  return m?Number(m[1]):null;
};
async function request(path="/",options={}) {
  const began=performance.now();
  const span={};
  try{
    const response=await traceContext.run(span,()=>fetch(origin+path,{
      method:options.method||"GET",redirect:"manual",
      headers:options.noAuth?{"Cache-Control":"no-store"}:headers,
      signal:AbortSignal.timeout(15000),
    }));
    const ttfbMs=Math.round(performance.now()-began);
    const body=await response.text();
    return {
      status:response.status,
      ttfbMs,
      body,
      contentType:response.headers.get("content-type")||"",
      cacheControl:response.headers.get("cache-control")||"",
      timings:response.headers.get("server-timing")||"",
      colo:(response.headers.get("cf-ray")||"").match(/-([A-Z]{3})$/)?.[1]||"unknown",
      clientQueueMs:elapsed(span.sent,span.created),
      clientSentToHeadersMs:elapsed(span.received,span.sent),
    };
  }catch{return {status:0,ttfbMs:Math.round(performance.now()-began),body:"",contentType:"",cacheControl:"",timings:"",colo:"unknown",clientQueueMs:null,clientSentToHeadersMs:null};}
}
const results={scope:"schema-parity isolated D1, 1000 SYNTHETIC books, zero customer accounts/orders",validations:{},waves:[]};
let denied={status:0};
for(let i=0;i<15;i++){
  denied=await request("/",{noAuth:true});
  if(denied.status===401)break;
  await new Promise(r=>setTimeout(r,1000));
}
assert.equal(denied.status,401,"Protected stage must deny unauthenticated homepage");
results.validations.unauthorized401=true;
const post=await request("/",{method:"POST"});
assert.equal(post.status,405,"Protected SSR must reject POST");
results.validations.authenticatedWritesDenied=true;
const ready=await request("/api/fore/health/ready");
assert.equal(ready.status,200,"D1 readiness must pass before any performance sampling");
const health=JSON.parse(ready.body);
assert.equal(health.ok,true);
assert.equal(health.database,true);
results.validations.isolatedD1Ready=true;
const bootstrap=await request("/api/fore/storefront/bootstrap");
if(bootstrap.status!==200){
  const message=bootstrap.body.slice(0,400).replace(/Bearer\\s+[\\w.-]+/gi,"Bearer [redacted]");
  console.error(JSON.stringify({stage:"catalog-bootstrap",status:bootstrap.status,
    contentType:bootstrap.contentType,serverTiming:bootstrap.timings.slice(0,200),
    responsePreview:message}));
}
assert.equal(bootstrap.status,200,"Authorized synthetic catalog bootstrap must return 200");
const catalog=JSON.parse(bootstrap.body);
assert.ok(catalog.catalog?.results?.length>0,"Rights-authorized catalog must not be empty");
assert.equal(catalog.context?.rightsCountry,"US");
results.validations.liveUSRights=true;
const waves=[{concurrency:1,requests:4},{concurrency:4,requests:8},
{concurrency:8,requests:16},{concurrency:16,requests:24},{concurrency:32,requests:32}];
for(const wave of waves){
  let next=0;const rows=[];
  await Promise.all(Array.from({length:wave.concurrency},async()=>{
    while(next<wave.requests){
      next++;
      const response=await request("/");
      let cards=0;
      try{cards=validateHtml(response.status,response.contentType,response.body);}catch{}
      rows.push({
        status:response.status,cards,ttfbMs:response.ttfbMs,
        colo:response.colo,
        clientQueueMs:response.clientQueueMs,
        clientSentToHeadersMs:response.clientSentToHeadersMs,
        workerTotalMs:serverDuration(response.timings,"cove_total"),
        bootstrapMs:serverDuration(response.timings,"cove_ssr_bootstrap"),
        catalogMs:serverDuration(response.timings,"cove_backend_catalog"),
        catalogSqlMs:serverDuration(response.timings,"cove_backend_catalog_sql"),
        pageMs:serverDuration(response.timings,"cove_backend_page"),
        contextMs:serverDuration(response.timings,"cove_backend_context"),
        limitMs:serverDuration(response.timings,"cove_backend_limit"),
        edgeBootstrapMs:serverDuration(response.timings,"cove_backend_bootstrap"),
        authorized:!!cards&&response.status===200&&/no-store/i.test(response.cacheControl)&&/cove_ssr_local_rights;dur=0/.test(response.timings),
      });
    }
  }));
  const times=rows.map(x=>x.ttfbMs);
  const valid=rows.filter(x=>x.authorized).length;
  const summary={concurrency:wave.concurrency,offered:wave.requests,
    valid,failed:wave.requests-valid,
    p50Ms:percentile(times,0.5),p95Ms:percentile(times,0.95),
    maxMs:Math.max(...times),
    colocations:[...new Set(rows.map(x=>x.colo))].sort(),
    p95WorkerMs:percentile(rows.map(x=>x.workerTotalMs).filter(Number.isFinite),0.95),
    p95CatalogMs:percentile(rows.map(x=>x.catalogMs).filter(Number.isFinite),0.95),
    p95CatalogSqlMs:percentile(rows.map(x=>x.catalogSqlMs).filter(Number.isFinite),0.95),
    p95ContextMs:percentile(rows.map(x=>x.contextMs).filter(Number.isFinite),0.95),
    p95PageMs:percentile(rows.map(x=>x.pageMs).filter(Number.isFinite),0.95),
    p95LimitMs:percentile(rows.map(x=>x.limitMs).filter(Number.isFinite),0.95),
    p95EdgeBootstrapMs:percentile(rows.map(x=>x.edgeBootstrapMs).filter(Number.isFinite),0.95),
    p95BootstrapMs:percentile(rows.map(x=>x.bootstrapMs).filter(Number.isFinite),0.95),
    p95ClientQueueMs:percentile(rows.map(x=>x.clientQueueMs).filter(Number.isFinite),0.95),
    p95SentToHeadersMs:percentile(rows.map(x=>x.clientSentToHeadersMs).filter(Number.isFinite),0.95),
    pass:valid===wave.requests&&Math.max(...times)<800,
  };
  results.waves.push(summary);
}
results.validations.noFastUnauthorizedResponses=results.waves.every(w=>w.valid===w.offered);
results.performancePass=results.waves.every(w=>w.pass);
results.commercialCertified=false;
fs.mkdirSync("artifacts",{recursive:true});
fs.writeFileSync("artifacts/commercial-parity-ssr-smoke.json",JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
if(!results.performancePass)process.exitCode=1;
