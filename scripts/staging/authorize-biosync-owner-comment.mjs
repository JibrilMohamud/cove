/* eslint-disable prettier/prettier -- Exact owner-authenticated, QA-only, comment-trigger authorization. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export const REQUEST_PR=859;
export const REQUEST_ACTOR="JibrilMohamud";
export const COMMAND_PREFIX="/cove-biosync-hosted-qa ";
export function expectedCommand(sha){
  assert.match(sha||"",/^[a-f0-9]{40}$/);
  return COMMAND_PREFIX+sha+" confirm-isolated-qa confirm-atomic-owner-write";
}
/**
 * github.event is a GitHub-supplied signed webhook payload on the default
 * branch, never PR checkout code or an unverified public comment string.
 * This authorizes only separate Cloudflare QA account synthetic operations;
 * it is not consent to sell, grant rights or alter production.
 */
export function authorizeHostedComment(env,event){
  assert.equal(env?.GITHUB_REPOSITORY,"JibrilMohamud/cove");
  assert.equal(env?.GITHUB_EVENT_NAME,"issue_comment");
  assert.equal(env?.GITHUB_REF,"refs/heads/main");
  assert.equal(env?.GITHUB_ACTOR,REQUEST_ACTOR);
  assert.match(env?.GITHUB_SHA||"",/^[a-f0-9]{40}$/);
  assert.equal(event?.action,"created");
  assert.equal(event?.repository?.full_name,"JibrilMohamud/cove");
  assert.equal(event?.sender?.login,REQUEST_ACTOR);
  assert.equal(event?.comment?.user?.login,REQUEST_ACTOR);
  assert.equal(event?.comment?.author_association,"OWNER");
  assert.equal(event?.issue?.number,REQUEST_PR);
  assert.ok(event?.issue?.pull_request?.url,
    "The exact existing review PR, not an unreviewed issue, is required");
  assert.equal(event?.comment?.body,expectedCommand(env.GITHUB_SHA));
  return true;
}
export function checkHostedCommentEnvironment(env=process.env){
  const file=env.GITHUB_EVENT_PATH;
  assert.ok(typeof file==="string" && file.startsWith("/") && file.length<1024);
  const event=JSON.parse(readFileSync(file,"utf8"));
  authorizeHostedComment(env,event);
  return true;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    checkHostedCommentEnvironment();
    console.log("PASS: GitHub repository OWNER explicitly authorized exact main SHA for synthetic isolated BioSync QA only.");
  }catch{
    console.error("DENIED: no authenticated owner comment authorizes this QA rehearsal.");
    process.exitCode=1;
  }
}
