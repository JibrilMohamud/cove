/* eslint-disable prettier/prettier -- Exact legal proof and D1 fixtures must remain readable in independent regression review. */
/**
 * Exercise the ACTUAL private legal-owner endpoint and ACTUAL canonical
 * storefront SELECT against every current SQLite migration. All data is
 * synthetic, in two disposable local SQLite databases. This is correctness
 * evidence only; it cannot certify Cloudflare hosted latency.
 */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {readFileSync,readdirSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const dir=mkdtempSync(join(tmpdir(),"cove-native-firstpaint-schema-"));
const primary=new DatabaseSync(":memory:"),ownerDb=new DatabaseSync(":memory:");
try {
  const output=join(dir,"authority.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:output,bundle:true,format:"esm",platform:"node",target:"node22",
    logLevel:"silent",plugins:[{name:"cloudflare-do-host",setup(x){
      x.onResolve({filter:/^cloudflare:workers$/},()=>
        ({path:"cloudflare:workers",namespace:"owner-host"}));
      x.onLoad({filter:/.*/,namespace:"owner-host"},()=>
        ({contents:"export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
    }}]});
  const {CoveLegalAuthority}=await import(pathToFileURL(output).href);
  const load=async (name,path)=>{
    const outfile=join(dir,name+".mjs");
    await build({entryPoints:[path],outfile,bundle:true,format:"esm",
      platform:"node",target:"node22",logLevel:"silent"});
    return import(pathToFileURL(outfile).href);
  };
  const free=await load("free","src/storefront-strangler/legal-authority-core.ts");
  const commercial=await load("commercial","src/storefront-strangler/commercial-legal-core.ts");
  const paid=await load("paid","src/storefront-strangler/commercial-storefront-authority.ts");
  const market=await load("market","src/storefront-strangler/market-authority-core.ts");
  // The full catalog/rightsholder/DRM/commerce schema, not a hand-written
  // three-table imitation. The ephemeral DB cannot contact any provider.
  for(const file of readdirSync("drizzle").filter(n=>n.endsWith(".sql")).sort())
    primary.exec(readFileSync(join("drizzle",file),"utf8"));
  const now=new Date().toISOString(),until=new Date(Date.now()+120000).toISOString();
  const insert=(db,table,cols)=>{
    const names=Object.keys(cols);
    const fields=names.map(n=>'"'+n+'"').join(",");
    const slots=names.map(()=>"?").join(",");
    db.prepare("INSERT INTO "+table+"("+fields+") VALUES("+slots+")")
      .run(...names.map(n=>cols[n]));
  };
  const marketRow={country_code:"US",display_name:"United States",
    default_locale:"en-US",default_currency:"USD",created_at:now,updated_at:now};
  insert(primary,"storefront_markets",marketRow);
  const books=[
    {id:"prd_gutenberg_2701",edition:"ed_gutenberg_2701",work:"wrk_gutenberg_2701",
      source:"gutenberg",external:"2701",type:"public-domain",price:0,sku:"qa-free-2701"},
    {id:"prd_paid_book_001",edition:"ed_paid_book_001",work:"wrk_paid_book_001",
      source:"publisher",external:"paid-book-001",type:"retail",price:599,sku:"qa-paid-001"},
    {id:"prd_gutenberg_2702",edition:"ed_gutenberg_2702",work:"wrk_gutenberg_2702",
      source:"gutenberg",external:"2702",type:"public-domain",price:0,sku:"qa-unproved-2702"},
  ];
  for(const b of books){
    insert(primary,"works",{id:b.work,title:"Synthetic full-schema book",created_at:now,updated_at:now});
    insert(primary,"editions",{id:b.edition,work_id:b.work,title:"Synthetic full-schema book",
      created_at:now,updated_at:now,public_id:b.edition+"_public"});
    insert(primary,"products",{id:b.id,edition_id:b.edition,sku:b.sku,
      format:"ebook",source_name:b.source,source_external_id:b.external,
      created_at:now,updated_at:now,public_id:b.id+"_public"});
    insert(primary,"catalog_search_documents",{product_id:b.id,external_book_id:b.external,
      title:"Synthetic full-schema book",currency:"USD",price_minor:b.price,
      first_ingested_at:now,updated_at:now});
    insert(primary,"offers",{id:"offer_"+b.sku,product_id:b.id,offer_type:b.type,
      currency:"USD",amount_minor:b.price,created_at:now,updated_at:now});
    const grant="grant_"+b.sku;
    insert(primary,"rights_grants",{id:grant,edition_id:b.edition,territory_code:"US",
      format:"ebook",license_type:b.type,created_at:now});
    insert(primary,"rights_grant_territories",{grant_id:grant,territory_code:"US",
      snapshotted_at:now});
  }
  const execSql=(query,...args)=>{
    // SQLite's synchronous owner storage commits DDL and writes eagerly.
    if(!args.length&&/^\s*(?:CREATE|ALTER|DROP|PRAGMA)\s/i.test(query)){
      ownerDb.exec(query);return {toArray:()=>[]};
    }
    const statement=ownerDb.prepare(query);
    const rows=statement.columns().length?statement.all(...args):(statement.run(...args),[]);
    return {toArray:()=>rows};
  };
  const sql={exec:execSql};
  let servedPrimary=true,afterD1=null,reads=0;
  const binding={
    withSession(anchor){
      assert.equal(anchor,"first-primary");
      return this;
    },
    prepare(statement){
      return {bind(...args){
        return {
          async first(){return primary.prepare(statement).get(...args)??null;},
          async all(){
            reads++;
            const rows=primary.prepare(statement).all(...args);
            if(afterD1){const callback=afterD1;afterD1=null;callback();}
            return {results:rows,success:true,meta:{
              served_by_primary:servedPrimary,rows_written:0,
              timings:{sql_duration_ms:0},
            }};
          },
        };
      }};
    },
  };
  const secret="a".repeat(64);
  const env={PRIMARY_DB:binding,COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+12*60_000),
    COVE_RIGHTS_OWNER_SECRET:secret};
  const authority=new CoveLegalAuthority({storage:{sql}},env);
  // Seed verified owner proofs using the exact production owner proof
  // functions. This is explicitly synthetic; no permissions can come
  // from the mere existence of a catalog or its D1 grants.
  const freeBook=books[0],paidBook=books[1],unproved=books[2];
  const freeCommand={sourceId:"2701",territory:"US",revision:1,action:"allow"};
  assert.equal(free.applyAuthorityCommand(sql,freeCommand).applied,true);
  const offerJson=b=>JSON.stringify({type:b.type,currency:"USD",amountMinor:b.price});
  free.storeAuthorizedPresentationProof(sql,freeCommand,"USD",{
    productId:freeBook.id,editionId:freeBook.edition,
    productPublicId:freeBook.id+"_public",editionPublicId:freeBook.edition+"_public",
    offerJson:offerJson(freeBook)
  });
  const legal={productId:paidBook.id,editionId:paidBook.edition,territory:"US",
    channel:"retail",grantId:"grant_qa_paid_001",contractId:"contract_qa_paid_001",
    contractVersionId:"contract_version_qa_paid_001",validUntil:until};
  assert.equal(commercial.publishFreshCommercialProof(sql,legal,0).applied,true);
  paid.publishCommercialStorefront(sql,{
    product_id:paidBook.id,edition_id:paidBook.edition,
    product_public_id:paidBook.id+"_public",edition_public_id:paidBook.edition+"_public",
    offer_json:offerJson(paidBook),territory:"US",currency:"USD",rights_epoch:1,
    grant_id:legal.grantId,contract_id:legal.contractId,
    contract_version_id:legal.contractVersionId,valid_until:until
  });
  const call=(body,authorization=secret)=>{
    return authority.fetch(new Request("https://owner.internal/qa/native-first-paint",{
      method:"POST",headers:{"authorization":"Bearer "+authorization,
        "content-type":"application/json"},body:JSON.stringify(body)
    }));
  };
  const request={ids:[freeBook.id,paidBook.id,unproved.id],
    territory:"US",currency:"USD"};
  let response=await call(request);
  assert.equal(response.status,200,"Actual full-schema D1+owner handler must accept synthetic fixture");
  let result=await response.json();
  assert.equal(result.schema,"cove.qa.owner-native-first-paint.v1");
  assert.deepEqual(result.rows.map(row=>row.product_id),[freeBook.id,paidBook.id],
    "Available primary-only catalog product MUST NOT bypass owner permission");
  assert.ok(reads>0,"Endpoint must execute the real prepared native D1 SELECT");
  assert.equal((await call(request,"0".repeat(64))).status,401,
    "The synthetic owner route never admits an untrusted service binding");
  response=await call({...request,ids:[freeBook.id],sql:"SELECT 1"});
  assert.equal(response.status,503,"Unknown SQL payload is denied, not executed");
  servedPrimary=false;
  response=await call(request);
  assert.equal(response.status,503,"Unverified replica must deny");
  servedPrimary=true;
  afterD1=()=>free.persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"qa:full-schema-free-withdrawal"
  });
  response=await call(request);
  assert.equal(response.status,200,"A concurrent source denial may still return unaffected paid books");
  result=await response.json();
  assert.deepEqual(result.rows.map(row=>row.product_id),[paidBook.id],
    "An in-flight free source withdrawal MUST remove the revoked book");
  const withdrawPaid=commercial.denyCommercialSubject(sql,{
    subjectKind:"contract",subjectId:legal.contractId,operationId:"qa:paid-contract-withdrawal"
  });
  assert.equal(withdrawPaid.applied,true);
  response=await call(request);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).rows,[],
    "Paid contract withdrawal and global free denial cannot resurrect");
  // Before opening the synthetic QA lease, even the correct secret cannot
  // invoke this endpoint. Never substitute a disabled production owner.
  env.COVE_RIGHTS_OWNER_ENABLED="0";
  assert.equal((await call(request)).status,503);
  // Expired QA owner also refuses all queries, rather than preserving approvals.
  env.COVE_RIGHTS_OWNER_ENABLED="1";
  env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT=String(Date.now()-1);
  assert.equal((await call(request)).status,503);
  console.log("PASS full-schema owner-native-read: real 95-migration SQL, exact offers, primary session, paid+free intersection, in-flight global withdrawal, paid contract denial, disabled/expired QA owner");
} finally {
  primary.close();ownerDb.close();
  rmSync(dir,{recursive:true,force:true});
}
