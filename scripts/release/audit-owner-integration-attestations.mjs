/* eslint-disable prettier/prettier -- Read-only source evidence; never recertifies an attestation. */
import {createHash} from "node:crypto";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
let checked=0,stale=0;
function visit(dir){
 for(const ent of readdirSync(dir,{withFileTypes:true})){
  const name=join(dir,ent.name);
  if(ent.isDirectory())visit(name);
  else if(ent.isFile()&&name.endsWith(".json")){
   const str=readFileSync(name,"utf8");
   if(!str.includes("cove.canonical-writer-source-attestation.v1"))continue;
   let data;try{data=JSON.parse(str)}catch{continue}
   if(data.schema!=="cove.canonical-writer-source-attestation.v1")continue;
   for(const file of data.files||[]){
     checked++;
     if(typeof file.path!=="string"||typeof file.sha256!=="string")throw Error("invalid_attestation");
     const actual=createHash("sha256").update(readFileSync(file.path,"utf8")).digest("hex");
     if(file.sha256!==actual){stale++;console.log(JSON.stringify({attestation:name,source:file.path,recorded:file.sha256,actual}));}
   }
  }
 }
}
visit("docs/architecture");
console.log("QA attestation drift: "+stale+" mismatches among "+checked+" source claims.");
// This is a diagnostic, not a mechanism for approving new source.
