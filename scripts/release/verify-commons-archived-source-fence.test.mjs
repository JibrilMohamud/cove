/* eslint-disable prettier/prettier -- Exact provider-fence fixtures. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {assertArchivedSourceAccountFence,verifyFence} from "./verify-commons-archived-source-fence.mjs";
const account="d26430caa63ec55f6612e32f36aca5e9";
const broad="1c79fb61dbad11f320c96f6a03413e84";
const group=(id,name)=>({id,name});
const d1read=group("192192df92ee43ac90f2aeeffce67e35","D1 Read");
const r2write=group("2efd5506f9c8494dacb1fa10a3e7d5b6","Workers R2 Storage Bucket Item Write");
const deploy=group("e086da7e2179491d91ee5f35b3ca210a","Workers Scripts Write");
const ar="com.cloudflare.api.account."+account;
const bucket=name=>"com.cloudflare.edge.r2.bucket."+account+"_default_"+name;
const token=(g,resources={[ar]:"*"})=>({id:"a".repeat(32),name:"fixture",status:"active",
  policies:[{effect:"allow",resources,permission_groups:[g]}]});
const page=(...rows)=>({success:true,result:rows,result_info:{page:1,count:rows.length,total_count:rows.length,total_pages:1}});
test("only explicit reviewed direct REST exclusions and unrelated R2 scopes pass",()=>{
  assert.equal(assertArchivedSourceAccountFence(page(token(d1read))),true);
  assert.equal(assertArchivedSourceAccountFence(page(token(deploy))),true);
  assert.equal(assertArchivedSourceAccountFence(page(token(r2write,{[bucket("cove-production-media")]:"*"}))),true);
  for(const t of [token(r2write,{[bucket("cove-music-supply-qa-20261023")]:"*"}),token(r2write),
    token(group("b".repeat(32),"D1 Write")),token(group("b".repeat(32),"D1 Read")),
    {...token(d1read),id:broad},{...token(d1read),name:"Cove GitHub Deployments"},
    {...token(d1read),status:"disabled"},{...token(d1read),policies:[]}])
    assert.throws(()=>assertArchivedSourceAccountFence(page(t)));
  assert.throws(()=>assertArchivedSourceAccountFence({...page(token(d1read)),result_info:{page:1,count:1,total_count:2}}));
  assert.throws(()=>assertArchivedSourceAccountFence(page(token(d1read),token(d1read))));
});
test("account-only proof cannot substitute for all-user principal coverage",async()=>{
  const a="a".repeat(30),u="b".repeat(30);
  await assert.rejects(verifyFence(async path=>path.endsWith("/tokens")?page(token(d1read)):{},a,u),
    /principal_coverage_unverified/);
  await assert.rejects(verifyFence(async()=>page({...token(d1read),id:broad}),a,u),/broad_token_not_revoked/);
  await assert.rejects(verifyFence(async()=>{throw Error("should not call");},a,a),/distinct_audit_tokens/);
});
