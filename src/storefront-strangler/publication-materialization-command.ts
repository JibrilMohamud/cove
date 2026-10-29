/* eslint-disable prettier/prettier -- Complete typed publication workflow under a durable owner hold. */
import {z} from "zod/v3";
import {materializePublishingSubmissionOwned,type PublishingEnv} from "../features/fore/publishing.server";
import type {CatalogDB} from "../features/fore/catalog-model.server";
import type {AuthoritySql} from "./legal-authority-core";
import {commercialProductId,denyCommercialSubject} from "./commercial-legal-core";
import {beginPublicationCommand,commitPublicationCommand,markPublicationPublished,
  markPublicationPrepared,readPublicationCommand,recordPublicationRecovery} from "./publication-command-core";

const id=z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/);
const commandSchema=z.object({submissionId:id,
  reviewerUserId:z.string().regex(/^(?:[a-zA-Z0-9_-]{3,160}|system:automated-review)$/),
  operationId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/),
  territory:z.string().regex(/^[A-Z]{2}$/),currency:z.string().regex(/^[A-Z]{3}$/)}).strict();
type Submission={account_id:string;edition_id:string;revision:number;status:string;snapshot_json:string;snapshot_sha256:string};
type Draft={account_id:string;title_id:string;revision:number;status:string;catalog_work_id:string|null;catalog_edition_id:string|null;catalog_product_id:string|null};
type Account={status:string;identity_status:string;tax_status:string;payout_status:string;rights_party_id:string|null};
type Lifecycle={id:string;state:string;current_publication_version_id:string|null};
type FrozenAsset={id:string;kind:string;current_version_id:string;object_key:string;sha256:string;mime_type:string;size_bytes:number};
type FrozenSnapshot={account:{id:string};title:{id:string;catalog_work_id?:string|null};
  edition:{id:string;title_id:string;catalog_edition_id?:string|null;catalog_product_id?:string|null;
    contract_id:string;contract_version_id:string;release_date?:string|null};
  tax:{id:string};payout:{id:string};assets:FrozenAsset[];contributors:unknown[];
  aiDisclosure:{id:string;policy_version:string}};
type AssetEvidence=FrozenAsset&{edition_id:string;quarantine_status:string;validation_summary:string};
type Completion={id:string;publication_version_id:string;version_number:number;release_state:string;serving_state:string;
  owner_delivery_policy:string;manifest_json:string;current_publication_version_id:string|null;pending_publication_version_id:string|null};
type Reservation={submission_id:string;operation_id:string;product_id:string;edition_id:string;
  work_id:string;command_sha256:string};
type Context={primary:CatalogDB;bucket?:PublishingEnv["BUCKET"];sql:AuthoritySql;
  autoApprove?:string;executing:Set<string>;transactionSync<T>(fn:()=>T):T;
  publish(path:string,body:Record<string,unknown>):Promise<Response>};
const digest=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,"0")).join("");
function requireState(condition:unknown,reason:string):asserts condition {
  if(!condition)throw Error(reason);
}
export function createPublicationMaterializationSchema(sql:AuthoritySql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_publication_materializations(
    submission_id TEXT PRIMARY KEY NOT NULL,operation_id TEXT UNIQUE NOT NULL,
    product_id TEXT NOT NULL,edition_id TEXT NOT NULL,work_id TEXT NOT NULL,
    command_sha256 TEXT NOT NULL)`);
}

/** No SQL, manifest, catalog identity, terms or byte location comes from the
 * command caller. All are independently loaded from the approved immutable
 * submission. A restarted partial executor never repeats primary writes. */
export async function executePublicationMaterialization(ctx:Context,raw:unknown):Promise<Response> {
  const parsed=commandSchema.safeParse(raw),headers={"cache-control":"no-store"};
  if(!parsed.success)return new Response(null,{status:400,headers});
  const input=parsed.data,db=ctx.primary,sql=ctx.sql;
  // Serialize by submission before ANY awaited read; product lock below also
  // excludes a different revision/activation of the same canonical product.
  const submissionLock="submission:"+input.submissionId;
  if(ctx.executing.has(submissionLock))return new Response(null,{status:409,headers});
  ctx.executing.add(submissionLock);
  let productLock:string|null=null;
  try {
    const submission=await db.prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?")
      .bind(input.submissionId).first<Submission>();
    requireState(submission&&["approved","published"].includes(submission.status),"materialization_not_approved");
    requireState(/^[a-f0-9]{64}$/.test(submission.snapshot_sha256)&&
      await digest(submission.snapshot_json)===submission.snapshot_sha256,"materialization_snapshot_digest");
    const snapshot=JSON.parse(submission.snapshot_json) as FrozenSnapshot;
    requireState(snapshot?.account?.id===submission.account_id&&snapshot?.edition?.id===submission.edition_id&&
      snapshot?.title?.id===snapshot?.edition?.title_id&&Array.isArray(snapshot.assets)&&
      Array.isArray(snapshot.contributors)&&snapshot.aiDisclosure?.id&&snapshot.aiDisclosure?.policy_version,
      "materialization_snapshot_identity");
    const draft=await db.prepare("SELECT e.*,t.account_id,t.catalog_work_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?")
      .bind(submission.edition_id).first<Draft>();
    const account=await db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(submission.account_id).first<Account>();
    const lifecycle=await db.prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?")
      .bind(submission.edition_id).first<Lifecycle>();
    requireState(draft&&draft.account_id===submission.account_id&&draft.title_id===snapshot.title.id&&
      Number(draft.revision)===Number(submission.revision)&&["approved","published"].includes(draft.status)&&
      !["suppressed","takedown","retired"].includes(lifecycle?.state||""),"materialization_draft_scope");
    requireState(account?.status==="active"&&[account.identity_status,account.tax_status,account.payout_status]
      .every(s=>s==="verified"),"materialization_publisher_compliance");
    const now=new Date().toISOString();
    const tax=await db.prepare("SELECT * FROM publishing_tax_profiles WHERE id=? AND account_id=?")
      .bind(snapshot.tax?.id||"",submission.account_id).first<{status:string;valid_from:string|null;expires_at:string|null}>();
    const payout=await db.prepare("SELECT * FROM publishing_payout_accounts WHERE id=? AND account_id=?")
      .bind(snapshot.payout?.id||"",submission.account_id).first<{status:string}>();
    requireState(tax?.status==="verified"&&(!tax.valid_from||tax.valid_from<=now)&&
      (!tax.expires_at||tax.expires_at>now)&&payout?.status==="verified","materialization_frozen_compliance");
    const riskHold=await db.prepare("SELECT 1 held FROM risk_holds WHERE subject_type='publishing_account' AND subject_id=? AND status='active' AND hold_scope IN ('publishing','account') AND (expires_at IS NULL OR expires_at>?) LIMIT 1")
      .bind(submission.account_id,now).first<{held:number}>();
    requireState(!riskHold,"materialization_publisher_held");
    if(input.reviewerUserId==="system:automated-review") {
      requireState(String(ctx.autoApprove).toLowerCase()==="true","materialization_automation_disabled");
      const review=await db.prepare("SELECT outcome FROM publishing_automated_reviews WHERE submission_id=? AND policy_version='fore-trust-v2'")
        .bind(input.submissionId).first<{outcome:string}>();
      const risk=await db.prepare("SELECT action,expires_at FROM risk_assessments WHERE domain='publisher' AND subject_type='publishing_account' AND subject_id=? ORDER BY created_at DESC LIMIT 1")
        .bind(submission.account_id).first<{action:string;expires_at:string|null}>();
      const approval=await db.prepare("SELECT 1 approved FROM publishing_lifecycle_events WHERE lifecycle_id=? AND trigger_type='automation' AND reason_code='automated_low_risk_approval' AND json_extract(metadata_json,'$.submissionId')=? LIMIT 1")
        .bind(lifecycle?.id||"",input.submissionId).first<{approved:number}>();
      requireState(review?.outcome==="pass"&&risk&&!["hold","block"].includes(risk.action)&&
        (!risk.expires_at||risk.expires_at>now)&&approval,"materialization_automation_evidence");
    } else {
      const permitted=await db.prepare("SELECT 1 ok FROM staff_principals p JOIN staff_principal_roles r ON r.user_id=p.user_id JOIN staff_role_permissions permission ON permission.role_id=r.role_id WHERE p.user_id=? AND p.status='active' AND permission.permission IN ('publishing.review','staff.manage') LIMIT 1")
        .bind(input.reviewerUserId).first<{ok:number}>();
      const approval=await db.prepare("SELECT reviewer_user_id,decision FROM publishing_submission_reviews WHERE submission_id=? ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(input.submissionId).first<{decision:string;reviewer_user_id:string}>();
      requireState(permitted&&approval?.decision==="approve"&&approval.reviewer_user_id===input.reviewerUserId,
        "materialization_reviewer_not_approved");
    }
    // Positive paid authority needs an independently approved, exact contract
    // VERSION. Legacy unversioned self-publishing terms are not upgraded by
    // guessing a license or relaxing the owner's proof requirement.
    requireState(id.safeParse(snapshot.edition.contract_id).success&&
      id.safeParse(snapshot.edition.contract_version_id).success,"materialization_versioned_contract_required");
    const contract=await db.prepare(`SELECT rc.rightsholder_party_id FROM publisher_contract_assignments a
      JOIN rights_contracts rc ON rc.id=a.contract_id AND rc.status='active'
      JOIN rights_contract_versions v ON v.contract_id=rc.id AND v.id=? AND v.status='active'
      WHERE a.account_id=? AND a.contract_id=? AND a.status='active'
      AND (a.starts_at IS NULL OR a.starts_at<=?) AND (a.ends_at IS NULL OR a.ends_at>?)
      AND v.effective_from<=? AND (v.effective_to IS NULL OR v.effective_to>?)
      AND (rc.effective_from IS NULL OR rc.effective_from<=?) AND (rc.effective_to IS NULL OR rc.effective_to>?)`)
      .bind(snapshot.edition.contract_version_id,submission.account_id,snapshot.edition.contract_id,now,now,now,now,now,now).first<{rightsholder_party_id:string|null}>();
    requireState(contract&&contract.rightsholder_party_id===account.rights_party_id,
      "materialization_contract_assignment_changed");
    const commandSha256=await digest(JSON.stringify({submissionId:input.submissionId,
      snapshotSha256:submission.snapshot_sha256,reviewerUserId:input.reviewerUserId,
      territory:input.territory,currency:input.currency}));
    const reserved=sql.exec<Reservation>("SELECT * FROM cove_publication_materializations WHERE submission_id=?",
      input.submissionId).toArray()[0];
    requireState(!reserved||reserved.command_sha256===commandSha256,"materialization_command_collision");
    requireState(submission.status!=="published"||reserved,"materialization_historical_publication_requires_review");
    const workId=reserved?.work_id||snapshot.title.catalog_work_id||"wrk_"+crypto.randomUUID();
    const editionId=reserved?.edition_id||snapshot.edition.catalog_edition_id||"ed_"+crypto.randomUUID();
    const productId=reserved?.product_id||snapshot.edition.catalog_product_id||"prd_"+crypto.randomUUID();
    requireState(id.safeParse(workId).success&&id.safeParse(editionId).success&&
      commercialProductId.test(productId)&&!productId.startsWith("prd_gutenberg_"),"materialization_catalog_identity");
    if(ctx.executing.has(productId))return new Response(null,{status:409,headers});
    productLock=productId;ctx.executing.add(productId);
    const identity={operationId:reserved?.operation_id||input.operationId,productId,commandSha256};
    const resuming=!!readPublicationCommand(sql,identity.operationId);
    // A snapshot cannot remap an existing product, or update a different
    // publisher's catalog through caller-selected frozen IDs.
    requireState((!draft.catalog_product_id||draft.catalog_product_id===productId)&&
      (!draft.catalog_edition_id||draft.catalog_edition_id===editionId)&&
      (!draft.catalog_work_id||draft.catalog_work_id===workId),"materialization_catalog_mapping_changed");
    if(snapshot.edition.catalog_product_id) {
      const mapped=await db.prepare("SELECT p.edition_id,e.work_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=? AND p.source_name='fore_publishing' AND p.source_external_id=?")
        .bind(productId,submission.edition_id).first<{edition_id:string;work_id:string}>();
      requireState(mapped?.edition_id===editionId&&mapped.work_id===workId,"materialization_existing_catalog_scope");
    }
    const retiring:Array<{subjectKind:"grant"|"contract";subjectId:string}>=[];
    const releaseAt=snapshot.edition.release_date?Date.parse(snapshot.edition.release_date):0;
    const stageOnly=!!lifecycle?.current_publication_version_id&&Number.isFinite(releaseAt)&&releaseAt>Date.now();
    if(!resuming&&lifecycle?.current_publication_version_id&&!stageOnly) {
      const previous=await db.prepare("SELECT manifest_json FROM publishing_publication_versions WHERE id=? AND lifecycle_id=?")
        .bind(lifecycle.current_publication_version_id,lifecycle.id).first<{manifest_json:string}>();
      requireState(previous,"materialization_prior_manifest_missing");
      const prior=JSON.parse(previous.manifest_json);
      let grants=Array.isArray(prior.rightsGrantIds)?prior.rightsGrantIds:[];
      if(!grants.length&&prior.rightsContractManagedByPublication&&prior.rightsContractId)
        grants=(await db.prepare("SELECT id FROM rights_grants WHERE contract_id=?").bind(prior.rightsContractId).all<{id:string}>()).results.map(g=>g.id);
      for(const grant of new Set(grants)) {
        requireState(id.safeParse(grant).success,"materialization_prior_grant_identity");
        retiring.push({subjectKind:"grant",subjectId:String(grant)});
      }
      if(prior.rightsContractManagedByPublication&&prior.rightsContractId&&
         prior.rightsContractId!==snapshot.edition.contract_id) {
        requireState(id.safeParse(prior.rightsContractId).success,"materialization_prior_contract_identity");
        retiring.push({subjectKind:"contract",subjectId:prior.rightsContractId});
      }
    }
    // Verify source bytes before the first catalog write. The actual copier
    // rechecks the digest too, so a changed object cannot exploit a read race.
    requireState(ctx.bucket&&snapshot.assets.length>0&&snapshot.assets.length<=50,"materialization_private_bucket_required");
    const seenAssets=new Set<string>();
    for(const asset of snapshot.assets) {
      requireState(asset?.current_version_id&&!seenAssets.has(asset.kind),"materialization_asset_manifest");
      seenAssets.add(asset.kind);
      const version=await db.prepare("SELECT v.*,a.edition_id,a.kind FROM publishing_asset_versions v JOIN publishing_assets a ON a.id=v.asset_id WHERE v.id=? AND v.asset_id=?")
        .bind(asset.current_version_id,asset.id).first<AssetEvidence>();
      requireState(version?.edition_id===submission.edition_id&&version.kind===asset.kind&&
        version.object_key===asset.object_key&&version.sha256===asset.sha256&&version.mime_type===asset.mime_type&&
        Number(version.size_bytes)===Number(asset.size_bytes)&&["clean","promoted"].includes(version.quarantine_status)&&
        ["passed","warning"].includes(version.validation_summary),"materialization_asset_evidence_changed");
      const object=await ctx.bucket.get(asset.object_key);
      requireState(object,"materialization_asset_bytes_missing");
      const bytes=new Uint8Array(await object.arrayBuffer());
      const sha=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
      requireState(bytes.length===Number(asset.size_bytes)&&sha===asset.sha256,"materialization_asset_bytes_changed");
    }
    ctx.transactionSync(()=>{
      beginPublicationCommand(sql,identity);
      if(!reserved)sql.exec("INSERT INTO cove_publication_materializations(submission_id,operation_id,product_id,edition_id,work_id,command_sha256) VALUES(?,?,?,?,?,?)",
        input.submissionId,identity.operationId,productId,editionId,workId,commandSha256);
      if(!resuming)recordPublicationRecovery(sql,identity,"/publication/materialize-submission",{
        submissionId:input.submissionId,reviewerUserId:input.reviewerUserId,territory:input.territory,currency:input.currency});
      retiring.forEach((subject,index)=>denyCommercialSubject(sql,{...subject,
        operationId:"publication:"+identity.operationId+":retire:"+index}));
    });
    const checkedBucket:NonNullable<PublishingEnv["BUCKET"]>={
      get:async(key,options)=>{
        const object=await ctx.bucket!.get(key,options);
        requireState(object,"materialization_asset_bytes_missing");
        const asset=snapshot.assets.find(a=>a.object_key===key);
        requireState(asset,"materialization_unlisted_asset_read");
        const bytes=new Uint8Array(await object.arrayBuffer());
        const sha=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
        requireState(bytes.length===Number(asset.size_bytes)&&sha===asset.sha256,"materialization_asset_bytes_changed");
        return {arrayBuffer:async()=>bytes.buffer};
      },
      put:(key,value,options)=>ctx.bucket!.put(key,value,options),
      delete:key=>ctx.bucket!.delete(key)
    };
    if(!resuming)await materializePublishingSubmissionOwned({DB:db,BUCKET:checkedBucket},
      input.submissionId,input.reviewerUserId,{workId,editionId,productId,commandSha256,
        preparePresentation:async()=>{
          // This projection contains presentation data, but retail visibility
          // is protected. Derive it from the exact canonical product while
          // the owner still holds the whole materialization denied.
          await db.prepare(`INSERT INTO catalog_search_documents(product_id,external_book_id,title,subtitle,
            contributors_text,categories_text,keywords_text,languages_text,description,publisher_text,
            currency,price_minor,format,availability,suppressed,first_ingested_at,updated_at)
            SELECT p.id,p.id,e.title,e.subtitle,
              COALESCE((SELECT group_concat(c.name,' ') FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id=e.id),''),
              COALESCE((SELECT group_concat(c.name,' ') FROM edition_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.edition_id=e.id),''),
              COALESCE((SELECT group_concat(k.value,' ') FROM edition_keywords ek JOIN keywords k ON k.id=ek.keyword_id WHERE ek.edition_id=e.id),''),
              e.language,e.description,COALESCE(pub.name,''),COALESCE(o.currency,?),COALESCE(o.amount_minor,0),p.format,
              CASE WHEN p.storefront_status='active' AND e.release_status IN ('available','preorder') THEN 'available' ELSE 'unavailable' END,
              CASE WHEN p.storefront_status='active' THEN 0 ELSE 1 END,p.created_at,p.updated_at
            FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id
            LEFT JOIN offers o ON o.id=(SELECT offer.id FROM offers offer WHERE offer.product_id=p.id AND offer.active=1 ORDER BY offer.created_at DESC,offer.id DESC LIMIT 1)
            WHERE p.id=?
            ON CONFLICT(product_id) DO UPDATE SET title=excluded.title,subtitle=excluded.subtitle,
              contributors_text=excluded.contributors_text,categories_text=excluded.categories_text,
              keywords_text=excluded.keywords_text,languages_text=excluded.languages_text,description=excluded.description,
              publisher_text=excluded.publisher_text,currency=excluded.currency,price_minor=excluded.price_minor,
              format=excluded.format,availability=excluded.availability,suppressed=excluded.suppressed,updated_at=excluded.updated_at`)
            .bind(input.currency,productId).run();
        }});
    // The final immutable audit event is emitted only AFTER every catalog,
    // rights, offer, finance, version and lifecycle write has completed. A
    // publication-row-only shortcut is never sufficient recovery evidence.
    const complete=await db.prepare(`SELECT p.*,pv.id publication_version_id,pv.version_number,pv.release_state,
      pv.owner_delivery_policy,pv.manifest_json,l.current_publication_version_id,l.pending_publication_version_id,l.state,
      (SELECT current.release_state FROM publishing_publication_versions current WHERE current.id=l.current_publication_version_id) serving_state
      FROM publishing_publications p JOIN publishing_publication_versions pv ON pv.publication_id=p.id AND pv.submission_id=p.submission_id
      JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id
      JOIN publishing_audit_events a ON a.entity_type='publishing_submission' AND a.entity_id=p.submission_id AND a.action='published'
      AND json_extract(a.metadata_json,'$.ownerCommandSha256')=?
      AND json_extract(a.metadata_json,'$.publicationVersionId')=pv.id
      WHERE p.submission_id=? AND p.product_id=? AND p.edition_id=? AND p.work_id=? AND pv.snapshot_sha256=? LIMIT 1`)
      .bind(commandSha256,input.submissionId,productId,editionId,workId,submission.snapshot_sha256).first<Completion>();
    requireState(complete&&["live","updated","preorder","scheduled"].includes(complete.release_state)&&
      (complete.current_publication_version_id===complete.publication_version_id||
       complete.release_state==="scheduled"&&complete.pending_publication_version_id===complete.publication_version_id),
      "materialization_incomplete_primary_requires_repair");
    const manifest=JSON.parse(complete.manifest_json);
    requireState(manifest.snapshotSha256===submission.snapshot_sha256&&manifest.submissionId===input.submissionId&&
      manifest.productId===productId&&manifest.catalogEditionId===editionId&&manifest.workId===workId,
      "materialization_completion_identity");
    // Re-read mutable compliance after the entire remote workflow, including
    // every async asset copy, before releasing any owner hold.
    const current=await db.prepare("SELECT status,identity_status,tax_status,payout_status FROM publishing_accounts WHERE id=?")
      .bind(submission.account_id).first<Account>();
    requireState(current?.status==="active"&&[current.identity_status,current.tax_status,current.payout_status]
      .every(s=>s==="verified"),"materialization_compliance_changed_during_execution");
    const completedAt=new Date().toISOString();
    const currentScope=await db.prepare(`SELECT 1 ok FROM publishing_tax_profiles t
      JOIN publishing_payout_accounts p ON p.account_id=t.account_id
      JOIN publishing_edition_drafts e ON e.id=? AND e.revision=? AND e.status='published'
      JOIN publishing_titles title ON title.id=e.title_id AND title.account_id=t.account_id
      JOIN publishing_release_lifecycles l ON l.publishing_edition_id=e.id
      WHERE t.id=? AND p.id=? AND t.account_id=? AND t.status='verified' AND p.status='verified'
      AND (t.valid_from IS NULL OR t.valid_from<=?) AND (t.expires_at IS NULL OR t.expires_at>?)
      AND l.state NOT IN ('suppressed','takedown','retired')
      AND NOT EXISTS (SELECT 1 FROM risk_holds h WHERE h.subject_type='publishing_account'
        AND h.subject_id=t.account_id AND h.status='active' AND h.hold_scope IN ('publishing','account')
        AND (h.expires_at IS NULL OR h.expires_at>?))`)
      .bind(submission.edition_id,submission.revision,snapshot.tax.id,snapshot.payout.id,
        submission.account_id,completedAt,completedAt,completedAt).first<{ok:number}>();
    requireState(currentScope,"materialization_compliance_changed_during_execution");
    if(input.reviewerUserId!=="system:automated-review") {
      const stillPermitted=await db.prepare("SELECT 1 ok FROM staff_principals p JOIN staff_principal_roles r ON r.user_id=p.user_id JOIN staff_role_permissions permission ON permission.role_id=r.role_id WHERE p.user_id=? AND p.status='active' AND permission.permission IN ('publishing.review','staff.manage') LIMIT 1")
        .bind(input.reviewerUserId).first<{ok:number}>();
      requireState(stillPermitted,"materialization_reviewer_permission_changed");
    } else {
      const currentRisk=await db.prepare("SELECT action,expires_at FROM risk_assessments WHERE domain='publisher' AND subject_type='publishing_account' AND subject_id=? ORDER BY created_at DESC LIMIT 1")
        .bind(submission.account_id).first<{action:string;expires_at:string|null}>();
      requireState(currentRisk&&!["hold","block"].includes(currentRisk.action)&&
        (!currentRisk.expires_at||currentRisk.expires_at>completedAt),"materialization_automation_risk_changed");
    }
    const preparedOnly=complete.release_state==="scheduled"&&
      complete.current_publication_version_id===complete.publication_version_id;
    const result={publicationId:complete.id,publicationVersionId:complete.publication_version_id,
      productId,editionId,workId,versionNumber:Number(complete.version_number),releaseState:complete.release_state,
      ownerUpdatePolicy:complete.owner_delivery_policy,preparedOnly,
      state:preparedOnly?"scheduled":complete.serving_state};
    ctx.transactionSync(()=>commitPublicationCommand(sql,identity,result));
    if(preparedOnly)ctx.transactionSync(()=>markPublicationPrepared(sql,identity));
    else {
      let publishedEpoch:number|null=null;
      for(const path of ["/commercial/publish-verified","/storefront/publish-commercial"]) {
        const response=await ctx.publish(path,{productId,territory:input.territory,currency:input.currency,channel:"retail"});
        requireState(response.status===200,"materialization_positive_verification_failed");
        const proof=await response.json() as {applied?:unknown;epoch?:unknown};
        requireState(proof.applied===true&&Number.isSafeInteger(proof.epoch)&&Number(proof.epoch)>0&&
          (publishedEpoch===null||proof.epoch===publishedEpoch),"materialization_positive_epoch_mismatch");
        publishedEpoch=Number(proof.epoch);
      }
      ctx.transactionSync(()=>markPublicationPublished(sql,identity,publishedEpoch!));
    }
    return Response.json({schema:"cove.publication-materialization.v1",ownerFirst:true,
      operationId:input.operationId,submissionId:input.submissionId,...result,accessPublished:!preparedOnly},{headers});
  } finally {
    ctx.executing.delete(submissionLock);
    if(productLock)ctx.executing.delete(productLock);
  }
}
