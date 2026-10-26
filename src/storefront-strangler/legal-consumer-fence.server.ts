/* eslint-disable prettier/prettier -- Owner proof is a customer-access trust boundary. */
import {ApiError} from "../features/fore/errors";

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
  if(publicProducts.some(p=>p.source_name!=="gutenberg" ||
       !productPattern.test(p.id) ||
       p.id!=="prd_gutenberg_"+p.source_external_id))
    throw new ApiError(503,
      "Commercial-edition legal ownership has not been migrated; customer operation withheld.");
  const ids=publicProducts.map(p=>p.id);
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
    try{offer=JSON.parse(row.offer_json);}catch{}
    const p=offer as Record<string,unknown>|null;
    if(!p||Array.isArray(p) || p.type!=="public-domain"||
       p.amountMinor!==0||p.currency!==currency ||
       Object.keys(p).sort().join(",")!=="amountMinor,currency,type")
      throw new ApiError(503,"Legal-owner offer proof invalid.");
  }
}
