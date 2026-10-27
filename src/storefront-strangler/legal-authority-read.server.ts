/* eslint-disable prettier/prettier -- The private authorizer response is a legal trust boundary. */
import {
  assembleAuthorizedHomepagePresentation,
  readHomepagePresentation,
} from "./homepage-presentation.server";
import type { AuthorityPresentationRow } from "./legal-authority-core";

type LegalReadPort={fetch(request:Request):Promise<Response>};
type HomepageProjection=Awaited<ReturnType<typeof readHomepagePresentation>>;

/**
 * Authenticated direct Durable Object stub call: no public HTTP endpoint,
 * no KV/R2 permission bit, and never downgrade to stale presentation on an
 * unavailable owner. Use only after ALL canonical legal writers are fenced.
 */
export async function authorizeHomepageWithLegalOwner(
  owner:LegalReadPort,secret:string,projection:HomepageProjection
) {
  if(!/^[a-f0-9]{64}$/.test(secret)) throw Error("legal_owner_secret_unconfigured");
  const {candidates}=projection;
  if(candidates.productIds.length>128 ||
      !/^[A-Z]{2}$/.test(candidates.country) ||
      !/^[A-Z]{3}$/.test(candidates.currency))
    throw Error("invalid_homepage_owner_candidates");
  const response=await owner.fetch(new Request("https://legal-authority.internal/authorize-batch",{
    method:"POST",
    headers:{"content-type":"application/json","authorization":"Bearer "+secret},
    body:JSON.stringify({
      ids:candidates.productIds,territory:candidates.country,currency:candidates.currency
    }),
  }));
  if(response.status!==200) throw Error("legal_owner_unavailable");
  const payload=await response.json() as {
    schema?:unknown;rows?:unknown;
  };
  if(!payload||payload.schema!=="cove.legal-authorized.v1" ||
      !Array.isArray(payload.rows) || payload.rows.length>25)
    throw Error("legal_owner_malformed_response");
  const order=new Map(candidates.productIds.map((id,i)=>[id,i]));
  let previous=-1;
  const validated:AuthorityPresentationRow[]=[];
  for(const untrusted of payload.rows){
    const row=untrusted as Partial<AuthorityPresentationRow>|null;
    if(!row||typeof row!=="object" ||
        typeof row.product_id!=="string" ||
        typeof row.edition_id!=="string" ||
        typeof row.offer_json!=="string" ||
        row.offer_json.length>512 ||
        (row.product_public_id!==null && typeof row.product_public_id!=="string") ||
        (row.edition_public_id!==null && typeof row.edition_public_id!=="string"))
      throw Error("legal_owner_malformed_response");
    const position=order.get(row.product_id);
    if(position===undefined||position<=previous ||
        row.edition_id!=="ed_gutenberg_"+row.product_id.slice("prd_gutenberg_".length))
      throw Error("legal_owner_identity_mismatch");
    previous=position;
    let proof:unknown;
    try{proof=JSON.parse(row.offer_json);}
    catch{throw Error("legal_owner_malformed_offer");}
    const offer=proof as Record<string,unknown>|null;
    if(!offer||Array.isArray(offer)||offer.type!=="public-domain" ||
        offer.currency!==candidates.currency||offer.amountMinor!==0||
        Object.keys(offer).sort().join(",")!=="amountMinor,currency,type")
      throw Error("legal_owner_malformed_offer");
    validated.push(row as AuthorityPresentationRow);
  }
  return assembleAuthorizedHomepagePresentation(projection,validated);
}

/**
 * Mixed paid/free owner read. Only the globally fenced owner can authorize
 * a book. Paid prices come from canonical D1-verified immutable offer proof
 * in the owner; untrusted KV/R2 candidate bytes cannot change prices.
 * The existing /authorize-batch endpoint remains Gutenberg-only.
 */
export async function authorizeHomepageWithUnifiedOwner(
  owner:LegalReadPort,secret:string,projection:HomepageProjection
){
  if(!/^[a-f0-9]{64}$/.test(secret))throw Error("legal_owner_secret_unconfigured");
  const {candidates,displayBooks}=projection;
  if(candidates.productIds.length>128||
     !/^[A-Z]{2}$/.test(candidates.country)||
     !/^[A-Z]{3}$/.test(candidates.currency)||
     new Set(candidates.productIds).size!==candidates.productIds.length)
    throw Error("invalid_homepage_owner_candidates");
  const response=await owner.fetch(new Request(
    "https://legal-authority.internal/storefront/authorize-batch",{
      method:"POST",
      headers:{"content-type":"application/json",
        "authorization":"Bearer "+secret},
      body:JSON.stringify({ids:candidates.productIds,
        territory:candidates.country,currency:candidates.currency})
    }
  ));
  if(response.status!==200)throw Error("legal_owner_unavailable");
  const payload=await response.json() as {schema?:unknown;rows?:unknown};
  if(!payload||payload.schema!=="cove.storefront-owner.v1"||
     !Array.isArray(payload.rows)||payload.rows.length>25)
    throw Error("legal_owner_malformed_response");
  const position=new Map(candidates.productIds.map((id,i)=>[id,i]));
  const display=new Map(displayBooks.map(book=>[book.productId,book.editionId]));
  let previous=-1;
  const validated:AuthorityPresentationRow[]=[];
  for(const untrusted of payload.rows){
    const row=untrusted as Partial<AuthorityPresentationRow>|null;
    if(!row||typeof row!=="object"||
       typeof row.product_id!=="string"||
       typeof row.edition_id!=="string"||
       typeof row.offer_json!=="string"||row.offer_json.length>512||
       (row.product_public_id!==null&&typeof row.product_public_id!=="string")||
       (row.edition_public_id!==null&&typeof row.edition_public_id!=="string"))
      throw Error("legal_owner_malformed_response");
    const at=position.get(row.product_id);
    if(at===undefined||at<=previous||
       display.get(row.product_id)!==row.edition_id)
      throw Error("legal_owner_identity_mismatch");
    previous=at;
    let offerRaw:unknown;
    try{offerRaw=JSON.parse(row.offer_json);}
    catch{throw Error("legal_owner_malformed_offer");}
    const offer=offerRaw as Record<string,unknown>|null;
    if(!offer||Array.isArray(offer)||
       offer.currency!==candidates.currency||
       Object.keys(offer).sort().join(",")!=="amountMinor,currency,type"||
       !Number.isSafeInteger(offer.amountMinor)||
       (offer.amountMinor as number)<0)
      throw Error("legal_owner_malformed_offer");
    if(row.product_id.startsWith("prd_gutenberg_")){
      if(offer.type!=="public-domain"||offer.amountMinor!==0||
         row.edition_id!=="ed_gutenberg_"+row.product_id.slice(14))
        throw Error("legal_owner_free_proof_invalid");
    }else if(typeof offer.type!=="string"||
             !/^[a-z][a-z0-9_-]{2,39}$/.test(offer.type)||
             offer.type==="public-domain")
      throw Error("legal_owner_paid_proof_invalid");
    validated.push(row as AuthorityPresentationRow);
  }
  return assembleAuthorizedHomepagePresentation(projection,validated);
}
