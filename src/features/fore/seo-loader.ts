import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

export type SeoPayload = {
  title: string;
  description: string;
  canonical: string;
  image?: string;
  imageAlt?: string;
  type?: "website" | "book" | "profile";
  robots?: string;
  authorNames?: string[];
  authorUrls?: string[];
  bookIsbn?: string;
  jsonLd?: Record<string, unknown>[];
};

function plain(value: unknown, max = 280) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function absolute(origin: string, value?: string) {
  if (!value) return `${origin}/icons/cove-512.png`;
  try { return new URL(value, origin).toString(); } catch { return `${origin}/icons/cove-512.png`; }
}
function isoDate(value: unknown) {
  const text=String(value||""); if(!text)return undefined; const d=new Date(text); return Number.isNaN(d.valueOf())?text.slice(0,10):d.toISOString().slice(0,10);
}
function price(amountMinor: unknown) { return (Number(amountMinor || 0) / 100).toFixed(2); }
function seoOrigin() {
  const request=getRequest(),hint=request.headers.get("x-fore-public-origin");
  try { return new URL(hint||request.url).origin; } catch { return new URL(request.url).origin; }
}
function publicFetch(path: string) {
  const request=getRequest(), origin=new URL(request.url).origin;
  const headers=new Headers({accept:"application/json"});
  const country=request.headers.get("cf-ipcountry"); if(country)headers.set("cf-ipcountry",country);
  return fetch(new URL(path,origin),{headers}).then(async r=>r.ok?await r.json():null);
}

export const loadSiteSeo=createServerFn({method:"GET"}).handler(async():Promise<SeoPayload>=>{
  const origin=seoOrigin(), canonical=`${origin}/`, image=`${origin}/icons/cove-512.png`;
  return {title:"Cove — Bookstore & Reading Room",description:"Discover ebooks, browse curated collections, follow authors, and build your reading life on Cove.",canonical,image,imageAlt:"Cove",type:"website",jsonLd:[{"@context":"https://schema.org","@type":"WebSite",name:"Cove",url:canonical,potentialAction:{"@type":"SearchAction",target:`${origin}/search?q={search_term_string}`,"query-input":"required name=search_term_string"}}]};
});

export const loadBookSeo=createServerFn({method:"GET"})
  .inputValidator((value)=>z.object({id:z.string().min(1).max(200)}).parse(value))
  .handler(async({data}):Promise<SeoPayload|null>=>{
    const request=getRequest(),origin=seoOrigin();
    const detail:any=await publicFetch(`/api/fore/products/${encodeURIComponent(data.id)}/detail`); if(!detail?.book)return null;
    const b=detail.book,authors=(b.authors||[]).map((x:any)=>plain(x.name,120)).filter(Boolean),authorLabel=authors.join(", ");
    const summary=plain(b.publisherDescription||b.summaries?.[0]||b.description||`${b.title} by ${authorLabel||"Unknown author"}.`,300);
    const description=(summary||`Discover ${b.title}${authorLabel?` by ${authorLabel}`:""} on Cove.`).slice(0,165);
    const canonical=b.publicProductId?`${origin}/books/${encodeURIComponent(String(b.publicProductId))}`:`${origin}/book/${encodeURIComponent(String(b.id))}`;
    const image=absolute(origin,b.formats?.["image/jpeg"]||b.formats?.["image/png"]||"/icons/cove-512.png");
    const offer=detail.commerce?.offer,preorder=detail.commerce?.preorder;
    const availability=preorder?"https://schema.org/PreOrder":detail.commerce?.available?"https://schema.org/InStock":"https://schema.org/OutOfStock";
    const authorUrls=(b.authors||[]).map((a:any)=>a.slug||a.id?`${origin}/author/${encodeURIComponent(String(a.slug||a.id))}`:null).filter(Boolean) as string[];
    const authorEntities=(b.authors||[]).map((a:any,i:number)=>({"@type":"Person",name:plain(a.name,180),...(authorUrls[i]?{url:authorUrls[i]}:{})}));
    const acc:any=b.accessibility||{},publisherDeclaration=acc.publisherDeclaration&&typeof acc.publisherDeclaration==="object"?acc.publisherDeclaration:{};
    const bookEntityId=`${canonical}#book`,productEntityId=`${canonical}#product`;
    const bookLd:any={"@context":"https://schema.org","@type":"Book","@id":bookEntityId,mainEntityOfPage:canonical,name:plain(b.title,300),description,image,url:canonical,author:authorEntities,inLanguage:(b.languages||[])[0]||b.language||undefined,isbn:b.isbn13||undefined,datePublished:isoDate(b.releaseDate||b.publicationDate||b.originalPublicationDate),bookFormat:"https://schema.org/EBook",numberOfPages:Number(b.pageCount||b.numberOfPages||0)||undefined,publisher:b.publisher?{"@type":"Organization",name:b.publisher}:undefined};
    if(Array.isArray(acc.accessModes)&&acc.accessModes.length)bookLd.accessMode=acc.accessModes;
    if(Array.isArray(acc.accessModeSufficient)&&acc.accessModeSufficient.length)bookLd.accessModeSufficient=acc.accessModeSufficient.map((v:any)=>typeof v==="string"?v:v);
    if(Array.isArray(acc.features)&&acc.features.length)bookLd.accessibilityFeature=acc.features;
    if(Array.isArray(acc.hazards)&&acc.hazards.length)bookLd.accessibilityHazard=acc.hazards;
    if(publisherDeclaration.summary||acc.summary)bookLd.accessibilitySummary=plain(publisherDeclaration.summary||acc.summary,1000);
    const productLd:any={"@context":"https://schema.org","@type":"Product","@id":productEntityId,mainEntity:{"@id":bookEntityId},name:plain(b.title,300),description,image,url:canonical,sku:b.productId||String(b.id),gtin13:b.isbn13||undefined,category:detail.taxonomy?.[0]?.name||"eBook",brand:b.publisher?{"@type":"Brand",name:b.publisher}:undefined};
    if(offer){productLd.offers={"@type":"Offer","@id":`${canonical}#offer`,url:canonical,priceCurrency:offer.currency,price:price(offer.amountMinor),availability,itemCondition:"https://schema.org/NewCondition",seller:{"@type":"Organization",name:"Cove",url:`${origin}/`},...(offer.endsAt?{priceValidUntil:isoDate(offer.endsAt)}:{}),...(preorder?.releaseAt?{availabilityStarts:isoDate(preorder.releaseAt)}:{})};bookLd.isAccessibleForFree=Number(offer.amountMinor||0)===0;}
    const ratingCount=Number(detail.ratings?.count||detail.ratings?.reviewCount||0),ratingValue=Number(detail.ratings?.average||detail.ratings?.ratingValue||0);
    if(ratingCount>0&&ratingValue>0)productLd.aggregateRating={"@type":"AggregateRating",ratingValue:Number(ratingValue.toFixed(2)),reviewCount:ratingCount,bestRating:5,worstRating:1};
    const crumbItems:any[]=[{"@type":"ListItem",position:1,name:"Bookstore",item:`${origin}/`}];
    const primary=(detail.taxonomy||[]).find((t:any)=>t.is_primary)||(detail.taxonomy||[])[0];
    if(primary)crumbItems.push({"@type":"ListItem",position:2,name:plain(primary.name,120),item:`${origin}/ebooks/${String(primary.path).split('/').map(encodeURIComponent).join('/')}`});
    crumbItems.push({"@type":"ListItem",position:crumbItems.length+1,name:plain(b.title,180),item:canonical});
    const breadcrumbs={"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:crumbItems};
    return {title:`${plain(b.title,120)}${authorLabel?` by ${authorLabel}`:""} | Cove`,description,canonical,image,imageAlt:`Cover of ${plain(b.title,180)}`,type:"book",authorNames:authors,authorUrls,bookIsbn:b.isbn13||undefined,jsonLd:[bookLd,productLd,breadcrumbs]};
  });

export const loadAuthorSeo=createServerFn({method:"GET"})
  .inputValidator((value)=>z.object({ref:z.string().min(1).max(200)}).parse(value))
  .handler(async({data}):Promise<SeoPayload|null>=>{
    const request=getRequest(),origin=seoOrigin();
    const result:any=await publicFetch(`/api/fore/authors/${encodeURIComponent(data.ref)}`); if(!result?.author)return null;
    const a=result.author,canonical=`${origin}/author/${encodeURIComponent(String(a.slug||a.id))}`,bio=plain(a.biography,500);
    const description=(bio||`Books, series, and upcoming releases by ${a.name} on Cove.`).slice(0,165),image=a.photoUrl?absolute(origin,a.photoUrl):undefined;
    const person:any={"@context":"https://schema.org","@type":"Person",name:a.name,url:canonical,description:bio||undefined,image,mainEntityOfPage:canonical,sameAs:(a.links||[]).map((l:any)=>l.url).filter(Boolean)};
    if(a.publisher)person.affiliation={"@type":"Organization",name:a.publisher.name,url:a.publisher.slug?`${origin}/publisher/${encodeURIComponent(a.publisher.slug)}`:undefined};
    const breadcrumbs={"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:[{"@type":"ListItem",position:1,name:"Bookstore",item:`${origin}/`},{"@type":"ListItem",position:2,name:a.name,item:canonical}]};
    return {title:`${plain(a.name,120)} — Books, Series & Upcoming Releases | Cove`,description,canonical,image,imageAlt:image?`Portrait of ${a.name}`:undefined,type:"profile",authorNames:[a.name],jsonLd:[person,breadcrumbs]};
  });

export const loadCategorySeo=createServerFn({method:"GET"})
  .inputValidator((value)=>z.object({path:z.string().min(1).max(500)}).parse(value))
  .handler(async({data}):Promise<SeoPayload|null>=>{
    const request=getRequest(),origin=seoOrigin();
    const normalized=data.path.startsWith("/ebooks/")?data.path:`/ebooks/${data.path.replace(/^\/+/,"")}`;
    const page:any=await publicFetch(`/api/fore/storefront/page?path=${encodeURIComponent(normalized)}`); if(!page)return null;
    const requestedCanonical=String(page.canonical||normalized);let canonicalPath=normalized;
    try { const candidate=new URL(requestedCanonical,origin); if(candidate.origin===origin&&candidate.pathname.startsWith("/"))canonicalPath=candidate.pathname; } catch {}
    const canonical=`${origin}${canonicalPath}`,name=page.heading||page.title||"eBooks";
    const breadcrumbs=[{"@type":"ListItem",position:1,name:"Bookstore",item:`${origin}/`}].concat((page.breadcrumbs||[]).map((x:any,i:number)=>({"@type":"ListItem",position:i+2,name:x.name,item:`${origin}${x.href}`})));
    const collection={"@context":"https://schema.org","@type":"CollectionPage",name:page.seoTitle||page.title||name,description:page.seoDescription||page.description||`Browse ${name} eBooks on Cove.`,url:canonical,isPartOf:{"@type":"WebSite",name:"Cove",url:`${origin}/`}};
    return {title:page.seoTitle||`${name} eBooks | Cove`,description:(page.seoDescription||page.description||`Browse ${name} eBooks on Cove.`).slice(0,165),canonical,type:"website",robots:page.noindex?"noindex,follow":"index,follow",jsonLd:[collection,{"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:breadcrumbs}]};
  });


export const loadWorkSeo=createServerFn({method:"GET"})
  .inputValidator((value)=>z.object({id:z.string().min(1).max(200)}).parse(value))
  .handler(async({data}):Promise<SeoPayload|null>=>{
    const origin=seoOrigin(),result:any=await publicFetch(`/api/fore/works/${encodeURIComponent(data.id)}`); if(!result?.work)return null;
    const w=result.work,canonical=`${origin}/work/${encodeURIComponent(String(w.id))}`;
    const authorNames=Array.from(new Set(((w.contributors||[]).filter((c:any)=>c.role==="author").map((c:any)=>plain(c.name,140)).length?(w.contributors||[]).filter((c:any)=>c.role==="author").map((c:any)=>plain(c.name,140)):(result.editions||[]).flatMap((e:any)=>(e.contributors||[]).filter((c:any)=>c.role==="author").map((c:any)=>plain(c.name,140)))))).slice(0,20) as string[];
    const description=(plain(w.description,300)||`Explore editions of ${w.title}${authorNames.length?` by ${authorNames.join(", ")}`:""} on Cove.`).slice(0,165);
    const workExamples=[...(result.editions||[]).slice(0,50).map((e:any)=>({"@type":e.format==="audiobook"?"Audiobook":"Book",name:e.title,url:`${origin}/edition/${encodeURIComponent(String(e.editionId))}`,inLanguage:e.language||undefined,isbn:e.isbn13||undefined,bookFormat:e.format==="audiobook"?"https://schema.org/Audiobook":"https://schema.org/EBook"})),...(result.audioEditions||[]).slice(0,20).map((a:any)=>({"@type":"Audiobook",name:a.title,url:`${origin}/listen/${encodeURIComponent(String(a.id))}`,inLanguage:a.language||undefined,readBy:a.narrator?{"@type":"Person",name:plain(a.narrator,140)}:undefined}))];
    const workLd:any={"@context":"https://schema.org","@type":"CreativeWork",name:plain(w.title,300),description,url:canonical,inLanguage:w.originalLanguage||undefined,author:authorNames.map(name=>({"@type":"Person",name})),workExample:workExamples};
    return{title:`${plain(w.title,120)} — Editions & Formats | Cove`,description,canonical,type:"book",authorNames,jsonLd:[workLd,{"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:[{"@type":"ListItem",position:1,name:"Bookstore",item:`${origin}/`},{"@type":"ListItem",position:2,name:plain(w.title,180),item:canonical}]}]};
  });

export const loadEditionSeo=createServerFn({method:"GET"})
  .inputValidator((value)=>z.object({id:z.string().min(1).max(200)}).parse(value))
  .handler(async({data}):Promise<SeoPayload|null>=>{
    const origin=seoOrigin(),r:any=await publicFetch(`/api/fore/editions/${encodeURIComponent(data.id)}/resolve`); if(!r?.edition)return null;
    const e=r.edition,canonical=`${origin}/edition/${encodeURIComponent(String(r.editionId||data.id))}`,authors=(e.contributors||[]).filter((c:any)=>c.role==="author").map((c:any)=>plain(c.name,140));
    const descriptor=[e.publisher?.name||e.imprint?.name,e.language?String(e.language).toUpperCase():"",e.editionType?String(e.editionType).replaceAll("_"," "):""].filter(Boolean).join(" · ");
    const description=`${e.title}${authors.length?` by ${authors.join(", ")}`:""}${descriptor?`. ${descriptor}.`:""} View this edition and related editions on Cove.`.slice(0,165);
    const book:any={"@context":"https://schema.org","@type":"Book",name:plain(e.title,300),url:canonical,author:authors.map((name:string)=>({"@type":"Person",name})),inLanguage:e.language||undefined,isbn:e.isbn13||undefined,datePublished:isoDate(e.releaseDate||e.publicationDate),bookFormat:e.format==="audiobook"?"https://schema.org/Audiobook":"https://schema.org/EBook",isPartOf:r.workId?{"@type":"CreativeWork",url:`${origin}/work/${encodeURIComponent(String(r.workId))}`} : undefined,publisher:e.publisher?.name?{"@type":"Organization",name:e.publisher.name}:undefined};
    return{title:`${plain(e.title,120)}${authors.length?` by ${authors.join(", ")}`:""} — Edition | Cove`,description,canonical,type:"book",authorNames:authors,bookIsbn:e.isbn13||undefined,jsonLd:[book,{"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:[{"@type":"ListItem",position:1,name:"Bookstore",item:`${origin}/`},{"@type":"ListItem",position:2,name:e.title,item:r.workId?`${origin}/work/${encodeURIComponent(String(r.workId))}`:canonical},{"@type":"ListItem",position:3,name:"Edition",item:canonical}]}]};
  });

export function seoHead(payload:SeoPayload|null|undefined){
  if(!payload)return {meta:[{title:"Cove — Bookstore & Reading Room"}]};
  const meta:any[]=[{title:payload.title},{name:"description",content:payload.description},{name:"robots",content:payload.robots||"index,follow,max-image-preview:large"},{property:"og:site_name",content:"Cove"},{property:"og:title",content:payload.title},{property:"og:description",content:payload.description},{property:"og:type",content:payload.type==="book"?"book":payload.type==="profile"?"profile":"website"},{property:"og:url",content:payload.canonical},{name:"twitter:card",content:payload.image?"summary_large_image":"summary"},{name:"twitter:title",content:payload.title},{name:"twitter:description",content:payload.description}];
  for(const author of payload.authorNames||[])meta.push({name:"author",content:author});
  if(payload.type==="book")for(const url of payload.authorUrls||[])meta.push({property:"book:author",content:url});
  if(payload.type==="book"&&payload.bookIsbn)meta.push({property:"book:isbn",content:payload.bookIsbn});
  if(payload.image){meta.push({property:"og:image",content:payload.image},{name:"twitter:image",content:payload.image});if(payload.imageAlt)meta.push({property:"og:image:alt",content:payload.imageAlt},{name:"twitter:image:alt",content:payload.imageAlt});}
  return {meta,links:[{rel:"canonical",href:payload.canonical}],scripts:(payload.jsonLd||[]).map((value)=>({type:"application/ld+json",children:JSON.stringify(value).replace(/</g,"\\u003c")}))};
}
