/* eslint-disable prettier/prettier -- Isolated safety rehearsal: intentionally strict controls. */
/** Generate two gate-protected, ephemeral Workers. No customer bindings. */
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";

const ACCOUNT="f51e8ccbc394e2d6016ff8c2c303d54b";
const run=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;
assert.match(run||"",/^[0-9]{8,15}$/);
assert.match(attempt||"",/^[1-9][0-9]{0,2}$/);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,ACCOUNT);
const name="cove-rollback-proof-"+run+"-a"+attempt;
assert.ok(name.length<63 && !name.includes("persistence"));
const root=".output/rollback-stage";
mkdirSync(root,{recursive:true});
const gate=randomBytes(32).toString("hex");
const expires=Date.now()+12*60*1000;
const script=v=>[
  "const MARKER="+JSON.stringify(v)+";",
  "export default {fetch(request,env){",
  " if(Date.now()>Number(env.COVE_ROLLBACK_EXPIRES_AT))",
  '  return new Response("stage-expired",{status:503});',
  " const url=new URL(request.url);",
  ' if(request.method!=="GET"||url.pathname!=="/__cove/rollback")',
  '  return new Response("not-found",{status:404});',
  ' if(request.headers.get("x-cove-stage-gate")!==env.COVE_ROLLBACK_GATE)',
  '  return new Response("unauthorized",{status:401});',
  " return new Response(JSON.stringify({stage:true,version:MARKER}),{",
  ' status:200,headers:{"content-type":"application/json",',
  ' "cache-control":"no-store","x-cove-rollback-version":MARKER}});',
  "}};",
].join("\n");
for(const v of ["A","B"]){
  writeFileSync(root+"/worker-"+v+".mjs",script(v),{mode:0o600});
  const config={
    name,account_id:ACCOUNT,main:"worker-"+v+".mjs",
    compatibility_date:"2026-11-15",
    workers_dev:true,preview_urls:false,routes:[],
    observability:{enabled:false},
    vars:{COVE_ROLLBACK_REHEARSAL:"1",COVE_ROLLBACK_EXPIRES_AT:String(expires)}
  };
  assert.deepEqual(config.routes,[]);
  for(const bad of ["d1_databases","durable_objects","r2_buckets",
    "kv_namespaces","queues","services","triggers","analytics_engine_datasets"]){
    assert.equal(config[bad],undefined);
  }
  writeFileSync(root+"/wrangler-"+v+".jsonc",JSON.stringify(config,null,2),{mode:0o600});
}
writeFileSync(root+"/secrets.json",JSON.stringify({COVE_ROLLBACK_GATE:gate}),{mode:0o600});
writeFileSync(root+"/gate.json",JSON.stringify({name,gate,expires}),{mode:0o600});
console.log(JSON.stringify({event:"cove_stage_rollback_prepared",worker:name,
  expiresInMinutes:12,bindings:0,routes:0,releaseCertified:false}));
