/* eslint-disable prettier/prettier -- Test-only access to unexported owner closures; never a runtime entry. */
import {readFileSync} from "node:fs";
import {build} from "esbuild";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
export async function loadPrivateFinance(outfile){
 const source=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
 await build({stdin:{contents:source+"\nexport {privateFinance as testFinance,privateRoyalty as testRoyalty,executeOwnerRefundAccounting as testRefundAccounting,readPaidAccess as testReadPaidAccess,publishFreshEntitlement as testPublishFreshEntitlement};\nexport {postPaidSettlementTransaction as testPaidSettlement} from \"../features/fore/paid-settlement-transaction.server\";\nexport const testBindFinance=db=>bindPrivateFinanceExecutors(db,{...privateRoyalty,...privateFinance});\n",
   resolveDir:resolve("src/storefront-strangler"),sourcefile:"legal-authority.worker.ts",loader:"ts"},
   outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
   plugins:[{name:"test-cloudflare-host",setup(b){
     b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"fake",namespace:"test-host"}));
     b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:"export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }"}));
   }}]});
 return import(pathToFileURL(outfile).href);
}
