/* eslint-disable prettier/prettier -- Synthetic 82k full-vs-inverted scan experiment. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {performance} from "node:perf_hooks";

// Local SQLite microbenchmark, NEVER a legal decision, hosted 100-RPS
// acceptance, a real production D1 query, or a release certificate.
const PRODUCTS=82_249;
const db=new DatabaseSync(":memory:");
const pct=(values,p)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return Number(sorted[Math.max(0,Math.ceil(p*sorted.length)-1)].toFixed(3));
};
try{
  db.exec("PRAGMA journal_mode=MEMORY;PRAGMA synchronous=OFF;"+
    "CREATE TABLE items(product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,"+
      "rank_score INTEGER NOT NULL,price_minor INTEGER NOT NULL,"+
      "PRIMARY KEY(territory,currency,product_id)) WITHOUT ROWID;"+
    "CREATE INDEX idx_owner_rank ON items(territory,currency,rank_score DESC,product_id);"+
    "CREATE TABLE dims(product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,"+
      "kind TEXT NOT NULL,value TEXT NOT NULL,"+
      "PRIMARY KEY(territory,currency,product_id,kind,value)) WITHOUT ROWID;"+
    "CREATE INDEX idx_owner_inverted ON dims(territory,currency,kind,value,product_id);");
  const item=db.prepare("INSERT INTO items VALUES(?,'US','USD',?,?)");
  const dim=db.prepare("INSERT INTO dims VALUES(?,'US','USD',?,?)");
  const seededAt=performance.now();
  db.exec("BEGIN IMMEDIATE");
  try{
    for(let i=0;i<PRODUCTS;i++){
      const id="prd_stage_synthetic_"+String(i).padStart(6,"0");
      item.run(id,PRODUCTS-i,(i%170)*25);
      for(const [kind,value] of [
        ["categories","Category"+i%96],
        ["languages",i%3===0?"fr":"en"],
        ["formats",i%4===0?"audio":"ebook"],
        ["publishers","Publisher"+i%42],
        ["series","Series"+i%120],
      ])dim.run(id,kind,value);
    }
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  const seedMs=Number((performance.now()-seededAt).toFixed(2));
  const caps={categories:40,languages:30,formats:20,publishers:30,series:30};
  const filters=[
    {categories:"Category2",publishers:"Publisher4"},
    {categories:"Category5",publishers:"Publisher7"},
    {categories:"Category17",publishers:"Publisher11"},
    {categories:"Category29",publishers:"Publisher19"},
    {categories:"Category38",publishers:"Publisher21"},
    {categories:"Category44",publishers:"Publisher25"},
    {categories:"Category53",publishers:"Publisher31"},
    {categories:"Category65",publishers:"Publisher36"},
    // Positive intersection fixtures: category 96 and publisher 42 have gcd 6.
    // Include compatible residues rather than mostly impossible intersections.
    {categories:"Category0",publishers:"Publisher0"},
    {categories:"Category2",publishers:"Publisher2"},
    {categories:"Category10",publishers:"Publisher4"},
    {categories:"Category20",publishers:"Publisher8"},
    {categories:"Category42",publishers:"Publisher0"},
    {categories:"Category88",publishers:"Publisher40"},
    // Multi-dimensional positive cases and deliberately broad fallback cases.
    {categories:"Category5",languages:"en",formats:"ebook"},
    {categories:"Category0",languages:"fr",formats:"audio"},
    {languages:"en",formats:"ebook"},
    {formats:"ebook"},
  ];
  const posting=db.prepare("SELECT COUNT(*) n FROM dims INDEXED BY idx_owner_inverted "+
    "WHERE territory='US' AND currency='USD' AND kind=? AND value=?");
  function scan(filter,omit,selective){
    const fields=Object.entries(filter).filter(([k])=>k!==omit);
    const clauses=["i.territory='US'","i.currency='USD'"];
    const filterArgs=[];
    for(const [kind,value] of fields){
      clauses.push("EXISTS(SELECT 1 FROM dims x WHERE x.territory=i.territory "+
        "AND x.currency=i.currency AND x.product_id=i.product_id "+
        "AND x.kind=? AND x.value=?)");
      filterArgs.push(kind,value);
    }
    let from="items i",preArgs=[];
    if(selective&&fields.length){
      const candidate=fields.map(([kind,value])=>({kind,value,n:posting.get(kind,value).n}))
        .sort((a,b)=>a.n-b.n)[0];
      if(candidate.n<=4096){
        from="(SELECT DISTINCT product_id FROM dims INDEXED BY idx_owner_inverted "+
          "WHERE territory='US' AND currency='USD' AND kind=? AND value=?) seed "+
          "CROSS JOIN items i";
        preArgs=[candidate.kind,candidate.value];
        clauses.unshift("i.product_id=seed.product_id");
      }
    }
    return {from,where:clauses.join(" AND "),args:[...preArgs,...filterArgs]};
  }
  function calculate(filter,selective){
    const all=scan(filter,undefined,selective);
    const n=db.prepare("SELECT COUNT(*) n FROM "+all.from+" WHERE "+all.where)
      .get(...all.args).n;
    const page=db.prepare("SELECT i.product_id FROM "+all.from+" WHERE "+all.where+
      " ORDER BY i.rank_score DESC,i.product_id ASC LIMIT 24")
      .all(...all.args).map(row=>row.product_id);
    const facets={};
    for(const kind of Object.keys(caps)){
      const q=scan(filter,kind,selective);
      facets[kind]=db.prepare("SELECT dim.value,COUNT(DISTINCT i.product_id) n FROM "+
        q.from+" JOIN dims dim ON dim.product_id=i.product_id "+
        "AND dim.territory=i.territory AND dim.currency=i.currency "+
        "WHERE "+q.where+" AND dim.kind=? GROUP BY dim.value "+
        "ORDER BY n DESC,dim.value ASC LIMIT ?")
        .all(...q.args,kind,caps[kind]).map(row=>({value:row.value,n:row.n}));
    }
    const priceQ=scan(filter,"price",selective);
    const price=db.prepare("SELECT MIN(i.price_minor) min,MAX(i.price_minor) max FROM "+
      priceQ.from+" WHERE "+priceQ.where).get(...priceQ.args);
    return {count:n,page,facets,price:{...price}};
  }
  const baselineMs=[],selectiveMs=[],matched=[];
  const narrowBaselineMs=[],narrowSelectiveMs=[],broadBaselineMs=[],broadSelectiveMs=[];
  for(const filter of filters){
    // Classify the actual posting-plan choice, not a hand-picked case label.
    const usedPostingSeed=scan(filter,undefined,true).from.includes(" seed ");
    const before=performance.now();
    const baseline=calculate(filter,false);
    const oldMs=performance.now()-before;
    baselineMs.push(oldMs);
    const optimizedStart=performance.now();
    const optimized=calculate(filter,true);
    const newMs=performance.now()-optimizedStart;
    selectiveMs.push(newMs);
    assert.deepEqual(optimized,baseline,
      "Inverted dimension plans must preserve count, rank, facets and price");
    (usedPostingSeed?narrowBaselineMs:broadBaselineMs).push(oldMs);
    (usedPostingSeed?narrowSelectiveMs:broadSelectiveMs).push(newMs);
    matched.push({filter,count:baseline.count,usedPostingSeed});
  }
  assert.ok(matched.filter(x=>x.count>0).length>=9,
    "Performance corpus must include many real nonempty intersections");
  assert.ok(matched.some(x=>x.count===0),
    "Performance corpus must preserve impossible cross-dimension filters");
  assert.ok(matched.filter(x=>!x.usedPostingSeed).length>=2,
    "Broad filter cases must exercise the original full-scan fallback");
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT i.product_id FROM "+
    "(SELECT DISTINCT product_id FROM dims INDEXED BY idx_owner_inverted "+
    "WHERE territory='US' AND currency='USD' AND kind=? AND value=?) seed "+
    "CROSS JOIN items i WHERE i.product_id=seed.product_id "+
    "AND i.territory='US' AND i.currency='USD' "+
    "ORDER BY i.rank_score DESC,i.product_id LIMIT 24").all("categories","Category2");
  assert.ok(plan.some(row=>String(row.detail).includes("idx_owner_inverted")),
    "Real index must drive narrow posting lookup");
  assert.ok(plan.some(row=>/SEARCH i USING PRIMARY KEY/.test(String(row.detail))),
    "Each authorized item must be retrieved by its owner index key");
  console.log(JSON.stringify({
    schema:"cove.stage.selective-facet-benchmark.v1",
    products:PRODUCTS,synthetic:true,ownerRightsChecked:false,hostedCloudflare:false,
    releaseCertified:false,seedMs,distinctCases:filters.length,exactParity:true,
    positiveCases:matched.filter(x=>x.count>0).length,
    emptyCases:matched.filter(x=>x.count===0).length,
    broadFallbackCases:matched.filter(x=>!x.usedPostingSeed).length,
    old:{p50Ms:pct(baselineMs,.5),p95Ms:pct(baselineMs,.95),maxMs:pct(baselineMs,1)},
    inverted:{p50Ms:pct(selectiveMs,.5),p95Ms:pct(selectiveMs,.95),
      maxMs:pct(selectiveMs,1)},
    narrowPosting:{oldP95Ms:pct(narrowBaselineMs,.95),
      invertedP95Ms:pct(narrowSelectiveMs,.95)},
    broadFallback:{oldP95Ms:pct(broadBaselineMs,.95),
      invertedP95Ms:pct(broadSelectiveMs,.95)},
    matched,plan:plan.map(x=>x.detail).slice(0,12)
  }));
}finally{db.close();}
