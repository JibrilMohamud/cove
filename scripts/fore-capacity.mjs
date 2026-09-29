#!/usr/bin/env node
/**
 * Bounded Cove HTTP capacity probe. Intended for staging or explicitly isolated
 * production-shadow targets only. It never runs checkout mutations.
 *
 * Example:
 *   node scripts/fore-capacity.mjs https://staging.example.com 25 60 /api/fore/health/live
 */
const [baseArg, rpsArg="10", secondsArg="30", pathArg="/api/fore/health/live"] = process.argv.slice(2);
if (!baseArg) throw new Error("Usage: fore-capacity.mjs <base-url> [rps] [seconds] [path]");
const base=new URL(baseArg);if(!["https:","http:"].includes(base.protocol))throw new Error("HTTP(S) target required.");
const targetRps=Math.max(1,Math.min(1000,Number(rpsArg)||10)),durationSeconds=Math.max(1,Math.min(900,Number(secondsArg)||30));
const target=new URL(pathArg,base).toString(),durations=[],statuses=new Map();let started=0,finished=0,failed=0;const start=Date.now(),deadline=start+durationSeconds*1000,inFlight=new Set();
async function one(){const t=performance.now();started++;try{const r=await fetch(target,{method:"GET",headers:{"cache-control":"no-cache","user-agent":"Cove-Capacity-Probe/1.0"},signal:AbortSignal.timeout(10000)});statuses.set(r.status,(statuses.get(r.status)||0)+1);await r.arrayBuffer();if(!r.ok)failed++;}catch{failed++;statuses.set("network_error",(statuses.get("network_error")||0)+1);}finally{durations.push(performance.now()-t);finished++;}}
for(let tick=0;Date.now()<deadline;tick++){
  const tickStart=start+tick*1000;const requests=[];for(let i=0;i<targetRps;i++){const delay=Math.max(0,tickStart+Math.floor(i*1000/targetRps)-Date.now());requests.push(new Promise(resolve=>setTimeout(resolve,delay)).then(()=>one()));}
  const batch=Promise.all(requests);inFlight.add(batch);batch.finally(()=>inFlight.delete(batch));
  const sleep=Math.max(0,tickStart+1000-Date.now());if(sleep)await new Promise(r=>setTimeout(r,sleep));
}
await Promise.all([...inFlight]);durations.sort((a,b)=>a-b);const pct=p=>durations.length?durations[Math.min(durations.length-1,Math.floor((durations.length-1)*p))]:0,elapsed=(Date.now()-start)/1000;
console.log(JSON.stringify({target,configuredRps:targetRps,durationSeconds,started,finished,failed,errorRateBps:finished?Math.round(failed*10000/finished):0,achievedRps:Number((finished/elapsed).toFixed(2)),p50Ms:Math.round(pct(.50)),p95Ms:Math.round(pct(.95)),p99Ms:Math.round(pct(.99)),statuses:Object.fromEntries(statuses),startedAt:new Date(start).toISOString(),finishedAt:new Date().toISOString()},null,2));
if(failed)process.exitCode=2;
