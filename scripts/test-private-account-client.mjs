/* eslint-disable prettier/prettier -- Existing privacy fixtures use the actual private owner and actual public forwarding API. */
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {loadPrivateFinance} from "./test-private-finance-loader.mjs";
export async function loadAccountOwnerTestClient(folder){
 const {CoveLegalAuthority}=await loadPrivateFinance(join(folder,"private-account-owner.mjs"));
 const file=join(folder,"private-account-caller.mjs");
 await build({stdin:{contents:`export {processAccountDeletionQueue} from "./src/features/fore/account-management.server";
 export {bindPublicationOwner} from "./src/storefront-strangler/publication-owner-routing.server";`,resolveDir:resolve("."),loader:"ts"},outfile:file,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
 const client=await import(pathToFileURL(file).href),owners=new WeakMap(),stores=[];
 return {async processAccountDeletionQueue(env,limit=25){
  let state=owners.get(env.DB);
  if(!state){
   const durable=new DatabaseSync(":memory:");stores.push(durable);
   const sql={exec(query,...args){const q=durable.prepare(query),rows=q.columns().length?q.all(...args):(q.run(...args),[]);return {toArray:()=>rows};}};
   state={environment:{},sql};state.owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},state.environment);
   owners.set(env.DB,state);
  }
  const secret="a".repeat(64);
  Object.assign(state.environment,env,{PRIMARY_DB:env.DB,COVE_RIGHTS_OWNER_ENABLED:"1",COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),COVE_RIGHTS_OWNER_SECRET:secret});
  const db=client.bindPublicationOwner(env.DB,{owner:{fetch:request=>state.owner.fetch(request)},secret,territory:"US",currency:"USD"});
  return client.processAccountDeletionQueue({...env,DB:db},limit);
 },close(){for(const store of stores)store.close();}};
}
