/* eslint-disable prettier/prettier -- Provider-resolved, bounded production maintenance credential. */
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
export const account="d26430caa63ec55f6612e32f36aca5e9";
const owner="6e9c789f211145b0a01cae2dce20745d";
const ingress="9fd58acf99854aa2908b2159e885191e";
const handoff="c1299777099247d3b86e2e469b8e37e9";
export const profiles=Object.freeze({
  owner:[owner],
  "biosync-activate":[owner,ingress],
  gateway:["9695f5250e7c490b9d80b586f547afc7"],
  "literary-drain":[handoff,"82356ab1166f42d9a26a66f2f791ed32"],
  "literary-replay":[handoff],
  "literary-dormant":["41482394f424482ba74c90fe77ca65f6","5c6395a21c4c4633b891dd6a24bfb5c8","40a6b1dcb556451eb2573c2c5f4c4e"],
  "literary-publisher":["fa87170e33c0416b8f022a933dd6fcd5"]
});
export const editor="7e79ec33834341f28dd431ab73884400";
export const accountKey="com.cloudflare.api.account."+account;
const workerKey=id=>"com.cloudflare.edge.worker.script."+id;
const idPattern=/^[a-f0-9]{32}$/;
const MAX_LIFETIME_MS=2*60*60*1000;
const MIN_REMAINING_MS=40*60*1000;
export function checkMaintenancePolicy(verified,details,profile,now=Date.now()){
  assert.ok(Object.hasOwn(profiles,profile),"Unknown maintenance profile");
  assert.match(verified?.id||"",idPattern);
  assert.equal(verified.status,"active");
  assert.equal(details?.id,verified.id);
  assert.equal(details.status,"active");
  const expiry=Date.parse(details.expires_on||"");
  assert.ok(Number.isFinite(expiry)&&Date.parse(verified.expires_on||"")===expiry&&
    expiry-now>=MIN_REMAINING_MS&&expiry-now<=MAX_LIFETIME_MS,"Require expiring maintenance authorization, 40–120 minutes remaining");
  // A provider token can carry multiple policies; no companion grant, deny
  // exception, account-wide selector or additional Worker is accepted.
  assert.equal(details.policies?.length,1);
  const p=details.policies[0];
  assert.equal(p.effect,"allow");
  assert.equal(p.permission_groups?.length,1);
  assert.equal(p.permission_groups[0].id,editor);
  assert.equal(p.permission_groups[0].name,"Individual Workers Editor");
  assert.deepEqual(Object.keys(p.resources||{}),[accountKey]);
  const resource=p.resources[accountKey];
  assert.ok(resource&&typeof resource==="object"&&!Array.isArray(resource));
  const expected=profiles[profile].map(workerKey).sort();
  assert.deepEqual(Object.keys(resource).sort(),expected,"Exact existing Worker UUID set required");
  assert.ok(Object.values(resource).every(x=>x==="*"));
  return {profile,workerCount:expected.length,expiresOn:new Date(expiry).toISOString(),temporary:true};
}
export async function verifyMaintenance(profile,env=process.env,send=fetch,now=Date.now()){
  assert.equal(env.GITHUB_REPOSITORY,"JibrilMohamud/cove");
  assert.equal(env.GITHUB_REF,"refs/heads/main");
  assert.equal(env.GITHUB_EVENT_NAME,"workflow_dispatch");
  assert.ok(Object.hasOwn(profiles,profile));
  const write=env.COVE_CF_PROD_MAINTENANCE_TOKEN||"";
  const read=env.COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN||"";
  assert.ok(write.length>=20&&read.length>=20&&write!==read,"Distinct protected maintenance and inventory principals required");
  async function get(path,token){
    const response=await send("https://api.cloudflare.com/client/v4/accounts/"+account+path,{
      method:"GET",headers:{authorization:"Bearer "+token},redirect:"error",signal:AbortSignal.timeout(20000)
    });
    if(!response.ok)throw Error("Maintenance authorization metadata rejected: HTTP "+response.status);
    const body=await response.json();
    if(body.success!==true||!body.result)throw Error("Maintenance authorization metadata incomplete");
    return body.result;
  }
  const verified=await get("/tokens/verify",write);
  assert.match(verified?.id||"",idPattern);
  const details=await get("/tokens/"+verified.id,read);
  return checkMaintenancePolicy(verified,details,profile,now);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  // Never print provider policy objects or bearer values, including on error.
  try{console.log(JSON.stringify(await verifyMaintenance(process.argv[2])));}
  catch{console.error("NO-GO: temporary exact-Worker maintenance authorization not verified");process.exitCode=1;}
}
