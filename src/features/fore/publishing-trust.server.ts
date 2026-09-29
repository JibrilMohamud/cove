import { z } from "zod";
import { ApiError } from "./service";
import { createModerationCase, type StaffContext } from "./moderation.server";
import type { PublishingDB, PublishingEnv } from "./publishing.server";

const now=()=>new Date().toISOString();
const id=(p:string)=>`${p}_${crypto.randomUUID()}`;
const clean=(v:unknown,max=4000)=>String(v??"").trim().slice(0,max);
const origin=z.enum(["human","ai_assisted","ai_generated","mixed"]);
const optionalOrigin=z.enum(["human","ai_assisted","ai_generated","mixed","not_applicable"]);
export const FORE_RIGHTS_POLICY_VERSION="fore-rights-v1";
export const FORE_AI_POLICY_VERSION="fore-ai-content-v1";
const addressSchema=z.object({line1:z.string().trim().min(2).max(240),line2:z.string().trim().max(240).default(""),city:z.string().trim().min(1).max(160),region:z.string().trim().max(160).default(""),postalCode:z.string().trim().min(2).max(32),countryCode:z.string().regex(/^[A-Za-z]{2}$/).transform(v=>v.toUpperCase())});

async function member(db:PublishingDB,userId:string,accountId:string,min:"analyst"|"editor"|"admin"|"owner"="analyst"){
  const rank:any={analyst:1,editor:2,finance:2,admin:3,owner:4};
  const m=await db.prepare("SELECT role FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'").bind(accountId,userId).first<any>();
  if(!m||rank[String(m.role)]<rank[min])throw new ApiError(403,"You do not have permission to perform this publishing action.");
  return m;
}
async function edition(db:PublishingDB,editionId:string){
  const r=await db.prepare(`SELECT e.*,t.account_id,t.title FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`).bind(editionId).first<any>();
  if(!r)throw new ApiError(404,"Publishing edition not found.");return r;
}
async function audit(db:PublishingDB,accountId:string|null,userId:string|null,type:string,entityId:string,action:string,meta:unknown={}){
  await db.prepare("INSERT INTO publishing_audit_events(id,account_id,actor_user_id,entity_type,entity_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(id("pubaudit"),accountId,userId,type,entityId,action,JSON.stringify(meta),now()).run();
}

async function requireActivePolicy(db:PublishingDB,policyKey:string,version:string){
  const row=await db.prepare("SELECT policy_key,version,title,status,summary,rules_json,effective_at,published_at FROM publishing_policy_versions WHERE policy_key=? AND version=? AND status='active'").bind(policyKey,version).first<any>();
  if(!row)throw new ApiError(503,`Cove policy ${policyKey} ${version} is not active; publishing signatures are temporarily unavailable until policy configuration is reconciled.`);
  return row;
}

export async function publicPublishingPolicies(db:PublishingDB){
  const rows=(await db.prepare("SELECT policy_key,version,title,summary,rules_json,effective_at,published_at FROM publishing_policy_versions WHERE status='active' ORDER BY policy_key").all<any>()).results;
  return {policies:rows.map((r:any)=>({...r,rules:(()=>{try{return JSON.parse(String(r.rules_json||'{}'))}catch{return {}}})()}))};
}

export async function signPublishingRightsDeclaration(db:PublishingDB,userId:string,raw:unknown){
  const x=z.object({editionId:z.string().min(1),rightsBasis:z.enum(["owned","licensed","public_domain"]),authorityType:z.enum(["copyright_owner","exclusive_licensee","nonexclusive_licensee","authorized_agent","public_domain_republisher"]),rightsOwnerName:z.string().trim().min(2).max(240),sourceWorkTitle:z.string().max(500).default(""),sourceWorkAuthor:z.string().max(500).default(""),sourceWorkIdentifier:z.string().max(500).default(""),territoryScope:z.record(z.string(),z.unknown()).default({mode:"worldwide",exclude:[]}),rightsStartAt:z.string().datetime().nullable().optional(),rightsEndAt:z.string().datetime().nullable().optional(),rightsSummary:z.string().max(5000).default(""),authorityAttestation:z.literal(true),noInfringementAttestation:z.literal(true),evidenceCompleteAttestation:z.literal(true),signatureName:z.string().trim().min(2).max(240)}).parse(raw);
  const e=await edition(db,x.editionId);await member(db,userId,String(e.account_id),"editor");
  await requireActivePolicy(db,"publisher_rights",FORE_RIGHTS_POLICY_VERSION);
  if(!["draft","changes_requested"].includes(String(e.status)))throw new ApiError(409,"Open a new revision before changing the signed rights declaration.");
  if(x.rightsBasis!==String(e.rights_basis))throw new ApiError(400,"The declaration rights basis must match the edition rights basis.");
  if(x.rightsStartAt&&x.rightsEndAt&&x.rightsEndAt<=x.rightsStartAt)throw new ApiError(400,"Rights end date must follow the start date.");
  const prior=await db.prepare("SELECT id FROM publishing_rights_declarations WHERE edition_id=? AND revision=?").bind(e.id,e.revision).first<any>();
  if(prior)throw new ApiError(409,"This revision already has a signed immutable rights declaration. Open a new revision to replace it.");
  const declarationId=id("rightsdecl"),at=now();
  await db.prepare(`INSERT INTO publishing_rights_declarations(id,edition_id,account_id,revision,policy_version,rights_basis,authority_type,rights_owner_name,source_work_title,source_work_author,source_work_identifier,territory_scope_json,rights_start_at,rights_end_at,rights_summary,authority_attestation,no_infringement_attestation,evidence_complete_attestation,signature_name,signed_by_user_id,signed_at,status,created_at) VALUES(?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,1,1,1,?,?,?,'signed',?)`).bind(declarationId,e.id,e.account_id,e.revision,FORE_RIGHTS_POLICY_VERSION,x.rightsBasis,x.authorityType,x.rightsOwnerName,x.sourceWorkTitle,x.sourceWorkAuthor,x.sourceWorkIdentifier,JSON.stringify(x.territoryScope),x.rightsStartAt||null,x.rightsEndAt||null,x.rightsSummary,x.signatureName,userId,at,at).run();
  await audit(db,String(e.account_id),userId,"rights_declaration",declarationId,"signed",{editionId:e.id,revision:e.revision,rightsBasis:x.rightsBasis,policyVersion:FORE_RIGHTS_POLICY_VERSION});
  return{id:declarationId,editionId:e.id,revision:Number(e.revision),policyVersion:FORE_RIGHTS_POLICY_VERSION};
}

export async function signPublishingAiDisclosure(db:PublishingDB,userId:string,raw:unknown){
  const x=z.object({editionId:z.string().min(1),textOrigin:origin,coverOrigin:optionalOrigin,narrationOrigin:optionalOrigin,translationOrigin:optionalOrigin,syntheticVoiceLabel:z.string().max(240).default(""),modelNames:z.array(z.string().trim().min(1).max(160)).max(30).default([]),generationNotes:z.string().max(5000).default(""),humanEditorialReviewAttestation:z.literal(true),rightsResponsibilityAttestation:z.literal(true),nonSpamAttestation:z.literal(true),signatureName:z.string().trim().min(2).max(240)}).parse(raw);
  const e=await edition(db,x.editionId);await member(db,userId,String(e.account_id),"editor");
  await requireActivePolicy(db,"ai_content",FORE_AI_POLICY_VERSION);
  if(!["draft","changes_requested"].includes(String(e.status)))throw new ApiError(409,"Open a new revision before changing the signed AI-content disclosure.");
  if(e.format==="audiobook"&&["ai_generated","mixed"].includes(x.narrationOrigin)&&!x.syntheticVoiceLabel.trim())throw new ApiError(400,"AI-generated or mixed narration requires a customer-facing synthetic voice label.");
  const prior=await db.prepare("SELECT id FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?").bind(e.id,e.revision).first<any>();if(prior)throw new ApiError(409,"This revision already has a signed immutable AI-content disclosure. Open a new revision to replace it.");
  const disclosureId=id("aidisc"),at=now();
  await db.prepare(`INSERT INTO publishing_ai_disclosures(id,edition_id,account_id,revision,policy_version,text_origin,cover_origin,narration_origin,translation_origin,synthetic_voice_label,model_names_json,generation_notes,human_editorial_review_attestation,rights_responsibility_attestation,non_spam_attestation,signature_name,signed_by_user_id,signed_at,created_at) VALUES(?,?,?,?, ?,?,?,?,?,?,?,?,1,1,1,?,?,?,?)`).bind(disclosureId,e.id,e.account_id,e.revision,FORE_AI_POLICY_VERSION,x.textOrigin,x.coverOrigin,x.narrationOrigin,x.translationOrigin,x.syntheticVoiceLabel,JSON.stringify(x.modelNames),x.generationNotes,x.signatureName,userId,at,at).run();
  await audit(db,String(e.account_id),userId,"ai_disclosure",disclosureId,"signed",{editionId:e.id,revision:e.revision,policyVersion:FORE_AI_POLICY_VERSION,textOrigin:x.textOrigin,coverOrigin:x.coverOrigin,narrationOrigin:x.narrationOrigin});
  return{id:disclosureId,editionId:e.id,revision:Number(e.revision),policyVersion:FORE_AI_POLICY_VERSION};
}

export async function uploadRightsEvidence(env:PublishingEnv,userId:string,input:{declarationId:string;evidenceType:string;description?:string;filename:string;mimeType:string;bytes:Uint8Array;issuedBy?:string;issuedAt?:string|null;expiresAt?:string|null}){
  if(!env.BUCKET)throw new ApiError(503,"Publishing evidence storage is not configured.");
  const x=z.object({declarationId:z.string().min(1),evidenceType:z.enum(["license","assignment","contract","registration","permission","public_domain_source","identity_authority","other"]),description:z.string().max(2000).default(""),filename:z.string().trim().min(1).max(240),mimeType:z.string().max(160),issuedBy:z.string().max(240).default(""),issuedAt:z.string().datetime().nullable().optional(),expiresAt:z.string().datetime().nullable().optional()}).parse({...input,bytes:undefined});
  const allowedEvidenceMime=new Set(["application/pdf","image/jpeg","image/png","text/plain","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
  const evidenceMime=(x.mimeType||"application/octet-stream").toLowerCase();
  if(!allowedEvidenceMime.has(evidenceMime))throw new ApiError(415,"Rights evidence must be PDF, JPEG, PNG, plain text, or DOCX.");
  const d=await env.DB.prepare("SELECT * FROM publishing_rights_declarations WHERE id=?").bind(x.declarationId).first<any>();if(!d)throw new ApiError(404,"Rights declaration not found.");await member(env.DB,userId,String(d.account_id),"editor");
  if(!input.bytes.byteLength)throw new ApiError(400,"The evidence file is empty.");if(input.bytes.byteLength>25*1024*1024)throw new ApiError(413,"Rights evidence files are limited to 25 MB.");
  const digest=await sha256(input.bytes),evidenceId=id("rightsev"),jobId=id("rightsscan"),at=now(),safeName=x.filename.replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,120),objectKey=`publishing/private-rights-evidence/${d.account_id}/${d.id}/${evidenceId}/${safeName}`;
  await env.BUCKET.put(objectKey,input.bytes,{httpMetadata:{contentType:x.mimeType||"application/octet-stream"},customMetadata:{sha256:digest,classification:"confidential-rights-evidence"}});
  await env.DB.batch([env.DB.prepare(`INSERT INTO publishing_rights_evidence(id,declaration_id,account_id,evidence_type,description,original_filename,mime_type,size_bytes,object_key,sha256,scan_status,verification_status,issued_by,issued_at,expires_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued','unreviewed',?,?,?,?,?)`).bind(evidenceId,d.id,d.account_id,x.evidenceType,x.description,x.filename,x.mimeType,input.bytes.byteLength,objectKey,digest,x.issuedBy,x.issuedAt||null,x.expiresAt||null,userId,at),env.DB.prepare("INSERT INTO publishing_rights_evidence_scan_jobs(id,evidence_id,status,attempts,max_attempts,available_at,created_at,updated_at) VALUES(?,?,'queued',0,5,?,?,?)").bind(jobId,evidenceId,at,at,at)]);
  await audit(env.DB,String(d.account_id),userId,"rights_evidence",evidenceId,"uploaded",{declarationId:d.id,evidenceType:x.evidenceType,sha256:digest});
  return{id:evidenceId,scanJobId:jobId,sha256:digest,scanStatus:"queued"};
}

async function sha256(bytes:Uint8Array|string){const raw=typeof bytes==="string"?new TextEncoder().encode(bytes):bytes;const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",raw));return [...digest].map(v=>v.toString(16).padStart(2,"0")).join("");}
function normalizeText(s:string){return s.normalize("NFKC").toLowerCase().replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&[a-z0-9#]+;/gi," ").replace(/[^\p{L}\p{N}'’-]+/gu," ").replace(/\s+/g," ").trim().slice(0,500000);}
function fnv64(token:string){let h=1469598103934665603n;for(const c of new TextEncoder().encode(token)){h^=BigInt(c);h=BigInt.asUintN(64,h*1099511628211n)}return h;}
function simhash64(tokens:string[]){const v=new Array(64).fill(0);for(const t of tokens.slice(0,100000)){const h=fnv64(t);for(let i=0;i<64;i++)v[i]+=((h>>BigInt(i))&1n)?1:-1;}let out=0n;for(let i=0;i<64;i++)if(v[i]>=0)out|=1n<<BigInt(i);return out.toString(16).padStart(16,"0");}
function hamming(a:string,b:string){if(!/^[0-9a-f]{16}$/i.test(a)||!/^[0-9a-f]{16}$/i.test(b))return 64;let x=BigInt("0x"+a)^BigInt("0x"+b),n=0;while(x){x&=x-1n;n++;}return n;}

export async function recordAssetFingerprint(db:PublishingDB,input:{assetVersionId:string;accountId:string;editionId:string;assetKind:string;exactSha256:string;text?:string;metadata?:unknown}){
  const existing=await db.prepare("SELECT id FROM publishing_asset_fingerprints WHERE asset_version_id=?").bind(input.assetVersionId).first<any>();
  if(existing)return existing;
  const normalized=normalizeText(input.text||""),tokens=normalized?normalized.split(" ").filter(Boolean):[],normalizedHash=normalized?await sha256(normalized):"",sim=tokens.length>=100?simhash64(tokens):"",bands=simhashBands(sim),metaHash=await sha256(JSON.stringify(input.metadata||{})),fid=id("fingerprint"),at=now();
  await db.prepare("INSERT INTO publishing_asset_fingerprints(id,asset_version_id,account_id,edition_id,asset_kind,exact_sha256,normalized_text_sha256,simhash64,simhash_band0,simhash_band1,simhash_band2,simhash_band3,token_count,metadata_fingerprint,detector_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'fore-fingerprint-v2',?)")
    .bind(fid,input.assetVersionId,input.accountId,input.editionId,input.assetKind,input.exactSha256,normalizedHash,sim,...bands,tokens.length,metaHash,at).run();
  const candidates=(await db.prepare(`SELECT * FROM publishing_asset_fingerprints
    WHERE asset_version_id<>? AND asset_kind=? AND (
      exact_sha256=? OR (?<>'' AND normalized_text_sha256=?) OR
      (?<>'' AND (simhash_band0=? OR simhash_band1=? OR simhash_band2=? OR simhash_band3=?))
    ) ORDER BY created_at DESC LIMIT 4000`)
    .bind(input.assetVersionId,input.assetKind,input.exactSha256,normalizedHash,normalizedHash,sim,bands[0],bands[1],bands[2],bands[3]).all<any>()).results;
  for(const c of candidates){
    let type:string|undefined,score=0;
    if(c.exact_sha256===input.exactSha256){type="exact";score=1}
    else if(normalizedHash&&c.normalized_text_sha256===normalizedHash){type="normalized_text";score=.995}
    else if(sim){const d=hamming(sim,String(c.simhash64||""));if(d<=7){type="simhash";score=1-d/64}}
    if(!type)continue;
    const a=String(input.accountId),b=String(c.account_id),cross=a!==b,mid=id("simmatch");
    await db.prepare(`INSERT OR IGNORE INTO publishing_similarity_matches(id,asset_version_id,matched_asset_version_id,similarity_type,score,cross_account,disposition,detector_version,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'review','fore-fingerprint-v2',?,?,?)`)
      .bind(mid,input.assetVersionId,c.asset_version_id,type,score,cross?1:0,JSON.stringify({tokenCount:tokens.length,matchedTokenCount:Number(c.token_count||0),simhashDistance:sim?hamming(sim,String(c.simhash64||"")):null}),at,at).run();
    if(cross){
      const linkType=type==="exact"?"shared_exact_asset":"high_content_similarity",linkScore=type==="exact"?100:Math.round(score*100);
      await upsertAccountRiskLink(db,a,b,linkType,linkScore,{assetVersionId:input.assetVersionId,matchedAssetVersionId:c.asset_version_id,similarityType:type});
    }
  }
  return{id:fid,normalizedTextSha256:normalizedHash,simhash64:sim,tokenCount:tokens.length};
}

function simhashBands(sim:string):[string,string,string,string]{
  if(!/^[0-9a-f]{16}$/i.test(sim))return["","","",""];
  return[sim.slice(0,4),sim.slice(4,8),sim.slice(8,12),sim.slice(12,16)];
}

async function upsertAccountRiskLink(db:PublishingDB,a:string,b:string,linkType:string,score:number,evidence:unknown={}){
  if(!a||!b||a===b)return;
  const lo=a<b?a:b,hi=a<b?b:a,at=now();
  await db.prepare(`INSERT INTO publishing_account_risk_links(id,account_a_id,account_b_id,link_type,score,evidence_json,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(account_a_id,account_b_id,link_type) DO UPDATE SET score=MAX(score,excluded.score),evidence_json=excluded.evidence_json,last_seen_at=excluded.last_seen_at`)
    .bind(id("risklink"),lo,hi,linkType,Math.max(0,Math.min(100,score)),JSON.stringify(evidence),at,at).run();
  await ensureRiskCluster(db,lo,hi,linkType);
}

async function ensureRiskCluster(db:PublishingDB,a:string,b:string,reason:string){
  const links=(await db.prepare("SELECT link_type,score FROM publishing_account_risk_links WHERE account_a_id=? AND account_b_id=? ORDER BY score DESC").bind(a,b).all<any>()).results;
  if(!links.length)return;
  const max=Math.max(...links.map((r:any)=>Number(r.score||0))),aggregate=Math.min(100,max+Math.min(40,Math.max(0,links.length-1)*20));
  if(aggregate<85)return;
  const memberships=(await db.prepare(`SELECT DISTINCT c.id,c.risk_score FROM publishing_risk_clusters c JOIN publishing_risk_cluster_members m ON m.cluster_id=c.id
    WHERE m.account_id IN (?,?) AND c.status IN ('open','monitoring') ORDER BY c.risk_score DESC,c.created_at`).bind(a,b).all<any>()).results;
  const at=now(),cid=String(memberships[0]?.id||id("riskcluster"));
  if(!memberships.length)await db.prepare("INSERT INTO publishing_risk_clusters(id,status,risk_score,reason,created_at,updated_at) VALUES(?,'open',?,?,?,?)").bind(cid,aggregate,reason,at,at).run();
  else await db.prepare("UPDATE publishing_risk_clusters SET risk_score=MAX(risk_score,?),reason=?,updated_at=? WHERE id=?").bind(aggregate,reason,at,cid).run();
  for(const extra of memberships.slice(1)){
    const members=(await db.prepare("SELECT * FROM publishing_risk_cluster_members WHERE cluster_id=?").bind(extra.id).all<any>()).results;
    for(const m of members)await db.prepare(`INSERT INTO publishing_risk_cluster_members(cluster_id,account_id,member_score,evidence_json,added_at) VALUES(?,?,?,?,?)
      ON CONFLICT(cluster_id,account_id) DO UPDATE SET member_score=MAX(member_score,excluded.member_score),evidence_json=excluded.evidence_json`).bind(cid,m.account_id,m.member_score,m.evidence_json||"{}",m.added_at||at).run();
    await db.prepare("DELETE FROM publishing_risk_clusters WHERE id=?").bind(extra.id).run();
  }
  for(const accountId of [a,b])await db.prepare(`INSERT INTO publishing_risk_cluster_members(cluster_id,account_id,member_score,evidence_json,added_at) VALUES(?,?,?,'{}',?)
    ON CONFLICT(cluster_id,account_id) DO UPDATE SET member_score=MAX(member_score,excluded.member_score)`).bind(cid,accountId,aggregate,at).run();
}

const publicMailDomains=new Set(["gmail.com","googlemail.com","outlook.com","hotmail.com","live.com","yahoo.com","icloud.com","me.com","aol.com","proton.me","protonmail.com","pm.me","gmx.com","mail.com"]);
export async function scanAccountRiskLinks(db:PublishingDB,accountId:string){
  const account=await db.prepare("SELECT id,contact_email,finance_party_id,rights_party_id FROM publishing_accounts WHERE id=?").bind(accountId).first<any>();
  if(!account)return{links:0};
  let linked=0;
  const email=String(account.contact_email||"").toLowerCase(),domain=email.includes("@")?email.split("@").pop()||"":"";
  if(domain&&!publicMailDomains.has(domain)){
    const rows=(await db.prepare("SELECT id FROM publishing_accounts WHERE id<>? AND lower(substr(contact_email,instr(contact_email,'@')+1))=?").bind(accountId,domain).all<any>()).results;
    for(const r of rows){await upsertAccountRiskLink(db,accountId,String(r.id),"shared_contact_domain",45,{domain});linked++;}
  }
  const controllers=(await db.prepare(`SELECT DISTINCT m2.account_id FROM publishing_account_members m1 JOIN publishing_account_members m2 ON m2.user_id=m1.user_id
    WHERE m1.account_id=? AND m2.account_id<>? AND m1.status='active' AND m2.status='active' AND m1.role IN ('owner','admin') AND m2.role IN ('owner','admin')`).bind(accountId,accountId).all<any>()).results;
  for(const r of controllers){await upsertAccountRiskLink(db,accountId,String(r.account_id),"shared_account_controller",65,{basis:"shared active owner/admin identity"});linked++;}
  if(account.finance_party_id){
    const rows=(await db.prepare("SELECT id FROM publishing_accounts WHERE id<>? AND finance_party_id=? AND finance_party_id IS NOT NULL").bind(accountId,account.finance_party_id).all<any>()).results;
    for(const r of rows){await upsertAccountRiskLink(db,accountId,String(r.id),"shared_payout_reference",95,{financePartyId:String(account.finance_party_id)});linked++;}
  }
  if(account.rights_party_id){
    const rows=(await db.prepare("SELECT id FROM publishing_accounts WHERE id<>? AND rights_party_id=? AND rights_party_id IS NOT NULL").bind(accountId,account.rights_party_id).all<any>()).results;
    for(const r of rows){await upsertAccountRiskLink(db,accountId,String(r.id),"shared_identity_reference",90,{rightsPartyId:String(account.rights_party_id)});linked++;}
  }
  return{links:linked};
}

function normalizedName(v:string){return v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"").slice(0,240);}
function editDistance(a:string,b:string){const prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let last=prev[0];prev[0]=i;for(let j=1;j<=b.length;j++){const old=prev[j];prev[j]=Math.min(prev[j]+1,prev[j-1]+1,last+(a[i-1]===b[j-1]?0:1));last=old;}}return prev[b.length];}
export async function scanIdentitySimilarity(db:PublishingDB,input:{accountId:string;subjectType:"publisher_name"|"pen_name"|"contributor";subjectId:string;name:string}){
  const n=normalizedName(input.name);if(n.length<4)return[];
  const rows=[
    ...(await db.prepare("SELECT id,name,'publisher' entity_type FROM publishers WHERE name<>'' LIMIT 4000").all<any>()).results,
    ...(await db.prepare("SELECT id,name,'contributor' entity_type FROM contributors WHERE name<>'' LIMIT 4000").all<any>()).results,
    ...(await db.prepare("SELECT id,display_name name,'publishing_account' entity_type FROM publishing_accounts WHERE id<>? LIMIT 4000").bind(input.accountId).all<any>()).results,
    ...(await db.prepare("SELECT id,display_name name,'pen_name' entity_type FROM publishing_pen_names WHERE account_id<>? LIMIT 4000").bind(input.accountId).all<any>()).results,
  ];
  const matches:any[]=[];
  for(const r of rows){
    const m=normalizedName(String(r.name||""));if(!m)continue;
    const dist=editDistance(n,m),score=Math.round((1-dist/Math.max(n.length,m.length))*100);if(score<90)continue;
    const duplicate=await db.prepare(`SELECT id FROM publishing_identity_similarity_matches WHERE account_id=? AND subject_type=? AND subject_id=? AND submitted_name=? AND matched_entity_type=? AND matched_entity_id=? AND status='review' LIMIT 1`)
      .bind(input.accountId,input.subjectType,input.subjectId,input.name,r.entity_type,r.id).first<any>();
    if(duplicate){matches.push({id:String(duplicate.id),score,matchedName:r.name,matchedEntityType:r.entity_type,existing:true});continue;}
    const matchId=id("idsim"),at=now();
    await db.prepare("INSERT INTO publishing_identity_similarity_matches(id,account_id,subject_type,subject_id,submitted_name,matched_entity_type,matched_entity_id,matched_name,similarity_score,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)")
      .bind(matchId,input.accountId,input.subjectType,input.subjectId,input.name,r.entity_type,r.id,r.name,score,at,at).run();
    matches.push({id:matchId,score,matchedName:r.name,matchedEntityType:r.entity_type});
  }
  return matches;
}


export async function assessSubmissionContentPolicy(db:PublishingDB,submissionId:string){
  const existing=await db.prepare("SELECT * FROM publishing_content_policy_assessments WHERE submission_id=? AND policy_version=?").bind(submissionId,FORE_AI_POLICY_VERSION).first<any>();
  if(existing)return existing;
  const sub=await db.prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?").bind(submissionId).first<any>();
  if(!sub)throw new ApiError(404,"Publishing submission not found.");
  const ai=await db.prepare("SELECT * FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?").bind(sub.edition_id,sub.revision).first<any>();
  if(!ai)throw new ApiError(409,"A signed AI-content disclosure is required before automated review.");
  const [crossSimilarity,sameAccountSimilarity,recent]=await Promise.all([
    db.prepare(`SELECT COUNT(*) count,MAX(sm.score) max_score FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND sm.cross_account=1 AND sm.disposition IN ('review','fraud_hold','infringing')`).bind(sub.edition_id).first<any>(),
    db.prepare(`SELECT COUNT(*) count,MAX(sm.score) max_score FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND sm.cross_account=0 AND sm.disposition IN ('review','fraud_hold','infringing')`).bind(sub.edition_id).first<any>(),
    db.prepare("SELECT COUNT(*) count FROM publishing_submission_snapshots WHERE account_id=? AND submitted_at>=datetime('now','-24 hours')").bind(sub.account_id).first<any>(),
  ]);
  const signals:any[]=[],add=(type:string,points:number,evidence:any)=>signals.push({type,points,evidence});
  if(ai.text_origin==="ai_generated"||ai.text_origin==="mixed")add("generated_text_disclosed",25,{origin:ai.text_origin});
  if(ai.translation_origin==="ai_generated"||ai.translation_origin==="mixed")add("generated_translation_disclosed",25,{origin:ai.translation_origin});
  if(ai.cover_origin==="ai_generated"||ai.cover_origin==="mixed")add("generated_cover_disclosed",10,{origin:ai.cover_origin});
  if(ai.narration_origin==="ai_generated"||ai.narration_origin==="mixed")add("synthetic_narration_disclosed",10,{origin:ai.narration_origin,label:ai.synthetic_voice_label});
  if(Number(crossSimilarity?.max_score||0)>=.95)add("near_duplicate_cross_publisher_content",70,{matches:Number(crossSimilarity?.count||0),maxScore:Number(crossSimilarity.max_score)});
  else if(Number(crossSimilarity?.max_score||0)>=.89)add("cross_publisher_content_similarity_review",30,{matches:Number(crossSimilarity?.count||0),maxScore:Number(crossSimilarity.max_score)});
  if(Number(sameAccountSimilarity?.max_score||0)>=.97)add("low_value_derivative_variant_risk",45,{matches:Number(sameAccountSimilarity?.count||0),maxScore:Number(sameAccountSimilarity.max_score)});
  else if(Number(sameAccountSimilarity?.max_score||0)>=.92)add("same_publisher_variant_similarity",25,{matches:Number(sameAccountSimilarity?.count||0),maxScore:Number(sameAccountSimilarity.max_score)});
  if(Number(recent?.count||0)>=25)add("mass_submission_velocity",70,{submissions24h:Number(recent.count)});
  else if(Number(recent?.count||0)>=10)add("high_submission_velocity",35,{submissions24h:Number(recent.count)});
  const score=Math.min(100,signals.reduce((n,s)=>n+s.points,0)),outcome=score>=80?"block":score>=25?"review":"pass",assessmentId=id("policyassess"),at=now();
  await db.prepare("INSERT INTO publishing_content_policy_assessments(id,submission_id,ai_disclosure_id,policy_version,outcome,risk_score,signals_json,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(assessmentId,submissionId,ai.id,FORE_AI_POLICY_VERSION,outcome,score,JSON.stringify(signals),at).run();
  return{id:assessmentId,submission_id:submissionId,outcome,risk_score:score,signals_json:JSON.stringify(signals)};
}

async function publishingAccountForSubject(db:PublishingDB,subjectType:string,subjectId:string){let r:any=null;if(subjectType==="title")r=await db.prepare("SELECT account_id FROM publishing_titles WHERE id=?").bind(subjectId).first<any>();else if(subjectType==="edition")r=await db.prepare("SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?").bind(subjectId).first<any>();else if(subjectType==="publication")r=await db.prepare("SELECT publishing_account_id account_id FROM publishing_publications WHERE id=?").bind(subjectId).first<any>();else if(subjectType==="publisher")r=await db.prepare("SELECT id account_id FROM publishing_accounts WHERE publisher_id=? OR id=? LIMIT 1").bind(subjectId,subjectId).first<any>();else if(subjectType==="author")r=await db.prepare("SELECT account_id FROM publishing_pen_names WHERE contributor_id=? OR id=? LIMIT 1").bind(subjectId,subjectId).first<any>();return r?.account_id?String(r.account_id):null;}
async function lifecycleForSubject(db:PublishingDB,type:string,subjectId:string){if(type==="edition")return db.prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?").bind(subjectId).first<any>();if(type==="publication")return db.prepare(`SELECT l.* FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id JOIN publishing_release_lifecycles l ON l.publishing_edition_id=s.edition_id WHERE p.id=?`).bind(subjectId).first<any>();if(type==="title")return db.prepare(`SELECT l.* FROM publishing_edition_drafts e JOIN publishing_release_lifecycles l ON l.publishing_edition_id=e.id WHERE e.title_id=? ORDER BY l.updated_at DESC LIMIT 1`).bind(subjectId).first<any>();return null;}
function disputeEvent(db:PublishingDB,disputeId:string,eventType:string,actorType:"claimant"|"publisher"|"staff"|"system"|"worker",actorUserId:string|null,payload:any={}){return db.prepare("INSERT INTO rights_dispute_events(id,dispute_id,event_type,actor_type,actor_user_id,event_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("rightsevt"),disputeId,eventType,actorType,actorUserId,JSON.stringify(payload),now());}
async function notify(db:PublishingDB,disputeId:string,type:string,recipientType:"claimant"|"publisher"|"staff",recipient:string,payload:any={}){if(!recipient)return;await db.prepare("INSERT INTO rights_notification_jobs(id,dispute_id,notification_type,recipient_type,recipient,payload_json,status,attempts,max_attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,8,?,?,?)").bind(id("rightsnotify"),disputeId,type,recipientType,recipient,JSON.stringify(payload),now(),now(),now()).run();}

async function resolveCopyrightSubject(db:PublishingDB,input:{subjectType?:string;subjectId?:string;reportedUrl?:string}){
  if(input.subjectType&&input.subjectId){
    const accountId=await publishingAccountForSubject(db,input.subjectType,input.subjectId);
    if(!accountId)throw new ApiError(404,"The reported Cove publishing subject could not be found.");
    return{subjectType:input.subjectType,subjectId:input.subjectId,accountId,reportedUrl:input.reportedUrl||""};
  }
  if(!input.reportedUrl)throw new ApiError(400,"Provide a Cove content URL or a recognized publishing subject.");
  let u:URL;try{u=new URL(input.reportedUrl);}catch{throw new ApiError(400,"The reported content URL is invalid.");}
  const path=u.pathname.replace(/\/+$/g,"");
  let row:any=null,subjectType="",subjectId="";
  let m=path.match(/^\/book\/([^/]+)$/);
  if(m){const productId=decodeURIComponent(m[1]);row=await db.prepare("SELECT id,publishing_account_id FROM publishing_publications WHERE product_id=? ORDER BY published_at DESC LIMIT 1").bind(productId).first<any>();if(row){subjectType="publication";subjectId=String(row.id);}}
  m=path.match(/^\/edition\/([^/]+)$/);
  if(!row&&m){const editionId=decodeURIComponent(m[1]);row=await db.prepare("SELECT id,publishing_account_id FROM publishing_publications WHERE edition_id=? ORDER BY published_at DESC LIMIT 1").bind(editionId).first<any>();if(row){subjectType="publication";subjectId=String(row.id);}}
  m=path.match(/^\/publisher\/([^/]+)$/);
  if(!row&&m){const publisherId=decodeURIComponent(m[1]);row=await db.prepare("SELECT id,publisher_id FROM publishing_accounts WHERE publisher_id=? OR id=? LIMIT 1").bind(publisherId,publisherId).first<any>();if(row){subjectType="publisher";subjectId=String(row.publisher_id||row.id);row.publishing_account_id=row.id;}}
  m=path.match(/^\/author\/([^/]+)$/);
  if(!row&&m){const contributorId=decodeURIComponent(m[1]);row=await db.prepare("SELECT id,account_id,contributor_id FROM publishing_pen_names WHERE contributor_id=? OR id=? LIMIT 1").bind(contributorId,contributorId).first<any>();if(row){subjectType="author";subjectId=String(row.contributor_id||row.id);row.publishing_account_id=row.account_id;}}
  if(!row||!row.publishing_account_id)throw new ApiError(404,"That URL does not resolve to content published through Cove Publishing. Include a Cove book, edition, publisher, or author URL.");
  return{subjectType,subjectId,accountId:String(row.publishing_account_id),reportedUrl:u.toString()};
}

export async function submitCopyrightNotice(db:PublishingDB,userId:string|null,raw:unknown){
  const x=z.object({
    subjectType:z.enum(["title","edition","author","publisher","publication"]).optional(),
    subjectId:z.string().min(1).max(240).optional(),
    reportedUrl:z.string().url().max(2000).optional(),
    legalRegime:z.enum(["us_dmca","contractual","other"]).default("us_dmca"),
    claimantName:z.string().trim().min(2).max(240),claimantEmail:z.string().email(),claimantAddress:addressSchema,claimantPhone:z.string().trim().min(7).max(60),representedParty:z.string().max(240).default(""),
    copyrightedWorks:z.array(z.object({title:z.string().min(1).max(1000),author:z.string().max(500).default(""),registrationOrReference:z.string().max(500).default(""),description:z.string().max(4000).default("")})).min(1).max(200),
    infringingMaterial:z.array(z.object({url:z.string().url().or(z.literal("")),description:z.string().min(1).max(4000),location:z.string().max(1000).default("")})).min(1).max(200),
    rightsBasis:z.string().trim().min(3).max(2000),goodFaithAttestation:z.literal(true),accuracyPerjuryAttestation:z.literal(true),authorityAttestation:z.literal(true),signatureName:z.string().trim().min(2).max(240)
  }).superRefine((v,ctx)=>{if(!v.reportedUrl&&!(v.subjectType&&v.subjectId))ctx.addIssue({code:z.ZodIssueCode.custom,message:"A Cove content URL or publishing subject is required."});if((v.subjectType&&!v.subjectId)||(!v.subjectType&&v.subjectId))ctx.addIssue({code:z.ZodIssueCode.custom,message:"subjectType and subjectId must be provided together."});}).parse(raw);
  const subject=await resolveCopyrightSubject(db,x),lifecycle=await lifecycleForSubject(db,subject.subjectType,subject.subjectId);
  const sourceDigest=(await sha256(`${x.claimantEmail.toLowerCase()}|${subject.subjectType}|${subject.subjectId}|${JSON.stringify(x.copyrightedWorks)}|${JSON.stringify(x.infringingMaterial)}|${Date.now()}`)).slice(0,24);
  const c=await createModerationCase(db,{subjectType:subject.subjectType,subjectId:subject.subjectId,publishingAccountId:subject.accountId,category:"copyright",queue:"copyright",priority:"high",sourceType:"copyright_notice",sourceRef:`rights:${sourceDigest}`,riskScore:60,summary:`Rightsholder notice regarding ${subject.subjectType} ${subject.subjectId}.`,reporterUserId:userId,reasonCode:"copyright_notice",details:x.rightsBasis,evidence:{reportedUrl:subject.reportedUrl}});
  const disputeId=id("rightsdispute"),noticeId=id("dmcanotice"),at=now();
  await db.batch([
    db.prepare(`INSERT INTO rights_disputes(id,case_id,publishing_account_id,subject_type,subject_id,lifecycle_id,legal_regime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'notice_received',?,?)`).bind(disputeId,c.id,subject.accountId,subject.subjectType,subject.subjectId,lifecycle?.id||null,x.legalRegime,at,at),
    db.prepare(`INSERT INTO copyright_notices(id,dispute_id,complainant_user_id,claimant_name,claimant_email,claimant_address_json,claimant_phone,represented_party,copyrighted_works_json,infringing_material_json,rights_basis,good_faith_attestation,accuracy_perjury_attestation,authority_attestation,signature_name,status,received_at,updated_at,reported_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,1,1,?,'received',?,?,?)`).bind(noticeId,disputeId,userId,x.claimantName,x.claimantEmail.toLowerCase(),JSON.stringify(x.claimantAddress),x.claimantPhone,x.representedParty,JSON.stringify(x.copyrightedWorks),JSON.stringify(x.infringingMaterial),x.rightsBasis,x.signatureName,at,at,subject.reportedUrl),
    disputeEvent(db,disputeId,"notice_received","claimant",userId,{noticeId,legalRegime:x.legalRegime,reportedUrl:subject.reportedUrl,subjectType:subject.subjectType,subjectId:subject.subjectId})
  ]);
  await notify(db,disputeId,"notice_received","claimant",x.claimantEmail,{noticeId,caseId:c.id,subjectType:subject.subjectType,subjectId:subject.subjectId});
  return{id:noticeId,disputeId,caseId:c.id,status:"received",subjectType:subject.subjectType,subjectId:subject.subjectId};
}

async function takeDown(db:PublishingDB,dispute:any,staffUserId:string,reason:string){const at=now();if(dispute.lifecycle_id){const l=await db.prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?").bind(dispute.lifecycle_id).first<any>();if(l&&l.state!=="takedown"){await db.batch([db.prepare("UPDATE publishing_release_lifecycles SET enforcement_previous_state=state,state='takedown',state_reason=?,takedown_at=COALESCE(takedown_at,?),updated_at=? WHERE id=?").bind(reason,at,at,l.id),db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,'takedown','moderation',?,?,?,?)").bind(id("lifeevt"),l.id,l.state,staffUserId,"copyright_notice",JSON.stringify({disputeId:dispute.id}),at)]);}}
  const pubs=(await db.prepare(`SELECT p.*,s.edition_id source_edition_id FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id WHERE p.publishing_account_id=? AND (?='publishing_account' OR ?='publisher' OR (?='publication' AND p.id=?) OR (?='edition' AND s.edition_id=?) OR (?='title' AND s.edition_id IN (SELECT id FROM publishing_edition_drafts WHERE title_id=?)) OR (?='author' AND s.edition_id IN (SELECT ec.edition_id FROM publishing_edition_contributors ec JOIN publishing_pen_names pn ON pn.id=ec.pen_name_id WHERE pn.contributor_id=? OR pn.id=?)))`).bind(dispute.publishing_account_id,dispute.subject_type,dispute.subject_type,dispute.subject_type,dispute.subject_id,dispute.subject_type,dispute.subject_id,dispute.subject_type,dispute.subject_id,dispute.subject_type,dispute.subject_id,dispute.subject_id).all<any>()).results;
  for(const p of pubs){await db.prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?").bind(at,p.product_id).run();await applyRoyaltyHold(db,dispute,p,staffUserId);}
}
async function applyRoyaltyHold(db:PublishingDB,dispute:any,pub:any,staffUserId:string){if(!dispute.publishing_account_id)return;const acct=await db.prepare("SELECT finance_party_id FROM publishing_accounts WHERE id=?").bind(dispute.publishing_account_id).first<any>(),scopeType="product",scopeId=String(pub.product_id),at=now();await db.prepare("INSERT OR IGNORE INTO royalty_holds(id,dispute_id,publishing_account_id,finance_party_id,scope_type,scope_id,status,reason_code,started_by_user_id,started_at,created_at) VALUES(?,?,?,?,?,?,'active','copyright_dispute',?,?,?)").bind(id("royhold"),dispute.id,dispute.publishing_account_id,acct?.finance_party_id||null,scopeType,scopeId,staffUserId,at,at).run();await db.prepare(`UPDATE finance_royalty_events SET status='held' WHERE status IN ('accrued','payable') AND product_id=?`).bind(scopeId).run();await db.prepare(`UPDATE finance_royalty_allocations SET status='held' WHERE status IN ('accrued','payable') AND calculation_id IN (SELECT id FROM finance_royalty_calculations WHERE product_id=?)`).bind(scopeId).run();await db.prepare(`UPDATE payout_items SET status='held' WHERE status='pending' AND (id IN (SELECT pel.payout_item_id FROM payout_event_links pel JOIN finance_royalty_events re ON re.id=pel.royalty_event_id WHERE re.product_id=?) OR id IN (SELECT pal.payout_item_id FROM payout_allocation_links pal JOIN finance_royalty_allocations ra ON ra.id=pal.royalty_allocation_id JOIN finance_royalty_calculations rc ON rc.id=ra.calculation_id WHERE rc.product_id=?))`).bind(scopeId,scopeId).run();}
async function releaseHolds(db:PublishingDB,disputeId:string,staffUserId:string|null,reason:string){const rows=(await db.prepare("SELECT * FROM royalty_holds WHERE dispute_id=? AND status='active'").bind(disputeId).all<any>()).results,at=now();for(const h of rows){await db.prepare("UPDATE royalty_holds SET status='released',released_by_user_id=?,released_at=?,release_reason=? WHERE id=?").bind(staffUserId,at,reason,h.id).run();if(h.scope_type==="product"){await db.prepare(`UPDATE finance_royalty_events SET status='accrued' WHERE status='held' AND product_id=? AND NOT EXISTS (SELECT 1 FROM royalty_holds rh WHERE rh.status='active' AND rh.scope_type='product' AND rh.scope_id=?)`).bind(h.scope_id,h.scope_id).run();await db.prepare(`UPDATE finance_royalty_allocations SET status='accrued' WHERE status='held' AND calculation_id IN (SELECT id FROM finance_royalty_calculations WHERE product_id=?) AND NOT EXISTS (SELECT 1 FROM royalty_holds rh WHERE rh.status='active' AND rh.scope_type='product' AND rh.scope_id=?)`).bind(h.scope_id,h.scope_id).run();await db.prepare(`UPDATE payout_items SET status='pending' WHERE status='held' AND NOT EXISTS (SELECT 1 FROM payout_event_links pel JOIN finance_royalty_events re ON re.id=pel.royalty_event_id WHERE pel.payout_item_id=payout_items.id AND re.status='held') AND NOT EXISTS (SELECT 1 FROM payout_allocation_links pal JOIN finance_royalty_allocations ra ON ra.id=pal.royalty_allocation_id WHERE pal.payout_item_id=payout_items.id AND ra.status='held')`).run();}}}
async function restore(db:PublishingDB,dispute:any,actorType:"staff"|"worker",actorUserId:string|null,reason:string){const at=now();if(dispute.lifecycle_id){const l=await db.prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?").bind(dispute.lifecycle_id).first<any>();if(l&&l.state==="takedown"){const target=["live","updated","preorder","scheduled","approved"].includes(String(l.enforcement_previous_state))?String(l.enforcement_previous_state):"approved";await db.batch([db.prepare("UPDATE publishing_release_lifecycles SET state=?,state_reason=?,updated_at=? WHERE id=?").bind(target,reason,at,l.id),db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,'takedown',?,'moderation',?,?,?,?)").bind(id("lifeevt"),l.id,target,actorUserId,"copyright_restore",JSON.stringify({disputeId:dispute.id}),at)]);const pub=await db.prepare(`SELECT p.product_id FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id WHERE s.edition_id=? ORDER BY p.published_at DESC LIMIT 1`).bind(l.publishing_edition_id).first<any>();if(pub&&["live","updated","preorder"].includes(target))await db.prepare("UPDATE products SET storefront_status='active',updated_at=? WHERE id=?").bind(at,pub.product_id).run();}}
  const affectedProducts=(await db.prepare("SELECT scope_id FROM royalty_holds WHERE dispute_id=? AND scope_type='product'").bind(dispute.id).all<any>()).results.map((r:any)=>String(r.scope_id));
  await releaseHolds(db,dispute.id,actorUserId,reason);
  for(const productId of affectedProducts){
    const otherHold=await db.prepare("SELECT 1 ok FROM royalty_holds WHERE status='active' AND scope_type='product' AND scope_id=? LIMIT 1").bind(productId).first<any>();
    if(otherHold)continue;
    const release=await db.prepare(`SELECT l.state FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id JOIN publishing_release_lifecycles l ON l.publishing_edition_id=s.edition_id WHERE p.product_id=? ORDER BY p.published_at DESC LIMIT 1`).bind(productId).first<any>();
    if(release&&["live","updated","preorder"].includes(String(release.state)))await db.prepare("UPDATE products SET storefront_status='active',updated_at=? WHERE id=?").bind(at,productId).run();
  }
  await db.prepare("UPDATE rights_disputes SET status='restored',updated_at=? WHERE id=?").bind(at,dispute.id).run();await db.prepare("UPDATE copyright_notices SET status='restored',updated_at=? WHERE dispute_id=?").bind(at,dispute.id).run();await db.prepare("UPDATE copyright_counter_notices SET status='restored',updated_at=? WHERE dispute_id=? AND status IN ('forwarded','waiting','compliant')").bind(at,dispute.id).run();await disputeEvent(db,dispute.id,"content_restored",actorType,actorUserId,{reason}).run();}

export async function validateCopyrightNotice(db:PublishingDB,staff:StaffContext,raw:unknown){const x=z.object({disputeId:z.string().min(1),decision:z.enum(["needs_info","noncompliant","compliant_takedown"]),notes:z.string().max(10000).default("")}).parse(raw),d=await db.prepare(`SELECT rd.*,cn.id notice_id,cn.claimant_email,pa.contact_email publisher_email FROM rights_disputes rd JOIN copyright_notices cn ON cn.dispute_id=rd.id LEFT JOIN publishing_accounts pa ON pa.id=rd.publishing_account_id WHERE rd.id=?`).bind(x.disputeId).first<any>();if(!d)throw new ApiError(404,"Copyright dispute not found.");if(!["notice_received","needs_info"].includes(String(d.status)))throw new ApiError(409,"This notice is no longer awaiting validation.");const at=now();if(x.decision==="needs_info"){await db.batch([db.prepare("UPDATE copyright_notices SET status='needs_info',staff_validation_notes=?,validated_at=?,updated_at=? WHERE id=?").bind(x.notes,at,at,d.notice_id),db.prepare("UPDATE rights_disputes SET status='needs_info',updated_at=? WHERE id=?").bind(at,d.id),disputeEvent(db,d.id,"notice_needs_info","staff",staff.userId,{notes:x.notes})]);await notify(db,d.id,"needs_info","claimant",d.claimant_email,{notes:x.notes});return{status:"needs_info"};}if(x.decision==="noncompliant"){await db.batch([db.prepare("UPDATE copyright_notices SET status='noncompliant',staff_validation_notes=?,validated_at=?,updated_at=? WHERE id=?").bind(x.notes,at,at,d.notice_id),db.prepare("UPDATE rights_disputes SET status='resolved',resolution_code='notice_noncompliant',resolution_notes=?,resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE id=?").bind(x.notes,staff.userId,at,at,d.id),db.prepare("UPDATE moderation_cases SET status='resolved',resolved_at=?,updated_at=? WHERE id=?").bind(at,at,d.case_id),disputeEvent(db,d.id,"notice_rejected","staff",staff.userId,{notes:x.notes})]);await notify(db,d.id,"notice_noncompliant","claimant",d.claimant_email,{noticeId:d.notice_id,notes:x.notes});return{status:"noncompliant"};}await db.batch([db.prepare("UPDATE copyright_notices SET status='actioned',staff_validation_notes=?,validated_at=?,actioned_at=?,updated_at=? WHERE id=?").bind(x.notes,at,at,at,d.notice_id),db.prepare("UPDATE rights_disputes SET status='taken_down',takedown_at=?,updated_at=? WHERE id=?").bind(at,at,d.id),db.prepare("UPDATE moderation_cases SET status='actioned',updated_at=? WHERE id=?").bind(at,d.case_id),disputeEvent(db,d.id,"notice_validated_and_takedown_ordered","staff",staff.userId,{notes:x.notes})]);await takeDown(db,d,staff.userId,"copyright_notice");await notify(db,d.id,"notice_actioned","claimant",d.claimant_email,{disputeId:d.id,noticeId:d.notice_id});await notify(db,d.id,"takedown_to_publisher","publisher",d.publisher_email||"",{disputeId:d.id,noticeId:d.notice_id,counterNoticeAvailable:d.legal_regime==="us_dmca"});return{status:"taken_down",disputeId:d.id};}

export async function submitCopyrightCounterNotice(db:PublishingDB,userId:string,raw:unknown){
  const x=z.object({disputeId:z.string().min(1),subscriberName:z.string().trim().min(2).max(240),subscriberAddress:addressSchema,subscriberPhone:z.string().trim().min(7).max(60),removedMaterial:z.array(z.object({description:z.string().min(1).max(4000),formerLocation:z.string().max(1000).default("")})).min(1).max(200),mistakePerjuryAttestation:z.literal(true),jurisdictionConsent:z.literal(true),serviceConsent:z.literal(true),signatureName:z.string().trim().min(2).max(240),statement:z.string().max(10000).default("")}).parse(raw);
  const d=await db.prepare(`SELECT rd.*,cn.id notice_id FROM rights_disputes rd JOIN copyright_notices cn ON cn.dispute_id=rd.id WHERE rd.id=?`).bind(x.disputeId).first<any>();
  if(!d)throw new ApiError(404,"Copyright dispute not found.");
  if(!d.publishing_account_id)throw new ApiError(409,"This dispute has no publisher account eligible to counter-notify.");
  await member(db,userId,String(d.publishing_account_id),"admin");
  if(d.legal_regime!=="us_dmca")throw new ApiError(409,"This dispute does not use the U.S. DMCA counter-notice workflow.");
  if(!["taken_down","counter_received"].includes(String(d.status)))throw new ApiError(409,"A counter-notice may be submitted only after the material has been taken down.");
  const prior=await db.prepare("SELECT * FROM copyright_counter_notices WHERE dispute_id=? AND status IN ('received','needs_info','compliant','forwarded','waiting') ORDER BY received_at DESC LIMIT 1").bind(d.id).first<any>();
  if(prior&&prior.status!=="needs_info")throw new ApiError(409,"This dispute already has an active counter-notice.");
  const cid=id("counter"),at=now(),statements:any[]=[];
  if(prior){statements.push(db.prepare("UPDATE copyright_counter_notices SET status='closed',updated_at=? WHERE id=? AND status='needs_info'").bind(at,prior.id));statements.push(disputeEvent(db,d.id,"counter_notice_superseded_after_needs_info","publisher",userId,{priorCounterNoticeId:prior.id,newCounterNoticeId:cid}));}
  statements.push(db.prepare(`INSERT INTO copyright_counter_notices(id,dispute_id,notice_id,publishing_account_id,submitter_user_id,subscriber_name,subscriber_address_json,subscriber_phone,removed_material_json,mistake_perjury_attestation,jurisdiction_consent,service_consent,signature_name,statement,status,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1,1,?,?,'received',?,?)`).bind(cid,d.id,d.notice_id,d.publishing_account_id,userId,x.subscriberName,JSON.stringify(x.subscriberAddress),x.subscriberPhone,JSON.stringify(x.removedMaterial),x.signatureName,x.statement,at,at));
  statements.push(db.prepare("UPDATE rights_disputes SET status='counter_received',restore_not_before_at=NULL,restore_deadline_at=NULL,updated_at=? WHERE id=?").bind(at,d.id));
  statements.push(db.prepare("UPDATE copyright_notices SET status='countered',updated_at=? WHERE id=?").bind(at,d.notice_id));
  statements.push(disputeEvent(db,d.id,prior?"counter_notice_resubmitted":"counter_notice_received","publisher",userId,{counterNoticeId:cid,priorCounterNoticeId:prior?.id||null}));
  await db.batch(statements);
  return{id:cid,status:"received",supersedes:prior?.id||null};
}

function utcDateKey(d:Date){return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;}
function observedFixedHoliday(year:number,month:number,day:number){const d=new Date(Date.UTC(year,month,day));if(d.getUTCDay()===6)d.setUTCDate(d.getUTCDate()-1);else if(d.getUTCDay()===0)d.setUTCDate(d.getUTCDate()+1);return d;}
function nthWeekday(year:number,month:number,weekday:number,n:number){const d=new Date(Date.UTC(year,month,1));const delta=(weekday-d.getUTCDay()+7)%7;d.setUTCDate(1+delta+(n-1)*7);return d;}
function lastWeekday(year:number,month:number,weekday:number){const d=new Date(Date.UTC(year,month+1,0));const delta=(d.getUTCDay()-weekday+7)%7;d.setUTCDate(d.getUTCDate()-delta);return d;}
function isUsFederalBusinessHoliday(d:Date){
  const y=d.getUTCFullYear(),key=utcDateKey(d),holidays=[
    observedFixedHoliday(y,0,1),observedFixedHoliday(y+1,0,1),nthWeekday(y,0,1,3),nthWeekday(y,1,1,3),lastWeekday(y,4,1),observedFixedHoliday(y,5,19),observedFixedHoliday(y,6,4),nthWeekday(y,8,1,1),nthWeekday(y,9,1,2),observedFixedHoliday(y,10,11),nthWeekday(y,10,4,4),observedFixedHoliday(y,11,25),
  ];
  return holidays.some(h=>utcDateKey(h)===key);
}
function addBusinessDays(input:Date,days:number){const d=new Date(input);let n=0;while(n<days){d.setUTCDate(d.getUTCDate()+1);const day=d.getUTCDay();if(day!==0&&day!==6&&!isUsFederalBusinessHoliday(d))n++;}return d.toISOString();}

export async function validateCopyrightCounterNotice(db:PublishingDB,staff:StaffContext,raw:unknown){
  const x=z.object({counterNoticeId:z.string().min(1),decision:z.enum(["needs_info","reject","compliant_forward"]),notes:z.string().max(10000).default("")}).parse(raw),c=await db.prepare(`SELECT cn.*,rd.case_id,rd.status dispute_status,n.claimant_email,pa.contact_email publisher_email FROM copyright_counter_notices cn JOIN rights_disputes rd ON rd.id=cn.dispute_id JOIN copyright_notices n ON n.id=cn.notice_id LEFT JOIN publishing_accounts pa ON pa.id=cn.publishing_account_id WHERE cn.id=?`).bind(x.counterNoticeId).first<any>();
  if(!c)throw new ApiError(404,"Counter-notice not found.");
  if(!["received","needs_info"].includes(String(c.status)))throw new ApiError(409,"This counter-notice is no longer awaiting validation.");
  const at=now();
  if(x.decision==="needs_info"){
    await db.batch([db.prepare("UPDATE copyright_counter_notices SET status='needs_info',validated_at=?,updated_at=? WHERE id=?").bind(at,at,c.id),disputeEvent(db,c.dispute_id,"counter_notice_needs_info","staff",staff.userId,{notes:x.notes})]);
    await notify(db,c.dispute_id,"counter_needs_info","publisher",c.publisher_email||"",{counterNoticeId:c.id,notes:x.notes});
    return{status:"needs_info"};
  }
  if(x.decision==="reject"){
    await db.batch([db.prepare("UPDATE copyright_counter_notices SET status='rejected',validated_at=?,updated_at=? WHERE id=?").bind(at,at,c.id),db.prepare("UPDATE rights_disputes SET status='taken_down',restore_not_before_at=NULL,restore_deadline_at=NULL,updated_at=? WHERE id=?").bind(at,c.dispute_id),disputeEvent(db,c.dispute_id,"counter_notice_rejected","staff",staff.userId,{notes:x.notes})]);
    await notify(db,c.dispute_id,"counter_rejected","publisher",c.publisher_email||"",{counterNoticeId:c.id,notes:x.notes});
    return{status:"rejected"};
  }
  const receivedAt=new Date(String(c.received_at||at)),base=Number.isNaN(receivedAt.valueOf())?new Date():receivedAt,notBefore=addBusinessDays(base,10),deadline=addBusinessDays(base,14);
  await db.batch([db.prepare("UPDATE copyright_counter_notices SET status='forwarded',validated_at=?,forwarded_at=?,updated_at=? WHERE id=?").bind(at,at,at,c.id),db.prepare("UPDATE rights_disputes SET status='waiting_restore_window',restore_not_before_at=?,restore_deadline_at=?,updated_at=? WHERE id=?").bind(notBefore,deadline,at,c.dispute_id),db.prepare("UPDATE moderation_cases SET status='waiting_external',updated_at=? WHERE id=?").bind(at,c.case_id),disputeEvent(db,c.dispute_id,"counter_notice_forwarded","staff",staff.userId,{counterNoticeId:c.id,receivedAt:c.received_at,restoreNotBeforeAt:notBefore,restoreDeadlineAt:deadline,notes:x.notes})]);
  await notify(db,c.dispute_id,"counter_forwarded_to_claimant","claimant",c.claimant_email,{counterNoticeId:c.id,receivedAt:c.received_at,restoreNotBeforeAt:notBefore,restoreDeadlineAt:deadline});
  return{status:"forwarded",restoreNotBeforeAt:notBefore,restoreDeadlineAt:deadline};
}

export async function recordCopyrightCourtAction(db:PublishingDB,staff:StaffContext,raw:unknown){
  const x=z.object({disputeId:z.string().min(1),filedBy:z.enum(["claimant","publisher","other"]).default("claimant"),court:z.string().trim().min(2).max(500),caseNumber:z.string().trim().min(1).max(240),filingDate:z.string().datetime(),evidenceReference:z.string().max(1000).default("")}).parse(raw),d=await db.prepare(`SELECT rd.*,n.claimant_email,pa.contact_email publisher_email FROM rights_disputes rd JOIN copyright_notices n ON n.dispute_id=rd.id LEFT JOIN publishing_accounts pa ON pa.id=rd.publishing_account_id WHERE rd.id=?`).bind(x.disputeId).first<any>();
  if(!d)throw new ApiError(404,"Copyright dispute not found.");
  if(!["counter_forwarded","waiting_restore_window","restoration_eligible","counter_received"].includes(String(d.status)))throw new ApiError(409,"This dispute is not in a counter-notice restoration window.");
  const at=now(),courtActionId=id("courtact");
  await db.batch([
    db.prepare("INSERT INTO copyright_court_actions(id,dispute_id,filed_by,court,case_number,filing_date,evidence_reference,recorded_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(courtActionId,d.id,x.filedBy,x.court,x.caseNumber,x.filingDate,x.evidenceReference,staff.userId,at),
    db.prepare("UPDATE rights_disputes SET status='litigation_hold',litigation_hold=1,updated_at=? WHERE id=?").bind(at,d.id),
    db.prepare("UPDATE copyright_notices SET status='litigation_hold',updated_at=? WHERE dispute_id=?").bind(at,d.id),
    db.prepare("UPDATE copyright_counter_notices SET status='court_action',updated_at=? WHERE dispute_id=? AND status IN ('forwarded','waiting','compliant')").bind(at,d.id),
    disputeEvent(db,d.id,"court_action_recorded","staff",staff.userId,{...x,courtActionId})
  ]);
  await notify(db,d.id,"court_action_recorded","claimant",d.claimant_email||"",{...x,courtActionId});
  await notify(db,d.id,"court_action_recorded","publisher",d.publisher_email||"",{...x,courtActionId});
  return{status:"litigation_hold",courtActionId};
}

async function recalcRepeatPolicy(db:PublishingDB,accountId:string){
  const r=await db.prepare("SELECT COUNT(*) incidents,COALESCE(SUM(strike_points),0) points,MAX(decided_at) last_at FROM publisher_infringement_incidents WHERE publishing_account_id=? AND status='active' AND (expires_at IS NULL OR expires_at>datetime('now'))").bind(accountId).first<any>(),points=Number(r?.points||0),state=points>=9?"termination_review":points>=6?"restricted":points>=3?"warning":"normal",at=now();
  await db.prepare(`INSERT INTO repeat_infringer_policy_state(publishing_account_id,active_incidents,active_strike_points,policy_state,last_incident_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(publishing_account_id) DO UPDATE SET active_incidents=excluded.active_incidents,active_strike_points=excluded.active_strike_points,policy_state=CASE WHEN repeat_infringer_policy_state.policy_state='terminated' THEN 'terminated' ELSE excluded.policy_state END,last_incident_at=excluded.last_incident_at,updated_at=excluded.updated_at`).bind(accountId,Number(r?.incidents||0),points,state,r?.last_at||null,at).run();
  if(state==="restricted")await db.prepare("UPDATE publishing_accounts SET status='restricted',updated_at=? WHERE id=? AND status NOT IN ('suspended','closed')").bind(at,accountId).run();
  if(state==="termination_review")await createModerationCase(db,{subjectType:"publishing_account",subjectId:accountId,publishingAccountId:accountId,category:"copyright",queue:"copyright",priority:"urgent",sourceType:"system",sourceRef:`repeat-infringer:${accountId}`,riskScore:100,summary:`Repeat-infringer policy reached termination review with ${points} active strike points.`});
  return{points,state};
}
export async function resolveRightsDispute(db:PublishingDB,staff:StaffContext,raw:unknown){
  const x=z.object({
    disputeId:z.string().min(1),
    resolutionCode:z.enum(["no_infringement","claimant_withdrawn","infringement_confirmed","court_order","settlement","other"]),
    notes:z.string().trim().min(3).max(10000),
    restoreContent:z.boolean().default(false),
    royaltyDisposition:z.enum(["release","continue_hold"]).optional(),
    // Backward-compatible input only. A rights decision no longer silently forfeits publisher money.
    forfeitRoyalties:z.boolean().optional(),
  }).parse(raw),d=await db.prepare("SELECT * FROM rights_disputes WHERE id=?").bind(x.disputeId).first<any>();
  if(!d)throw new ApiError(404,"Copyright dispute not found.");
  if(String(d.status)==="resolved")throw new ApiError(409,"This rights dispute is already resolved.");
  const at=now();
  if(x.forfeitRoyalties===true)throw new ApiError(400,"Royalty forfeiture is not a copyright-case shortcut. Keep disputed funds on hold until an authorized finance/legal disposition is recorded.");
  const mustRelease=["no_infringement","claimant_withdrawn"].includes(x.resolutionCode);
  const royaltyDisposition=mustRelease?"release":(x.royaltyDisposition||"continue_hold");
  if(x.restoreContent)await restore(db,d,"staff",staff.userId,`resolution:${x.resolutionCode}`);
  else if(royaltyDisposition==="release")await releaseHolds(db,d.id,staff.userId,x.resolutionCode);
  if(d.publishing_account_id&&["infringement_confirmed","court_order"].includes(x.resolutionCode)){
    const incidentType=x.resolutionCode==="court_order"?"court_order":"confirmed_infringement",points=x.resolutionCode==="court_order"?5:3;
    await db.prepare("INSERT OR IGNORE INTO publisher_infringement_incidents(id,publishing_account_id,dispute_id,incident_type,strike_points,status,decided_by_user_id,rationale,decided_at) VALUES(?,?,?,?,?,'active',?,?,?)").bind(id("infrincident"),d.publishing_account_id,d.id,incidentType,points,staff.userId,x.notes,at).run();
    await recalcRepeatPolicy(db,String(d.publishing_account_id));
  }
  await db.batch([db.prepare("UPDATE rights_disputes SET status='resolved',resolution_code=?,resolution_notes=?,resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE id=?").bind(x.resolutionCode,x.notes,staff.userId,at,at,d.id),db.prepare("UPDATE moderation_cases SET status='resolved',resolved_at=?,updated_at=? WHERE id=?").bind(at,at,d.case_id),disputeEvent(db,d.id,"dispute_resolved","staff",staff.userId,{resolutionCode:x.resolutionCode,notes:x.notes,restoreContent:x.restoreContent,royaltyDisposition})]);
  const notice=await db.prepare("SELECT claimant_email FROM copyright_notices WHERE dispute_id=?").bind(d.id).first<any>(),publisher=d.publishing_account_id?await db.prepare("SELECT contact_email FROM publishing_accounts WHERE id=?").bind(d.publishing_account_id).first<any>():null;
  const payload={resolutionCode:x.resolutionCode,notes:x.notes,contentRestored:x.restoreContent,royaltyDisposition};
  await notify(db,d.id,"dispute_resolved","claimant",notice?.claimant_email||"",payload);await notify(db,d.id,"dispute_resolved","publisher",publisher?.contact_email||"",payload);
  return{status:"resolved",resolutionCode:x.resolutionCode,royaltyDisposition};
}

export async function manageRepeatInfringerPolicy(db:PublishingDB,staff:StaffContext,raw:unknown){
  const x=z.object({accountId:z.string().min(1),action:z.enum(["terminate","overturn_incident","recalculate"]),incidentId:z.string().min(1).optional(),notes:z.string().trim().min(3).max(10000)}).parse(raw),account=await db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(x.accountId).first<any>();
  if(!account)throw new ApiError(404,"Publishing account not found.");
  const at=now();
  if(x.action==="overturn_incident"){
    if(!x.incidentId)throw new ApiError(400,"incidentId is required when overturning an infringement incident.");
    const incident=await db.prepare("SELECT * FROM publisher_infringement_incidents WHERE id=? AND publishing_account_id=?").bind(x.incidentId,x.accountId).first<any>();
    if(!incident)throw new ApiError(404,"Infringement incident not found.");
    if(incident.status!=="active")throw new ApiError(409,"Only an active infringement incident can be overturned.");
    await db.prepare("UPDATE publisher_infringement_incidents SET status='overturned' WHERE id=?").bind(incident.id).run();
    const state=await recalcRepeatPolicy(db,x.accountId);
    await audit(db,x.accountId,staff.userId,"repeat_infringer_policy",x.accountId,"incident_overturned",{incidentId:incident.id,notes:x.notes,policyState:state.state,strikePoints:state.points});
    return{action:x.action,incidentId:incident.id,...state};
  }
  const state=await recalcRepeatPolicy(db,x.accountId);
  if(x.action==="recalculate"){
    await audit(db,x.accountId,staff.userId,"repeat_infringer_policy",x.accountId,"recalculated",{notes:x.notes,policyState:state.state,strikePoints:state.points});
    return{action:x.action,...state};
  }
  if(state.points<9&&state.state!=="termination_review")throw new ApiError(409,"Repeat-infringer termination requires the account to reach Cove's termination-review threshold.");
  const lifecycles=(await db.prepare(`SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=?`).bind(x.accountId).all<any>()).results;
  const statements:any[]=[db.prepare("UPDATE repeat_infringer_policy_state SET policy_state='terminated',updated_at=? WHERE publishing_account_id=?").bind(at,x.accountId),db.prepare("UPDATE publishing_accounts SET status='closed',updated_at=? WHERE id=?").bind(at,x.accountId)];
  for(const l of lifecycles){
    if(!["takedown","retired"].includes(String(l.state))){
      statements.push(db.prepare("UPDATE publishing_release_lifecycles SET enforcement_previous_state=state,state='takedown',state_reason='repeat_infringer_termination',takedown_at=COALESCE(takedown_at,?),updated_at=? WHERE id=?").bind(at,at,l.id));
      statements.push(db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,'takedown','moderation',?,'repeat_infringer_termination',?,?)").bind(id("lifeevt"),l.id,l.state,staff.userId,JSON.stringify({notes:x.notes,accountId:x.accountId}),at));
    }
    if(l.catalog_product_id)statements.push(db.prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?").bind(at,l.catalog_product_id));
  }
  await db.batch(statements);
  await audit(db,x.accountId,staff.userId,"repeat_infringer_policy",x.accountId,"terminated",{notes:x.notes,strikePoints:state.points,releaseCount:lifecycles.length});
  return{action:"terminate",state:"terminated",strikePoints:state.points,releasesDisabled:lifecycles.length};
}

export async function advanceRightsDisputeDeadlines(db:PublishingDB){const due=(await db.prepare("SELECT * FROM rights_disputes WHERE status='waiting_restore_window' AND litigation_hold=0 AND restore_not_before_at IS NOT NULL AND restore_not_before_at<=?").bind(now()).all<any>()).results;let restored=0;for(const d of due){await db.prepare("UPDATE rights_disputes SET status='restoration_eligible',updated_at=? WHERE id=?").bind(now(),d.id).run();await restore(db,{...d,status:"restoration_eligible"},"worker",null,"dmca_counter_notice_window_elapsed");const n=await db.prepare("SELECT claimant_email FROM copyright_notices WHERE dispute_id=?").bind(d.id).first<any>(),a=d.publishing_account_id?await db.prepare("SELECT contact_email FROM publishing_accounts WHERE id=?").bind(d.publishing_account_id).first<any>():null;await notify(db,d.id,"restored","claimant",n?.claimant_email||"",{reason:"counter_notice_window_elapsed"});await notify(db,d.id,"restored","publisher",a?.contact_email||"",{reason:"counter_notice_window_elapsed"});restored++;}return{checked:due.length,restored};}

export async function leaseRightsNotificationJobs(db:PublishingDB,raw:unknown){const x=z.object({workerId:z.string().min(1).max(160),limit:z.number().int().min(1).max(100).default(20),leaseSeconds:z.number().int().min(30).max(1800).default(300)}).parse(raw),at=now(),until=new Date(Date.now()+x.leaseSeconds*1000).toISOString();await db.prepare("UPDATE rights_notification_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=?,updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts<max_attempts").bind(at,at,at).run();const rows=(await db.prepare("SELECT * FROM rights_notification_jobs WHERE status='queued' AND available_at<=? AND attempts<max_attempts ORDER BY created_at LIMIT ?").bind(at,x.limit).all<any>()).results;const leased:any[]=[];for(const r of rows){await db.prepare("UPDATE rights_notification_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").bind(x.workerId,until,at,r.id).run();const got=await db.prepare("SELECT * FROM rights_notification_jobs WHERE id=? AND status='leased' AND lease_owner=?").bind(r.id,x.workerId).first<any>();if(got)leased.push(got);}return{jobs:leased};}
export async function completeRightsNotificationJob(db:PublishingDB,raw:unknown){const x=z.object({jobId:z.string().min(1),workerId:z.string().min(1),status:z.enum(["sent","failed"]),providerMessageId:z.string().max(500).default(""),error:z.string().max(2000).default("")}).parse(raw),j=await db.prepare("SELECT * FROM rights_notification_jobs WHERE id=? AND status='leased' AND lease_owner=?").bind(x.jobId,x.workerId).first<any>();if(!j)throw new ApiError(409,"Notification job lease is missing or no longer owned by this worker.");const terminal=x.status==="sent"||Number(j.attempts)>=Number(j.max_attempts),status=x.status==="sent"?"sent":terminal?"failed":"queued",available=status==="queued"?new Date(Date.now()+Math.min(3600,60*Math.pow(2,Math.max(0,Number(j.attempts)-1)))*1000).toISOString():j.available_at;await db.prepare("UPDATE rights_notification_jobs SET status=?,provider_message_id=?,last_error=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").bind(status,x.providerMessageId,x.error,available,now(),j.id).run();return{id:j.id,status};}

export async function leaseRightsEvidenceScanJobs(db:PublishingDB,raw:unknown){const x=z.object({workerId:z.string().min(1).max(160),limit:z.number().int().min(1).max(50).default(10),leaseSeconds:z.number().int().min(30).max(1800).default(300)}).parse(raw),at=now(),until=new Date(Date.now()+x.leaseSeconds*1000).toISOString();await db.prepare("UPDATE publishing_rights_evidence_scan_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=?,updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts<max_attempts").bind(at,at,at).run();const rows=(await db.prepare("SELECT j.*,e.object_key,e.mime_type,e.sha256,e.size_bytes FROM publishing_rights_evidence_scan_jobs j JOIN publishing_rights_evidence e ON e.id=j.evidence_id WHERE j.status='queued' AND j.available_at<=? AND j.attempts<j.max_attempts ORDER BY j.created_at LIMIT ?").bind(at,x.limit).all<any>()).results;for(const r of rows)await db.prepare("UPDATE publishing_rights_evidence_scan_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").bind(x.workerId,until,at,r.id).run();return{jobs:rows};}
export async function completeRightsEvidenceScanJob(db:PublishingDB,raw:unknown){const x=z.object({jobId:z.string().min(1),workerId:z.string().min(1),status:z.enum(["passed","failed","blocked"]),error:z.string().max(2000).default("")}).parse(raw),j=await db.prepare("SELECT * FROM publishing_rights_evidence_scan_jobs WHERE id=? AND status='leased' AND lease_owner=?").bind(x.jobId,x.workerId).first<any>();if(!j)throw new ApiError(409,"Evidence scan lease is missing or no longer owned by this worker.");const at=now(),scanStatus=x.status==="passed"?"clean":x.status==="blocked"?"rejected":"failed";await db.batch([db.prepare("UPDATE publishing_rights_evidence_scan_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?").bind(x.status,x.error,at,j.id),db.prepare("UPDATE publishing_rights_evidence SET scan_status=? WHERE id=?").bind(scanStatus,j.evidence_id)]);return{id:j.id,status:x.status};}

export async function reviewRightsEvidence(db:PublishingDB,staff:StaffContext,raw:unknown){const x=z.object({evidenceId:z.string().min(1),status:z.enum(["verified","insufficient","rejected"])}).parse(raw),e=await db.prepare("SELECT * FROM publishing_rights_evidence WHERE id=?").bind(x.evidenceId).first<any>();if(!e)throw new ApiError(404,"Rights evidence not found.");if(e.scan_status!=="clean")throw new ApiError(409,"Rights evidence must pass malware/scanning checks before staff review.");await db.prepare("UPDATE publishing_rights_evidence SET verification_status=? WHERE id=?").bind(x.status,e.id).run();await audit(db,String(e.account_id),staff.userId,"rights_evidence",e.id,"reviewed",{status:x.status});return{saved:true,status:x.status};}
export async function resolveSimilarityMatch(db:PublishingDB,staff:StaffContext,raw:unknown){const x=z.object({id:z.string().min(1),disposition:z.enum(["cleared","authorized_overlap","infringing","fraud_hold"])}).parse(raw),r=await db.prepare("SELECT * FROM publishing_similarity_matches WHERE id=?").bind(x.id).first<any>();if(!r)throw new ApiError(404,"Similarity match not found.");await db.prepare("UPDATE publishing_similarity_matches SET disposition=?,updated_at=? WHERE id=?").bind(x.disposition,now(),x.id).run();return{saved:true,reviewedBy:staff.userId};}
export async function resolveIdentitySimilarity(db:PublishingDB,staff:StaffContext,raw:unknown){
  const x=z.object({id:z.string().min(1),status:z.enum(["cleared","authorized","impersonation"])}).parse(raw),r=await db.prepare("SELECT * FROM publishing_identity_similarity_matches WHERE id=?").bind(x.id).first<any>();
  if(!r)throw new ApiError(404,"Identity similarity match not found.");
  await db.prepare("UPDATE publishing_identity_similarity_matches SET status=?,updated_at=? WHERE id=?").bind(x.status,now(),x.id).run();
  if(x.status==="impersonation"){
    await createModerationCase(db,{subjectType:r.subject_type==="pen_name"?"author":"publisher",subjectId:String(r.subject_id),publishingAccountId:String(r.account_id),category:"impersonation",queue:"impersonation",priority:"high",sourceType:"identity_similarity",sourceRef:`identity-match:${r.id}`,riskScore:Number(r.similarity_score),summary:`Potential impersonation match: ${r.submitted_name} vs ${r.matched_name}.`});
    let targetAccountId:string|null=null;
    if(r.matched_entity_type==="publishing_account")targetAccountId=String(r.matched_entity_id);
    else if(r.matched_entity_type==="pen_name")targetAccountId=(await db.prepare("SELECT account_id FROM publishing_pen_names WHERE id=?").bind(r.matched_entity_id).first<any>())?.account_id||null;
    else if(r.matched_entity_type==="publisher")targetAccountId=(await db.prepare("SELECT id FROM publishing_accounts WHERE publisher_id=? ORDER BY created_at LIMIT 1").bind(r.matched_entity_id).first<any>())?.id||null;
    if(targetAccountId&&targetAccountId!==String(r.account_id))await upsertAccountRiskLink(db,String(r.account_id),String(targetAccountId),"repeated_impersonation_target",Math.max(90,Number(r.similarity_score||0)),{identitySimilarityMatchId:r.id,matchedEntityType:r.matched_entity_type,matchedEntityId:r.matched_entity_id});
  }
  return{saved:true,reviewedBy:staff.userId};
}
export async function resolveRiskCluster(db:PublishingDB,staff:StaffContext,raw:unknown){const x=z.object({id:z.string().min(1),status:z.enum(["cleared","confirmed_fraud","monitoring"]),reason:z.string().max(5000).default("")}).parse(raw),r=await db.prepare("SELECT * FROM publishing_risk_clusters WHERE id=?").bind(x.id).first<any>();if(!r)throw new ApiError(404,"Risk cluster not found.");await db.prepare("UPDATE publishing_risk_clusters SET status=?,reason=?,updated_at=? WHERE id=?").bind(x.status,x.reason,now(),x.id).run();return{saved:true,reviewedBy:staff.userId};}

export async function rightsOperationsDashboard(db:PublishingDB){const [disputes,notices,counters,holds,incidents,repeatStates,similarity,identityMatches,clusters,notifications,evidence]=await Promise.all([db.prepare(`SELECT d.*,c.priority,c.status case_status,a.display_name publisher_name FROM rights_disputes d JOIN moderation_cases c ON c.id=d.case_id LEFT JOIN publishing_accounts a ON a.id=d.publishing_account_id ORDER BY d.created_at DESC LIMIT 500`).all<any>(),db.prepare("SELECT * FROM copyright_notices ORDER BY received_at DESC LIMIT 500").all<any>(),db.prepare("SELECT * FROM copyright_counter_notices ORDER BY received_at DESC LIMIT 500").all<any>(),db.prepare("SELECT * FROM royalty_holds ORDER BY started_at DESC LIMIT 500").all<any>(),db.prepare("SELECT * FROM publisher_infringement_incidents ORDER BY decided_at DESC LIMIT 500").all<any>(),db.prepare("SELECT r.*,a.display_name publisher_name FROM repeat_infringer_policy_state r JOIN publishing_accounts a ON a.id=r.publishing_account_id ORDER BY active_strike_points DESC").all<any>(),db.prepare("SELECT * FROM publishing_similarity_matches WHERE disposition IN ('review','fraud_hold','infringing') ORDER BY score DESC,created_at DESC LIMIT 500").all<any>(),db.prepare("SELECT * FROM publishing_identity_similarity_matches WHERE status='review' ORDER BY similarity_score DESC,created_at DESC LIMIT 500").all<any>(),db.prepare("SELECT c.*,COUNT(m.account_id) member_count FROM publishing_risk_clusters c LEFT JOIN publishing_risk_cluster_members m ON m.cluster_id=c.id GROUP BY c.id ORDER BY c.risk_score DESC,c.updated_at DESC LIMIT 300").all<any>(),db.prepare("SELECT notification_type,status,COUNT(*) count FROM rights_notification_jobs GROUP BY notification_type,status ORDER BY notification_type,status").all<any>(),db.prepare(`SELECT e.id,e.declaration_id,e.account_id,e.evidence_type,e.description,e.original_filename,e.mime_type,e.size_bytes,e.sha256,e.scan_status,e.verification_status,e.issued_by,e.issued_at,e.expires_at,e.created_at,d.rights_basis,d.edition_id,d.revision,a.display_name publisher_name FROM publishing_rights_evidence e JOIN publishing_rights_declarations d ON d.id=e.declaration_id JOIN publishing_accounts a ON a.id=e.account_id ORDER BY e.created_at DESC LIMIT 500`).all<any>()]);return{disputes:disputes.results,notices:notices.results,counters:counters.results,royaltyHolds:holds.results,infringementIncidents:incidents.results,repeatInfringerStates:repeatStates.results,similarityMatches:similarity.results,identityMatches:identityMatches.results,riskClusters:clusters.results,notificationQueue:notifications.results,rightsEvidence:evidence.results};}

export async function publisherRightsSnapshot(db:PublishingDB,userId:string,accountId:string){await member(db,userId,accountId,"analyst");const [declarations,evidence,ai,accessibility,disputes,counters,holds]=await Promise.all([db.prepare("SELECT * FROM publishing_rights_declarations WHERE account_id=? ORDER BY signed_at DESC").bind(accountId).all<any>(),db.prepare(`SELECT e.id,e.declaration_id,e.evidence_type,e.description,e.original_filename,e.mime_type,e.size_bytes,e.sha256,e.scan_status,e.verification_status,e.issued_by,e.issued_at,e.expires_at,e.created_at FROM publishing_rights_evidence e WHERE e.account_id=? ORDER BY e.created_at DESC`).bind(accountId).all<any>(),db.prepare("SELECT * FROM publishing_ai_disclosures WHERE account_id=? ORDER BY signed_at DESC").bind(accountId).all<any>(),db.prepare(`SELECT d.* FROM publishing_accessibility_declarations d JOIN publishing_edition_drafts e ON e.id=d.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY d.created_at DESC`).bind(accountId).all<any>(),db.prepare("SELECT * FROM rights_disputes WHERE publishing_account_id=? ORDER BY created_at DESC").bind(accountId).all<any>(),db.prepare("SELECT * FROM copyright_counter_notices WHERE publishing_account_id=? ORDER BY received_at DESC").bind(accountId).all<any>(),db.prepare("SELECT * FROM royalty_holds WHERE publishing_account_id=? ORDER BY started_at DESC").bind(accountId).all<any>()]);return{rightsDeclarations:declarations.results,rightsEvidence:evidence.results,aiDisclosures:ai.results,accessibilityDeclarations:accessibility.results,rightsDisputes:disputes.results,counterNotices:counters.results,royaltyHolds:holds.results};}
