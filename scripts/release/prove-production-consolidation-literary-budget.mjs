/* eslint-disable prettier/prettier -- native SQL and exact isolated schema */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {transform} from "esbuild";
const {code}=await transform(readFileSync("src/storefront-strangler/literary-owner-budget-rollover.ts","utf8"),{loader:"ts",format:"esm"});
const {rollOwnedLiteraryBudget,recordOwnedBudgetTick,LITERARY_BUDGET_CRON}=await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const day="2026-11-25",prev="2026-11-24",now=()=>Date.parse(day+"T12:00:00Z");
function wrap(sqlite,{readOnly=false}={}){
  const handles=new WeakMap();
  const stmt=(sql,args=[])=>{
    if(readOnly&&!/^SELECT\b/.test(sql))throw Error("primary_write");
    const prepared=sqlite.prepare(sql);
    const obj={bind:(...values)=>stmt(sql,values),first:async()=>prepared.get(...args)||null};
    handles.set(obj,()=>prepared.all(...args));return obj;
  };
  return {prepare:stmt,async batch(items){
    if(readOnly)throw Error("primary_batch");
    sqlite.exec("BEGIN");
    try{const result=items.map(x=>({results:handles.get(x)()}));sqlite.exec("COMMIT");return result;}
    catch(error){sqlite.exec("ROLLBACK");throw error;}
  }};
}
const p=new DatabaseSync(":memory:"),l=new DatabaseSync(":memory:");
try{
  p.exec("CREATE TABLE cove_runtime_config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE literary_profile_jobs(status TEXT,lease_until TEXT); CREATE TABLE literary_profile_state(id INTEGER PRIMARY KEY,lease_until TEXT); CREATE TABLE literary_profile_budget(day TEXT PRIMARY KEY,reserved_units INTEGER,calls INTEGER);");
  p.exec("INSERT INTO cove_runtime_config VALUES('literary_processing_owner','isolated'),('literary_budget_domain','isolated');");
  p.prepare("INSERT INTO literary_profile_budget VALUES(?,?,?)").run(day,170,2);
  l.exec(readFileSync("infra/content-budget/0001_ledger.sql","utf8"));
  const primary=wrap(p,{readOnly:true}),isolated=wrap(l);
  assert.equal((await rollOwnedLiteraryBudget(primary,isolated,now)).state,"previous_day_not_active");
  assert.equal(l.prepare("SELECT COUNT(*) n FROM literary_profile_budget").get().n,0);
  l.prepare("INSERT INTO literary_budget_cutover(day,status,original_reserved_units,original_calls,prepared_at,operator_receipt) VALUES(?,'active',0,0,'fixture','fixture')").run(prev);
  p.exec("INSERT INTO literary_profile_jobs VALUES('running','9999-01-01T00:00:00Z')");
  await assert.rejects(rollOwnedLiteraryBudget(primary,isolated,now),/not_frozen/);
  p.exec("DELETE FROM literary_profile_jobs");
  await assert.rejects(rollOwnedLiteraryBudget(primary,isolated,(()=>{let n=0;return ()=>now()+(n++?86400000:0);})()),/snapshot_drift/);
  l.prepare("INSERT INTO literary_profile_budget VALUES(?,?,?)").run(day,180,3);
  l.prepare("INSERT INTO literary_budget_cutover(day,status,original_reserved_units,original_calls,prepared_at,operator_receipt) VALUES(?,'prepared',100,1,'fixture','fixture')").run(day);
  const receipt=await rollOwnedLiteraryBudget(primary,isolated,now);
  assert.equal(receipt.state,"active");assert.equal(receipt.primaryMutation,false);
  assert.deepEqual({...l.prepare("SELECT reserved_units,calls FROM literary_profile_budget WHERE day=?").get(day)},{reserved_units:180,calls:3});
  assert.deepEqual({...l.prepare("SELECT status,original_reserved_units,original_calls FROM literary_budget_cutover WHERE day=?").get(day)},{status:"active",original_reserved_units:170,original_calls:2});
  assert.equal((await rollOwnedLiteraryBudget(primary,isolated,now)).state,"already_active");
  assert.equal(p.prepare("SELECT reserved_units FROM literary_profile_budget").get().reserved_units,170);
  const release="a".repeat(40),slot=now();
  await recordOwnedBudgetTick(isolated,receipt,slot,release,LITERARY_BUDGET_CRON);
  assert.deepEqual({...l.prepare("SELECT release_sha,scheduled_ms,day,state FROM literary_owner_budget_tick_receipt").get()},{release_sha:release,scheduled_ms:slot,day,state:"active"});
  await recordOwnedBudgetTick(isolated,receipt,slot-60000,release,LITERARY_BUDGET_CRON);
  assert.equal(l.prepare("SELECT scheduled_ms FROM literary_owner_budget_tick_receipt").get().scheduled_ms,slot);
  await assert.rejects(recordOwnedBudgetTick(isolated,{...receipt,state:"previous_day_not_active"},slot,release,LITERARY_BUDGET_CRON),/not_proven/);
  l.prepare("UPDATE literary_budget_cutover SET status='closed' WHERE day=?").run(day);
  await assert.rejects(rollOwnedLiteraryBudget(primary,isolated,now),/closed_day/);
  l.exec("CREATE TABLE rights_grants(id TEXT)");
  await assert.rejects(rollOwnedLiteraryBudget(primary,isolated,now),/binding_invalid/);
  await assert.rejects(rollOwnedLiteraryBudget(primary,primary,now),/binding_invalid/);
  console.log("PASS native owner budget: no bootstrap, primary lease/frozen snapshot, atomic prepared recovery, monotonic totals, idempotence, closed day and contaminated binding denial");
}finally{p.close();l.close();}
