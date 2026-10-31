/* eslint-disable prettier/prettier -- Prove complete shared helper removal and executable private source lineage. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import ts from "typescript";
import {assertPublishingOwnerSourceLineage} from "./check-publishing-owner-source-lineage.mjs";
const read=p=>readFileSync(p,"utf8"),sha=x=>createHash("sha256").update(x).digest("hex");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json")),lineage=JSON.parse(read("docs/architecture/retired-publication-helpers-owner-lineage.json"));
assert.equal(lineage.retiredCount,14);assert.equal(lineage.productionOwnerCertified,false);assert.equal(review.releaseApproval,false);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=70,"New owner-required site appeared after publication retirement");
assert.equal(new Set(lineage.retired.map(x=>x.siteId)).size,14);
for(const row of lineage.retired)assert.ok(!review.sites.some(x=>x.siteId===row.siteId));
for(const row of lineage.sources){assert.equal(sha(read(row.file)),row.currentSha256);assert.ok(!review.sites.some(x=>x.file===row.file));}
assertPublishingOwnerSourceLineage();
const pub=read(lineage.sources[0].file),repair=read(lineage.sources[1].file),owner=read("src/storefront-strangler/legal-authority.worker.ts");
for(const name of ["recordPublicationActivation","ensureCatalogParties","transitionPublishingLifecycle","recordInlineResult","refreshAssetValidationSummary"])
 assert.doesNotMatch(pub,new RegExp("(?:async )?function "+name+"\\("));
assert.match(pub,/Publishing lifecycle creation requires its private owner/);
assert.match(repair,/dispatchRegionalEpubRepair/);assert.doesNotMatch(repair,/\.prepare\(|\.batch\(|BUCKET\.(get|head)/);
assert.match(owner,/const \{recordPublicationActivation,ensurePublishingLifecycle,ensureCatalogParties\}=privatePublishingEditor/);
assert.doesNotMatch(owner,/import[^;]*\b(?:recordPublicationActivation|ensureCatalogParties|ensurePublishingLifecycle)\b[^;]*from "\.\.\/features\/fore\/publishing.server"/s);
const parsed=ts.createSourceFile("owner.ts",owner,ts.ScriptTarget.Latest,true),literals=new Set();assert.equal(parsed.parseDiagnostics.length,0);
function visit(n){if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n))literals.add(sha(n.getText(parsed)));ts.forEachChild(n,visit);}visit(parsed);
const changed=new Set(["recordPublicationActivation","ensurePublishingLifecycle","transitionPublishingLifecycle","ensureCatalogParties"]);
for(const row of lineage.retired.filter(x=>!changed.has(x.functionName)))assert.ok(literals.has(row.sqlSha256),"Exact private original missing: "+row.functionName+" "+row.table);
assert.match(owner,/Terminal publication state requires fresh independently verified reinstatement/);
assert.match(owner,/WHERE id=\? AND state=\? AND updated_at=\?/);
assert.match(owner,/WHERE EXISTS\(SELECT 1 FROM publishing_release_lifecycles WHERE id=\? AND state=\? AND updated_at=\?/);
assert.match(owner,/async function repairRegionalEpubAssetsPrivate\(/);
assert.match(owner,/if\(route==="\/catalog\/repair-regional-assets"\)/);
assert.ok(owner.indexOf('if (!qaOwnerLeaseLive(env))')<owner.indexOf('if(route==="/catalog/repair-regional-assets")'));
const bundle=await build({entryPoints:lineage.sources.map(x=>x.file),bundle:true,platform:"node",format:"esm",write:false,outdir:"test-only",metafile:true,logLevel:"silent"});
assert.ok(!Object.keys(bundle.metafile.inputs).some(x=>x.endsWith("legal-authority.worker.ts")));
console.log("PASS: 14 shared publishing/repair owner SQL sites retired; immutable predecessor lineage; private helper linkage; no owner code in public bundles; 70 owner-required remain");
