import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleSeoDocumentRequest } from "./features/fore/seo.server";
import { handleCoveApi, kickCatalogIngestion } from "./features/fore/api.server";
import { applySecurityHeaders, securityTxt } from "./lib/security-headers";
import { handleVercelIngestionControl, proxyPersistenceApi } from "./lib/persistence-backend";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const runtimeEnv = (env && typeof env === "object")
        ? env
        : (typeof process !== "undefined" ? process.env : {});
      const foreEnv=runtimeEnv as {
        DB?:any;BUCKET?:any;FORE_PUBLIC_URL?:string;FORE_ENVIRONMENT?:string;
        FORE_CSP_REPORT_URI?:string;FORE_SECURITY_CONTACT_EMAIL?:string;FORE_SECURITY_POLICY_URL?:string;
        FORE_BACKEND_URL?:string;FORE_BACKEND_TOKEN?:string;COVE_AUDIO_PIPELINE_URL?:string;CRON_SECRET?:string;FORE_INGESTION_TRIGGER_TOKEN?:string;FORE_INGESTION_VERIFY_JWK?:string;
      };
      if (request.method === "GET" && new URL(request.url).pathname === "/api/fore/audio-pipeline-health") {
        if (!foreEnv.COVE_AUDIO_PIPELINE_URL) {
          return applySecurityHeaders(request,new Response(JSON.stringify({ok:false,error:"Audio pipeline service binding is unavailable."}),{
            status:503,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
          }),foreEnv);
        }
        try {
          const target=new URL("/health",foreEnv.COVE_AUDIO_PIPELINE_URL);
          const response=await fetch(target,{signal:AbortSignal.timeout(15000)});
          const body=await response.text();
          let detail:unknown=body;
          try{detail=JSON.parse(body);}catch{}
          return applySecurityHeaders(request,new Response(JSON.stringify({ok:response.ok,status:response.status,detail}),{
            status:response.ok?200:502,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
          }),foreEnv);
        } catch (error) {
          return applySecurityHeaders(request,new Response(JSON.stringify({
            ok:false,error:error instanceof Error?error.message:String(error)
          }),{status:502,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}}),foreEnv);
        }
      }
      const ingestionControl = await handleVercelIngestionControl(request, foreEnv);
      if (ingestionControl) return applySecurityHeaders(request, ingestionControl, foreEnv);
      const persistenceResponse = await proxyPersistenceApi(request, foreEnv);
      if (persistenceResponse) return applySecurityHeaders(request, persistenceResponse, foreEnv);
      const apiResponse = await handleCoveApi(request, foreEnv as any);
      if (apiResponse) {
        if (foreEnv.DB && new URL(request.url).pathname === "/api/fore/catalog") {
          const waitUntil = (ctx as { waitUntil?: (promise: Promise<unknown>) => void } | undefined)?.waitUntil;
          const ingestion = kickCatalogIngestion(foreEnv as any).catch((error) => console.warn("Catalog ingestion kick failed", error));
          if (waitUntil) waitUntil(ingestion);
        }
        return applySecurityHeaders(request, apiResponse, foreEnv);
      }
      const securityDocument=securityTxt(request,foreEnv); if(securityDocument)return applySecurityHeaders(request,securityDocument,foreEnv);
      if(foreEnv.DB){const seo=await handleSeoDocumentRequest(request,foreEnv.DB,foreEnv.FORE_PUBLIC_URL);if(seo)return applySecurityHeaders(request,seo,foreEnv);}
      const publicOrigin=foreEnv.FORE_PUBLIC_URL?new URL(foreEnv.FORE_PUBLIC_URL).origin:new URL(request.url).origin;
      const forwardedHeaders=new Headers(request.headers);forwardedHeaders.set("x-fore-public-origin",publicOrigin);
      const routedRequest=new Request(request,{headers:forwardedHeaders});
      const handler = await getServerEntry();
      const response = await handler.fetch(routedRequest, runtimeEnv, ctx);
      return applySecurityHeaders(request,await normalizeCatastrophicSsrResponse(response),foreEnv);
    } catch (error) {
      console.error(error);
      return applySecurityHeaders(request,new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),((env && typeof env === "object") ? env : (typeof process !== "undefined" ? process.env : {})) as any);
    }
  },
};
