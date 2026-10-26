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
};
const productPattern=/^prd_gutenberg_(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/;
const QA_PRIMARY="5e3a6b69-6f3d-4b19-b837-01f7aa56ce87";
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
  for(const p of results){
    if(!p||typeof p.product_id!=="string"||
       !ids.includes(p.product_id)||observed.has(p.product_id)||
       typeof p.edition_id!=="string"||
       !/^[a-zA-Z0-9_-]{3,160}$/.test(p.edition_id) ||
       typeof p.grant_id!=="string"||
       !/^[a-zA-Z0-9_-]{3,180}$/.test(p.grant_id) ||
       (p.contract_id!==null&&(typeof p.contract_id!=="string"||
         !/^[a-zA-Z0-9_-]{3,180}$/.test(p.contract_id))) ||
       (p.contract_version_id!==null&&(typeof p.contract_version_id!=="string"||
         !/^[a-zA-Z0-9_-]{3,180}$/.test(p.contract_version_id))) ||
       (p.contract_version_id!==null&&!p.contract_id)||
       typeof p.valid_until!=="string"||
       !Number.isFinite(Date.parse(p.valid_until))||
       Date.parse(p.valid_until)<=Date.now()||
       !Number.isSafeInteger(p.epoch)||Number(p.epoch)<=0)
      throw new ApiError(503,"Commercial legal proof identity or epoch invalid.");
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
     env.COVE_LEGAL_WRITER_PRIMARY_ID!==QA_PRIMARY ||
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
