/* eslint-disable prettier/prettier -- Protected writer inventory transport fault tests. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPhysicalWriterReadTransport,retryAfterMs} from './physical-d1-writer-read-transport.mjs';
const TOKEN='read_token_fixture_long_enough';
const ACCOUNT='d26430caa63ec55f6612e32f36aca5e9';
const SCRIPTS='/accounts/'+ACCOUNT+'/workers/scripts';
function clock(){
 let time=1000000;
 const sleeps=[];
 return {now:()=>time,sleep:async ms=>{assert.ok(ms>=0);sleeps.push(ms);time+=ms;},sleeps};
}
function ok(value=[]){return {status:200,json:async()=>({success:true,errors:[],result:value})};}
function limited(retryAfter){
 let cancelled=false;
 return {
   status:429,headers:{get:key=>key==='retry-after'?retryAfter:null},
   body:{cancel:async()=>{cancelled=true;}},
   get cancelled(){return cancelled;}
 };
}
test('concurrent requests are serialized with <=2 starts/sec across endpoint/token types',async()=>{
 const c=clock(),starts=[],paths=[];
 const client=createPhysicalWriterReadTransport({...c,fetchImpl:async(url,init)=>{
   assert.equal(init.method,'GET');assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/'));
   starts.push(c.now());paths.push(url.split('/client/v4')[1]);
   return ok();
 }});
 await Promise.all([
   client.get(SCRIPTS,TOKEN),
   client.get(SCRIPTS+'/cove-persistence-backend/deployments',TOKEN),
   client.get('/accounts/'+ACCOUNT+'/tokens',TOKEN),
   client.get('/user/tokens',TOKEN)
 ]);
 assert.deepEqual(starts,[1000000,1000500,1001000,1001500]);
 assert.deepEqual(paths,[SCRIPTS,SCRIPTS+'/cove-persistence-backend/deployments','/accounts/'+ACCOUNT+'/tokens','/user/tokens']);
 assert.deepEqual(client.stats(),{calls:4,rateLimited:0,rateLimitWaitMs:0});
});
test('429 retries only the original GET, respects long Retry-After and cancels throttled body',async()=>{
 const c=clock(),first=limited('45');
 let n=0;
 const client=createPhysicalWriterReadTransport({...c,fetchImpl:async()=>++n===1?first:ok()});
 await client.get(SCRIPTS,TOKEN);
 assert.equal(first.cancelled,true);assert.equal(n,2);
 assert.deepEqual(c.sleeps,[45000]);
 assert.equal(client.stats().rateLimitWaitMs,45000);
});
test('HTTP date Retry-After is calculated and too-long retry fails closed',async()=>{
 const c=clock();
 assert.equal(retryAfterMs(new Date(c.now()+70000).toUTCString(),c.now()),70000);
 assert.equal(retryAfterMs('invalid',c.now()),0);
 const tooLong=limited('600'),client=createPhysicalWriterReadTransport({...c,fetchImpl:async()=>tooLong});
 await assert.rejects(()=>client.get(SCRIPTS,TOKEN),/writer_audit_rate_limited/);
 assert.deepEqual(c.sleeps,[]);
 assert.equal(client.stats().calls,1);
});
test('non-429 HTTP, network failure and malformed response are never silently retried',async()=>{
 for(const r of [
   async()=>({status:403,body:{cancel:async()=>{}}}),
   async()=>{throw Error('secret upstream response');},
   async()=>({status:200,json:async()=>({success:true,result:[]})})
 ]){
   let calls=0;
   const client=createPhysicalWriterReadTransport({fetchImpl:async()=>{calls++;return r();}});
   await assert.rejects(()=>client.get(SCRIPTS,TOKEN),/writer_audit_/);
   assert.equal(calls,1);
 }
});
test('unapproved endpoints, POST-equivalent paths and missing credentials cannot send any request',async()=>{
 let calls=0;
 const client=createPhysicalWriterReadTransport({fetchImpl:async()=>{calls++;return ok();}});
 for(const path of [
   '/accounts/'+ACCOUNT+'/d1/database',
   SCRIPTS+'/cove-persistence-backend/settings',
   SCRIPTS+'/cove-persistence-backend/versions',
   SCRIPTS+'/cove-persistence-backend/versions/not-a-uuid',
   '/accounts/'+ACCOUNT+'/tokens/privileged/revoke',
   '/user/tokens/create',
   '/accounts/other-account/workers/scripts'
 ])await assert.rejects(()=>client.get(path,TOKEN),/writer_audit_endpoint_denied/);
 await assert.rejects(()=>client.get(SCRIPTS,''),/writer_audit_read_token_missing/);
 assert.equal(calls,0);
});
test('canonical read-group queries are fixed GET-only; arbitrary or mutation lookups are denied',async()=>{
 const c=clock(),requested=[];
 const client=createPhysicalWriterReadTransport({...c,fetchImpl:async(url,init)=>{
   assert.equal(init.method,'GET');
   requested.push(url);
   return ok();
 }});
 for(const name of ['API Tokens Read','User Details Read','Account Analytics Read']){
   await client.get('/user/tokens/permission_groups?name='+encodeURIComponent(name),TOKEN);
 }
 // Additional aliases are never enumerated unfiltered; only two exact
 // canonical READ/READ-ONLY candidate names can be fetched by ID.
 for(const name of ['Workers KV Storage Read','Workers KV Storage Read-Only'])
   await client.get('/user/tokens/permission_groups?name='+encodeURIComponent(name),TOKEN);
 assert.equal(requested.length,5);
 for(const scope of ['com.cloudflare.api.user','com.cloudflare.api.account',
   'com.cloudflare.api.account.zone','com.cloudflare.edge.r2.bucket'])
   await client.get('/user/tokens/permission_groups?scope='+scope,TOKEN);
 assert.equal(requested.length,9);
 for(const path of [
   '/user/tokens/permission_groups',
   '/user/tokens/permission_groups?scope=com.cloudflare.api.account&name=D1%20Write',
   '/user/tokens/permission_groups?scope=com.cloudflare.api.account&page=2',
   '/user/tokens/permission_groups?scope=arbitrary',
   '/user/tokens/permission_groups?name=D1%20Write',
   '/user/tokens/permission_groups?name=Account%20Analytics%20Write',
   '/user/tokens/permission_groups?name=Account%20Analytics%20Read&page=2',
   '/user/tokens/permission_groups?name=API%20Tokens%20Write'
 ])await assert.rejects(()=>client.get(path,TOKEN),/writer_audit_endpoint_denied/);
 assert.equal(requested.length,9);
});
test('release script requires separate protected scopes and repeats Worker revision list',()=>{
 const code=readFileSync('scripts/release/certify-exclusive-primary-d1.mjs','utf8');
 const flow=readFileSync('.github/workflows/cove-exclusive-primary-d1-writer-audit.yml','utf8');
 for(const key of ['CF_WORKERS_METADATA_READ_TOKEN','CF_WORKERS_CONTENT_READ_TOKEN','CF_ACCOUNT_TOKENS_AUDIT_READ_TOKEN','CF_USER_AUDIT_TOKEN'])
   assert.ok(code.includes(key)&&flow.includes(key),key);
 assert.match(code,/github\.event_name|GITHUB_EVENT_NAME/);
 assert.match(code,/JSON\.stringify\(baseline\)!==JSON\.stringify\(final\)/);
 assert.match(code,/inventoryAtomicSnapshot:false/);
 assert.match(flow,/environment: cove-production-release-audit/);
 assert.match(flow,/timeout-minutes: 55/);
});
