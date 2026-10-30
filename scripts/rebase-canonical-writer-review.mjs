/* eslint-disable prettier/prettier -- A deliberate source-bound review rebase, never a production release approval. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {currentWriterSites,REVIEW_PATH} from './reconcile-canonical-writers.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export const identity=site=>JSON.stringify([
  site.file,site.functionName,site.table,site.operation,site.sqlSha256
]);
const counts=rows=>rows.reduce((map,row)=>(map.set(row.disposition,(map.get(row.disposition)||0)+1),map),new Map());
const sorted=rows=>[...rows].sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line);

/** Source SHA changes affect every site ID in the file. Preserve the complete
 * reviewed disposition, command family and reason for each unchanged literal.
 * A deleted literal must be explicitly acknowledged with external evidence;
 * a new or changed SQL literal can NEVER be approved by this tool.
 * No caller/guard change can be approved by running this script alone.
 */
export function rebaseReview(review,current,{approvedSourceFiles=[],retirementEvidence=null}={}) {
  assert.equal(review.schema,'cove.canonical-writer-review.v1');
  assert.equal(review.releaseApproval,false);
  const approved=new Set(approvedSourceFiles);
  assert.equal(approved.size,approvedSourceFiles.length,'Duplicate reviewed source attestation');
  const old=new Map(),fresh=new Map();
  for(const row of sorted(review.sites)) {
    assert.equal(row.productionOwnerGuarded,false);
    const key=identity(row),array=old.get(key)||[];array.push(row);old.set(key,array);
  }
  for(const row of sorted(current)) {
    assert.equal(row.literal,true,'A new nonliteral writer is not eligible for automated rebase');
    const key=identity(row),array=fresh.get(key)||[];array.push(row);fresh.set(key,array);
  }
  const candidates=[],removed=[],touched=new Set();
  for(const [key,freshSites] of fresh) {
    const originals=old.get(key)||[];
    if(freshSites.length>originals.length)
      throw Error('New or changed canonical SQL needs separate source review: '+key);
    if(new Set(originals.map(x=>JSON.stringify([x.disposition,x.commandFamily||null,x.reason]))).size!==1)
      throw Error('Ambiguous duplicate SQL disposition requires manual review: '+key);
    const original=originals[0];
    if(!original)throw Error('Unrecognized canonical SQL: '+key);
    for(let i=0;i<freshSites.length;i++) {
      const site=freshSites[i];
      if(originals[i].siteId!==site.siteId){
        if(!approved.has(site.file))throw Error('Changed source requires independent file attestation: '+site.file);
        touched.add(site.file);
      }
      candidates.push({...originals[i],siteId:site.siteId,line:site.line});
    }
    if(originals.length>freshSites.length)removed.push(...originals.slice(freshSites.length));
  }
  for(const [key,originals] of old)if(!fresh.has(key))removed.push(...originals);
  if(removed.length) {
    if(typeof retirementEvidence!=='string'||!retirementEvidence.startsWith('docs/'))
      throw Error('Removal requires a reviewed docs/ retirement-evidence path');
    // A deletion is not owner certification: the reporter always remains blocked.
    for(const row of removed) {
      if(!approved.has(row.file))throw Error('Retired source needs independent file attestation: '+row.file);
      touched.add(row.file);
    }
  }
  const oldTotals=counts(review.sites),newTotals=counts(candidates);
  for(const [disposition,n] of newTotals)
    assert.ok(n<=(oldTotals.get(disposition)||0),'Disposition count increased unexpectedly');
  assert.equal(new Set(candidates.map(r=>r.siteId)).size,candidates.length,'Duplicate site IDs');
  assert.equal(candidates.length,current.length,'Every executable SQL site must retain a review');
  assert.equal(new Set(candidates.filter(r=>r.disposition==='owner-command-required').map(r=>r.commandFamily)).has(undefined),false);
  return {review:{...review,releaseApproval:false,sites:sorted(candidates)},removed:sorted(removed),touched:[...touched].sort(),
    before:Object.fromEntries(oldTotals),after:Object.fromEntries(newTotals),retirementEvidence};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const argv=process.argv.slice(2);
  const take=prefix=>argv.find(a=>a.startsWith(prefix))?.slice(prefix.length);
  const manifestPath=take('--review-attestation=');
  assert.ok(manifestPath&&manifestPath.startsWith('docs/'),'Pass --review-attestation=docs/... for independent source review');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.equal(manifest.schema,'cove.canonical-writer-source-attestation.v1');
  assert.equal(manifest.releaseApproval,false);
  assert.ok(typeof manifest.rationale==='string'&&manifest.rationale.length>=80,'Independent reviewer rationale required');
  assert.ok(Array.isArray(manifest.files)&&manifest.files.length>0);
  for(const file of manifest.files){
    assert.match(file.path,/^(?:src|scripts|worker|workers)\//);
    assert.match(file.sha256,/^[a-f0-9]{64}$/);
    assert.equal(hash(readFileSync(file.path,'utf8')),file.sha256,'Attested source SHA differs: '+file.path);
    assert.ok(typeof file.review==='string'&&file.review.length>=40,'File caller/guard review required');
  }
  const output=rebaseReview(JSON.parse(readFileSync(REVIEW_PATH,'utf8')),currentWriterSites(),{
    approvedSourceFiles:manifest.files.map(f=>f.path),retirementEvidence:manifest.retirementEvidence||null
  });
  const affected=new Set(output.touched);
  assert.deepEqual([...affected].sort(),manifest.files.map(f=>f.path).filter(x=>affected.has(x)).sort(),
    'Every changed source must have attested entry');
  if(output.removed.length) {
    assert.ok(manifest.retirementEvidence&&manifest.retirementEvidence.startsWith('docs/'));
    const doc=readFileSync(manifest.retirementEvidence,'utf8');
    assert.ok(doc.length>=300,'Retirement evidence must describe the removed production paths and rollback');
  }
  if(argv.includes('--write'))writeFileSync(REVIEW_PATH,JSON.stringify(output.review,null,2)+'\n');
  console.log(JSON.stringify({schema:'cove.writer-review-rebase.v1',written:argv.includes('--write'),
    before:output.before,after:output.after,removed:output.removed.map(x=>({file:x.file,functionName:x.functionName,table:x.table,commandFamily:x.commandFamily})),
    touched:output.touched,productionReleaseEligible:false},null,2));
}
