/* eslint-disable prettier/prettier -- Keep the predecessor editor evidence immutable while requiring the exact new source. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
export function assertPublishingOwnerSourceLineage(){
 const editor=JSON.parse(readFileSync("docs/architecture/retired-publishing-editor-owner-lineage.json","utf8"));
 const helpers=JSON.parse(readFileSync("docs/architecture/retired-publication-helpers-owner-lineage.json","utf8"));
 assert.equal(helpers.previousPublishingSourceSha256,editor.currentSourceSha256);
 const source=helpers.sources.find(x=>x.file==="src/features/fore/publishing.server.ts");
 assert.equal(source.originalSha256,editor.currentSourceSha256);
 const current=createHash("sha256").update(readFileSync(source.file,"utf8")).digest("hex");
 assert.equal(current,source.currentSha256,"Publishing helpers need a new exact caller/source attestation");
 assert.equal(helpers.publishingRetiredCount,10);assert.equal(helpers.productionOwnerCertified,false);
 return current;
}
