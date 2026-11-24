/* eslint-disable prettier/prettier -- Isolated fixture and configuration contract. */
import assert from "node:assert/strict";
import test from "node:test";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {QA_PAID_D1,PRODUCTION_D1} from "./paid-qa-cloudflare-credentials.mjs";
import {bindPaidQaTemplateToIsolatedPrimary} from "./paid-qa-template-binding.mjs";
import {consolidatedPaidConfigs,prepareConsolidatedBusinessFixture} from "./paid-consolidated-business-qa.mjs";
const run="45400000000-1";
function owner(){
  const c=bindPaidQaTemplateToIsolatedPrimary(JSON.parse(readFileSync("wrangler.legal-paid-authority.example.jsonc","utf8")));
  c.name="cove-paid-legal-owner-"+run;
  c.vars.COVE_RIGHTS_OWNER_ENABLED="1";c.vars.STRIPE_LIVEMODE="false";
  return c;
}
test("only exact isolated private paid owner and D1-unbound named business gateway",()=>{
  const c=owner(),g=consolidatedPaidConfigs(c,run);
  assert.equal(c.d1_databases[0].database_id,QA_PAID_D1);
  assert.equal(c.workers_dev,false);assert.equal(g.d1_databases,undefined);
  assert.deepEqual(g.services,[{binding:"BUSINESS_OWNER",service:c.name,entrypoint:"CoveBusinessEntrypoint"}]);
  assert.equal(g.triggers,undefined);
  const prod=owner();prod.d1_databases[0].database_id=PRODUCTION_D1;
  assert.throws(()=>consolidatedPaidConfigs(prod,run));
  const live=owner();live.vars.STRIPE_LIVEMODE="true";
  assert.throws(()=>consolidatedPaidConfigs(live,run));
  const publicOwner=owner();publicOwner.workers_dev=true;
  assert.throws(()=>consolidatedPaidConfigs(publicOwner,run));
});
test("source-controlled locale and operational bootstrap works twice without writing paid or rights rows",async()=>{
  const src=new DatabaseSync(":memory:"),db=new DatabaseSync(":memory:");
  try{
    for(const n of readdirSync("drizzle").filter(n=>n.endsWith(".sql")).sort())
      src.exec(readFileSync(join("drizzle",n),"utf8"));
    db.exec(src.prepare("SELECT sql FROM sqlite_master WHERE name='territories'").get().sql);
    const territory=src.prepare("SELECT * FROM territories WHERE code='US'").get();
    const cols=Object.keys(territory);
    db.prepare("INSERT INTO territories("+cols.join(",")+") VALUES("+cols.map(()=>"?").join(",")+")").run(...Object.values(territory));
    db.exec(src.prepare("SELECT sql FROM sqlite_master WHERE name='storefront_markets'").get().sql);
    const market=src.prepare("SELECT * FROM storefront_markets WHERE country_code='US'").get();
    db.prepare("INSERT INTO storefront_markets("+Object.keys(market).join(",")+") VALUES("+Object.keys(market).map(()=>"?").join(",")+")").run(...Object.values(market));
    const qaSql=async(sql,params=[])=>{
      const stmt=db.prepare(sql);
      if(/^\s*(SELECT|PRAGMA)\b/i.test(sql))return {results:stmt.all(...params).map(r=>({...r})),success:true};
      return {results:[],meta:stmt.run(...params),success:true};
    };
    await prepareConsolidatedBusinessFixture(qaSql);
    await prepareConsolidatedBusinessFixture(qaSql);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM storefront_market_locales WHERE country_code='US' AND locale='en-US'").get().n,1);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM ui_translation_messages").get().n>0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('rights_grants','entitlements','commerce_orders')").get().n,0);
  }finally{db.close();src.close();}
});
