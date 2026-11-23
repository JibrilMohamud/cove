/* eslint-disable prettier/prettier -- Protected hosted QA comment trigger negative tests. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {authorizeHostedComment,expectedCommand,REQUEST_PR}
  from "./authorize-biosync-owner-comment.mjs";
const sha="a".repeat(40);
const env={
  GITHUB_REPOSITORY:"JibrilMohamud/cove",
  GITHUB_EVENT_NAME:"issue_comment",
  GITHUB_REF:"refs/heads/main",
  GITHUB_ACTOR:"JibrilMohamud",
  GITHUB_SHA:sha,
};
const event={
  action:"created",
  repository:{full_name:"JibrilMohamud/cove"},
  sender:{login:"JibrilMohamud"},
  comment:{user:{login:"JibrilMohamud"},author_association:"OWNER",
    body:expectedCommand(sha)},
  issue:{number:REQUEST_PR,pull_request:{url:"https://api.github.com/repos/JibrilMohamud/cove/pulls/859"}},
};
const bad=(x,y)=>assert.throws(()=>authorizeHostedComment(x,y));
test("Exact repository owner comment on the reviewed default branch authorizes only synthetic QA",()=>{
  assert.equal(authorizeHostedComment(env,event),true);
  assert.equal(expectedCommand(sha),
    "/cove-biosync-hosted-qa "+sha+" confirm-isolated-qa confirm-atomic-owner-write");
});
test("Forged user, bot actor, collaborator or foreign repo cannot authorize",()=>{
  bad({...env,GITHUB_ACTOR:"attacker"},event);
  bad({...env,GITHUB_REPOSITORY:"attacker/cove"},event);
  bad(env,{...event,sender:{login:"attacker"}});
  bad(env,{...event,comment:{...event.comment,user:{login:"attacker"}}});
  bad(env,{...event,comment:{...event.comment,author_association:"COLLABORATOR"}});
  bad(env,{...event,repository:{full_name:"attacker/cove"}});
});
test("Retargeted branch, stale SHA, missing confirmation and replay edits all fail closed",()=>{
  bad({...env,GITHUB_REF:"refs/pull/859/merge"},event);
  bad({...env,GITHUB_SHA:"b".repeat(40)},event);
  bad({...env,GITHUB_SHA:"not a sha"},event);
  bad(env,{...event,action:"edited"});
  bad(env,{...event,comment:{...event.comment,body:"/cove-biosync-hosted-qa "+sha}});
  bad(env,{...event,comment:{...event.comment,body:expectedCommand(sha)+"\nextra"}});
  bad(env,{...event,comment:{...event.comment,body:expectedCommand(sha)+" --production"}});
  bad({...env,GITHUB_EVENT_NAME:"pull_request"},event);
  bad({...env,GITHUB_EVENT_NAME:"workflow_dispatch"},event);
});
test("Only the exact owner-review PR with actual pull_request identity can trigger",()=>{
  bad(env,{...event,issue:{...event.issue,number:850}});
  bad(env,{...event,issue:{number:859}});
  bad(env,{...event,issue:{...event.issue,pull_request:null}});
});
test("GitHub job never executes PR code, runs only protected QA, and never reads broad production token",()=>{
  const flow=readFileSync(".github/workflows/cove-biosync-owner-comment-qa.yml","utf8");
  const script=readFileSync("scripts/staging/prove-biosync-hosted-owner-write.mjs","utf8");
  assert.match(flow,/issue_comment:\s*\n\s*types: \[created\]/);
  assert.match(flow,/github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(flow,/github\.event\.issue\.number == 859/);
  assert.match(flow,/github\.actor == 'JibrilMohamud'/);
  assert.match(flow,/github\.event\.issue\.pull_request != null/);
  assert.match(flow,/environment: cove-production-release-audit/);
  assert.match(flow,/ref: \$\{\{ github\.sha \}\}/);
  assert.match(flow,/CLOUDFLARE_ACCOUNT_ID: f51e8ccbc394e2d6016ff8c2c303d54b/);
  assert.match(flow,/COVE_CF_QA_WORKERS_DEPLOY_TOKEN/);
  assert.match(flow,/COVE_CF_QA_D1_MUTATION_TOKEN/);
  assert.match(flow,/COVE_CF_QA_R2_STORAGE_TOKEN/);
  assert.doesNotMatch(flow,/secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(flow,/4bd657ac-8789-403e-a28c-93aba8d0a989/);
  assert.doesNotMatch(flow,/d26430caa63ec55f6612e32f36aca5e9/);
  assert.match(script,/checkHostedCommentEnvironment\(process\.env\)/);
  assert.match(script,/\["workflow_dispatch","issue_comment"\]\.includes\(event\)/);
});
