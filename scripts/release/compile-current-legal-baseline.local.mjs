/* eslint-disable prettier/prettier -- Local-only private evidence compilation */
import {readFileSync,writeFileSync,lstatSync} from "node:fs";
import {compileCurrentLegalBaseline} from "./current-legal-baseline.mjs";

function load(path,max){
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.size<2||stat.size>max)throw Error("invalid_input_file");
  return JSON.parse(readFileSync(path,"utf8"));
}
try{
  if(process.env.CI||process.env.GITHUB_ACTIONS||!process.stdout.isTTY||!process.stdin.isTTY||
    process.argv.length!==7)throw Error("local_interactive_only");
  const [inventoryPath,reviewPath,trustPath,epochPath,outPath]=process.argv.slice(2);
  const inventory=load(inventoryPath,512*1024*1024);
  const review=load(reviewPath,512*1024*1024);
  const trust=load(trustPath,16384);
  const epoch=load(epochPath,1024);
  const result=compileCurrentLegalBaseline({inventory,review,trust,ownerEpoch:epoch.ownerEpoch,nowMs:Date.now()});
  // Exclusive create, mode 0600 where supported. No scope identifiers in stdout.
  writeFileSync(outPath,JSON.stringify(result)+"\n",{flag:"wx",mode:0o600});
  console.log(JSON.stringify({counts:result.counts,manifestSha256:result.manifestSha256,
    authorizing:false,permitsPublication:false,releaseCertified:false}));
}catch{
  console.error("BLOCKED: private current baseline compilation failed; no publication authorized");
  process.exitCode=1;
}
