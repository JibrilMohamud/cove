/* eslint-disable prettier/prettier -- Owner proof is a customer-access trust boundary. */
import {ApiError} from "../features/fore/service";

export type StageLegalConsumerEnv={
  COVE_SSR_STAGING?:string;
  COVE_CANONICAL_LEGAL_WRITE_LOCK?:string;
  COVE_LEGAL_CONSUMER_STAGE_ENABLED?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
  LEGAL_AUTHORITY?:{getByName(name:string):{fetch(request:Request):Promise<Response>}};
};
type ConsumerProduct={
  id:string;source_name:string;source_external_id?:string|null;
  expectedEditionId?:string|null;expectedGrantId?:string|null;
  expectedContractVersionId?:string|null;
};
const productPattern=/^prd_gutenberg_(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/;
// These exact synthetic QA databases are segregated from both production and
// the 100-RPS capacity fixture. The second has canonical paid-order schema.
// No production D1 identifier can enable the staging customer authorization.
const QA_PRIMARY_IDS=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87","7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);
/** A paid buyer's delivery is authorized only if BOTH the current paid
 * product grant and exact buyer entitlement are present in the same private
 * owner snapshot. This is a single RPC + a single indexed SQLite read;
 * existing device, publisher distribution and fraud controls remain required.
 */
export async function requireStagePaidEntitlementAccess(
  env:StageLegalConsumerEnv,
  input:{
    entitlementId:string;userId:string;productId:string;territory:string;
    channel:"retail"|"subscription"|"library";
  }
) {
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1")return;
  if(env.COVE_SSR_STAGING!=="1" ||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1" ||
     !QA_PRIMARY_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"") ||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"") ||
     !env.LEGAL_AUTHORITY?.getByName ||
     !input||typeof input.entitlementId!=="string"||
     !/^[a-zA-Z0-9_-]{8,160}$/.test(input.entitlementId) ||
     typeof input.userId!=="string" ||
     !/^[a-zA-Z0-9_-]{8,160}$/.test(input.userId) ||
     typeof input.productId!=="string" ||
     !commercialPattern.test(input.productId) ||
     input.productId.startsWith("prd_gutenberg_") ||
     !/^[A-Z]{2}$/.test(input.territory) ||
     !["retail","subscription","library"].includes(input.channel))
    throw new ApiError(503,"Paid entitlement owner is not configured or scoped.");
  let payload:unknown;
  try {
    const response=await env.LEGAL_AUTHORITY
      .getByName("cove-staged-legal-global-v1")
      .fetch(new Request("https://legal-authority.internal/commercial/entitlement/authorize",{
        method:"POST",
        headers:{"authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
          "content-type":"application/json"},
        body:JSON.stringify(input)
      }));
    if(response.status!==200)throw Error("owner_outage");
    payload=await response.json();
  }catch{
    throw new ApiError(503,"Protected paid-entitlement owner unavailable.");
  }
  const result=payload as {schema?:unknown;allowed?:unknown;proof?:Record<string,unknown>}|null;
  if(!result||result.schema!=="cove.paid-access.v1")
    throw new ApiError(503,"Paid-entitlement proof malformed.");
  if(result.allowed!==true)
    throw new ApiError(451,"This purchase's distribution or entitlement access is not authorized.");
  const proof=result.proof;
  // A positive owner response is never a transferable bearer allowance.
  // Bind the returned immutable purchase scope to THIS authorization call,
  // even if a private service is misconfigured or a previous proof is replayed.
  if(!proof||
     proof.entitlement_id!==input.entitlementId ||
     proof.user_id!==input.userId ||
     proof.product_id!==input.productId ||
     proof.territory!==input.territory ||
     proof.channel!==input.channel ||
     typeof proof.order_id!=="string" ||
     !/^[a-zA-Z0-9_-]{8,160}$/.test(proof.order_id) ||
     typeof proof.edition_id!=="string"||
     !/^[a-zA-Z0-9_-]{3,160}$/.test(proof.edition_id) ||
     typeof proof.grant_id!=="string"||
     !/^[a-zA-Z0-9_-]{3,180}$/.test(proof.grant_id)||
     typeof proof.contract_id!=="string"||
     !/^[a-zA-Z0-9_-]{3,180}$/.test(proof.contract_id)||
     typeof proof.contract_version_id!=="string"||
     !/^[a-zA-Z0-9_-]{3,180}$/.test(proof.contract_version_id)||
     !Number.isSafeInteger(proof.product_epoch) ||
     Number(proof.product_epoch)<=0 ||
     !Number.isSafeInteger(proof.entitlement_epoch) ||
     Number(proof.entitlement_epoch)<=0 ||
     typeof proof.valid_until!=="string"||
     !Number.isFinite(Date.parse(proof.valid_until)) ||
     Date.parse(proof.valid_until)<=Date.now())
    throw new ApiError(503,"Paid entitlement proof expired or corrupt.");
}

const commercialPattern=/^prd_[a-zA-Z0-9_-]{3,120}$/;
type CommercialProofRow={
  product_id?:unknown;edition_id?:unknown;grant_id?:unknown;
  contract_id?:unknown;contract_version_id?:unknown;valid_until?:unknown;
  epoch?:unknown;
};
/** Strong authority is checked for authenticated commercial actions only.
 * The owner snapshot proves current *product rights*; the existing primary
 * purchase/entitlement and contract delivery checks are additional mandatory
 * conditions. Product proof alone NEVER creates an entitlement.
 */
async function authorizeStageCommercialProducts(
  env:StageLegalConsumerEnv,products:ConsumerProduct[],territory:string,
  channel:"retail"|"subscription"|"library"
) {
  const ids=products.map(p=>p.id);
  if(ids.some(id=>!commercialPattern.test(id)||
      id.startsWith("prd_gutenberg_")) || new Set(ids).size!==ids.length)
    throw new ApiError(503,"Commercial product identity is not canonical.");
  let rows:unknown;
  try {
    const response=await env.LEGAL_AUTHORITY!.getByName("cove-staged-legal-global-v1")
      .fetch(new Request("https://legal-authority.internal/commercial/authorize-batch",{
        method:"POST",headers:{"content-type":"application/json",
          "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET},
        body:JSON.stringify({ids,territory,channel})
      }));
    if(response.status!==200)throw Error("commercial_owner_unavailable");
    const parsed=await response.json() as {schema?:unknown;rows?:unknown};
    if(parsed?.schema!=="cove.commercial-legal.v1"||
       !Array.isArray(parsed.rows))throw Error("commercial_owner_invalid");
    rows=parsed.rows;
  }catch{
    throw new ApiError(503,"Independent commercial rights authority unavailable.");
  }
  const results=rows as CommercialProofRow[];
  if(results.length!==ids.length)
    throw new ApiError(451,"Commercial distribution rights are withdrawn or not yet authorized.");
  const observed=new Set<string>();
  const expected=new Map(products.map(p=>[p.id,p]));
  for(const p of results){
    if(!p||typeof p.product_id!=="string"||
       !ids.includes(p.product_id)||observed.has(p.product_id)||
       typeof p.edition_id!=="string"||
       !/^[a-zA-Z0-9_-]{3,160}$/.test(p.edition_id) ||
       typeof p.grant_id!=="string"||
       !/^[a-zA-Z0-9_-]{3,180}$/.test(p.grant_id) ||
       typeof p.contract_id!=="string"||
       !/^[a-zA-Z0-9_-]{3,180}$/.test(p.contract_id) ||
       typeof p.contract_version_id!=="string"||
       !/^[a-zA-Z0-9_-]{3,180}$/.test(p.contract_version_id) ||
       typeof p.valid_until!=="string"||
       !Number.isFinite(Date.parse(p.valid_until))||
       Date.parse(p.valid_until)<=Date.now()||
       !Number.isSafeInteger(p.epoch)||Number(p.epoch)<=0)
      throw new ApiError(503,"Commercial legal proof identity or epoch invalid.");
    const exact=expected.get(p.product_id);
    if(!exact ||
       (exact.expectedEditionId!==undefined &&
         p.edition_id!==exact.expectedEditionId) ||
       (exact.expectedGrantId!==undefined &&
         p.grant_id!==exact.expectedGrantId) ||
       (exact.expectedContractVersionId!==undefined &&
         p.contract_version_id!==exact.expectedContractVersionId))
      throw new ApiError(503,"Commercial grant or contract version differs from canonical pricing.");
    observed.add(p.product_id);
  }
}


/**
 * Opt-in QA consumer fence for detail, checkout, EPUB and offline licensing.
 * Fail closed for products whose positive legal model is not yet migrated:
 * paid editions MUST NOT inherit a Gutenberg public-domain grant.
 * This does not make an independent rights owner production ready.
 */
export async function requireStageLegalConsumerProof(
  env:StageLegalConsumerEnv,
  products:ConsumerProduct[],
  territory:string,
  currency:string
):Promise<void>{
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1")return;
  if(env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1" ||
     !QA_PRIMARY_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"") ||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"") ||
     !env.LEGAL_AUTHORITY?.getByName ||
     !/^[A-Z]{2}$/.test(territory)||!/^[A-Z]{3}$/.test(currency))
    throw new ApiError(503,"The legal-owner consumer cutover is not certified.");
  if(!Array.isArray(products)||products.length>25||
     products.some(p=>!p||typeof p.id!=="string"||
       typeof p.source_name!=="string"))
    throw new ApiError(503,"Unbounded legal-owner consumer authorization.");
  // Personal imports are checked by their existing user-bound ownership path
  // and must never become public catalog products. They are not storefront
  // rights grants and cannot be covered by a public-domain owner proof.
  const publicProducts=products.filter(p=>p.source_name!=="upload");
  if(!publicProducts.length)return;
  const paid=publicProducts.filter(p=>p.source_name!=="gutenberg");
  if(paid.length)await authorizeStageCommercialProducts(env,paid,territory,"retail");
  const free=publicProducts.filter(p=>p.source_name==="gutenberg");
  if(!free.length)return;
  if(free.some(p=>!productPattern.test(p.id) ||
       p.id!=="prd_gutenberg_"+p.source_external_id))
    throw new ApiError(503,"Public-domain source identity mismatch.");
  const ids=free.map(p=>p.id);
  if(new Set(ids).size!==ids.length)
    throw new ApiError(503,"Duplicate legal-owner product.");
  let rows:unknown;
  try{
    const response=await env.LEGAL_AUTHORITY
      .getByName("cove-staged-legal-global-v1")
      .fetch(new Request("https://legal-authority.internal/authorize-batch",{
        method:"POST",
        headers:{"content-type":"application/json",
          "authorization":"Bearer "+env.COVE_RIGHTS_OWNER_SECRET},
        body:JSON.stringify({ids,territory,currency})
      }));
    if(response.status!==200)
      throw Error("owner_unavailable");
    const payload=await response.json() as {schema?:unknown;rows?:unknown};
    if(payload?.schema!=="cove.legal-authorized.v1"||
       !Array.isArray(payload.rows))throw Error("owner_payload_invalid");
    rows=payload.rows;
  }catch{
    throw new ApiError(503,"Strong legal-owner verification unavailable.");
  }
  const authorized=rows as Array<{
    product_id?:unknown;edition_id?:unknown;offer_json?:unknown
  }>;
  if(authorized.length!==ids.length)
    throw new ApiError(451,"Legal owner has not approved this edition for the selected market.");
  const found=new Set<string>();
  for(const row of authorized){
    if(!row || typeof row.product_id!=="string" ||
       typeof row.edition_id!=="string" ||
       typeof row.offer_json!=="string" ||
       !ids.includes(row.product_id)||found.has(row.product_id)||
       row.edition_id!=="ed_gutenberg_"+row.product_id.slice("prd_gutenberg_".length))
      throw new ApiError(503,"Legal-owner proof identity mismatch.");
    found.add(row.product_id);
    let offer:unknown;
    try{offer=JSON.parse(row.offer_json);}
    catch{throw new ApiError(503,"Legal-owner offer proof malformed.");}
    const p=offer as Record<string,unknown>|null;
    if(!p||Array.isArray(p) || p.type!=="public-domain"||
       p.amountMinor!==0||p.currency!==currency ||
       Object.keys(p).sort().join(",")!=="amountMinor,currency,type")
      throw new ApiError(503,"Legal-owner offer proof invalid.");
  }
}
