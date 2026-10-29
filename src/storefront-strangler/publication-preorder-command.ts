/* eslint-disable prettier/prettier -- A preorder is a positive legal publication, never an unfenced scheduler write. */
import type {CatalogDB} from "../features/fore/catalog-model.server";
import {openPublicationPreorderOwned} from "../features/fore/publishing.server";
import type {AuthoritySql} from "./legal-authority-core";
import {commercialProductId} from "./commercial-legal-core";
import {marketIsWithdrawn} from "./market-authority-core";
import {beginPublicationCommand,commitPublicationCommand,markPublicationPublished,readPublicationCommand,recordPublicationRecovery} from "./publication-command-core";

type Context={
  primary:CatalogDB;sql:AuthoritySql;executing:Set<string>;
  transactionSync<T>(fn:()=>T):T;
  publish(path:string,input:{productId:string;territory:string;currency:string;channel:"retail"}):Promise<Response>;
};
const noStore={"cache-control":"no-store"};
async function sha256(text:string) {
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
export async function executePublicationPreorder(context:Context,raw:unknown):Promise<Response> {
  const input=raw as {operationId?:unknown;publicationVersionId?:unknown;territory?:unknown;currency?:unknown}|null;
  if(!input||Array.isArray(input)||Object.keys(input).sort().join(",")!=="currency,operationId,publicationVersionId,territory"||
    typeof input.operationId!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(input.operationId)||
    typeof input.publicationVersionId!=="string"||!/^[a-zA-Z0-9_-]{3,180}$/.test(input.publicationVersionId)||
    typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
    typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
    return new Response(null,{status:400,headers:noStore});
  const {primary,sql}=context;
  if(marketIsWithdrawn(sql,input.territory))return new Response(null,{status:409,headers:noStore});
  const version=await primary.prepare(
    "SELECT pv.manifest_json,pv.snapshot_sha256,pv.version_number,pv.lifecycle_id,pv.submission_id,l.state,l.current_publication_version_id,l.pending_publication_version_id,p.product_id,p.edition_id,p.work_id,s.snapshot_json,s.snapshot_sha256 submission_sha256,s.status submission_status,a.status account_status,a.identity_status,a.tax_status,a.payout_status FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_publications p ON p.id=pv.publication_id JOIN publishing_submission_snapshots s ON s.id=pv.submission_id AND s.id=p.submission_id AND s.edition_id=l.publishing_edition_id AND s.account_id=p.publishing_account_id JOIN publishing_accounts a ON a.id=s.account_id WHERE pv.id=?"
  ).bind(input.publicationVersionId).first<{
    manifest_json:string;snapshot_sha256:string;version_number:number;lifecycle_id:string;submission_id:string;
    state:string;current_publication_version_id:string|null;pending_publication_version_id:string|null;
    product_id:string;edition_id:string;work_id:string;snapshot_json:string;submission_sha256:string;
    submission_status:string;account_status:string;identity_status:string;tax_status:string;payout_status:string;
  }>();
  if(!version||!["scheduled","preorder"].includes(version.state)||
    version.current_publication_version_id!==input.publicationVersionId||version.pending_publication_version_id||
    version.submission_status!=="published"||version.account_status!=="active"||
    [version.identity_status,version.tax_status,version.payout_status].some(s=>s!=="verified")||
    !/^[a-f0-9]{64}$/.test(version.snapshot_sha256)||
    version.snapshot_sha256!==version.submission_sha256||
    await sha256(version.snapshot_json)!==version.snapshot_sha256)
    return new Response(null,{status:409,headers:noStore});
  let manifest:{schemaVersion?:unknown;submissionId?:unknown;snapshotSha256?:unknown;
    productId?:unknown;catalogEditionId?:unknown;workId?:unknown;
    metadata?:{releaseDate?:unknown;preorderDate?:unknown}};
  try{manifest=JSON.parse(version.manifest_json);}
  catch{return new Response(null,{status:409,headers:noStore});}
  const release=typeof manifest?.metadata?.releaseDate==="string"?Date.parse(manifest.metadata.releaseDate):NaN;
  const preorder=typeof manifest?.metadata?.preorderDate==="string"?Date.parse(manifest.metadata.preorderDate):NaN;
  if(!manifest||manifest.schemaVersion!==4||manifest.submissionId!==version.submission_id||
    manifest.snapshotSha256!==version.snapshot_sha256||typeof manifest.productId!=="string"||
    !commercialProductId.test(manifest.productId)||manifest.productId.startsWith("prd_gutenberg_")||
    manifest.productId!==version.product_id||manifest.catalogEditionId!==version.edition_id||manifest.workId!==version.work_id||
    !Number.isFinite(release)||release<=Date.now()||!Number.isFinite(preorder)||preorder>Date.now()||preorder>=release)
    return new Response(null,{status:409,headers:noStore});
  const productId=manifest.productId;
  const identity={operationId:input.operationId,productId,commandSha256:await sha256(JSON.stringify({
    kind:"open-preorder",publicationVersionId:input.publicationVersionId,territory:input.territory,
    currency:input.currency,manifest:version.manifest_json,snapshot:version.snapshot_sha256
  }))};
  if(context.executing.has(productId))return new Response(null,{status:409,headers:noStore});
  context.executing.add(productId);
  try {
    const pending=sql.exec<{operation_id:string;command_sha256:string}>(
      "SELECT operation_id,command_sha256 FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
      productId).toArray()[0];
    if(pending&&pending.command_sha256===identity.commandSha256&&version.state==="preorder")
      identity.operationId=pending.operation_id;
    const resuming=readPublicationCommand(sql,identity.operationId)!==null;
    if(version.state==="preorder"&&!resuming)return new Response(null,{status:409,headers:noStore});
    const command=context.transactionSync(()=>{
      const held=beginPublicationCommand(sql,identity);
      if(!resuming)recordPublicationRecovery(sql,identity,"/publication/open-preorder",{
        publicationVersionId:input.publicationVersionId,territory:input.territory,currency:input.currency
      });
      return held;
    });
    let result:{publicationVersionId:string;state:string;versionNumber:number};
    if(version.state==="preorder") {
      result={publicationVersionId:input.publicationVersionId,state:"preorder",versionNumber:Number(version.version_number)};
    } else {
      // A partial D1 command cannot be replayed after process loss: no
      // inference from a few written rows may release the durable denial.
      if(resuming||command.state==="committed")return new Response(null,{status:503,headers:noStore});
      result=await openPublicationPreorderOwned(primary,input.publicationVersionId);
    }
    const complete=await primary.prepare(
      "SELECT p.storefront_status,e.release_status,l.state,l.current_publication_version_id FROM products p JOIN editions e ON e.id=p.edition_id JOIN publishing_release_lifecycles l ON l.id=? WHERE p.id=? AND EXISTS (SELECT 1 FROM publishing_publication_activations a WHERE a.lifecycle_id=l.id AND a.publication_version_id=? AND a.reason_code='preorder_opened')"
    ).bind(version.lifecycle_id,productId,input.publicationVersionId).first<{
      storefront_status:string;release_status:string;state:string;current_publication_version_id:string|null
    }>();
    if(!complete||complete.storefront_status!=="active"||complete.release_status!=="preorder"||
      complete.state!=="preorder"||complete.current_publication_version_id!==input.publicationVersionId)
      return new Response(null,{status:503,headers:noStore});
    context.transactionSync(()=>commitPublicationCommand(sql,identity,result));
    let publishedEpoch:number|null=null;
    for(const path of ["/commercial/publish-verified","/storefront/publish-commercial"]) {
      const verified=await context.publish(path,{productId,territory:input.territory,currency:input.currency,channel:"retail"});
      if(verified.status!==200)return new Response(null,{status:503,headers:noStore});
      const proof=await verified.json() as {applied?:unknown;epoch?:unknown};
      if(proof.applied!==true||!Number.isSafeInteger(proof.epoch)||Number(proof.epoch)<=0||
        publishedEpoch!==null&&proof.epoch!==publishedEpoch)
        return new Response(null,{status:503,headers:noStore});
      publishedEpoch=Number(proof.epoch);
    }
    context.transactionSync(()=>markPublicationPublished(sql,identity,publishedEpoch!));
    return Response.json({schema:"cove.publication-preorder.v1",ownerFirst:true,
      operationId:input.operationId,...result},{headers:noStore});
  } finally {context.executing.delete(productId);}
}
