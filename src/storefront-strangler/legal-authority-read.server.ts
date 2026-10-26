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
