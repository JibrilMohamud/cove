/* eslint-disable prettier/prettier -- Keep isolated revision fences and metadata bounds adjacent. */
/**
 * Independent catalog graph projection. All fields are ADVISORY, stored in a
 * physically separate D1. No grants, offers, prices, entitlements, signing,
 * order state, or legal authorization can be derived from this document.
 *
 * A single monotonic UPSERT replaces dozens of contributor/subject/language/
 * taxonomy/asset-derived writes on the discovery data plane. It never
 * authorizes customer download or storefront presentation.
 */
import { normalizeCatalogIndexRow, type RawCatalogIndexRow } from "./catalog-index-core";

export type CatalogGraphDocument = {
  sourceId: string;
  revision: number;
  visible: number;
  workId: string;
  editionId: string;
  productId: string;
  title: string;
  description: string;
  contributorsJson: string;
  subjectsJson: string;
  shelvesJson: string;
  languagesJson: string;
  assetsJson: string;
  sourceName: string;
  sourceItemId: string;
};
function clean(input: unknown, max: number) {
  return [...String(input ?? "").normalize("NFKC")]
    .map(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)
    .join("").replace(/\s+/g," ").trim().slice(0,max);
}
function values(raw: string|null|undefined, limit: number, len: number, obj=false) {
  if (raw && raw.length>65536) throw Error("catalog_graph_unbounded_input");
  let parsed:unknown;
  try { parsed=JSON.parse(raw||"[]"); } catch { return []; }
  if(!Array.isArray(parsed)) return [];
  return [...new Set(parsed.slice(0,limit).map(x=>clean(obj && x && typeof x==="object"
    ? (x as {name?:unknown}).name : x,len)).filter(Boolean))];
}
function allowedAsset(input: unknown):string {
  if(typeof input!=="string"||input.length>2048) return "";
  try {
    const url=new URL(input);
    // Untrusted metadata may not create script/file/internal URLs.
    if(url.protocol!=="https:"||url.username||url.password||!url.hostname.includes(".")) return "";
    return url.href;
  } catch { return ""; }
}
export function prepareIsolatedCatalogGraph(
  source: RawCatalogIndexRow|null,id:string,revision:number,
):CatalogGraphDocument {
  const doc=normalizeCatalogIndexRow(source,id,revision);
  const visible=doc.visible;
  if (source?.formats_json && source.formats_json.length>65536)
    throw Error("catalog_graph_unbounded_input");
  let formats:Record<string,unknown>={};
  try{
    const value=JSON.parse(source?.formats_json||"{}");
    if(value && typeof value==="object" && !Array.isArray(value)) formats=value;
  } catch { formats = {}; }
  const assets=visible ? Object.fromEntries(
    ["image/jpeg","image/png","application/epub+zip","text/html"]
      .map(key=>[key,allowedAsset(formats[key])])
      .filter((entry)=>Boolean(entry[1]))
  ) : {};
  return {
    sourceId:id,revision,visible,workId:"wrk_gutenberg_"+id,
    editionId:"ed_gutenberg_"+id,productId:doc.productId,
    title:doc.title,description:doc.description,
    contributorsJson:JSON.stringify(visible?values(source?.authors_json,40,200,true):[]),
    subjectsJson:JSON.stringify(visible?values(source?.subjects_json,60,180):[]),
    shelvesJson:JSON.stringify(visible?values(source?.bookshelves_json,40,180):[]),
    languagesJson:JSON.stringify(visible?values(source?.languages_json,16,15):[]),
    assetsJson:JSON.stringify(assets),
    sourceName:visible?clean(source?.source_id,40):"",
    sourceItemId:visible?clean(source?.source_item_id,120):"",
  };
}
export function catalogGraphWrite(doc:CatalogGraphDocument){
  return {
    sql:`INSERT INTO catalog_graph_documents
      (source_id,revision,visible,work_id,edition_id,product_id,title,description,
      contributors_json,subjects_json,shelves_json,languages_json,assets_json,
      source_name,source_item_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET
      revision=excluded.revision,visible=excluded.visible,
      work_id=excluded.work_id,edition_id=excluded.edition_id,
      product_id=excluded.product_id,title=excluded.title,
      description=excluded.description,contributors_json=excluded.contributors_json,
      subjects_json=excluded.subjects_json,shelves_json=excluded.shelves_json,
      languages_json=excluded.languages_json,assets_json=excluded.assets_json,
      source_name=excluded.source_name,source_item_id=excluded.source_item_id
      WHERE excluded.revision>catalog_graph_documents.revision`,
    binds:[doc.sourceId,doc.revision,doc.visible,doc.workId,doc.editionId,
      doc.productId,doc.title,doc.description,doc.contributorsJson,
      doc.subjectsJson,doc.shelvesJson,doc.languagesJson,doc.assetsJson,
      doc.sourceName,doc.sourceItemId],
  };
}
