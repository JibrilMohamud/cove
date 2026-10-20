import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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
async function request(path="/",options={}) {
  const began=performance.now();
  try{
    const response=await fetch(origin+path,{
      method:options.method||"GET",redirect:"manual",
      headers:options.noAuth?{"Cache-Control":"no-store"}:headers,
      signal:AbortSignal.timeout(15000),
    });
    const ttfbMs=Math.round(performance.now()-began);
    const body=await response.text();
    return {
      status:response.status,
      ttfbMs,
      body,
      contentType:response.headers.get("content-type")||"",
      cacheControl:response.headers.get("cache-control")||"",
      timings:response.headers.get("server-timing")||"",
    };
  }catch{return {status:0,ttfbMs:Math.round(performance.now()-began),body:"",contentType:"",cacheControl:"",timings:""};}
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
