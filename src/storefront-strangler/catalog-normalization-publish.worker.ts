/* eslint-disable prettier/prettier -- Private noncustomer catalog publication endpoint. */
import { publishFencedCanonicalMetadata, type CanonicalPublisherEnv } from "./catalog-normalization-publish.server";
export default {
  async fetch(request: Request, env: CanonicalPublisherEnv) {
    if (request.method!=="POST" || new URL(request.url).pathname!=="/run" ||
        request.headers.get("content-type")!=="application/json")
      return new Response(null,{status:404});
    // Only private service binding, no workers.dev routes or cron.
    try {
      const raw=await request.text();
      if(raw.length>2048) return new Response(null,{status:413});
      const payload=JSON.parse(raw) as { ids: string[] };
      const result=await publishFencedCanonicalMetadata(env,payload.ids);
      return Response.json(result,{headers:{"cache-control":"no-store"}});
    } catch (e) {
      console.warn("Private canonical publisher denied",e instanceof Error?e.message:"error");
      return new Response(null,{status:503,headers:{"cache-control":"no-store"}});
    }
  },
};
