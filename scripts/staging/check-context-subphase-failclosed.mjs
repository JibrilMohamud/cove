/* eslint-disable prettier/prettier -- Source-exact synthetic context SQL failure regression. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
const root=mkdtempSync(path.join(tmpdir(),"cove-context-subphase-test-"));
try {
  const out=path.join(root,"resolver.mjs");
  await build({entryPoints:["src/features/fore/localization.server.ts"],
    outfile:out,bundle:true,platform:"neutral",format:"esm",target:"es2022",
    conditions:["workerd","worker","browser","import","default"],
    external:["node:*","cloudflare:*"],logLevel:"silent"});
  const {resolveStorefrontContext}=await import(pathToFileURL(out).href);
  const secret="NEVER_EMIT_ACCOUNT_OR_SQL";
  const original=new Error(secret);
  const marketRow={country_code:"US",market_status:"active",
    default_locale:"en-US",default_currency:"USD",active_locale:"en-US",
    active_language_code:"en",active_direction:"ltr",active_priority:1,
    tax_inclusive_default:0,checkout_enabled:1};
  const run=async(stage,includeMarkets=false,extraHeaders={})=>{
    const observed=[];
    const db={
      prepare(sql){
        const key=sql.includes("storefront_user_preferences")?"preference":
          sql.includes("storefront_currency_options")?"currency":"market";
        const stmt={
          bind(){return stmt;},
          async first(){if(key===stage)throw original;return null;},
          async all(){
            if(stage==="market"&&key==="market")throw original;
            return {results:[stage==="locale"
              ? {...marketRow,active_locale:null}:marketRow]};
          },
        };
        return stmt;
      },
      async batch(){
        if(stage==="details")throw original;
        return [
          {results:[{payment_method:"card",provider:"stripe",currency:"USD",
            availability:"available",priority:1}]},
          {results:[]},
        ];
      },
    };
    const headers=new Headers(extraHeaders);
    const request=new Request("https://stage.cove.invalid/api/fore/storefront/context",{headers});
    let result;
    try{
      result=await resolveStorefrontContext(db,request,
        stage==="preference"?"synthetic-user":null,"US",includeMarkets,
        undefined,name=>observed.push(name));
      if(stage!=="success")throw Error("Synthetic target did not fail: "+stage);
      assert.equal(result.rightsCountry,"US");
      assert.equal(result.locale,"en-US");
      assert.equal(result.currency,"USD");
      assert.equal(observed.length,0);
    }catch(error){
      if(stage==="locale"){
        assert.equal(observed.join(","),"locale");
        assert.equal(error.status,503);
      }else{
        assert.equal(error,original,"Must preserve exact rejecting D1 error identity");
        assert.deepEqual(observed,[stage],"Only fixed stage label may be emitted");
      }
    }
    assert.ok(!JSON.stringify(observed).includes(secret));
    return {stage,marker:observed[0]||null};
  };
  const cases=[];
  cases.push(await run("preference"));
  cases.push(await run("market",true));
  cases.push(await run("locale"));
  cases.push(await run("currency",false,{"cookie":"fore-currency=EUR"}));
  cases.push(await run("details"));
  cases.push(await run("success"));
  console.log(JSON.stringify({event:"cove_context_market_d1_failure_stages",
    cases,actualResolver:true,productionD1Requests:0,releaseCertified:false}));
} finally {rmSync(root,{recursive:true,force:true});}
