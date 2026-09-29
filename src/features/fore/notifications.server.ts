import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";

type DB=CoveEnv["DB"];
const uid=(p:string)=>`${p}_${crypto.randomUUID()}`;
const EVENT_TYPES=["purchase_receipt","preorder_released","author_new_book","wishlist_price_drop","subscription_billing","payment_failed","publisher_book_approved","publisher_book_rejected","royalty_statement_ready","payout_sent","review_moderated","account_security_alert","social_follow","social_reply","social_club_invite","author_social_post"] as const;
export type NotificationEventType=typeof EVENT_TYPES[number];
export type NotificationInput={
  userId:string; eventType:NotificationEventType; dedupeKey:string; title:string; body:string;
  topic?:string; urgency?:"low"|"normal"|"high"|"critical"; productId?:string|null;
  subjectType?:string; subjectId?:string; actionUrl?:string; payload?:Record<string,unknown>;
  forceChannels?:Array<"email"|"web_push"|"mobile_push"|"in_app">;
  allowedChannels?:Array<"email"|"web_push"|"mobile_push"|"in_app">;
};

const TOPIC_BY_EVENT:Record<NotificationEventType,string>={
  purchase_receipt:"orders",preorder_released:"preorders",author_new_book:"authorReleases",wishlist_price_drop:"priceDrops",
  subscription_billing:"billing",payment_failed:"billing",publisher_book_approved:"publishing",publisher_book_rejected:"publishing",
  royalty_statement_ready:"royalties",payout_sent:"payouts",review_moderated:"reviews",account_security_alert:"security",social_follow:"social",social_reply:"social",social_club_invite:"social",author_social_post:"authorReleases",
};
const REQUIRED_TOPICS=new Set(["security"]);
const DEFAULT_TOPICS:Record<string,boolean>={orders:true,preorders:true,authorReleases:true,priceDrops:true,billing:true,publishing:true,royalties:true,payouts:true,reviews:true,security:true,social:true};
function parseJson(v:any,f:any){try{return JSON.parse(String(v||""));}catch{return f;}}
async function sha256(v:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");}

export async function notificationPreferences(db:DB,userId:string){
  const row=await db.prepare("SELECT * FROM notification_preferences WHERE user_id=?").bind(userId).first<any>();
  if(!row)return{email:true,inApp:true,webPush:false,mobilePush:false,topics:{...DEFAULT_TOPICS},quietHours:{},timezone:"UTC"};
  return{email:!!row.email_enabled,inApp:!!row.in_app_enabled,webPush:!!row.web_push_enabled,mobilePush:!!row.mobile_push_enabled,topics:{...DEFAULT_TOPICS,...parseJson(row.topic_preferences_json,{})},quietHours:parseJson(row.quiet_hours_json,{}),timezone:row.timezone||"UTC"};
}
export async function saveNotificationPreferences(db:DB,userId:string,raw:unknown){
  const x=z.object({email:z.boolean(),inApp:z.boolean(),webPush:z.boolean(),mobilePush:z.boolean().default(false),topics:z.record(z.boolean()).default({}),quietHours:z.record(z.any()).default({}),timezone:z.string().min(1).max(80).default("UTC")}).parse(raw);
  x.topics.security=true;
  await db.prepare(`INSERT INTO notification_preferences(user_id,email_enabled,in_app_enabled,web_push_enabled,mobile_push_enabled,topic_preferences_json,quiet_hours_json,timezone,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled,in_app_enabled=excluded.in_app_enabled,web_push_enabled=excluded.web_push_enabled,mobile_push_enabled=excluded.mobile_push_enabled,topic_preferences_json=excluded.topic_preferences_json,quiet_hours_json=excluded.quiet_hours_json,timezone=excluded.timezone,updated_at=excluded.updated_at`)
    .bind(userId,Number(x.email),Number(x.inApp),Number(x.webPush),Number(x.mobilePush),JSON.stringify(x.topics),JSON.stringify(x.quietHours),x.timezone,now()).run();
  return notificationPreferences(db,userId);
}

export async function registerPushEndpoint(db:DB,userId:string,raw:unknown,request:Request){
  const x=z.object({channel:z.enum(["web_push","mobile_push"]),platform:z.string().max(40).default("web"),endpoint:z.string().min(8).max(4096),p256dh:z.string().max(1024).default(""),auth:z.string().max(1024).default(""),providerToken:z.string().max(4096).default("")}).parse(raw);
  if(x.channel==="web_push"&&(!x.p256dh||!x.auth))throw new ApiError(400,"A Web Push subscription must include p256dh and auth keys.");
  const h=await sha256(x.endpoint),at=now(),existing=await db.prepare("SELECT id FROM notification_push_endpoints WHERE user_id=? AND channel=? AND endpoint_hash=?").bind(userId,x.channel,h).first<any>(),id=existing?.id||uid("push");
  if(existing)await db.prepare("UPDATE notification_push_endpoints SET platform=?,endpoint=?,p256dh=?,auth_secret=?,provider_token=?,user_agent=?,last_seen_at=?,revoked_at=NULL WHERE id=?").bind(x.platform,x.endpoint,x.p256dh,x.auth,x.providerToken,(request.headers.get("user-agent")||"").slice(0,240),at,id).run();
  else await db.prepare("INSERT INTO notification_push_endpoints(id,user_id,channel,platform,endpoint_hash,endpoint,p256dh,auth_secret,provider_token,user_agent,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,userId,x.channel,x.platform,h,x.endpoint,x.p256dh,x.auth,x.providerToken,(request.headers.get("user-agent")||"").slice(0,240),at,at).run();
  return{id,channel:x.channel,platform:x.platform};
}
export async function revokePushEndpoint(db:DB,userId:string,id:string){await db.prepare("UPDATE notification_push_endpoints SET revoked_at=? WHERE id=? AND user_id=?").bind(now(),id,userId).run();return{revoked:true};}

async function userEmail(db:DB,userId:string){const a=await db.prepare("SELECT email FROM auth_accounts WHERE app_id=?").bind(userId).first<any>();if(a?.email)return String(a.email);const c=await db.prepare("SELECT email FROM commerce_customers WHERE user_id=?").bind(userId).first<any>();return String(c?.email||"");}
function channelEnabled(p:any,topic:string,channel:string,forced?:string[],allowed?:string[]){if(allowed&&!allowed.includes(channel))return false;if(forced?.includes(channel))return true;if(REQUIRED_TOPICS.has(topic)&&channel==="in_app")return true;if(p.topics?.[topic]===false&&!REQUIRED_TOPICS.has(topic))return false;if(channel==="in_app")return p.inApp;if(channel==="email")return p.email;if(channel==="web_push")return p.webPush;if(channel==="mobile_push")return p.mobilePush;return false;}

export async function emitNotification(db:DB,input:NotificationInput){
  const topic=input.topic||TOPIC_BY_EVENT[input.eventType],at=now(),existing=await db.prepare("SELECT id FROM notification_events WHERE user_id=? AND dedupe_key=?").bind(input.userId,input.dedupeKey).first<any>();
  if(existing)return{id:existing.id,deduped:true};
  const id=uid("notice");
  await db.prepare("INSERT INTO notification_events(id,user_id,event_type,topic,urgency,dedupe_key,subject_type,subject_id,product_id,title,body,action_url,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,input.userId,input.eventType,topic,input.urgency||"normal",input.dedupeKey,input.subjectType||"",input.subjectId||"",input.productId||null,input.title,input.body,input.actionUrl||"",JSON.stringify(input.payload||{}),at).run();
  const p=await notificationPreferences(db,input.userId);
  if(channelEnabled(p,topic,"in_app",input.forceChannels,input.allowedChannels))await db.prepare("INSERT OR IGNORE INTO notification_inbox(notification_id,user_id,created_at) VALUES(?,?,?)").bind(id,input.userId,at).run();
  if(channelEnabled(p,topic,"email",input.forceChannels,input.allowedChannels)){
    const email=await userEmail(db,input.userId);if(email)await db.prepare("INSERT OR IGNORE INTO notification_delivery_jobs(id,notification_id,user_id,channel,destination_ref,status,attempts,available_at,created_at,updated_at) VALUES(?,?,?,'email',?,'pending',0,?,?,?)").bind(uid("ndj"),id,input.userId,email,at,at,at).run();
  }
  for(const channel of ["web_push","mobile_push"] as const)if(channelEnabled(p,topic,channel,input.forceChannels,input.allowedChannels)){
    const eps=(await db.prepare("SELECT id,endpoint FROM notification_push_endpoints WHERE user_id=? AND channel=? AND revoked_at IS NULL").bind(input.userId,channel).all<any>()).results;
    for(const ep of eps)await db.prepare("INSERT OR IGNORE INTO notification_delivery_jobs(id,notification_id,user_id,channel,endpoint_id,destination_ref,status,attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)").bind(uid("ndj"),id,input.userId,channel,ep.id,ep.endpoint,at,at,at).run();
  }
  return{id,deduped:false};
}

export async function notificationInbox(db:DB,userId:string,opts:{limit?:number;unreadOnly?:boolean}={}){
  const limit=Math.max(1,Math.min(100,opts.limit||50)),where=opts.unreadOnly?" AND i.read_at IS NULL":"";
  const rows=(await db.prepare(`SELECT n.*,i.read_at,i.archived_at FROM notification_inbox i JOIN notification_events n ON n.id=i.notification_id WHERE i.user_id=? AND i.archived_at IS NULL${where} ORDER BY n.created_at DESC LIMIT ?`).bind(userId,limit).all<any>()).results.map((r:any)=>({...r,payload:parseJson(r.payload_json,{})}));
  const unread=Number((await db.prepare("SELECT COUNT(*) c FROM notification_inbox WHERE user_id=? AND read_at IS NULL AND archived_at IS NULL").bind(userId).first<any>())?.c||0);
  return{items:rows,unread};
}
export async function markNotifications(db:DB,userId:string,raw:unknown){const x=z.object({ids:z.array(z.string()).max(100).default([]),all:z.boolean().default(false),archive:z.boolean().default(false)}).parse(raw),at=now();if(x.all){await db.prepare(x.archive?"UPDATE notification_inbox SET read_at=COALESCE(read_at,?),archived_at=? WHERE user_id=?":"UPDATE notification_inbox SET read_at=COALESCE(read_at,?) WHERE user_id=?").bind(...(x.archive?[at,at,userId]:[at,userId])).run();}else for(const id of x.ids)await db.prepare(x.archive?"UPDATE notification_inbox SET read_at=COALESCE(read_at,?),archived_at=? WHERE notification_id=? AND user_id=?":"UPDATE notification_inbox SET read_at=COALESCE(read_at,?) WHERE notification_id=? AND user_id=?").bind(...(x.archive?[at,at,id,userId]:[at,id,userId])).run();return notificationInbox(db,userId);}

function providerConfig(env:CoveEnv,channel:string){if(channel==="email")return{url:env.FORE_EMAIL_API_URL,key:env.FORE_EMAIL_API_KEY,provider:"email-bridge"};if(channel==="web_push")return{url:env.FORE_WEB_PUSH_API_URL,key:env.FORE_PUSH_API_KEY,provider:"web-push-bridge"};return{url:env.FORE_MOBILE_PUSH_API_URL,key:env.FORE_PUSH_API_KEY,provider:"mobile-push-bridge"};}
export async function processNotificationDeliveryQueue(env:CoveEnv,limit=50){
  const db=env.DB,at=now(),leaseUntil=new Date(Date.now()+60_000).toISOString(),jobs=(await db.prepare("SELECT * FROM notification_delivery_jobs WHERE ((status IN ('pending','retry') AND available_at<=?) OR (status='leased' AND leased_until<=?)) ORDER BY available_at,created_at LIMIT ?").bind(at,at,Math.max(1,Math.min(200,limit))).all<any>()).results;let sent=0,retry=0,suppressed=0;
  for(const job of jobs){
    await db.prepare("UPDATE notification_delivery_jobs SET status='leased',leased_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND (status IN ('pending','retry') OR (status='leased' AND leased_until<=?))").bind(leaseUntil,at,job.id,at).run();
    const fresh=await db.prepare("SELECT * FROM notification_delivery_jobs WHERE id=?").bind(job.id).first<any>();if(!fresh||fresh.status!=="leased")continue;
    const n=await db.prepare("SELECT * FROM notification_events WHERE id=?").bind(job.notification_id).first<any>(),cfg=providerConfig(env,job.channel),attempt=Number(fresh.attempts||1);
    if(!cfg.url){await db.batch([db.prepare("UPDATE notification_delivery_jobs SET status='suppressed',last_error='provider_not_configured',leased_until=NULL,updated_at=? WHERE id=?").bind(now(),job.id),db.prepare("INSERT OR IGNORE INTO notification_delivery_attempts(id,delivery_job_id,attempt_number,provider,outcome,error_code,error_detail,attempted_at) VALUES(?,?,?,?,'suppressed','provider_not_configured','Outbound provider bridge is not configured.',?)").bind(uid("nda"),job.id,attempt,cfg.provider,now())]);suppressed++;continue;}
    try{
      const endpoint=job.endpoint_id?await db.prepare("SELECT * FROM notification_push_endpoints WHERE id=? AND revoked_at IS NULL").bind(job.endpoint_id).first<any>():null;if(job.endpoint_id&&!endpoint)throw new Error("push_endpoint_revoked");
      const r=await fetch(cfg.url,{method:"POST",headers:{"content-type":"application/json",...(cfg.key?{authorization:`Bearer ${cfg.key}`}:{})},body:JSON.stringify({channel:job.channel,to:job.destination_ref,notification:{id:n.id,type:n.event_type,title:n.title,body:n.body,actionUrl:n.action_url,urgency:n.urgency,payload:parseJson(n.payload_json,{})},subscription:endpoint?{endpoint:endpoint.endpoint,p256dh:endpoint.p256dh,auth:endpoint.auth_secret,providerToken:endpoint.provider_token,platform:endpoint.platform}:undefined}),signal:AbortSignal.timeout(10_000)});
      const response:any=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(String(response?.error||`provider_${r.status}`)),{status:r.status});const pmid=String(response?.id||response?.messageId||"");
      await db.batch([db.prepare("UPDATE notification_delivery_jobs SET status='sent',provider_message_id=?,sent_at=?,leased_until=NULL,last_error='',updated_at=? WHERE id=?").bind(pmid,now(),now(),job.id),db.prepare("INSERT OR IGNORE INTO notification_delivery_attempts(id,delivery_job_id,attempt_number,provider,outcome,http_status,provider_message_id,attempted_at) VALUES(?,?,?,?,'sent',?,?,?)").bind(uid("nda"),job.id,attempt,cfg.provider,r.status,pmid,now())]);sent++;
    }catch(e:any){const dead=attempt>=6,delay=Math.min(3600,Math.pow(2,attempt)*30),next=new Date(Date.now()+delay*1000).toISOString(),message=String(e?.message||e).slice(0,500);await db.batch([db.prepare("UPDATE notification_delivery_jobs SET status=?,available_at=?,leased_until=NULL,last_error=?,updated_at=? WHERE id=?").bind(dead?"dead":"retry",next,message,now(),job.id),db.prepare("INSERT OR IGNORE INTO notification_delivery_attempts(id,delivery_job_id,attempt_number,provider,outcome,http_status,error_code,error_detail,attempted_at) VALUES(?,?,?,? ,?, ?,?,?,?)").bind(uid("nda"),job.id,attempt,cfg.provider,dead?"failed":"retry",Number(e?.status||0)||null,"delivery_error",message,now())]);retry++;}
  }
  return{processed:jobs.length,sent,retry,suppressed};
}
