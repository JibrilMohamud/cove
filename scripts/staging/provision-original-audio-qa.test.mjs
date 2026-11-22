/* eslint-disable prettier/prettier -- Keep isolated QA media pointer fixtures source-exact. */
import assert from "node:assert/strict";
import test from "node:test";
import {provisionPublishedQaAudio} from "./provision-original-audio-qa.mjs";

const runId="45083189744-3";
const scope="qa/"+runId+"/";
const base={
  runId,productId:"prd_paid_qa_20261027",buyerId:"user_initial_qa_"+runId,
  objectKey:scope+"chapter.wav",sha:"a".repeat(64),sizeBytes:8044,
  evidenceSha:"b".repeat(64),evidenceSize:64
};

test("publisher manifest, rights evidence and audio R2 pointers use only exact protected-run keys",async()=>{
  const writes=[];
  const qaSql=async(sql,params=[])=>{
    if(sql.startsWith("SELECT p.edition_id,e.work_id"))
      return {results:[{edition_id:"ed_paid_qa_20261027",work_id:"work_qa"}]};
    if(sql.startsWith("SELECT id FROM commercial_audio_policy_versions"))
      return {results:[{id:"qa_policy"}]};
    writes.push({sql,params});
    return {results:[],meta:{changes:1}};
  };
  await provisionPublishedQaAudio(qaSql,base);
  const evidence=writes.find(x=>x.sql.includes("INSERT INTO publishing_rights_evidence"));
  assert.ok(evidence);
  assert.equal(evidence.params[4],scope+"rights.txt");
  const snapshot=writes.find(x=>x.sql.includes("INSERT INTO publishing_submission_snapshots"));
  assert.ok(snapshot);
  assert.equal(JSON.parse(snapshot.params[3]).sourceSnapshot.commercialAudio.chapters[0].object_key,
    scope+"chapter.wav");
  assert.ok(writes.some(x=>x.sql.includes("INSERT INTO publishing_publications")));
});

test("legacy shared, forged run and customer media prefixes are refused before SQL",async()=>{
  let called=0;
  const qaSql=async()=>{called++;throw Error("must never query owner on bad media path")};
  for(const objectKey of [
    "qa/chapter.wav",
    "qa/45083189744-2/chapter.wav",
    "customers/chapter.wav",
    "../qa/"+runId+"/chapter.wav"
  ]){
    await assert.rejects(provisionPublishedQaAudio(qaSql,{...base,objectKey}));
  }
  assert.equal(called,0);
});
