/* eslint-disable prettier/prettier -- Owner-only, journaled distribution contract version mutation. */
import {saveContractVersion} from "../features/fore/traditional-publishing.server";
import type {CatalogDB} from "../features/fore/catalog-model.server";
import type {AuthoritySql} from "./legal-authority-core";
import {denyCommercialSubject} from "./commercial-legal-core";

type Input={actorUserId:string;operationId:string;contract:Record<string,unknown>};
type Receipt={schema:"cove.owner-contract-version.v1";ownerFirst:true;operationId:string;
  contractId:string;id:string;versionNumber:number;status:string;ownerDenied:boolean;stored:true};
const identity=/^[a-zA-Z0-9_-]{3,160}$/;
const operation=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/;
const statuses=new Set(["draft","active","superseded","terminated"]);
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const fail=(message:string):never=>{throw Error(message);};
export function createContractVersionOwnerSchema(sql:AuthoritySql){
  sql.exec("CREATE TABLE IF NOT EXISTS cove_owner_contract_version_commands (operation_id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','completed')), receipt_json TEXT)");
}
/** The owner must independently revalidate staff authority and contract identity.
 * Production never enters this method without the existing time-bounded QA lease.
 * Pending commands are NOT retried blindly across primary D1 crash windows.
 */
export async function executeOwnerContractVersion(ctx:{
  primary:CatalogDB;sql:AuthoritySql;executing:Set<string>;
  transactionSync<T>(fn:()=>T):T;
},raw:unknown):Promise<Receipt>{
  if(!isRecord(raw)||Object.keys(raw).sort().join(",")!=="actorUserId,contract,operationId"||
    typeof raw.actorUserId!=="string"||!identity.test(raw.actorUserId)||
    typeof raw.operationId!=="string"||!operation.test(raw.operationId)||
    !isRecord(raw.contract))return fail("owner_contract_invalid_command");
  const input=raw as Input,contractId=input.contract.contractId;
  if(typeof contractId!=="string"||!identity.test(contractId)||
    !Number.isSafeInteger(input.contract.versionNumber)||Number(input.contract.versionNumber)<1||
    (input.contract.status!==undefined&&!statuses.has(String(input.contract.status))))
    return fail("owner_contract_invalid_scope");
  const lock=contractId;
  if(ctx.executing.has(lock))return fail("owner_contract_concurrent_version");
  ctx.executing.add(lock);
  try {
    const payload=JSON.stringify([input.actorUserId,input.contract]);
    const payloadSha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(payload)))]
      .map(v=>v.toString(16).padStart(2,"0")).join("");
    const old=ctx.sql.exec<{payload_sha256:string;state:string;receipt_json:string|null}>(
      "SELECT payload_sha256,state,receipt_json FROM cove_owner_contract_version_commands WHERE operation_id=?",
      input.operationId).toArray()[0];
    if(old){
      if(old.payload_sha256!==payloadSha256)return fail("owner_contract_operation_collision");
      if(old.state!=="completed"||!old.receipt_json)return fail("owner_contract_pending_recovery_required");
      return JSON.parse(old.receipt_json) as Receipt;
    }
    // Do not trust the staff check performed by the outer API: it may have
    // changed before the private owner commits, or the caller may be forged.
    const permission=await ctx.primary.prepare(
      "SELECT 1 ok FROM staff_principals p JOIN staff_principal_roles r ON r.user_id=p.user_id JOIN staff_role_permissions pr ON pr.role_id=r.role_id WHERE p.user_id=? AND p.status='active' AND pr.permission IN ('finance.contract.manage','staff.manage') LIMIT 1"
    ).bind(input.actorUserId).first<{ok:number}>();
    if(!permission)return fail("owner_contract_staff_permission_denied");
    const contract=await ctx.primary.prepare(
      "SELECT id,status FROM rights_contracts WHERE id=?"
    ).bind(contractId).first<{id:string;status:string}>();
    if(!contract||contract.status!=="active")return fail("owner_contract_not_active");
    // Draft updates do not change a live grant. Non-draft transitions always
    // deny rights at the owner first; positive reauthorization is a separate
    // independently verified command, never an implication of this write.
    const status=String(input.contract.status||"draft"),deny=status!=="draft";
    ctx.transactionSync(()=>{
      ctx.sql.exec("INSERT INTO cove_owner_contract_version_commands(operation_id,payload_sha256,state) VALUES(?,?,'pending')",
        input.operationId,payloadSha256);
      if(deny)denyCommercialSubject(ctx.sql,{subjectKind:"contract",subjectId:contractId,
        operationId:"contract:"+input.operationId});
    });
    const result=await saveContractVersion(ctx.primary,input.actorUserId,input.contract);
    if(result.contractId!==contractId||result.versionNumber!==input.contract.versionNumber||
      result.status!==status||typeof result.id!=="string"||!identity.test(result.id))
      return fail("owner_contract_primary_receipt_mismatch");
    const current=await ctx.primary.prepare(
      "SELECT status,version_number FROM rights_contract_versions WHERE id=? AND contract_id=?"
    ).bind(result.id,contractId).first<{status:string;version_number:number}>();
    if(current?.status!==status||current.version_number!==result.versionNumber)
      return fail("owner_contract_primary_completion_not_verified");
    const receipt:Receipt={schema:"cove.owner-contract-version.v1",ownerFirst:true,
      operationId:input.operationId,contractId,id:result.id,versionNumber:result.versionNumber,
      status,ownerDenied:deny,stored:true};
    ctx.transactionSync(()=>{
      ctx.sql.exec("UPDATE cove_owner_contract_version_commands SET state='completed',receipt_json=? WHERE operation_id=? AND state='pending'",
        JSON.stringify(receipt),input.operationId);
    });
    return receipt;
  }finally{ctx.executing.delete(lock);}
}
