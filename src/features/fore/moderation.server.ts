import { z } from "zod";
import { ApiError } from "./service";
import type { CoveIdentity } from "./auth.server";
import { emitNotification } from "./notifications.server";
import { recordPrivilegedAccess } from "./privileged-access.server";

export type ModerationDB = {
  prepare(sql: string): { bind(...values: unknown[]): any; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<any> };
  batch(statements: any[]): Promise<unknown>;
};

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const clean = (v: unknown, max = 4000) => String(v ?? "").trim().slice(0, max);
const caseEvent = (db: ModerationDB, caseId: string, eventType: string, actorType: "staff"|"publisher"|"reporter"|"system", actorUserId: string|null, payload: unknown = {}) => db.prepare("INSERT INTO moderation_case_events(id,case_id,event_type,actor_type,actor_user_id,event_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("modevt"),caseId,eventType,actorType,actorUserId,JSON.stringify(payload||{}),now());

export type StaffContext = {
  userId: string;
  email: string;
  displayName: string;
  permissions: Set<string>;
  roles: string[];
  mfaRequired: boolean;
};

export async function requireStaffPermission(db: ModerationDB, identity: CoveIdentity | null | undefined, permission: string, request?: Request): Promise<StaffContext> {
  const deny=async(status:number,message:string,reason:string)=>{if(request)await recordPrivilegedAccess(db as any,request,{actorType:"staff",actorId:identity?.id||"anonymous",permissionOrScope:permission,outcome:"denied",status,metadata:{reason}});throw new ApiError(status,message);};
  if (!identity) return deny(401, "Sign in with your staff account.", "not_authenticated") as never;
  const principal = await db.prepare("SELECT * FROM staff_principals WHERE user_id=? AND status='active'").bind(identity.id).first<any>();
  if (!principal) return deny(403, "This account is not provisioned for Cove staff operations.", "principal_missing_or_inactive") as never;
  if (String(principal.sso_provider||"") && String(principal.sso_provider)!==String(identity.authProvider||"")) return deny(403,"This staff account must authenticate through its assigned SSO provider.","sso_provider_mismatch") as never;
  if (String(principal.sso_subject||"") && String(principal.sso_subject)!==String(identity.authSubject||"")) return deny(403,"The authenticated SSO subject does not match this staff principal.","sso_subject_mismatch") as never;
  if (Number(principal.mfa_required) === 1 && identity.aal !== "aal2") return deny(403, "Staff operations require MFA. Complete a second authentication factor and try again.", "aal2_required") as never;
  const rows = (await db.prepare(`SELECT r.name,p.permission FROM staff_principal_roles pr JOIN staff_roles r ON r.id=pr.role_id JOIN staff_role_permissions p ON p.role_id=r.id WHERE pr.user_id=?`).bind(identity.id).all<any>()).results;
  const permissions = new Set(rows.map((r:any)=>String(r.permission))), roles=[...new Set(rows.map((r:any)=>String(r.name)))];
  if (!permissions.has(permission) && !permissions.has("staff.manage")) return deny(403, `Staff permission required: ${permission}.`, "permission_missing") as never;
  if(request)await recordPrivilegedAccess(db as any,request,{actorType:"staff",actorId:identity.id,permissionOrScope:permission,outcome:"authorized",status:200,metadata:{roles}});
  return { userId: identity.id, email: identity.email || principal.email || "", displayName: identity.name || principal.display_name || identity.email || identity.id, permissions, roles, mfaRequired: !!principal.mfa_required };
}

export async function bootstrapStaffPrincipal(db: ModerationDB, actorUserId: string, raw: unknown) {
  const x = z.object({
    userId: z.string().min(1).max(240), email: z.string().email().or(z.literal("")).default(""), displayName: z.string().max(160).default(""),
    roles: z.array(z.string().min(1).max(80)).min(1).max(20), mfaRequired: z.boolean().default(true), ssoProvider: z.string().max(120).default(""), ssoSubject: z.string().max(240).default("")
  }).parse(raw), at=now();
  const before=await db.prepare("SELECT * FROM staff_principals WHERE user_id=?").bind(x.userId).first<any>();
  const beforeRoles=(await db.prepare("SELECT r.name FROM staff_principal_roles pr JOIN staff_roles r ON r.id=pr.role_id WHERE pr.user_id=? ORDER BY r.name").bind(x.userId).all<any>()).results.map((r:any)=>String(r.name));
  const roleRows=(await db.prepare(`SELECT id,name FROM staff_roles WHERE name IN (${x.roles.map(()=>"?").join(",")})`).bind(...x.roles).all<any>()).results;
  if(roleRows.length!==new Set(x.roles).size) throw new ApiError(400,"One or more staff roles are unknown.");
  const after={userId:x.userId,email:x.email.toLowerCase(),displayName:x.displayName,ssoProvider:x.ssoProvider,status:"active",mfaRequired:x.mfaRequired,roles:[...new Set(x.roles)].sort()};
  const statements:any[]=[
    db.prepare(`INSERT INTO staff_principals(user_id,email,display_name,sso_provider,sso_subject,status,mfa_required,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,sso_provider=excluded.sso_provider,sso_subject=excluded.sso_subject,status='active',mfa_required=excluded.mfa_required,updated_at=excluded.updated_at`).bind(x.userId,x.email.toLowerCase(),x.displayName,x.ssoProvider,x.ssoSubject,x.mfaRequired?1:0,actorUserId,at,at),
    db.prepare("DELETE FROM staff_principal_roles WHERE user_id=?").bind(x.userId)
  ];
  for(const r of roleRows) statements.push(db.prepare("INSERT INTO staff_principal_roles(user_id,role_id,granted_by_user_id,granted_at) VALUES(?,?,?,?)").bind(x.userId,r.id,actorUserId,at));
  statements.push(db.prepare("INSERT INTO staff_audit_events(id,target_user_id,actor_user_id,event_type,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("staffaudit"),x.userId,actorUserId,before?"principal_updated":"principal_bootstrapped",JSON.stringify(before?{...before,roles:beforeRoles}:{}),JSON.stringify(after),at));
  await db.batch(statements);
  return {userId:x.userId,roles:after.roles,mfaRequired:x.mfaRequired};
}

export async function manageStaffPrincipal(db: ModerationDB, staff: StaffContext, raw: unknown) {
  const x=z.object({
    userId:z.string().min(1).max(240),
    status:z.enum(["active","suspended","disabled"]).optional(),
    roles:z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    mfaRequired:z.boolean().optional(),
    displayName:z.string().max(160).optional(),
    email:z.string().email().or(z.literal("")).optional(),
    ssoProvider:z.string().max(120).optional(),
    ssoSubject:z.string().max(240).optional(),
  }).parse(raw),at=now();
  const before=await db.prepare("SELECT * FROM staff_principals WHERE user_id=?").bind(x.userId).first<any>();
  if(!before)throw new ApiError(404,"Staff principal not found.");
  if(x.userId===staff.userId&&x.status&&x.status!=="active")throw new ApiError(409,"You cannot suspend or disable your own staff principal.");
  const beforeRoles=(await db.prepare("SELECT r.name FROM staff_principal_roles pr JOIN staff_roles r ON r.id=pr.role_id WHERE pr.user_id=? ORDER BY r.name").bind(x.userId).all<any>()).results.map((r:any)=>String(r.name));
  let roleRows:any[]=[],roles=beforeRoles;
  if(x.roles){
    roleRows=(await db.prepare(`SELECT id,name FROM staff_roles WHERE name IN (${x.roles.map(()=>"?").join(",")})`).bind(...x.roles).all<any>()).results;
    if(roleRows.length!==new Set(x.roles).size)throw new ApiError(400,"One or more staff roles are unknown.");
    roles=[...new Set(x.roles)].sort();
  }
  const status=x.status||String(before.status),mfaRequired=x.mfaRequired??!!before.mfa_required,email=x.email===undefined?String(before.email||""):x.email.toLowerCase(),displayName=x.displayName===undefined?String(before.display_name||""):x.displayName,ssoProvider=x.ssoProvider===undefined?String(before.sso_provider||""):x.ssoProvider,ssoSubject=x.ssoSubject===undefined?String(before.sso_subject||""):x.ssoSubject;
  const statements:any[]=[db.prepare("UPDATE staff_principals SET email=?,display_name=?,sso_provider=?,sso_subject=?,status=?,mfa_required=?,updated_at=? WHERE user_id=?").bind(email,displayName,ssoProvider,ssoSubject,status,mfaRequired?1:0,at,x.userId)];
  if(x.roles){statements.push(db.prepare("DELETE FROM staff_principal_roles WHERE user_id=?").bind(x.userId));for(const r of roleRows)statements.push(db.prepare("INSERT INTO staff_principal_roles(user_id,role_id,granted_by_user_id,granted_at) VALUES(?,?,?,?)").bind(x.userId,r.id,staff.userId,at));}
  const statusEvent=status!==before.status?(status==="active"?"principal_reactivated":status==="suspended"?"principal_suspended":"principal_disabled"):(x.roles&&JSON.stringify(roles)!==JSON.stringify(beforeRoles)?"roles_changed":"principal_updated");
  const after={userId:x.userId,email,displayName,ssoProvider,status,mfaRequired,roles};
  statements.push(db.prepare("INSERT INTO staff_audit_events(id,target_user_id,actor_user_id,event_type,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("staffaudit"),x.userId,staff.userId,statusEvent,JSON.stringify({...before,roles:beforeRoles}),JSON.stringify(after),at));
  await db.batch(statements);
  return after;
}

export async function createModerationCase(db: ModerationDB, input: { subjectType:string; subjectId:string; publishingAccountId?:string|null; category:string; queue?:string; priority?:string; sourceType?:string; sourceRef?:string; riskScore?:number; summary?:string; reporterUserId?:string|null; reasonCode?:string; details?:string; evidence?:unknown }) {
  const sourceRef=clean(input.sourceRef,240),sourceType=input.sourceType||"system",at=now(),incomingRisk=Math.max(0,Math.min(100,Number(input.riskScore||0)));
  if(sourceRef){const existing=await db.prepare("SELECT id FROM moderation_cases WHERE source_type=? AND source_ref=?").bind(sourceType,sourceRef).first<any>();if(existing)return {id:String(existing.id),existing:true};}
  if(sourceType==="user_report"&&!sourceRef){
    const existing=await db.prepare(`SELECT id,report_count FROM moderation_cases WHERE source_type='user_report' AND subject_type=? AND subject_id=? AND category=? AND status IN ('open','triage','in_review','waiting_external','appealed') ORDER BY opened_at DESC LIMIT 1`).bind(input.subjectType,input.subjectId,input.category).first<any>();
    if(existing){
      const nextCount=Number(existing.report_count||0)+1;
      await db.batch([
        db.prepare(`UPDATE moderation_cases SET report_count=report_count+1,risk_score=MAX(risk_score,?),priority=CASE WHEN report_count+1>=15 THEN 'urgent' WHEN report_count+1>=5 AND priority IN ('low','normal') THEN 'high' ELSE priority END,updated_at=? WHERE id=?`).bind(incomingRisk,at,existing.id),
        db.prepare("INSERT INTO moderation_case_reports(id,case_id,reporter_user_id,reason_code,details,evidence_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("modreport"),existing.id,input.reporterUserId||null,clean(input.reasonCode,120)||"reported",clean(input.details,5000),JSON.stringify(input.evidence||{}),at),
        caseEvent(db,String(existing.id),"report_aggregated","reporter",input.reporterUserId||null,{reasonCode:clean(input.reasonCode,120)||"reported",reportCount:nextCount,riskScore:incomingRisk})
      ]);
      return {id:String(existing.id),existing:true,reportCount:nextCount};
    }
  }
  const caseId=id("modcase"),priority=input.priority||"normal",slaHours=priority==="urgent"?4:priority==="high"?24:priority==="low"?168:72,sla=new Date(Date.now()+slaHours*3600000).toISOString();
  await db.prepare(`INSERT INTO moderation_cases(id,subject_type,subject_id,publishing_account_id,category,queue,priority,status,source_type,source_ref,risk_score,report_count,summary,sla_due_at,opened_at,updated_at) VALUES(?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?)`).bind(caseId,input.subjectType,input.subjectId,input.publishingAccountId||null,input.category,input.queue||"general",priority,sourceType,sourceRef,incomingRisk,sourceType==="user_report"?1:0,clean(input.summary,1000),sla,at,at).run();
  if(sourceType==="user_report"||input.reporterUserId||input.reasonCode||input.details) await db.prepare("INSERT INTO moderation_case_reports(id,case_id,reporter_user_id,reason_code,details,evidence_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(id("modreport"),caseId,input.reporterUserId||null,clean(input.reasonCode,120)||"reported",clean(input.details,5000),JSON.stringify(input.evidence||{}),at).run();
  await caseEvent(db,caseId,"case_opened",sourceType==="user_report"?"reporter":"system",input.reporterUserId||null,{subjectType:input.subjectType,subjectId:input.subjectId,category:input.category,queue:input.queue||"general",priority,riskScore:incomingRisk,sourceType}).run();
  return {id:caseId,existing:false,reportCount:sourceType==="user_report"?1:0};
}

export async function runAutomatedPublishingReview(db: ModerationDB, submissionId: string) {
  const existing=await db.prepare("SELECT * FROM publishing_automated_reviews WHERE submission_id=? AND policy_version='fore-trust-v2'").bind(submissionId).first<any>();
  if(existing)return existing;
  const sub=await db.prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?").bind(submissionId).first<any>(); if(!sub)throw new ApiError(404,"Publishing submission not found.");
  const [dup,acct,sanctions,prior,policy,repeatState,similarity,identity,clusters,evidence]=await Promise.all([
    db.prepare(`SELECT SUM(CASE WHEN d.disposition='fraud_hold' THEN 1 ELSE 0 END) fraud_holds,SUM(CASE WHEN d.disposition='duplicate' THEN 1 ELSE 0 END) duplicates,SUM(CASE WHEN d.disposition='review' THEN 1 ELSE 0 END) reviews FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=?`).bind(sub.edition_id).first<any>(),
    db.prepare("SELECT status FROM publishing_accounts WHERE id=?").bind(sub.account_id).first<any>(),
    db.prepare("SELECT COUNT(*) count,COALESCE(SUM(strike_points),0) strikes FROM moderation_sanctions WHERE publishing_account_id=? AND status='active' AND (ends_at IS NULL OR ends_at>datetime('now'))").bind(sub.account_id).first<any>(),
    db.prepare("SELECT COUNT(*) count FROM moderation_cases WHERE publishing_account_id=? AND status IN ('actioned','resolved','closed') AND category IN ('scam','impersonation','copyright','publishing_risk')").bind(sub.account_id).first<any>(),
    db.prepare("SELECT * FROM publishing_content_policy_assessments WHERE submission_id=? AND policy_version='fore-ai-content-v1'").bind(submissionId).first<any>(),
    db.prepare("SELECT * FROM repeat_infringer_policy_state WHERE publishing_account_id=?").bind(sub.account_id).first<any>(),
    db.prepare(`SELECT COUNT(*) count,MAX(sm.score) max_score,SUM(CASE WHEN sm.disposition='fraud_hold' THEN 1 ELSE 0 END) fraud_holds FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND sm.cross_account=1 AND sm.disposition IN ('review','infringing','fraud_hold')`).bind(sub.edition_id).first<any>(),
    db.prepare("SELECT COUNT(*) count,MAX(similarity_score) max_score FROM publishing_identity_similarity_matches WHERE account_id=? AND status IN ('review','impersonation')").bind(sub.account_id).first<any>(),
    db.prepare(`SELECT COUNT(*) count,MAX(c.risk_score) max_score FROM publishing_risk_cluster_members m JOIN publishing_risk_clusters c ON c.id=m.cluster_id WHERE m.account_id=? AND c.status IN ('open','confirmed_fraud','monitoring')`).bind(sub.account_id).first<any>(),
    db.prepare(`SELECT SUM(CASE WHEN e.scan_status<>'clean' THEN 1 ELSE 0 END) scan_problems,SUM(CASE WHEN e.verification_status='rejected' THEN 1 ELSE 0 END) rejected,SUM(CASE WHEN d.rights_basis IN ('licensed','public_domain') AND (e.id IS NULL OR e.verification_status<>'verified') THEN 1 ELSE 0 END) pending_verification FROM publishing_rights_declarations d LEFT JOIN publishing_rights_evidence e ON e.declaration_id=d.id WHERE d.edition_id=? AND d.revision=?`).bind(sub.edition_id,sub.revision).first<any>(),
  ]);
  const signals:any[]=[];let score=0;
  const add=(type:string,points:number,evidence:unknown)=>{score=Math.min(100,score+points);signals.push({type,points,evidence})};
  if(Number(dup?.fraud_holds||0)>0)add("fraud_hold",80,{count:Number(dup.fraud_holds)});
  if(Number(dup?.duplicates||0)>0)add("confirmed_duplicate",45,{count:Number(dup.duplicates)});
  if(Number(dup?.reviews||0)>0)add("duplicate_review",20,{count:Number(dup.reviews)});
  if(policy){const ps=Number(policy.risk_score||0);if(ps>0)add("ai_content_policy",Math.min(80,ps),{outcome:policy.outcome,signals:JSON.parse(String(policy.signals_json||"[]"))});}
  if(Number(similarity?.fraud_holds||0)>0)add("similarity_fraud_hold",90,{count:Number(similarity.fraud_holds)});else if(Number(similarity?.max_score||0)>=.95)add("cross_publisher_near_duplicate",65,{count:Number(similarity.count||0),maxScore:Number(similarity.max_score)});
  if(Number(identity?.count||0)>0)add("identity_similarity",Math.min(60,Math.max(20,Number(identity.max_score||0)-50)),{count:Number(identity.count),maxScore:Number(identity.max_score)});
  if(Number(clusters?.count||0)>0)add("suspicious_publisher_cluster",Math.min(70,Math.max(20,Number(clusters.max_score||0)-30)),{count:Number(clusters.count),maxScore:Number(clusters.max_score)});
  if(Number(evidence?.scan_problems||0)>0||Number(evidence?.rejected||0)>0)add("rights_evidence_problem",80,{scanProblems:Number(evidence.scan_problems||0),rejected:Number(evidence.rejected||0)});
  else if(Number(evidence?.pending_verification||0)>0)add("rights_evidence_pending_verification",35,{pending:Number(evidence.pending_verification||0)});
  if(acct?.status==="suspended"||acct?.status==="restricted")add("account_restriction",100,{status:acct.status});
  if(Number(sanctions?.count||0)>0)add("active_sanctions",Math.min(50,10+Number(sanctions.strikes||0)*5),{count:Number(sanctions.count),strikes:Number(sanctions.strikes||0)});
  if(Number(prior?.count||0)>=3)add("repeat_offender_pattern",30,{priorCases:Number(prior.count)});
  if(repeatState&&repeatState.policy_state!=="normal")add("repeat_infringer_policy",repeatState.policy_state==="termination_review"||repeatState.policy_state==="terminated"?100:repeatState.policy_state==="restricted"?80:35,{policyState:repeatState.policy_state,strikePoints:Number(repeatState.active_strike_points||0)});
  const outcome=score>=80?"block":score>=25?"review":"pass",at=now(),reviewId=id("autoreview");
  await db.prepare("INSERT INTO publishing_automated_reviews(id,submission_id,policy_version,outcome,risk_score,signals_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(reviewId,submissionId,"fore-trust-v2",outcome,score,JSON.stringify(signals),at).run();
  let caseId:string|undefined;
  if(outcome!=="pass"){
    const c=await createModerationCase(db,{subjectType:"edition",subjectId:String(sub.edition_id),publishingAccountId:String(sub.account_id),category:"publishing_risk",queue:outcome==="block"?"fraud":"publishing",priority:outcome==="block"?"urgent":"high",sourceType:"automated_review",sourceRef:`submission:${submissionId}`,riskScore:score,summary:`Automated publishing review routed this submission for ${outcome==='block'?'blocking review':'human review'}.`});caseId=c.id;
    for(const sig of signals) await db.prepare("INSERT INTO moderation_signals(id,case_id,subject_type,subject_id,detector,detector_version,signal_type,score,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id("modsignal"),caseId,"edition",sub.edition_id,"fore-publishing-risk","v2",sig.type,Math.min(100,sig.points),JSON.stringify(sig.evidence||{}),at).run();
  }
  return {id:reviewId,submission_id:submissionId,outcome,risk_score:score,signals_json:JSON.stringify(signals),caseId};
}

export async function moderationDashboard(db: ModerationDB, includeAudit = false, includeStaff = false) {
  const auditPromise=includeAudit?db.prepare(`SELECT * FROM moderation_case_events ORDER BY created_at DESC LIMIT 500`).all<any>():Promise.resolve({results:[] as any[]});
  const staffPromise=includeStaff?db.prepare(`SELECT p.user_id,p.email,p.display_name,p.sso_provider,p.status,p.mfa_required,p.created_at,p.updated_at,COALESCE(group_concat(r.name,','),'') roles FROM staff_principals p LEFT JOIN staff_principal_roles pr ON pr.user_id=p.user_id LEFT JOIN staff_roles r ON r.id=pr.role_id GROUP BY p.user_id ORDER BY p.display_name,p.email,p.user_id`).all<any>():Promise.resolve({results:[] as any[]});
  const staffAuditPromise=includeStaff?db.prepare("SELECT * FROM staff_audit_events ORDER BY created_at DESC LIMIT 300").all<any>():Promise.resolve({results:[] as any[]});
  const [cases,appeals,sanctions,copyright,signals,notes,actions,auditEvents,staffPrincipals,staffAuditEvents]=await Promise.all([
    db.prepare(`SELECT c.*,a.display_name publisher_name FROM moderation_cases c LEFT JOIN publishing_accounts a ON a.id=c.publishing_account_id ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,c.opened_at ASC LIMIT 500`).all<any>(),
    db.prepare(`SELECT a.*,c.subject_type,c.subject_id,c.category FROM moderation_appeals a JOIN moderation_cases c ON c.id=a.case_id ORDER BY a.submitted_at DESC LIMIT 300`).all<any>(),
    db.prepare(`SELECT s.*,a.display_name publisher_name FROM moderation_sanctions s JOIN publishing_accounts a ON a.id=s.publishing_account_id ORDER BY s.created_at DESC LIMIT 300`).all<any>(),
    db.prepare(`SELECT cc.*,c.status case_status,c.priority FROM copyright_complaints cc JOIN moderation_cases c ON c.id=cc.case_id ORDER BY cc.received_at DESC LIMIT 300`).all<any>(),
    db.prepare(`SELECT subject_type,subject_id,COUNT(*) signal_count,MAX(score) max_score FROM moderation_signals GROUP BY subject_type,subject_id ORDER BY max_score DESC,signal_count DESC LIMIT 300`).all<any>(),
    db.prepare(`SELECT n.*,c.category,c.subject_type,c.subject_id FROM moderation_notes n JOIN moderation_cases c ON c.id=n.case_id ORDER BY n.created_at DESC LIMIT 500`).all<any>(),
    db.prepare(`SELECT a.*,c.category,c.subject_type,c.subject_id FROM moderation_actions a JOIN moderation_cases c ON c.id=a.case_id ORDER BY a.created_at DESC LIMIT 500`).all<any>(),
    auditPromise,staffPromise,staffAuditPromise,
  ]);
  return {cases:cases.results,appeals:appeals.results,sanctions:sanctions.results,copyright:copyright.results,signals:signals.results,notes:notes.results,actions:actions.results,auditEvents:auditEvents.results,staffPrincipals:staffPrincipals.results,staffAuditEvents:staffAuditEvents.results};
}

export async function manageModerationCase(db: ModerationDB, staff: StaffContext, raw: unknown) {
  const x=z.object({caseId:z.string().min(1),status:z.enum(["open","triage","in_review","waiting_external","actioned","appealed","resolved","closed"]).optional(),priority:z.enum(["low","normal","high","urgent"]).optional(),queue:z.enum(["reviews","titles","authors","publishers","copyright","fraud","impersonation","appeals","publishing","general"]).optional(),assignedToUserId:z.string().max(240).nullable().optional()}).parse(raw);
  const row=await db.prepare("SELECT * FROM moderation_cases WHERE id=?").bind(x.caseId).first<any>();if(!row)throw new ApiError(404,"Moderation case not found.");
  const fields:string[]=[],values:any[]=[];if(x.status){fields.push("status=?");values.push(x.status);fields.push("resolved_at=?");values.push(["resolved","closed"].includes(x.status)?now():null)}if(x.priority){fields.push("priority=?");values.push(x.priority)}if(x.queue){fields.push("queue=?");values.push(x.queue)}if(x.assignedToUserId!==undefined){if(x.assignedToUserId){const p=await db.prepare("SELECT 1 ok FROM staff_principals WHERE user_id=? AND status='active'").bind(x.assignedToUserId).first<any>();if(!p)throw new ApiError(400,"Assigned staff principal is not active.");}fields.push("assigned_to_user_id=?");values.push(x.assignedToUserId||null)}if(!fields.length)return{saved:true};const at=now();fields.push("updated_at=?");values.push(at);values.push(x.caseId);
  const changes={status:x.status,priority:x.priority,queue:x.queue,assignedToUserId:x.assignedToUserId};
  await db.batch([db.prepare(`UPDATE moderation_cases SET ${fields.join(",")} WHERE id=?`).bind(...values),caseEvent(db,x.caseId,"case_managed","staff",staff.userId,{before:{status:row.status,priority:row.priority,queue:row.queue,assignedToUserId:row.assigned_to_user_id},changes})]);return{saved:true,actor:staff.userId};
}

export async function addModerationNote(db: ModerationDB, staff: StaffContext, raw: unknown) {
  const x=z.object({caseId:z.string().min(1),note:z.string().trim().min(1).max(10000),visibility:z.enum(["internal","publisher_visible"]).default("internal")}).parse(raw);const row=await db.prepare("SELECT 1 ok FROM moderation_cases WHERE id=?").bind(x.caseId).first<any>();if(!row)throw new ApiError(404,"Moderation case not found.");const noteId=id("modnote"),at=now();await db.batch([db.prepare("INSERT INTO moderation_notes(id,case_id,staff_user_id,visibility,note,created_at) VALUES(?,?,?,?,?,?)").bind(noteId,x.caseId,staff.userId,x.visibility,x.note,at),caseEvent(db,x.caseId,"note_added","staff",staff.userId,{noteId,visibility:x.visibility})]);return{id:noteId};
}

async function lifecycleForCase(db:ModerationDB,c:any){
  if(c.subject_type==="edition")return db.prepare("SELECT l.*,e.catalog_product_id,e.catalog_edition_id,t.account_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?").bind(c.subject_id).first<any>();
  if(c.subject_type==="title")return db.prepare("SELECT l.*,e.catalog_product_id,e.catalog_edition_id,t.account_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.id=? ORDER BY e.updated_at DESC LIMIT 1").bind(c.subject_id).first<any>();
  if(c.subject_type==="publication")return db.prepare("SELECT l.*,e.catalog_product_id,e.catalog_edition_id,t.account_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_publications p ON p.edition_id=e.catalog_edition_id WHERE p.id=?").bind(c.subject_id).first<any>();
  return null;
}

export async function executeModerationAction(db: ModerationDB, staff: StaffContext, raw: unknown) {
  const x=z.object({caseId:z.string().min(1),actionType:z.enum(["no_action","hide_review","show_review","warn_publisher","restrict_publisher","suspend_publisher","suppress_title","restore_title","takedown_title","retire_title","reject_submission","approve_submission","escalate","copyright_takedown","copyright_restore","impersonation_remove"]),reasonCode:z.string().max(120).default(""),rationale:z.string().max(8000).default("")}).parse(raw);
  const c=await db.prepare("SELECT * FROM moderation_cases WHERE id=?").bind(x.caseId).first<any>();if(!c)throw new ApiError(404,"Moderation case not found.");
  if(["approve_submission","reject_submission"].includes(x.actionType))throw new ApiError(409,"Publishing submission decisions must use the publishing review workflow so immutable review evidence and release materialization remain consistent.");
  const perm=x.actionType==="hide_review"||x.actionType==="show_review"?"moderation.review.manage":x.actionType.includes("copyright")?"moderation.copyright.manage":x.actionType==="impersonation_remove"?"moderation.impersonation.manage":x.actionType==="suppress_title"?"moderation.emergency_suppress":x.actionType.includes("takedown")?"moderation.takedown":x.actionType.includes("publisher")?"moderation.sanction.manage":x.actionType==="restore_title"||x.actionType==="retire_title"?"moderation.title.manage":"moderation.case.manage";
  if(!staff.permissions.has(perm)&&!staff.permissions.has("staff.manage"))throw new ApiError(403,`Staff permission required: ${perm}.`);
  const at=now(),actionId=id("modaction"),stmts:any[]=[];
  if(x.actionType==="hide_review"||x.actionType==="show_review"){if(c.subject_type!=="review")throw new ApiError(409,"This action requires a review subject.");stmts.push(db.prepare("UPDATE reviews SET moderation=? WHERE id=?").bind(x.actionType==="hide_review"?"hidden":"visible",c.subject_id));}
  if(["warn_publisher","restrict_publisher","suspend_publisher"].includes(x.actionType)){
    const accountId=String(c.publishing_account_id||c.subject_id);const acct=await db.prepare("SELECT id FROM publishing_accounts WHERE id=?").bind(accountId).first<any>();if(!acct)throw new ApiError(409,"This case is not linked to a publishing account.");
    const sanctionType=x.actionType==="warn_publisher"?"warning":x.actionType==="restrict_publisher"?"publishing_restriction":"temporary_suspension",strike=x.actionType==="warn_publisher"?1:x.actionType==="restrict_publisher"?3:5;
    if(x.actionType!=="warn_publisher")stmts.push(db.prepare("UPDATE publishing_accounts SET status=?,updated_at=? WHERE id=?").bind(x.actionType==="suspend_publisher"?"suspended":"restricted",at,accountId));
    stmts.push(db.prepare("INSERT INTO moderation_sanctions(id,publishing_account_id,case_id,action_id,sanction_type,strike_points,status,starts_at,created_at) VALUES(?,?,?,?,?,?,'active',?,?)").bind(id("sanction"),accountId,x.caseId,actionId,sanctionType,strike,at,at));
  }
  if(["suppress_title","restore_title","takedown_title","retire_title","copyright_takedown","copyright_restore","impersonation_remove"].includes(x.actionType)){
    const l=await lifecycleForCase(db,c);if(!l)throw new ApiError(409,"This case is not linked to a Cove Publishing release.");
    const restoring=x.actionType==="restore_title"||x.actionType==="copyright_restore";let restoredFrom:string|null=null;
    if(restoring){const prior=await db.prepare("SELECT from_state FROM publishing_lifecycle_events WHERE lifecycle_id=? AND to_state IN ('suppressed','takedown') ORDER BY created_at DESC LIMIT 1").bind(l.id).first<any>();restoredFrom=prior?.from_state?String(prior.from_state):null;}
    const target=restoring&&restoredFrom&&!['suppressed','takedown','retired'].includes(restoredFrom)?restoredFrom:restoring?(l.current_publication_version_id?"live":"approved"):x.actionType==="retire_title"?"retired":(x.actionType==="takedown_title"||x.actionType==="copyright_takedown"||x.actionType==="impersonation_remove")?"takedown":"suppressed";
    const tsColumn=target==="suppressed"?"suppressed_at":target==="takedown"?"takedown_at":target==="retired"?"retired_at":null;
    stmts.push(db.prepare(`UPDATE publishing_release_lifecycles SET state=?,state_reason=?,${tsColumn?`${tsColumn}=?,`:""}updated_at=? WHERE id=?`).bind(...(tsColumn?[target,x.reasonCode||x.actionType,at,at,l.id]:[target,x.reasonCode||x.actionType,at,l.id])));
    const hasServingVersion=!!l.current_publication_version_id,storefrontActive=["preorder","live","updated"].includes(target)||(hasServingVersion&&!["suppressed","takedown","retired"].includes(target));
    if(l.catalog_product_id)stmts.push(db.prepare("UPDATE products SET storefront_status=?,updated_at=? WHERE id=?").bind(storefrontActive?"active":"inactive",at,l.catalog_product_id));
    if(l.catalog_edition_id){const releaseStatus=target==="preorder"?"preorder":storefrontActive?"available":target;stmts.push(db.prepare("UPDATE editions SET release_status=?,updated_at=? WHERE id=?").bind(releaseStatus,at,l.catalog_edition_id));}
    stmts.push(db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?, 'moderation',?,?,?,?)").bind(id("lifeevt"),l.id,l.state,target,staff.userId,x.reasonCode,JSON.stringify({caseId:x.caseId,actionType:x.actionType,restoredFrom}),at));
  }
  if(x.actionType==="copyright_takedown")stmts.push(db.prepare("UPDATE copyright_complaints SET notice_status='actioned',updated_at=? WHERE case_id=?").bind(at,x.caseId));
  if(x.actionType==="copyright_restore")stmts.push(db.prepare("UPDATE copyright_complaints SET notice_status='restored',updated_at=? WHERE case_id=?").bind(at,x.caseId));
  if(x.actionType==="escalate")stmts.push(db.prepare("UPDATE moderation_cases SET priority='urgent',status='in_review',updated_at=? WHERE id=?").bind(at,x.caseId));
  stmts.push(db.prepare("INSERT INTO moderation_actions(id,case_id,staff_user_id,action_type,reason_code,rationale,reversible,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(actionId,x.caseId,staff.userId,x.actionType,x.reasonCode,x.rationale,["no_action","retire_title","escalate"].includes(x.actionType)?0:1,at));
  if(x.actionType!=="escalate")stmts.push(db.prepare(`UPDATE moderation_cases SET status=?,resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END,updated_at=? WHERE id=?`).bind(x.actionType==="no_action"?"resolved":"actioned",x.actionType==="no_action"?"resolved":"actioned",at,at,x.caseId));
  stmts.push(caseEvent(db,x.caseId,"action_applied","staff",staff.userId,{actionId,actionType:x.actionType,reasonCode:x.reasonCode,rationale:x.rationale}));
  await db.batch(stmts);
  if(x.actionType==="hide_review"||x.actionType==="show_review")try{const review=await db.prepare("SELECT user_id,book_id FROM reviews WHERE id=?").bind(c.subject_id).first<any>();if(review?.user_id)await emitNotification(db,{userId:String(review.user_id),eventType:"review_moderated",dedupeKey:`review-moderated:${actionId}:${review.user_id}`,title:x.actionType==="hide_review"?"Your review was moderated":"Your review was restored",body:x.actionType==="hide_review"?(x.rationale||"A Cove moderator hid your review under the review guidelines."):(x.rationale||"A Cove moderator restored your review."),urgency:x.actionType==="hide_review"?"high":"normal",subjectType:"review",subjectId:String(c.subject_id),actionUrl:review.book_id?`/book/${encodeURIComponent(String(review.book_id))}`:"/library",payload:{caseId:x.caseId,actionId,actionType:x.actionType,reasonCode:x.reasonCode}});}catch(e){console.error("Review moderation notification enqueue failed",e);}
  return{id:actionId,actionType:x.actionType};
}

export async function submitModerationAppeal(db: ModerationDB, userId: string, raw: unknown) {
  const x=z.object({caseId:z.string().min(1),actionId:z.string().min(1).optional(),accountId:z.string().min(1),statement:z.string().trim().min(20).max(12000),evidence:z.array(z.string().max(1000)).max(30).default([])}).parse(raw);
  const member=await db.prepare("SELECT 1 ok FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'").bind(x.accountId,userId).first<any>();if(!member)throw new ApiError(403,"You may appeal only for a publishing account you represent.");
  const c=await db.prepare("SELECT * FROM moderation_cases WHERE id=? AND publishing_account_id=?").bind(x.caseId,x.accountId).first<any>();if(!c)throw new ApiError(404,"Appealable moderation case not found.");
  if(!["actioned","resolved","closed"].includes(String(c.status)))throw new ApiError(409,"An appeal may be filed only after a moderation action has been applied or the case has been resolved.");
  const action=x.actionId
    ? await db.prepare("SELECT * FROM moderation_actions WHERE id=? AND case_id=?").bind(x.actionId,x.caseId).first<any>()
    : await db.prepare("SELECT * FROM moderation_actions WHERE case_id=? AND reversible=1 ORDER BY created_at DESC LIMIT 1").bind(x.caseId).first<any>();
  if(!action)throw new ApiError(409,"This case does not have an appealable moderation action.");
  if(Number(action.reversible)!==1)throw new ApiError(409,"The selected moderation action is not appealable through this workflow.");
  const priorActionAppeal=await db.prepare("SELECT id,status FROM moderation_appeals WHERE action_id=? ORDER BY submitted_at DESC LIMIT 1").bind(action.id).first<any>();if(priorActionAppeal)throw new ApiError(409,"This moderation action has already been appealed.");
  const openAppeal=await db.prepare("SELECT id FROM moderation_appeals WHERE case_id=? AND status IN ('submitted','in_review') LIMIT 1").bind(x.caseId).first<any>();if(openAppeal)throw new ApiError(409,"This moderation case already has an open appeal.");
  const appealId=id("appeal"),at=now();await db.batch([
    db.prepare("INSERT INTO moderation_appeals(id,case_id,action_id,appellant_user_id,publishing_account_id,statement,evidence_json,status,submitted_at) VALUES(?,?,?,?,?,?,?,'submitted',?)").bind(appealId,x.caseId,action.id,userId,x.accountId,x.statement,JSON.stringify(x.evidence),at),
    db.prepare("UPDATE moderation_cases SET status='appealed',queue='appeals',updated_at=? WHERE id=?").bind(at,x.caseId),
    caseEvent(db,x.caseId,"appeal_submitted","publisher",userId,{appealId,actionId:action.id})
  ]);return{id:appealId,status:"submitted",actionId:action.id};
}

export async function decideModerationAppeal(db: ModerationDB, staff: StaffContext, raw: unknown) {
  const x=z.object({appealId:z.string().min(1),decision:z.enum(["granted","denied"]),notes:z.string().max(10000).default("")}).parse(raw),appeal=await db.prepare("SELECT * FROM moderation_appeals WHERE id=? AND status IN ('submitted','in_review')").bind(x.appealId).first<any>();if(!appeal)throw new ApiError(404,"Open appeal not found.");const at=now();await db.batch([db.prepare("UPDATE moderation_appeals SET status=?,decided_by_user_id=?,decision_notes=?,decided_at=? WHERE id=?").bind(x.decision,staff.userId,x.notes,at,x.appealId),db.prepare("UPDATE moderation_cases SET status=?,updated_at=?,resolved_at=? WHERE id=?").bind(x.decision==="granted"?"in_review":"resolved",at,x.decision==="denied"?at:null,appeal.case_id),caseEvent(db,String(appeal.case_id),"appeal_decided","staff",staff.userId,{appealId:x.appealId,decision:x.decision,notes:x.notes})]);return{saved:true};
}

async function publishingAccountForSubject(db: ModerationDB, subjectType: string, subjectId: string) {
  let row:any=null;
  if(subjectType==="publishing_account") row=await db.prepare("SELECT id account_id FROM publishing_accounts WHERE id=?").bind(subjectId).first<any>();
  else if(subjectType==="title") row=await db.prepare("SELECT account_id FROM publishing_titles WHERE id=?").bind(subjectId).first<any>();
  else if(subjectType==="edition") row=await db.prepare("SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?").bind(subjectId).first<any>();
  else if(subjectType==="publication") row=await db.prepare("SELECT publishing_account_id account_id FROM publishing_publications WHERE id=?").bind(subjectId).first<any>();
  else if(subjectType==="publisher") row=await db.prepare("SELECT id account_id FROM publishing_accounts WHERE publisher_id=? OR id=? ORDER BY CASE WHEN publisher_id=? THEN 0 ELSE 1 END LIMIT 1").bind(subjectId,subjectId,subjectId).first<any>();
  else if(subjectType==="author") row=await db.prepare("SELECT account_id FROM publishing_pen_names WHERE contributor_id=? OR id=? ORDER BY updated_at DESC LIMIT 1").bind(subjectId,subjectId).first<any>();
  return row?.account_id?String(row.account_id):null;
}

async function verifiedSubjectPublishingAccount(db: ModerationDB, subjectType: string, subjectId: string, claimed: string|null|undefined) {
  const resolved=await publishingAccountForSubject(db,subjectType,subjectId);
  if(resolved&&claimed&&resolved!==claimed)throw new ApiError(400,"The supplied publishing account does not own the reported subject.");
  return resolved;
}

export async function submitCopyrightComplaint(db:ModerationDB,userId:string|null,raw:unknown){
  const x=z.object({subjectType:z.enum(["title","edition","author","publisher","publication"]),subjectId:z.string().min(1).max(240),publishingAccountId:z.string().max(240).nullable().optional(),claimantName:z.string().trim().min(2).max(240),claimantEmail:z.string().email(),representedParty:z.string().max(240).default(""),workDescription:z.string().trim().min(20).max(12000),allegedlyInfringingUrl:z.string().url().or(z.literal("")).default(""),goodFaithAttestation:z.literal(true),accuracyAttestation:z.literal(true),signatureName:z.string().trim().min(2).max(240)}).parse(raw);
  const publishingAccountId=await verifiedSubjectPublishingAccount(db,x.subjectType,x.subjectId,x.publishingAccountId);
  const c=await createModerationCase(db,{subjectType:x.subjectType,subjectId:x.subjectId,publishingAccountId,category:"copyright",queue:"copyright",priority:"high",sourceType:"copyright_notice",riskScore:60,summary:`Copyright complaint regarding ${x.subjectType} ${x.subjectId}.`,reporterUserId:userId,reasonCode:"copyright",details:x.workDescription});
  const complaintId=id("copyright"),at=now();await db.batch([db.prepare("INSERT INTO copyright_complaints(id,case_id,complainant_user_id,claimant_name,claimant_email,represented_party,work_description,allegedly_infringing_url,good_faith_attestation,accuracy_attestation,signature_name,notice_status,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1,?,'received',?,?)").bind(complaintId,c.id,userId,x.claimantName,x.claimantEmail.toLowerCase(),x.representedParty,x.workDescription,x.allegedlyInfringingUrl,x.signatureName,at,at),caseEvent(db,c.id,"copyright_notice_received",userId?"reporter":"system",userId,{complaintId})]);return{id:complaintId,caseId:c.id,status:"received"};
}

export async function submitAbuseReport(db:ModerationDB,userId:string|null,raw:unknown){
  const x=z.object({subjectType:z.enum(["review","title","edition","author","publisher","publishing_account","publication","user"]),subjectId:z.string().min(1).max(240),publishingAccountId:z.string().max(240).nullable().optional(),reason:z.enum(["spam","scam","impersonation","harassment","misleading","copyright","other"]),details:z.string().max(5000).default("")}).parse(raw);
  const queue=x.reason==="scam"?"fraud":x.reason==="impersonation"?"impersonation":x.subjectType==="review"?"reviews":x.subjectType==="author"?"authors":"titles";
  const publishingAccountId=await verifiedSubjectPublishingAccount(db,x.subjectType,x.subjectId,x.publishingAccountId);
  return createModerationCase(db,{subjectType:x.subjectType,subjectId:x.subjectId,publishingAccountId,category:x.reason,queue,priority:["scam","impersonation","copyright"].includes(x.reason)?"high":"normal",sourceType:"user_report",riskScore:x.reason==="scam"?50:x.reason==="impersonation"?45:20,summary:`${x.reason} report for ${x.subjectType} ${x.subjectId}`,reporterUserId:userId,reasonCode:x.reason,details:x.details});
}

