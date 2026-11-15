/* eslint-disable prettier/prettier -- Isolated stage deployment with explicit transient error boundary. */
/**
 * Repeated Cloudflare workers.dev creation occasionally returns code 10007
 * AFTER a successful Worker upload. Retry only that exact known
 * name-registration race, never a permission, routing or source error.
 * Unique Worker namespace is scoped by Actions run ID + attempt number.
 * The unconditional GitHub workflow cleanup always removes that namespace.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';

export function isTransientWorkerRegistrationError(text){
  return /This Worker does not exist on your account/.test(text) &&
    /\[code:\s*10007\]/.test(text);
}
const selfTest=()=>{
  assert.equal(isTransientWorkerRegistrationError(
    'This Worker does not exist on your account. [code: 10007]'),true);
  for(const other of ['Unauthorized [code: 10000]','Worker quota exceeded [code: 10007]',
    'This Worker does not exist on your account. [code: 10000]'])
    assert.equal(isTransientWorkerRegistrationError(other),false);
  console.log('PASS: only Workers registration 10007 is retriable');
};
function redacted(output,secret){
  let result=output;
  for(const value of [secret,process.env.CLOUDFLARE_API_TOKEN]){
    if(typeof value==='string'&&value.length>18)result=result.split(value).join('[REDACTED]');
  }
  return result.slice(-18000);
}
function execAttempt(args){
  return new Promise((resolve,reject)=>{
    const child=spawn('npm',args,{env:process.env,stdio:['ignore','pipe','pipe']});
    let output='';
    for(const stream of [child.stdout,child.stderr]){
      stream.setEncoding('utf8');
      stream.on('data',chunk=>{output=(output+chunk).slice(-30000);});
    }
    child.once('error',reject);
    child.once('close',code=>resolve({code,output}));
  });
}
async function main(){
  const run=process.env.GITHUB_RUN_ID;
  const attempt=process.env.GITHUB_RUN_ATTEMPT;
  assert.match(run||'',/^[0-9]{8,15}$/);
  assert.match(attempt||'',/^[1-9][0-9]{0,2}$/);
  const cfg=JSON.parse(readFileSync('wrangler.owner-do-capacity.generated.jsonc','utf8'));
  const expected='cove-owner-do-capacity-'+run+'-a'+attempt;
  assert.equal(cfg.name,expected);
  assert.equal(cfg.workers_dev,true);
  assert.deepEqual(cfg.routes,[]);
  assert.equal(cfg.d1_databases,undefined);
  assert.equal(cfg.services,undefined);
  assert.equal(cfg.preview_urls,false);
  const secret=JSON.parse(readFileSync('.output/stage-owner-do/secrets.json','utf8'))
    .COVE_OWNER_DO_GATE;
  assert.match(secret,/^[a-f0-9]{64}$/);
  const args=['exec','--yes','--package=wrangler@4.151.0','--','wrangler','deploy',
    '--config','wrangler.owner-do-capacity.generated.jsonc','--secrets-file',
    '.output/stage-owner-do/secrets.json'];
  for(let n=1;n<=3;n++){
    console.log(JSON.stringify({event:'cove_owner_index_stage_deploy_attempt',
      attempt:n,worker:expected,releaseCertified:false}));
    const result=await execAttempt(args);
    if(result.code===0){
      console.log(redacted(result.output,secret));
      console.log(JSON.stringify({event:'cove_owner_index_stage_deployed',
        attempt:n,worker:expected,releaseCertified:false}));
      return;
    }
    if(!isTransientWorkerRegistrationError(result.output)||n===3){
      console.error(redacted(result.output,secret));
      throw Error('stage_owner_index_deploy_failed_at_attempt_'+n);
    }
    console.warn(JSON.stringify({event:'cove_owner_index_stage_retry_10007',
      attempt:n,worker:expected,releaseCertified:false}));
    await sleep(n===1?2000:5000);
  }
}
if(process.argv.includes('--self-test'))selfTest();
else main().catch(e=>{
  console.error('BLOCKED: '+String(e.message||'isolated_stage_deploy_failed'));
  process.exitCode=1;
});
