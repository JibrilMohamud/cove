/* eslint-disable prettier/prettier -- one-hop unbound production gateway */
import {WorkerEntrypoint} from "cloudflare:workers";
import {checkToken,bearer,productionBiosyncRequest,hashConfigured,refuse} from "./production-persistence-enrollment";
type Env={
  COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED?:string;
  FORE_ENVIRONMENT?:string;
  FORE_BACKEND_TOKEN_SHA256?:string;
  COVE_BIOSYNC_CLIENT_TOKEN_SHA256?:string;
  BUSINESS_OWNER?:{fetch(request:Request):Promise<Response>;attestDisabledOwner():Promise<unknown>};
};
function enrolled(env:Env){
  return env.COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED==="1"&&env.FORE_ENVIRONMENT==="production"&&
    hashConfigured(env.FORE_BACKEND_TOKEN_SHA256)&&!!env.BUSINESS_OWNER?.fetch&&
    Object.keys(env).every(k=>["COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED","FORE_ENVIRONMENT",
      "FORE_BACKEND_TOKEN_SHA256","COVE_BIOSYNC_CLIENT_TOKEN_SHA256","BUSINESS_OWNER"].includes(k));
}
export class BackendOwnerAttestation extends WorkerEntrypoint<Env>{
  async fetch(){return refuse(404);}
  async attestDisabledOwner(){
    if(!enrolled(this.env))throw Error("production_gateway_not_enrolled");
    return this.env.BUSINESS_OWNER!.attestDisabledOwner();
  }
}
export default {
  async fetch(request:Request,env:Env){
    if(!enrolled(env))return refuse();
    const biosync=productionBiosyncRequest(request);
    const expected=biosync?env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256:env.FORE_BACKEND_TOKEN_SHA256;
    if(biosync&&expected===env.FORE_BACKEND_TOKEN_SHA256)return refuse();
    if(!await checkToken(biosync?bearer(request):request.headers.get("x-cove-backend-token")||"",expected))
      return refuse(401);
    // No D1, no R2, no cron, no raw owner secret. Never retry an uncertain write.
    try{return await env.BUSINESS_OWNER!.fetch(request);}catch{return refuse();}
  }
};
