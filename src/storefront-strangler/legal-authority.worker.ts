/* eslint-disable prettier/prettier -- Private legal-authority boundary is security-sensitive. */
import {ownerSettlementDiagnostic} from "./owner-settlement-diagnostic";
import { DurableObject } from "cloudflare:workers";
import {DISABLED_OWNER_ATTEST_ROUTE,PRODUCTION_OWNER_OBJECT,isDisabledProductionOwner,validOwnerChallenge,disabledOwnerReceipt} from "./production-disabled-owner-attestation";
import {publishVerifiedPaidOrderAtomic,type VerifiedPaidOrderLine} from "./paid-order-atomic-publication";
import {executeOwnerRefundAccounting} from "./refund-accounting-owner-executor";
import {executeOwnerPaidSettlement} from "./paid-settlement-owner-executor";
import {createMarketAuthoritySchema,denyMarket,marketIsWithdrawn} from "./market-authority-core";
import { authorizeStorefrontPresentationIds, type CatalogDB } from "../features/fore/catalog-model.server";
import { resolveProductRights } from "../features/fore/rights.server";
import {activatePublicationVersionOwned} from "../features/fore/publishing.server";
import {createPublicationMaterializationSchema,executePublicationMaterialization} from "./publication-materialization-command";
import type {PublishingEnv} from "../features/fore/publishing.server";
import {executePublicationPreorder} from "./publication-preorder-command";
import {beginPublicationCommand,commitPublicationCommand,readPublicationCommand,markPublicationPublished,recordPublicationRecovery} from "./publication-command-core";
import {recoverPublicationCommands} from "./publication-command-recovery";
import {
  captureEntitlementEpoch,createPaidEntitlementSchema,
  denyPaidOrder,denyPaidEntitlement,denyPaidEntitlementsBatch,
  publishFreshEntitlement,readPaidAccess,readPaidOrderPermission,
  validatePaidEntitlementScope,
} from "./commercial-entitlement-core";
import {
  captureCommercialEpoch, createCommercialAuthoritySchema,
  denyCommercialProduct, denyCommercialProductsBatch, denyCommercialSubject,
  publishFreshCommercialProof, readCommercialProofs,
  commercialProductId, type CommercialChannel,
} from "./commercial-legal-core";
import {
  createCommercialStorefrontSchema,publishCommercialStorefront,readCommercialStorefront,
} from "./commercial-storefront-authority";
import {
  applyAuthorityCommand, capturePositiveVerificationFence, commitFreshPositiveVerification,
  createAuthoritySchema, createAuthorityProofSchema,
  readAuthority, readAuthorizedPresentations,
  persistSourceWithdrawal, persistSourceWithdrawalsBatch,
  validateAuthorityCommand, type AuthoritySql,
} from "./legal-authority-core";

type LegalAuthorityEnv = {
  PRIMARY_DB: CatalogDB;
  BUCKET?:PublishingEnv["BUCKET"];
  FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK?:string;
  COVE_RIGHTS_OWNER_SECRET?: string;
  COVE_RIGHTS_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?: string;
  STRIPE_SECRET_KEY?:string;
  STRIPE_LIVEMODE?:string;
  STRIPE_TAX_ENABLED?:string;
  LEGAL_AUTHORITY?: {getByName(name:string):{fetch(request:Request):Promise<Response>}};
};
// Never accept an unspecified primary binding. This is a newly provisioned,
// completely separate canonical QA D1. Real production is NOT enrolled.
// Only these two physically separate, synthetic QA databases can issue a
// short-lived owner lease. The second has canonical paid-commerce schema;
// neither is the capacity fixture or a customer production database.
const QA_PRIMARIES = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);
function qaOwnerLeaseLive(env:LegalAuthorityEnv) {
  const expires=Number(env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT);
  const now=Date.now();
  // An interrupted GitHub job cannot accidentally leave the QA legal owner
  // operable. A fresh, strictly bounded lease is required by BOTH the Worker
  // entrypoint and its Durable Object; no stale toggle can bypass this fence.
  return env.COVE_RIGHTS_OWNER_ENABLED==="1" &&
    QA_PRIMARIES.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID||"") &&
    Number.isSafeInteger(expires) && expires>now &&
    expires<=now+15*60*1000 &&
    !!env.COVE_RIGHTS_OWNER_SECRET &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET);
}

export class CoveLegalAuthority extends DurableObject<LegalAuthorityEnv> {
  private publicationExecutions=new Set<string>();
  private publicationRecoveryRunning=false;
  private settlementExecutions=new Set<string>();
  private settlementRecoveryRunning=false;
  constructor(ctx: { storage: { sql: unknown } }, env: LegalAuthorityEnv) {
    super(ctx, env);
    createAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createAuthorityProofSchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialStorefrontSchema(ctx.storage.sql as unknown as AuthoritySql);
    createPaidEntitlementSchema(ctx.storage.sql as unknown as AuthoritySql);
    createMarketAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createPublicationMaterializationSchema(ctx.storage.sql as unknown as AuthoritySql);
  }

  async fetch(request: Request): Promise<Response> {
    const noStore={ "cache-control": "no-store" };
    const env=this.env;
    // Disabled production mode exposes one private, authenticated read-only
    // challenge. This path cannot invoke any rights, payment or D1 command.
    // The QA lease below remains the ONLY authorized mutating/read mode.
    if(new URL(request.url).pathname===DISABLED_OWNER_ATTEST_ROUTE){
      if(!isDisabledProductionOwner(env))
        return new Response(null,{status:503,headers:noStore});
      if(request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
        return new Response(null,{status:401,headers:noStore});
      if(request.method!=="POST"||
         request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
        return new Response(null,{status:405,headers:noStore});
      const input=await request.text();
      if(input.length>128)return new Response(null,{status:413,headers:noStore});
      let parsed:unknown;
      try{parsed=JSON.parse(input);}catch{return new Response(null,{status:400,headers:noStore});}
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||
         Object.keys(parsed).join(",")!=="challenge"||
         !validOwnerChallenge((parsed as {challenge?:unknown}).challenge))
        return new Response(null,{status:400,headers:noStore});
      return Response.json(disabledOwnerReceipt((parsed as {challenge:string}).challenge),
        {headers:noStore});
    }
    if (!qaOwnerLeaseLive(env))
      return new Response(null,{status:503,headers:noStore});
    // All calls must arrive by private service binding with an independent
    // operator secret. Nothing on this Worker should be publicly routed.
    if (request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
      return new Response(null,{status:401,headers:noStore});
    if(request.method!=="POST") return new Response(null,{status:405,headers:noStore});
    const route=new URL(request.url).pathname;
    if(!["/deny","/deny-next","/deny-next-batch","/verify","/publish-allow","/authorize-batch",
      "/commercial/deny-next","/commercial/deny-batch","/commercial/subject/deny-next","/commercial/publish-verified",
      "/commercial/authorize-batch",
      "/storefront/authorize-batch","/storefront/publish-commercial",
      "/market/deny-next",
      "/commercial/order/deny-next","/commercial/order/verify","/commercial/order/revoke",
      "/commercial/order/settle",
      "/commercial/order/recover-settlements",
      "/commercial/refund/post-accounting",
      "/commercial/refund/record-provider",
      "/commercial/entitlement/deny-next","/commercial/entitlement/deny-batch",
      "/commercial/entitlement/publish-verified",
      "/commercial/entitlement/publish-order-verified",
      "/publication/materialize-submission",
      "/publication/activate-version",
      "/publication/open-preorder",
      "/publication/recover-recorded",
      "/commercial/entitlement/authorize"].includes(route))
      return new Response(null,{status:404,headers:noStore});
    if (request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return new Response(null,{status:415,headers:noStore});
    let raw:unknown;
    try {
      const bytes=await request.text();
      if(bytes.length>(["/authorize-batch","/deny-next-batch","/commercial/authorize-batch","/commercial/deny-batch","/commercial/entitlement/deny-batch","/storefront/authorize-batch"].includes(route)?24000:1024)) return new Response(null,{status:413,headers:noStore});
      raw=JSON.parse(bytes);
    }catch {return new Response(null,{status:400,headers:noStore});}
    const sql=this.ctx.storage.sql as unknown as AuthoritySql;
    try {
      if(route==="/commercial/order/recover-settlements"){
        const input=raw as {limit?:unknown}|null;
        if(!input||Object.keys(input).join(",")!=="limit"||!Number.isSafeInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>25)
          return new Response(null,{status:400,headers:noStore});
        if(this.settlementRecoveryRunning)return new Response(null,{status:409,headers:noStore});
        this.settlementRecoveryRunning=true;
        try{
          // Two independent crash windows: a journal without a committed D1
          // receipt, and a receipt whose owner publication was interrupted.
          // Keyset cursors advance past blocked orders so retries cannot
          // starve later settlements, including internal-only tender.
          const cursors=sql.exec<{scope:string;after_id:string;after_time:string}>("SELECT scope,after_id,after_time FROM cove_paid_settlement_recovery_cursors").toArray();
          const journalCursor=cursors.find(c=>c.scope==="journal")?.after_id||"";
          let recorded=sql.exec<{order_id:string}>("SELECT order_id FROM cove_paid_settlement_commands WHERE state='pending' AND order_id>? ORDER BY order_id LIMIT ?",journalCursor,Number(input.limit)).toArray();
          if(!recorded.length&&journalCursor)recorded=sql.exec<{order_id:string}>("SELECT order_id FROM cove_paid_settlement_commands WHERE state='pending' ORDER BY order_id LIMIT ?",Number(input.limit)).toArray();
          const receiptCursor=cursors.find(c=>c.scope==="receipt");
          const readReceipts=(afterTime:string,afterId:string)=>env.PRIMARY_DB.prepare("SELECT order_id,settled_at FROM commerce_settlement_receipts WHERE owner_published_at IS NULL AND (settled_at>? OR (settled_at=? AND order_id>?)) ORDER BY settled_at,order_id LIMIT ?")
            .bind(afterTime,afterTime,afterId,input.limit).all<{order_id:string;settled_at:string}>();
          let receipts=(await readReceipts(receiptCursor?.after_time||"",receiptCursor?.after_id||"")).results;
          if(!receipts.length&&receiptCursor)receipts=(await readReceipts("","")).results;
          const pending:Array<{order_id:string}>=[],seen=new Set<string>();
          const through:{journal:string|null;receipt:{order_id:string;settled_at:string}|null}={journal:null,receipt:null};
          const receiptFirst=cursors.find(c=>c.scope==="turn")?.after_id==="receipt";
          for(let i=0;i<Number(input.limit)&&pending.length<Number(input.limit);i++){
            const takeJournal=()=>{const j=recorded[i];if(j&&pending.length<Number(input.limit)){
              through.journal=j.order_id;if(!seen.has(j.order_id)){seen.add(j.order_id);pending.push(j);}
            }};
            const takeReceipt=()=>{const r=receipts[i];if(r&&pending.length<Number(input.limit)){
              through.receipt=r;if(!seen.has(r.order_id)){seen.add(r.order_id);pending.push(r);}
            }};
            if(receiptFirst){takeReceipt();takeJournal();}else{takeJournal();takeReceipt();}
          }
          sql.exec("INSERT INTO cove_paid_settlement_recovery_cursors(scope,after_id,after_time) VALUES('turn',?,'') ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id",receiptFirst?"journal":"receipt");
          if(through.journal)sql.exec("INSERT INTO cove_paid_settlement_recovery_cursors(scope,after_id,after_time) VALUES('journal',?,'') ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id",through.journal);
          if(through.receipt)sql.exec("INSERT INTO cove_paid_settlement_recovery_cursors(scope,after_id,after_time) VALUES('receipt',?,?) ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id,after_time=excluded.after_time",through.receipt.order_id,through.receipt.settled_at);
          let recovered=0,blocked=0;
          for(const row of pending){
            const response=await this.fetch(new Request("https://legal-authority.internal/commercial/order/settle",{
              method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,"content-type":"application/json"},
              body:JSON.stringify({orderId:row.order_id})
            }));
            if(response.status===200)recovered++;else blocked++;
          }
          return Response.json({schema:"cove.owner-settlement-recovery.v1",checked:pending.length,recovered,blocked},{headers:noStore});
        }finally{this.settlementRecoveryRunning=false;}
      }
      if(route==="/commercial/order/settle"){
        const receipt=await executeOwnerPaidSettlement({env,sql,executing:this.settlementExecutions,
          publish:async order=>{
            const lines=(await env.PRIMARY_DB.prepare("SELECT id FROM commerce_order_items WHERE order_id=? AND preorder_id IS NULL LIMIT 26").bind(order.id).all<{id:string}>()).results;
            if(!lines.length)return; // Financial preorder reservation grants no bytes.
            const response=await this.fetch(new Request("https://legal-authority.internal/commercial/entitlement/publish-order-verified",{
              method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,"content-type":"application/json"},
              body:JSON.stringify({orderId:order.id,userId:order.user_id,territory:order.territory_code,channel:"retail"})
            }));
            if(response.status!==200)throw Error("owner_settlement_publication_incomplete");
          }},raw);
        return Response.json(receipt,{headers:noStore});
      }
      if(route==="/publication/recover-recorded") {
        const input=raw as {operationId?:unknown}|null;
        if(!input||Object.keys(input).join(",")!=="operationId"||
          typeof input.operationId!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(input.operationId))
          return new Response(null,{status:400,headers:noStore});
        if(this.publicationRecoveryRunning)return new Response(null,{status:409,headers:noStore});
        this.publicationRecoveryRunning=true;
        try {
          const result=await recoverPublicationCommands(sql,(path,body)=>this.fetch(new Request(
            "https://legal-authority.internal"+path,{method:"POST",headers:{
              authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,"content-type":"application/json"
            },body:JSON.stringify(body)})));
          return Response.json({schema:"cove.publication-recovery.v1",ownerFirst:true,
            operationId:input.operationId,...result},{headers:noStore});
        } finally {this.publicationRecoveryRunning=false;}
      }
      if(route==="/publication/materialize-submission") {
        const storage=this.ctx.storage as typeof this.ctx.storage & {transactionSync<T>(fn:()=>T):T};
        return await executePublicationMaterialization({primary:env.PRIMARY_DB,bucket:env.BUCKET,sql,
          autoApprove:env.FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK,
          executing:this.publicationExecutions,transactionSync:fn=>storage.transactionSync(fn),
          publish:(path,body)=>this.fetch(new Request("https://legal-authority.internal"+path,{
            method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},body:JSON.stringify(body)
          }))},raw);
      }
      if(route==="/publication/open-preorder") {
        const storage=this.ctx.storage as typeof this.ctx.storage & {transactionSync<T>(fn:()=>T):T};
        return await executePublicationPreorder({primary:env.PRIMARY_DB,sql,
          executing:this.publicationExecutions,transactionSync:fn=>storage.transactionSync(fn),
          publish:(path,input)=>this.fetch(new Request("https://legal-authority.internal"+path,{
            method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},body:JSON.stringify(input)
          }))},raw);
      }
      if(route==="/publication/activate-version") {
        const input=raw as {operationId?:unknown;publicationVersionId?:unknown;
          actorUserId?:unknown;triggerType?:unknown;territory?:unknown;currency?:unknown}|null;
        if(!input||typeof input.operationId!=="string"||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(input.operationId)||
          typeof input.publicationVersionId!=="string"||
          !/^[a-zA-Z0-9_-]{3,180}$/.test(input.publicationVersionId)||
          !(input.actorUserId===null||typeof input.actorUserId==="string"&&
            /^[a-zA-Z0-9_-]{3,180}$/.test(input.actorUserId))||
          !["staff","schedule","rollback"].includes(String(input.triggerType))||
          typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
          typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        if(input.triggerType!=="schedule") {
          if(input.actorUserId===null)return new Response(null,{status:403,headers:noStore});
          const permitted=await env.PRIMARY_DB.prepare(
            "SELECT 1 ok FROM staff_principals p JOIN staff_principal_roles r ON r.user_id=p.user_id JOIN staff_role_permissions permission ON permission.role_id=r.role_id WHERE p.user_id=? AND p.status='active' AND permission.permission IN (?, 'publishing.lifecycle.manage','staff.manage') LIMIT 1"
          ).bind(input.actorUserId,input.triggerType==="rollback"?"publishing.rollback":"publishing.review")
            .first<{ok:number}>();
          if(!permitted)return new Response(null,{status:403,headers:noStore});
        }
        const version=await env.PRIMARY_DB.prepare(
          "SELECT pv.manifest_json,pv.snapshot_sha256,pv.submission_id,pv.version_number,pv.lifecycle_id,l.state,l.current_publication_version_id,l.pending_publication_version_id,p.product_id,p.edition_id,p.work_id,s.snapshot_json,s.snapshot_sha256 submission_sha256,s.status submission_status,a.status account_status,a.identity_status,a.tax_status,a.payout_status FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_publications p ON p.id=pv.publication_id JOIN publishing_submission_snapshots s ON s.id=pv.submission_id AND s.id=p.submission_id AND s.edition_id=l.publishing_edition_id AND s.account_id=p.publishing_account_id JOIN publishing_accounts a ON a.id=s.account_id WHERE pv.id=?"
        ).bind(input.publicationVersionId).first<{
          manifest_json:string;snapshot_sha256:string;submission_id:string;snapshot_json:string;
          submission_sha256:string;version_number:number;lifecycle_id:string;
          state:string;current_publication_version_id:string|null;pending_publication_version_id:string|null;product_id:string;edition_id:string;work_id:string;
          submission_status:string;account_status:string;identity_status:string;tax_status:string;payout_status:string
        }>();
        if(!version||["suppressed","takedown","retired"].includes(version.state)||
          version.submission_status!=="published"||version.account_status!=="active"||
          [version.identity_status,version.tax_status,version.payout_status].some(s=>s!=="verified"))
          return new Response(null,{status:409,headers:noStore});
        let manifest:{schemaVersion?:unknown;snapshotSha256?:unknown;submissionId?:unknown;
          productId?:unknown;catalogEditionId?:unknown;workId?:unknown;
          metadata?:{releaseDate?:unknown}};
        try{manifest=JSON.parse(version.manifest_json);}
        catch{return new Response(null,{status:409,headers:noStore});}
        if(!manifest||manifest.schemaVersion!==4||manifest.submissionId!==version.submission_id||
          manifest.snapshotSha256!==version.snapshot_sha256||
          !/^[a-f0-9]{64}$/.test(version.snapshot_sha256)||
          version.snapshot_sha256!==version.submission_sha256||typeof manifest.productId!=="string"||
          !commercialProductId.test(manifest.productId)||manifest.productId.startsWith("prd_gutenberg_")||
          manifest.productId!==version.product_id||manifest.catalogEditionId!==version.edition_id||
          manifest.workId!==version.work_id)
          return new Response(null,{status:409,headers:noStore});
        const snapshotDigest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(version.snapshot_json));
        if([...new Uint8Array(snapshotDigest)].map(b=>b.toString(16).padStart(2,"0")).join("")!==version.snapshot_sha256)
          return new Response(null,{status:409,headers:noStore});
        if(input.triggerType==="schedule") {
          const releaseAt=typeof manifest.metadata?.releaseDate==="string"?
            Date.parse(manifest.metadata.releaseDate):NaN;
          if(!Number.isFinite(releaseAt)||releaseAt>Date.now())
            return new Response(null,{status:409,headers:noStore});
        }
        const productId=manifest.productId;
        // Hash the canonical immutable manifest as well as every command
        // argument. Reusing an operation ID for changed evidence is invalid.
        const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({
          publicationVersionId:input.publicationVersionId,actorUserId:input.actorUserId,
          triggerType:input.triggerType,territory:input.territory,currency:input.currency,
          manifest:version.manifest_json
        })));
        const identity={operationId:input.operationId,productId,
          commandSha256:[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("")};
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        if(this.publicationExecutions.has(productId))
          return new Response(null,{status:409,headers:noStore});
        this.publicationExecutions.add(productId);
        try {
        const pending=sql.exec<{operation_id:string;command_sha256:string}>(
          "SELECT operation_id,command_sha256 FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
          productId).toArray()[0];
        // A caller that lost the response may have generated a new transport
        // ID. Reconcile only the SAME immutable command against its complete
        // canonical activation marker; never start a second primary executor.
        if(pending&&pending.command_sha256===identity.commandSha256&&
          version.current_publication_version_id===input.publicationVersionId)
          identity.operationId=pending.operation_id;
        const resuming=readPublicationCommand(sql,identity.operationId)!==null;
        // A delayed scheduler command cannot activate an old version after
        // a different release became current. Exact recorded-command replay
        // remains available for a completed initial/scheduled activation.
        if(input.triggerType==="schedule"&&!resuming&&
          (!["scheduled","preorder"].includes(version.state)||
            (version.pending_publication_version_id||version.current_publication_version_id)!==input.publicationVersionId))
          return new Response(null,{status:409,headers:noStore});
        if(!resuming&&version.current_publication_version_id===input.publicationVersionId) {
          const state=sql.exec<{epoch:number;verdict:string}>(
            "SELECT epoch,verdict FROM cove_commercial_authority WHERE product_id=?",productId).toArray()[0];
          const lastDenial=state?sql.exec<{operation_id:string}>(
            "SELECT operation_id FROM cove_commercial_withdrawal_ops WHERE product_id=? AND epoch=?",
            productId,state.epoch).toArray()[0]:null;
          if(state?.verdict==="deny"&&
            !lastDenial?.operation_id.startsWith("retail:publication:"))
            return new Response(null,{status:409,headers:noStore});
        }
        // Canonical activation retires the prior manifest's grants and may
        // terminate its publication-managed contract. Those identities can
        // cover OTHER products: withdraw their owner proofs before any write,
        // rather than relying only on this product's edit hold.
        const retiring:{subjectKind:"grant"|"contract";subjectId:string}[]=[];
        if(!resuming&&version.current_publication_version_id&&
          version.current_publication_version_id!==input.publicationVersionId) {
          const previous=await env.PRIMARY_DB.prepare(
            "SELECT manifest_json FROM publishing_publication_versions WHERE id=? AND lifecycle_id=?"
          ).bind(version.current_publication_version_id,version.lifecycle_id)
            .first<{manifest_json:string}>();
          if(!previous)return new Response(null,{status:409,headers:noStore});
          const prior=JSON.parse(previous.manifest_json) as {
            rightsGrantIds?:unknown;rightsContractManagedByPublication?:unknown;rightsContractId?:unknown
          };
          if(!prior||typeof prior!=="object")return new Response(null,{status:409,headers:noStore});
          let grants=Array.isArray(prior.rightsGrantIds)?prior.rightsGrantIds.map(String).filter(Boolean):[];
          if(!grants.length&&prior.rightsContractManagedByPublication&&prior.rightsContractId)
            grants=(await env.PRIMARY_DB.prepare("SELECT id FROM rights_grants WHERE contract_id=?")
              .bind(prior.rightsContractId).all<{id:string}>()).results.map(row=>row.id);
          const next=manifest as typeof manifest&{rightsGrantIds?:unknown;rightsContractId?:unknown;
            rightsContractManagedByPublication?:unknown};
          let nextGrants=Array.isArray(next.rightsGrantIds)?next.rightsGrantIds.map(String).filter(Boolean):[];
          if(!nextGrants.length&&next.rightsContractManagedByPublication&&next.rightsContractId)
            nextGrants=(await env.PRIMARY_DB.prepare("SELECT id FROM rights_grants WHERE contract_id=?")
              .bind(next.rightsContractId).all<{id:string}>()).results.map(row=>row.id);
          const retained=new Set(nextGrants);
          for(const subjectId of new Set(grants))
            if(!retained.has(subjectId))retiring.push({subjectKind:"grant",subjectId});
          if(prior.rightsContractManagedByPublication&&typeof prior.rightsContractId==="string"&&
            prior.rightsContractId!==next.rightsContractId)
            retiring.push({subjectKind:"contract",subjectId:prior.rightsContractId});
        }
        const command=storage.transactionSync(()=>{
          const pending=beginPublicationCommand(sql,identity);
          if(!resuming)recordPublicationRecovery(sql,identity,"/publication/activate-version",{
            publicationVersionId:input.publicationVersionId,actorUserId:input.actorUserId,
            triggerType:input.triggerType,territory:input.territory,currency:input.currency
          });
          retiring.forEach((subject,index)=>denyCommercialSubject(sql,{
            ...subject,operationId:"publication:"+identity.operationId+":retire:"+index
          }));
          return pending;
        });
        let result:{publicationVersionId:string;state:string;versionNumber:number};
        if(version.current_publication_version_id===input.publicationVersionId&&
          ["live","updated"].includes(version.state)) {
          const marker=await env.PRIMARY_DB.prepare(
            "SELECT id FROM publishing_publication_activations WHERE publication_version_id=? AND lifecycle_id=? LIMIT 1"
          ).bind(input.publicationVersionId,version.lifecycle_id).first<{id:string}>();
          if(!marker||!["live","updated"].includes(version.state))
            return new Response(null,{status:503,headers:noStore});
          result={publicationVersionId:input.publicationVersionId,state:version.state,
            versionNumber:Number(version.version_number)};
        } else {
          // A committed old operation cannot rerun an old version after a
          // newer publication became current. A new rollback command is
          // required and must independently reverify current legal evidence.
          if(command.state==="committed")
            return new Response(null,{status:409,headers:noStore});
          // A restarted owner cannot infer how much of an interrupted
          // multi-table primary command committed. Only a complete canonical
          // activation marker can reconcile it. Never blindly replay writes.
          if(resuming)return new Response(null,{status:503,headers:noStore});
          result=await activatePublicationVersionOwned(env.PRIMARY_DB,
            input.publicationVersionId,input.actorUserId as string|null,
            input.triggerType as "staff"|"schedule"|"rollback");
        }
        const completion=await env.PRIMARY_DB.prepare(
          "SELECT p.storefront_status,l.state,l.current_publication_version_id FROM products p JOIN publishing_release_lifecycles l ON l.id=? WHERE p.id=? AND EXISTS (SELECT 1 FROM publishing_publication_activations a WHERE a.lifecycle_id=l.id AND a.publication_version_id=?)"
        ).bind(version.lifecycle_id,productId,input.publicationVersionId).first<{
          storefront_status:string;state:string;current_publication_version_id:string|null
        }>();
        if(!completion||completion.storefront_status!=="active"||
          completion.current_publication_version_id!==input.publicationVersionId||
          !["live","updated"].includes(completion.state))
          return new Response(null,{status:503,headers:noStore});
        storage.transactionSync(()=>commitPublicationCommand(sql,identity,result));
        // Ending the write hold grants NOTHING. Both legal and offer
        // publication perform their own fresh canonical reads and epoch CAS.
        let publishedEpoch:number|null=null;
        for(const path of ["/commercial/publish-verified","/storefront/publish-commercial"]) {
          const verify=await this.fetch(new Request("https://legal-authority.internal"+path,{
            method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},body:JSON.stringify({productId,
              territory:input.territory,currency:input.currency,channel:"retail"})
          }));
          if(verify.status!==200)return new Response(null,{status:503,headers:noStore});
          const proof=await verify.json() as {applied?:unknown;epoch?:unknown};
          if(proof.applied!==true||!Number.isSafeInteger(proof.epoch)||Number(proof.epoch)<=0||
            publishedEpoch!==null&&proof.epoch!==publishedEpoch)
            return new Response(null,{status:503,headers:noStore});
          publishedEpoch=Number(proof.epoch);
        }
        storage.transactionSync(()=>markPublicationPublished(sql,identity,publishedEpoch!));
        return Response.json({schema:"cove.publication-activation.v1",ownerFirst:true,
          operationId:input.operationId,...result},{headers:noStore});
        } finally {this.publicationExecutions.delete(productId);}
      }
      if(route==="/market/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyMarket(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      // All territory-sensitive owner decisions, including historical paid
      // entitlements, are blocked by one durable market tombstone. This is
      // deliberately NOT an asynchronous fanout across product grants.
      const marketScopedRoutes=new Set([
        "/verify","/authorize-batch","/publish-allow",
        "/commercial/authorize-batch","/commercial/publish-verified",
        "/storefront/authorize-batch","/storefront/publish-commercial",
        "/commercial/entitlement/authorize",
        "/commercial/entitlement/publish-verified"
      ]);
      if(marketScopedRoutes.has(route) &&
         marketIsWithdrawn(sql,(raw as {territory?:unknown})?.territory))
        return new Response(null,{status:409,headers:noStore});
      if(route==="/commercial/order/verify"){
        return Response.json(readPaidOrderPermission(sql,raw),{headers:noStore});
      }
      if(route==="/commercial/order/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyPaidOrder(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/order/revoke"){
        // This command owns the canonical reconciliation, rather than
        // delegating raw SQL to an independently privileged QA writer.
        // Neither a buyer ID, entitlement list nor arbitrary SQL is accepted.
        const input=raw as {orderId?:unknown;operationId?:unknown}|null;
        if(!input||Array.isArray(input)||
           Object.keys(input).sort().join(",")!=="operationId,orderId"||
           typeof input.orderId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(input.orderId)||
           typeof input.operationId!=="string"||
           !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(input.operationId))
          return new Response(null,{status:400,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id FROM commerce_orders WHERE id=?"
        ).bind(input.orderId).first<{id:string;user_id:string}>();
        if(!order||order.id!==input.orderId||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(order.user_id))
          return new Response(null,{status:409,headers:noStore});
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        // ONE durable terminal order tombstone denies every old buyer proof
        // before the first canonical write, including a concurrent grant
        // whose D1 verification was already in flight. D1 failure leaves
        // this denial committed; the exact command can safely reconcile on
        // retry. An operation ID cannot be replayed for a different order.
        storage.transactionSync(()=>denyPaidOrder(sql,input));
        // A refunded buyer must not retain an active EPUB delivery token or
        // audio offline-license record. Reconcile all three canonical tables
        // atomically AFTER the durable owner veto. An interrupted D1 batch
        // leaves the whole order denied and is repairable with the same ID.
        await env.PRIMARY_DB.batch([
          env.PRIMARY_DB.prepare(
            "UPDATE entitlements SET status='revoked' WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase' AND status='active'"
          ).bind(order.user_id,input.orderId),
          env.PRIMARY_DB.prepare(
            "UPDATE audio_offline_licenses SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason='order_refunded' WHERE entitlement_id IN (SELECT id FROM entitlements WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase') AND status='active'"
          ).bind(new Date().toISOString(),order.user_id,input.orderId),
          env.PRIMARY_DB.prepare(
            "UPDATE commercial_delivery_grants SET status='revoked' WHERE user_id=? AND entitlement_id IN (SELECT id FROM entitlements WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase') AND status='active'"
          ).bind(order.user_id,order.user_id,input.orderId)
        ]);
        return Response.json({schema:"cove.paid-order-revocation.v1",
          orderDenied:true,reconciled:true,orderId:input.orderId,
          operationId:input.operationId},{status:200,headers:noStore});
      }
      if(route==="/commercial/refund/record-provider"){
        // Synthetic QA owner lease + private DO bearer are enforced above.
        // Production must separately certify provider evidence provenance.
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          throw Error("invalid_refund_provider_command");
        const q=raw as Record<string,unknown>;
        const validId=/^[a-zA-Z0-9_-]{8,160}$/;
        const provider=/^re_[a-zA-Z0-9_-]{4,200}$/;
        const payment=/^pi_[a-zA-Z0-9_-]{4,200}$/;
        const accepted=new Set(["pending","requires_action","succeeded","failed","canceled"]);
        if(Object.keys(q).sort().join(",")!==
             "amountMinor,currency,orderId,paymentIntentId,providerRefundId,refundId,status"||
           typeof q.orderId!=="string"||!validId.test(q.orderId)||
           typeof q.refundId!=="string"||!validId.test(q.refundId)||
           typeof q.providerRefundId!=="string"||!provider.test(q.providerRefundId)||
           typeof q.paymentIntentId!=="string"||!payment.test(q.paymentIntentId)||
           typeof q.currency!=="string"||!/^[A-Z]{3}$/.test(q.currency)||
           typeof q.status!=="string"||!accepted.has(q.status)||
           !Number.isSafeInteger(q.amountMinor)||Number(q.amountMinor)<=0||
           Number(q.amountMinor)>1_000_000_000_000)
          throw Error("invalid_refund_provider_command");
        const refund=await env.PRIMARY_DB.prepare(
          "SELECT id,order_id,provider_refund_id,stripe_amount_minor,currency,status,succeeded_at FROM commerce_refunds WHERE id=?"
        ).bind(q.refundId).first<{id:string;order_id:string;provider_refund_id:string|null;
          stripe_amount_minor:number;currency:string;status:string;succeeded_at:string|null}>();
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,stripe_payment_intent_id,currency FROM commerce_orders WHERE id=?"
        ).bind(q.orderId).first<{id:string;stripe_payment_intent_id:string|null;currency:string}>();
        if(!refund||refund.id!==q.refundId||refund.order_id!==q.orderId||
           !order||order.id!==q.orderId||
           order.stripe_payment_intent_id!==q.paymentIntentId||
           order.currency!==q.currency||refund.currency!==q.currency||
           Number(refund.stripe_amount_minor)!==q.amountMinor||
           (refund.provider_refund_id&&refund.provider_refund_id!==q.providerRefundId))
          throw Error("owner_refund_provider_scope_mismatch");
        if(readPaidOrderPermission(sql,{orderId:q.orderId}).allowed!==false)
          throw Error("owner_refund_denial_required");
        // Provider identity is immutable and succeeded cannot regress under
        // out-of-order signed Stripe webhooks or caller retries.
        const state=refund.succeeded_at||refund.status==="succeeded"?
          "succeeded":q.status;
        if(refund.provider_refund_id!==q.providerRefundId||refund.status!==state){
          const write=await env.PRIMARY_DB.prepare(
            "UPDATE commerce_refunds SET provider_refund_id=?,status=CASE WHEN succeeded_at IS NOT NULL OR status='succeeded' THEN 'succeeded' ELSE ? END,updated_at=? WHERE id=? AND order_id=? AND (provider_refund_id IS NULL OR provider_refund_id=?)"
          ).bind(q.providerRefundId,state,new Date().toISOString(),
            q.refundId,q.orderId,q.providerRefundId).run() as {meta?:{changes?:number}};
          if((write.meta?.changes??0)===0)
            throw Error("owner_refund_provider_write_conflict");
        }
        const confirmed=await env.PRIMARY_DB.prepare(
          "SELECT id,order_id,provider_refund_id,status FROM commerce_refunds WHERE id=?"
        ).bind(q.refundId).first<{
          id:string;order_id:string;provider_refund_id:string|null;status:string}>();
        if(!confirmed||confirmed.id!==q.refundId||
           confirmed.order_id!==q.orderId||
           confirmed.provider_refund_id!==q.providerRefundId||
           confirmed.status!==state)
          throw Error("owner_refund_provider_confirmation_failed");
        return Response.json({schema:"cove.owner-refund-provider.v1",
          orderId:q.orderId,refundId:q.refundId,
          providerRefundId:q.providerRefundId,status:confirmed.status,
          ownerDenied:true,providerRecorded:true},
          {status:200,headers:noStore});
      }
      if(route==="/commercial/refund/post-accounting"){
        // Canonical finance posting is never delegated to caller-supplied SQL.
        // Only a persisted Stripe-success (or internal tender) refund under
        // the already durable whole-order owner veto can post. No rollback of
        // the owner denial occurs when D1 fails or a retry is interrupted.
        const receipt=await executeOwnerRefundAccounting(env.PRIMARY_DB,sql,raw);
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/deny-batch"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          denyPaidEntitlementsBatch(sql,raw)
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>denyPaidEntitlement(sql,raw));
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/commercial/entitlement/authorize"){
        const row=readPaidAccess(sql,raw);
        return Response.json({schema:"cove.paid-access.v1",allowed:!!row,proof:row},
          {headers:noStore});
      }
      if(route==="/commercial/entitlement/publish-order-verified"){
        // No caller-supplied entitlement list is trusted. The strong owner
        // discovers ALL canonical lines for this exact paid order and
        // verifies their immutable purchase scopes against its own legal
        // grants. One DO transaction then publishes the entire cart or none.
        const q=raw as {orderId?:unknown;userId?:unknown;
          territory?:unknown;channel?:unknown}|null;
        if(!q||typeof q.orderId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(q.orderId)||
           typeof q.userId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(q.userId)||
           typeof q.territory!=="string"||!/^[A-Z]{2}$/.test(q.territory)||
           q.channel!=="retail")
          return new Response(null,{status:400,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id,territory_code,status FROM commerce_orders WHERE id=? AND user_id=?"
        ).bind(q.orderId,q.userId).first<{
          id:string;user_id:string;territory_code:string;status:string
        }>();
        if(!order||order.status!=="paid"||order.territory_code!==q.territory)
          return new Response(null,{status:409,headers:noStore});
        const items=(await env.PRIMARY_DB.prepare(
          `SELECT oi.id,oi.product_id,oi.sales_channel,oi.preorder_id,
                  oi.entitlement_status,oi.rights_grant_id,oi.rights_snapshot_json,
                  e.id entitlement_id,e.status entitlement_state,e.source entitlement_source,
                  e.starts_at entitlement_starts_at,e.ends_at entitlement_ends_at
             FROM commerce_order_items oi LEFT JOIN entitlements e
               ON e.order_item_id=oi.id AND e.user_id=? AND
                  e.product_id=oi.product_id AND e.entitlement_type='purchase'
            WHERE oi.order_id=? ORDER BY oi.id LIMIT 26`
        ).bind(q.userId,q.orderId).all<{
          id:string;product_id:string;sales_channel:string;
          preorder_id:string|null;entitlement_status:string;
          rights_grant_id:string|null;rights_snapshot_json:string|null;
          entitlement_id:string|null;entitlement_state:string|null;
          entitlement_source:string|null;entitlement_starts_at:string|null;
          entitlement_ends_at:string|null;
        }>()).results;
        if(!items.length||items.length>25||
           new Set(items.map(x=>x.product_id)).size!==items.length)
          return new Response(null,{status:409,headers:noStore});
        // Preorders never mint a downloadable entitlement in this path.
        const delivered=items.filter(x=>!x.preorder_id);
        if(!delivered.length)
          return new Response(null,{status:409,headers:noStore});
        if(delivered.some(x=>x.entitlement_status!=="granted"||
           x.entitlement_state!=="active"||x.entitlement_source!=="commerce"||
           x.sales_channel!=="retail"||!x.entitlement_id))
          return new Response(null,{status:409,headers:noStore});
        // Read-only canonical buyer risk gate. Each denied/held line
        // invalidates the full cart, not just an individual ebook.
        const hold=await env.PRIMARY_DB.prepare(
          "SELECT 1 ok FROM risk_holds WHERE domain='buyer' AND subject_type='order' AND subject_id=? AND status='active' AND hold_scope IN ('checkout','entitlement') LIMIT 1"
        ).bind(q.orderId).first<{ok:number}>();
        if(hold)return new Response(null,{status:409,headers:noStore});
        const lines:VerifiedPaidOrderLine[]=[];
        const now=Date.now();
        for(const item of delivered){
          // A multi-book cart obeys the same time window as a single
          // purchase. Invalid canonical timestamps fail closed rather than
          // issuing a fresh five-minute owner lease for an expired line.
          const starts=item.entitlement_starts_at===null?null:
            Date.parse(item.entitlement_starts_at);
          const ends=item.entitlement_ends_at===null?null:
            Date.parse(item.entitlement_ends_at);
          if((starts!==null&&(!Number.isFinite(starts)||starts>now))||
             (ends!==null&&(!Number.isFinite(ends)||ends<=now)))
            return new Response(null,{status:409,headers:noStore});
          const rows=readCommercialProofs(sql,[item.product_id],
            q.territory,"retail");
          if(rows.length!==1)return new Response(null,{status:409,headers:noStore});
          const rights=rows[0]!;
          let purchased:unknown;
          try{purchased=JSON.parse(item.rights_snapshot_json||"null");}
          catch{return new Response(null,{status:409,headers:noStore});}
          const acquired=purchased as {
            grantId?:unknown;editionId?:unknown;territory?:unknown;
            salesChannel?:unknown;contractId?:unknown;contractVersionId?:unknown
          }|null;
          if(!acquired||acquired.grantId!==item.rights_grant_id||
             acquired.grantId!==rights.grant_id||
             acquired.editionId!==rights.edition_id||
             acquired.contractId!==rights.contract_id||
             acquired.contractVersionId!==rights.contract_version_id||
             acquired.territory!==q.territory||acquired.salesChannel!=="retail")
            return new Response(null,{status:409,headers:noStore});
          const expiry=Math.min(now+5*60_000,Date.parse(rights.valid_until),
            ends??Number.POSITIVE_INFINITY);
          if(!Number.isFinite(expiry)||expiry<=now)
            return new Response(null,{status:409,headers:noStore});
          const scope={
            entitlementId:item.entitlement_id!,userId:q.userId,
            productId:item.product_id
          };
          lines.push({...scope,territory:q.territory,channel:"retail",
            orderId:q.orderId,productEpoch:rights.epoch,
            validUntil:new Date(expiry).toISOString(),
            expectedEpoch:captureEntitlementEpoch(sql,scope)});
        }
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          publishVerifiedPaidOrderAtomic(sql,lines,Date.now())
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/publish-verified"){
        const scope=validatePaidEntitlementScope(raw);
        const input=raw as {territory?:unknown;channel?:unknown};
        if(typeof input.territory!=="string" ||
           !/^[A-Z]{2}$/.test(input.territory)||
           !["retail","subscription","library"].includes(String(input.channel)))
          return new Response(null,{status:400,headers:noStore});
        // Product permission must already be published. Entitlement alone
        // NEVER overrides a global paid-contract withdrawal.
        const rights=readCommercialProofs(sql,[scope.productId],
          input.territory,input.channel as CommercialChannel);
        if(rights.length!==1)return new Response(null,{status:409,headers:noStore});
        const expected=captureEntitlementEpoch(sql,scope);
        const ent=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id,product_id,status,entitlement_type,source,starts_at,ends_at,order_item_id FROM entitlements WHERE id=? AND user_id=? AND product_id=?"
        ).bind(scope.entitlementId,scope.userId,scope.productId)
          .first<{id:string;user_id:string;product_id:string;status:string;
            entitlement_type:string;source:string;starts_at:string|null;
            ends_at:string|null;order_item_id:string|null}>();
        if(!ent||ent.status!=="active"||ent.entitlement_type!=="purchase"||
           ent.source!=="commerce"||!ent.order_item_id)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const starts=ent.starts_at===null?null:Date.parse(ent.starts_at);
        const ends=ent.ends_at===null?null:Date.parse(ent.ends_at);
        if((starts!==null&&(!Number.isFinite(starts)||starts>now))||
           (ends!==null&&(!Number.isFinite(ends)||ends<=now)))
          return new Response(null,{status:409,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT co.id order_id,co.territory_code,coi.sales_channel,coi.preorder_id,coi.entitlement_status,co.status order_status,coi.rights_grant_id,coi.rights_snapshot_json FROM commerce_order_items coi JOIN commerce_orders co ON co.id=coi.order_id WHERE coi.id=? AND coi.product_id=? AND co.user_id=?"
        ).bind(ent.order_item_id,scope.productId,scope.userId)
          .first<{order_id:string;territory_code:string;sales_channel:string;preorder_id:string|null;
          entitlement_status:string;order_status:string;
          rights_grant_id:string|null;rights_snapshot_json:string|null}>();
        if(!order||order.entitlement_status!=="granted"||
           order.order_status!=="paid" ||order.preorder_id!==null||
           order.territory_code!==input.territory||
           order.sales_channel!==input.channel||
           order.rights_grant_id!==rights[0].grant_id)
          return new Response(null,{status:409,headers:noStore});
        // This compatibility endpoint may only publish a genuinely
        // single-delivery order. Otherwise a caller could expose the first
        // valid line of a cart whose second line fails atomic certification.
        // Preorders are financial reservations and do not deliver here.
        const inventory=await env.PRIMARY_DB.prepare(
          "SELECT COUNT(*) delivery_count FROM commerce_order_items WHERE order_id=? AND preorder_id IS NULL"
        ).bind(order.order_id).first<{delivery_count:number}>();
        if(!inventory||inventory.delivery_count!==1)
          return new Response(null,{status:409,headers:noStore});
        let purchased:unknown=null;
        try{purchased=JSON.parse(order.rights_snapshot_json||"");}
        catch{return new Response(null,{status:409,headers:noStore});}
        // The paid order's original acquisition identity must match ALL
        // dimensions of the fresh legal proof, not only a contract version.
        // An unrelated grant, edition, contract or market cannot launder
        // a settled buyer entitlement into a new legal scope.
        const acquired=purchased as {
          grantId?:unknown;editionId?:unknown;territory?:unknown;
          salesChannel?:unknown;contractId?:unknown;contractVersionId?:unknown
        }|null;
        if(!acquired ||
           acquired.grantId!==rights[0].grant_id ||
           acquired.editionId!==rights[0].edition_id ||
           acquired.territory!==input.territory ||
           acquired.salesChannel!==input.channel ||
           acquired.contractId!==rights[0].contract_id ||
           acquired.contractVersionId!==rights[0].contract_version_id)
          return new Response(null,{status:409,headers:noStore});
        const hold=await env.PRIMARY_DB.prepare(
          "SELECT 1 ok FROM risk_holds rh JOIN commerce_order_items oi ON oi.order_id=rh.subject_id WHERE rh.domain='buyer' AND rh.subject_type='order' AND rh.status='active' AND rh.hold_scope IN ('checkout','entitlement') AND oi.id=? LIMIT 1"
        ).bind(ent.order_item_id).first<{ok:number}>();
        if(hold)return new Response(null,{status:409,headers:noStore});
        const expiry=Math.min(Date.now()+5*60000,
          ends??Number.POSITIVE_INFINITY,
          Date.parse(rights[0].valid_until));
        if(!Number.isFinite(expiry)||expiry<=Date.now())
          return new Response(null,{status:409,headers:noStore});
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_paid_entitlement_verification");
          return publishFreshEntitlement(sql,{...scope,
            // The owner core must receive the exact acquisition market.
            // Omitting either field rejects all positive buyer publication.
            territory:input.territory,channel:input.channel as CommercialChannel,
            orderId:order.order_id,productEpoch:rights[0].epoch,
            validUntil:new Date(expiry).toISOString()
          },expected);
        });
        return Response.json(receipt,{status:receipt.applied?200:409,headers:noStore});
      }
      if(route==="/commercial/subject/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyCommercialSubject(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/deny-batch"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          denyCommercialProductsBatch(sql,raw)
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>
          denyCommercialProduct(sql,raw)
        );
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      // Mixed free and contract-backed paid shelf. The entire authorization
      // happens under one strongly consistent SQLite owner, never primary D1.
      // Missing/unpublished rows are absent, not inferred from KV/R2.
      if(route==="/storefront/authorize-batch"){
        const input=raw as {ids?:unknown;territory?:unknown;currency?:unknown};
        if(!input||!Array.isArray(input.ids)||input.ids.length>128||
           new Set(input.ids).size!==input.ids.length||
           input.ids.some(id=>typeof id!=="string"||
             !/^prd_[a-zA-Z0-9_-]{3,120}$/.test(id))||
           typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
           typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        const free=input.ids.filter((id):id is string=>
          typeof id==="string"&&id.startsWith("prd_gutenberg_"));
        const paid=input.ids.filter((id):id is string=>
          typeof id==="string"&&!id.startsWith("prd_gutenberg_"));
        const rows=[
          ...readAuthorizedPresentations(sql,free,input.territory,input.currency),
          ...readCommercialStorefront(sql,paid,input.territory,input.currency)
        ];
        const position=new Map(input.ids.map((id,i)=>[id,i]));
        rows.sort((a,b)=>(position.get(a.product_id)??129)-(position.get(b.product_id)??129));
        return Response.json({schema:"cove.storefront-owner.v1",rows:rows.slice(0,25)},
          {headers:noStore});
      }
      if(route==="/storefront/publish-commercial"){
        const input=raw as {productId?:unknown;territory?:unknown;currency?:unknown};
        if(!input||typeof input.productId!=="string"||
           !commercialProductId.test(input.productId)||
           input.productId.startsWith("prd_gutenberg_")||
           typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
           typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        const rights=readCommercialProofs(sql,[input.productId],
          input.territory,"retail");
        if(rights.length!==1)return new Response(null,{status:409,headers:noStore});
        const row=(await authorizeStorefrontPresentationIds(
          env.PRIMARY_DB,[input.productId],input.territory,input.currency
        ))[0];
        if(!row||row.product_id!==input.productId||
           row.edition_id!==rights[0].edition_id||
           !row.offer_json)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const expires=Math.min(now+5*60_000,Date.parse(rights[0].valid_until));
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_offer_verification");
          return publishCommercialStorefront(sql,{
            product_id:row.product_id,edition_id:row.edition_id,
            product_public_id:row.product_public_id,
            edition_public_id:row.edition_public_id,
            territory:input.territory as string,currency:input.currency as string,
            rights_epoch:rights[0].epoch,
            grant_id:rights[0].grant_id,contract_id:rights[0].contract_id!,
            contract_version_id:rights[0].contract_version_id!,
            offer_json:row.offer_json!,
            valid_until:new Date(expires).toISOString()
          });
        });
        return Response.json(receipt,{headers:noStore});
      }
      if(route==="/commercial/authorize-batch"){
        const input=raw as {ids?:unknown;territory?:unknown;channel?:unknown};
        if(!input||!Array.isArray(input.ids)||
           typeof input.territory!=="string"||typeof input.channel!=="string")
          return new Response(null,{status:400,headers:noStore});
        const rows=readCommercialProofs(
          sql,input.ids,input.territory,input.channel as CommercialChannel
        );
        return Response.json({schema:"cove.commercial-legal.v1",rows},
          {headers:noStore});
      }
      if(route==="/commercial/publish-verified"){
        const input=raw as {productId?:unknown;territory?:unknown;channel?:unknown};
        if(!input||typeof input.productId!=="string"||
           !commercialProductId.test(input.productId) ||
           input.productId.startsWith("prd_gutenberg_")||
           typeof input.territory!=="string"||
           !/^[A-Z]{2}$/.test(input.territory)||
           !["retail","subscription","library"].includes(String(input.channel)))
          return new Response(null,{status:400,headers:noStore});
        if(sql.exec("SELECT 1 pending FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
          input.productId).toArray().length)
          return new Response(null,{status:409,headers:noStore});
        const startEpoch=captureCommercialEpoch(sql,input);
        const product=await env.PRIMARY_DB.prepare(
          "SELECT id,source_name,edition_id FROM products WHERE id=?"
        ).bind(input.productId).first<{
          id:string;source_name:string;edition_id:string
        }>();
        if(!product || ["gutenberg","upload"].includes(product.source_name))
          return new Response(null,{status:409,headers:noStore});
        // The canonical evaluator checks territorial grant priority, contract
        // version scope, license language, DRM, channel and current status.
        // Persist=false: owner publication does NOT add primary D1 writes.
        const decision=await resolveProductRights(
          env.PRIMARY_DB,input.productId,input.territory,{
            salesChannel:input.channel as CommercialChannel,persist:false
          }
        );
        if(!decision.allowed || !decision.grantId ||
           decision.editionId!==product.edition_id ||
           decision.productId!==product.id)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const upperBound=now+30*60*1000;
        const ends=[decision.endsAt,
          (decision.contractPolicy as {effectiveTo?:unknown}|null)?.effectiveTo]
          .filter((v):v is string=>typeof v==="string"&&v.length>0)
          .map(v=>Date.parse(v));
        if(ends.some(t=>!Number.isFinite(t) || t<=now))
          return new Response(null,{status:409,headers:noStore});
        const expiresAt=Math.min(upperBound,...ends);
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_commercial_verification");
          return publishFreshCommercialProof(sql,{
            productId:product.id,editionId:product.edition_id,
            territory:input.territory as string,channel:input.channel as CommercialChannel,
            grantId:decision.grantId!,contractId:decision.contractId,
            contractVersionId:decision.contractVersionId,
            validUntil:new Date(expiresAt).toISOString(),
          },startEpoch);
        });
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/verify") {
        const input=raw as {sourceId?:unknown;territory?:unknown};
        if(!input||typeof input.sourceId!=="string"||typeof input.territory!=="string")
          return new Response(null,{status:400,headers:noStore});
        return Response.json(readAuthority(sql,input.sourceId,input.territory),
          {headers:noStore});
      }
      if(route==="/authorize-batch") {
        const input=raw as {ids?:unknown;territory?:unknown;currency?:unknown};
        if(!input||!Array.isArray(input.ids)||
           typeof input.territory!=="string"||typeof input.currency!=="string")
          return new Response(null,{status:400,headers:noStore});
        const rows=readAuthorizedPresentations(sql,input.ids,input.territory,input.currency);
        return Response.json({schema:"cove.legal-authorized.v1",rows},
          {headers:noStore});
      }
      if(route==="/deny-next-batch") {
        // Transaction boundary is mandatory even when an unexpected receipt
        // throws mid-batch: all owner fences persist or none persist.
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>
          persistSourceWithdrawalsBatch(sql,raw)
        );
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/deny-next") {
        const verdict=persistSourceWithdrawal(sql,raw);
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      const command=validateAuthorityCommand(raw);
      if(route==="/deny") {
        if(command.action!=="deny") return new Response(null,{status:400,headers:noStore});
        const verdict=applyAuthorityCommand(sql,command);
        // A stale/failed deny is NOT acknowledged as successful.
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(command.action!=="allow"||command.territory==="*")
        return new Response(null,{status:400,headers:noStore});
      const input=raw as {currency?:unknown};
      if(typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
        return new Response(null,{status:400,headers:noStore});
      // Positive transitions alone contact canonical primary D1. This
      // verifies a current retail grant, exact source/evidence/territory and
      // active market offer; the hot /verify path never consults D1.
      // It is NOT sufficient to enable production until ALL canonical legal
      // mutation writers have been enclosed in deny-first owner fencing.
      const proofStartRevision=capturePositiveVerificationFence(sql,command);
      const authorized=await authorizeStorefrontPresentationIds(
        env.PRIMARY_DB,["prd_gutenberg_"+command.sourceId],
        command.territory,input.currency
      );
      if(authorized.length!==1 ||
          authorized[0].product_id!=="prd_gutenberg_"+command.sourceId ||
          !authorized[0].offer_json)
        return new Response(null,{status:409,headers:noStore});
      const storage=this.ctx.storage as typeof this.ctx.storage&{
        transactionSync<T>(fn:()=>T):T;
      };
      const verdict=storage.transactionSync(()=>{
        if(marketIsWithdrawn(sql,command.territory))
          throw Error("market_withdrawn_during_source_verification");
        return commitFreshPositiveVerification(
        sql,command,proofStartRevision,input.currency as string,{
          productId:authorized[0].product_id,
          editionId:authorized[0].edition_id,
          productPublicId:authorized[0].product_public_id || null,
          editionPublicId:authorized[0].edition_public_id || null,
          offerJson:authorized[0].offer_json!,
        });
      });
      if(!verdict.applied)
        return Response.json(verdict,{status:409,headers:noStore});
      return Response.json(verdict,{status:200,headers:noStore});
    } catch(error) {
      console.error("cove_legal_authority_closed",error instanceof Error?error.name:"unknown");
      return new Response(null,{status:503,headers:route==="/commercial/order/settle"?
        {...noStore,"x-cove-owner-settlement-failure":ownerSettlementDiagnostic(error)}:noStore});
    }
  }
}
// Service-binding-only entrypoint for the separately authenticated QA caller.
// workers_dev=false, routes=[], no preview URLs; even this private entrypoint
// is disabled unless the dedicated QA primary ID and secret match exactly.
// The Durable Object remains the single legal serialization point.
export default {
  async fetch(request:Request,env:LegalAuthorityEnv):Promise<Response> {
    // Private service-binding proof only. The production owner stays
    // disabled for every existing rights, publication and payment route.
    if(new URL(request.url).pathname===DISABLED_OWNER_ATTEST_ROUTE){
      if(!isDisabledProductionOwner(env)||!env.LEGAL_AUTHORITY?.getByName)
        return new Response(null,{status:503,headers:{"cache-control":"no-store"}});
      if(request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
        return new Response(null,{status:401,headers:{"cache-control":"no-store"}});
      return env.LEGAL_AUTHORITY.getByName(PRODUCTION_OWNER_OBJECT).fetch(request);
    }
    if(!qaOwnerLeaseLive(env) || !env.LEGAL_AUTHORITY?.getByName)
      return new Response(null,{status:503,headers:{"cache-control":"no-store"}});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
      return new Response(null,{status:401,headers:{"cache-control":"no-store"}});
    return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1").fetch(request);
  }
};
