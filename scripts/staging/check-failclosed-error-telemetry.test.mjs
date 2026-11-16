/* eslint-disable prettier/prettier -- Error-path failure-injection guard. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transform} from 'esbuild';

const source=readFileSync('src/features/fore/failclosed-error-telemetry.ts','utf8');
const {code}=await transform(source,{loader:'ts',format:'esm',target:'es2022'});
const {settleErrorTelemetry}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

test('without Worker lifetime, both telemetry jobs settle and neither can throw into API',async()=>{
  let attempted=0;
  const answer=settleErrorTelemetry([
    ()=>{attempted++;throw Error('D1 unavailable');},
    async()=>{attempted++;throw Error('external reporting unavailable');}
  ]);
  assert.ok(answer instanceof Promise);
  await assert.doesNotReject(answer);
  assert.equal(attempted,2);
});

test('with Worker lifetime a slow D1 error writer cannot hold up the fail-closed response',async()=>{
  let release;
  let queued;
  let notified=false;
  const pending=new Promise(resolve=>{release=resolve;});
  const immediate=settleErrorTelemetry([
    ()=>pending,
    ()=>{notified=true;}
  ],{waitUntil(p){queued=p;}});
  assert.equal(immediate,undefined,'no blocking await on Worker response path');
  assert.ok(queued instanceof Promise);
  await Promise.resolve();
  assert.equal(notified,true,'external reporter proceeds during D1 backlog');
  release();
  await queued;
});

test('a throwing waitUntil implementation fails over to bounded completion, never throws',async()=>{
  const work=settleErrorTelemetry([
    ()=>Promise.reject(Error('primary D1 7429')),
    ()=>{throw Error('reporter failed');}
  ],{waitUntil(){throw Error('execution context unavailable');}});
  await assert.doesNotReject(work);
});

test('successful telemetry is invoked once each and is not retried on the error response path',async()=>{
  const calls=[];
  await settleErrorTelemetry([
    ()=>{calls.push('primary-d1');return {success:true};},
    async()=>{calls.push('external');}
  ]);
  assert.deepEqual(calls,['primary-d1','external']);
});

test('production API only defers non-authoritative error telemetry; signed webhook and denial paths unchanged',()=>{
  const api=readFileSync('src/features/fore/api.server.ts','utf8');
  assert.match(api,/import \{ settleErrorTelemetry \} from "\.\/failclosed-error-telemetry"/);
  const start=api.lastIndexOf('  } catch (e) {');
  const error=api.slice(start);
  assert.match(error,/if \(!\(e instanceof ApiError\) && !\(e instanceof z\.ZodError\)\)/);
  assert.match(error,/await settleErrorTelemetry\(/);
  assert.match(error,/recordErrorEvent\(env\.DB as any, undefined, request, e/);
  assert.match(error,/reportExternalError\(env, request, e\)/);
  assert.match(error,/      execution,\s*\);/);
  assert.match(error,/if \(e instanceof ApiError\) return json\(\{ error: e\.message \}, e\.status\)/);
  assert.match(error,/request\.method === "GET"[\s\S]*?"This content could not be loaded\. Please try again\."/);
  assert.match(api,/return json\(await stripeWebhook\(env, request\)\)/,'signed Stripe flow untouched');
  assert.doesNotMatch(error,/await recordErrorEvent\(/,'never wait on error D1 writer inline');
});
