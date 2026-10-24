import { publishIsolatedLiteraryInference, type IsolatedInferenceEnv } from "./lib/literary-isolated-inference.server";
import { admitCatalogBatch } from "./lib/catalog-ingestion-backpressure";

/**
 * Dedicated private operator Worker. NEVER share its service tokens with
 * a public storefront or bind it to customer ingress. It has no cron.
 */
type PublisherEnv = IsolatedInferenceEnv & {
  FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256?: string;
  FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256?: string;
};
const sha = async (value: string) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
};
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let bits=0;
  for(let i=0;i<a.length;i++) bits|=a.charCodeAt(i)^b.charCodeAt(i);
  return bits===0;
};
async function authorized(req: Request, env: PublisherEnv) {
  const pairs = [
    [req.headers.get("x-cove-literary-publish-token") || "", env.FORE_LITERARY_INFERENCE_PUBLISH_TOKEN_SHA256 || ""],
    [req.headers.get("x-cove-literary-backend-token") || "", env.FORE_LITERARY_INFERENCE_BACKEND_TOKEN_SHA256 || ""],
  ] as const;
  if(pairs[0][0]===pairs[1][0]) return false;
  for(const [actual,expected] of pairs){
    if(actual.length<40||actual.length>256||!/^[a-f0-9]{64}$/.test(expected))return false;
    if(!safeEqual(await sha(actual),expected))return false;
  }
  return true;
}
export async function handleLiteraryPublication(
  req: Request, env: PublisherEnv,
  publish: typeof publishIsolatedLiteraryInference = publishIsolatedLiteraryInference,
  admit: typeof admitCatalogBatch = admitCatalogBatch,
) {
  const url=new URL(req.url);
  if(url.pathname!=="/v1/operator/publish"||req.method!=="POST"||url.search)
    return new Response("Not found",{status:404});
  if(env.FORE_LITERARY_INFERENCE_PUBLISH_ENABLED!=="1")
    return Response.json({error:"literary_publisher_disabled"},{status:403});
  if(!(await authorized(req,env)))
    return Response.json({error:"literary_publisher_unauthorized"},{status:401});
  const headerLength=Number(req.headers.get("content-length")||0);
  if(headerLength>512)return Response.json({error:"oversized_request"},{status:413});
  const text=await req.text();
  if(text.length>512)return Response.json({error:"oversized_request"},{status:413});
  let jobId:string;
  try{
    const body=JSON.parse(text) as Record<string,unknown>;
    if(!body||typeof body!=="object"||Array.isArray(body)||
      Object.keys(body).length!==1||typeof body.jobId!=="string"||
      !/^[0-9a-f]{64}$/.test(body.jobId))throw Error("invalid");
    jobId=body.jobId;
  }catch{
    return Response.json({error:"invalid_literary_job_id"},{status:400});
  }
  const gate=await admit(env.DB,150);
  if(!gate.allowed)
    return Response.json({error:"primary_d1_busy",reason:gate.reason},
      {status:503,headers:{"cache-control":"no-store"}});
  try{
    const result=await publish(env,jobId);
    return Response.json(result,{headers:{"cache-control":"no-store"}});
  }catch(err){
    console.warn("literary_publication_failed",String(err).slice(0,120));
    return Response.json({error:"literary_publication_unavailable"},
      {status:409,headers:{"cache-control":"no-store"}});
  }
}
export default {
  async fetch(req:Request,env:PublisherEnv){
    return handleLiteraryPublication(req,env);
  },
};
