type Statement={bind(...v:unknown[]):Statement;first<T=any>():Promise<T|null>;all<T=any>():Promise<{results:T[]}>};
export type SeoDB={prepare(sql:string):Statement};
const PAGE_SIZE=20000;
const esc=(v:unknown)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const xml=(body:string)=>new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`,{headers:{"content-type":"application/xml; charset=utf-8","cache-control":"public, max-age=900, stale-while-revalidate=3600"}});
const text=(body:string)=>new Response(body,{headers:{"content-type":"text/plain; charset=utf-8","cache-control":"public, max-age=900"}});
function originOf(request:Request,publicUrl?:string){try{return new URL(publicUrl||request.url).origin}catch{return new URL(request.url).origin}}
function sitemapIndex(origin:string,urls:string[]){return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(loc=>`<sitemap><loc>${esc(origin+loc)}</loc></sitemap>`).join("")}</sitemapindex>`)}
async function count(db:SeoDB,kind:"books"|"authors"|"categories"|"works"|"editions"){
  let sql="";
  if(kind==="books")sql=`SELECT COUNT(*) n FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder')`;
  else if(kind==="works")sql=`SELECT COUNT(DISTINCT w.id) n FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND w.canonical_status<>'redirected'`;
  else if(kind==="editions")sql=`SELECT COUNT(DISTINCT e.id) n FROM editions e JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder')`;
  else if(kind==="authors")sql=`SELECT COUNT(DISTINCT c.id) n FROM contributors c JOIN edition_contributors ec ON ec.contributor_id=c.id AND ec.role='author' JOIN editions e ON e.id=ec.edition_id JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder')`;
  else sql=`SELECT COUNT(*) n FROM storefront_taxonomy_nodes n JOIN storefront_taxonomies t ON t.id=n.taxonomy_id WHERE t.is_default=1 AND t.status='active' AND n.visible=1`;
  return Number((await db.prepare(sql).first<any>())?.n||0);
}
async function typeIndex(request:Request,db:SeoDB,kind:"books"|"authors"|"categories"|"works"|"editions",publicUrl?:string){const origin=originOf(request,publicUrl),n=await count(db,kind),pages=Math.max(1,Math.ceil(n/PAGE_SIZE));return sitemapIndex(origin,Array.from({length:pages},(_,i)=>`/sitemaps/${kind}/${i+1}.xml`));}
async function page(request:Request,db:SeoDB,kind:"books"|"authors"|"categories"|"works"|"editions",pageNo:number,publicUrl?:string){
  const origin=originOf(request,publicUrl),offset=(Math.max(1,pageNo)-1)*PAGE_SIZE;let rows:any[]=[];
  if(kind==="books") rows=(await db.prepare(`SELECT p.public_id ref,MAX(p.updated_at,e.updated_at) updated_at FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder') AND p.public_id IS NOT NULL ORDER BY p.id LIMIT ? OFFSET ?`).bind(PAGE_SIZE,offset).all<any>()).results.map(r=>({loc:`/books/${encodeURIComponent(String(r.ref))}`,lastmod:r.updated_at}));
  else if(kind==="works") rows=(await db.prepare(`SELECT w.public_id ref,MAX(w.updated_at) updated_at FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND w.canonical_status<>'redirected' AND w.public_id IS NOT NULL GROUP BY w.id,w.public_id ORDER BY w.id LIMIT ? OFFSET ?`).bind(PAGE_SIZE,offset).all<any>()).results.map(r=>({loc:`/work/${encodeURIComponent(String(r.ref))}`,lastmod:r.updated_at}));
  else if(kind==="editions") rows=(await db.prepare(`SELECT e.public_id ref,MAX(e.updated_at,p.updated_at) updated_at FROM editions e JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder') AND e.public_id IS NOT NULL GROUP BY e.id,e.public_id ORDER BY e.id LIMIT ? OFFSET ?`).bind(PAGE_SIZE,offset).all<any>()).results.map(r=>({loc:`/edition/${encodeURIComponent(String(r.ref))}`,lastmod:r.updated_at}));
  else if(kind==="authors") rows=(await db.prepare(`SELECT c.id,c.slug,MAX(COALESCE(ap.updated_at,c.updated_at)) updated_at FROM contributors c JOIN edition_contributors ec ON ec.contributor_id=c.id AND ec.role='author' JOIN editions e ON e.id=ec.edition_id JOIN products p ON p.edition_id=e.id LEFT JOIN author_profiles ap ON ap.contributor_id=c.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder') GROUP BY c.id,c.slug ORDER BY c.id LIMIT ? OFFSET ?`).bind(PAGE_SIZE,offset).all<any>()).results.map(r=>({loc:`/author/${encodeURIComponent(String(r.slug||r.id))}`,lastmod:r.updated_at}));
  else rows=(await db.prepare(`SELECT n.path,n.updated_at FROM storefront_taxonomy_nodes n JOIN storefront_taxonomies t ON t.id=n.taxonomy_id WHERE t.is_default=1 AND t.status='active' AND n.visible=1 ORDER BY n.path LIMIT ? OFFSET ?`).bind(PAGE_SIZE,offset).all<any>()).results.map(r=>({loc:`/ebooks/${String(r.path).split('/').map(encodeURIComponent).join('/')}`,lastmod:r.updated_at}));
  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map(r=>`<url><loc>${esc(origin+r.loc)}</loc>${r.lastmod?`<lastmod>${esc(String(r.lastmod).slice(0,10))}</lastmod>`:""}</url>`).join("")}</urlset>`);
}
export async function handleSeoDocumentRequest(request:Request,db:SeoDB,publicUrl?:string):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname,origin=originOf(request,publicUrl);
  if(request.method!=="GET"&&request.method!=="HEAD")return null;
  if(path==="/robots.txt")return text(["User-agent: *","Allow: /","Disallow: /api/","Disallow: /checkout","Disallow: /cart","Disallow: /orders","Disallow: /publishing","Disallow: /staff","Disallow: /account","Disallow: /profile","Disallow: /library","Disallow: /downloads","Disallow: /highlights","Disallow: /definitions","Disallow: /stats","Disallow: /read/","Disallow: /listen/","Disallow: /wishlist","Disallow: /shelf","Disallow: /shelves",`Sitemap: ${origin}/sitemap.xml`,""].join("\n"));
  if(path==="/sitemap.xml"){const kinds=["books","works","editions","authors","categories"] as const,urls=["/sitemaps/pages.xml"];for(const kind of kinds){const n=await count(db,kind),pages=Math.max(1,Math.ceil(n/PAGE_SIZE));for(let i=1;i<=pages;i++)urls.push(`/sitemaps/${kind}/${i}.xml`);}return sitemapIndex(origin,urls);}
  if(path==="/sitemaps/pages.xml"){
    const publicPages=["/","/audiobooks","/new-releases","/preorders","/deals","/bestsellers","/trending","/most-read","/most-wishlisted","/new-and-noteworthy","/top-rated","/publishing-policy","/copyright"];
    return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${publicPages.map(loc=>`<url><loc>${esc(origin+loc)}</loc></url>`).join("")}</urlset>`);
  }
  const index=path.match(/^\/sitemaps\/(books|works|editions|authors|categories)\.xml$/);if(index)return typeIndex(request,db,index[1] as any,publicUrl);
  const match=path.match(/^\/sitemaps\/(books|works|editions|authors|categories)\/(\d+)\.xml$/);if(match)return page(request,db,match[1] as any,Number(match[2]),publicUrl);
  return null;
}
