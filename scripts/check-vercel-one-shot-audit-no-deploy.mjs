/* eslint-disable prettier/prettier -- Adversarial one-shot Vercel guard fixture. */
/* Single-use audit deployment guard: only a pinned, four-file main merge may skip Vercel production. */
import assert from "node:assert/strict";
import { shouldSkipPinnedProductionAudit, shouldBuildService } from "./vercel-ignore-build.mjs";

const previous="c959eaed64c58f7d9675c0c8b6852c70f4914dec";
const head="a".repeat(40);
const paths=[
  ".github/workflows/cove-protected-real-rights-spot-readonly.yml",
  "scripts/release/check-protected-production-rights-spot.mjs",
  "scripts/vercel-ignore-build.mjs",
  "scripts/check-vercel-one-shot-audit-no-deploy.mjs",
];
const env={VERCEL_ENV:"production",VERCEL_GIT_COMMIT_REF:"main"};
function fakeGit({parent=previous,parents=[parent],files=paths,
  current=head,throwError=false,root="/repo"}={}){
  return (cmd,args)=>{
    if(throwError)throw Error("git unavailable");
    assert.equal(cmd,"git");
    if(args.join(" ")==="rev-parse --show-toplevel")return root+"\n";
    assert.equal(args[0],"-C");
    assert.equal(args[1],root);
    const action=args.slice(2);
    if(action.join(" ")==="show -s --format=%P HEAD")return parents.join(" ")+"\n";
    if(action.join(" ")==="rev-parse HEAD")return current+"\n";
    if(action[0]==="diff"){
      assert.deepEqual(action,["diff","--no-ext-diff","--name-only",previous,current,"--"]);
      return files.join("\n")+"\n";
    }
    throw Error("Unexpected git command");
  };
}
assert.equal(shouldSkipPinnedProductionAudit(env,fakeGit()),true);
assert.equal(shouldBuildService("app","production",paths),true,
  "General production skipping must remain disabled");
assert.equal(shouldBuildService("audio","production",paths),true,
  "No wide production ignore regression");
for(const [label,mutated] of [
  ["wrong environment",{...env,VERCEL_ENV:"preview"}],
  ["wrong branch",{...env,VERCEL_GIT_COMMIT_REF:"feature"}],
  ["missing Git branch",{VERCEL_ENV:"production"}],
])assert.equal(shouldSkipPinnedProductionAudit(mutated,fakeGit()),false,label);
for(const [label,mutation] of [
  ["different parent",{parent:"b".repeat(40)}],
  ["merge with two parents",{parents:[previous,"b".repeat(40)]}],
  ["no parent",{parents:[]}],
  ["missing file",{files:paths.slice(0,-1)}],
  ["unrecognized file",{files:[...paths.slice(0,-1),"src/server.ts"]}],
  ["duplicate path",{files:[...paths.slice(0,-1),paths[0]]}],
  ["extra source file",{files:[...paths,"package.json"]}],
  ["empty git output",{files:[]}],
  ["no HEAD",{current:"not-a-sha"}],
  ["reused previous SHA",{current:previous}],
  ["unavailable git",{throwError:true}],
  ["missing root",{root:""}],
])assert.equal(shouldSkipPinnedProductionAudit(env,fakeGit(mutation)),false,label);
console.log("PASS: One-shot production no-deploy only for exact approved parent+four audit files; every unexpected branch, parent, file, git error or merge type forces build.");
