/* eslint-disable prettier/prettier -- Exact security/staging parity is a release invariant. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const folder = mkdtempSync(path.join(tmpdir(), "cove-one-response-"));
try {
  const outfile = path.join(folder, "security.mjs");
  await build({entryPoints:["src/lib/security-headers.ts"],outfile,
    bundle:true,platform:"node",target:"node22",format:"esm",logLevel:"silent"});
  const {buildSecurityHeaders,applySecurityHeaders}=await import(pathToFileURL(outfile).href);
  for (const url of ["https://stage.example.com/","http://localhost:8787/"]) {
    for (const mode of ["production","development"]) {
      const request=new Request(url,{headers:{"accept-encoding":"br"}});
      const env={FORE_ENVIRONMENT:mode,FORE_CSP_REPORT_URI:"https://reports.example.com/csp"};
      const input=new Response("<html>Authorized and CSP protected</html>",{
        status:200,headers:{"content-type":"text/html; charset=utf-8","server-timing":"cove_catalog;dur=32"}});
      const original=applySecurityHeaders(request,input,env);
      const optimized=buildSecurityHeaders(request,input.headers,env);
      assert.deepEqual([...optimized].sort(),[...original.headers].sort(),
        "Single-wrapping path must retain exact CSP, HSTS, referrer, CORP, and permissions");
      optimized.set("server-timing","cove_catalog;dur=32, cove_handler;dur=34");
      optimized.set("cache-control","no-store, max-age=0");
      optimized.set("x-robots-tag","noindex, nofollow, noarchive");
      const output=new Response(input.body,{status:input.status,headers:optimized});
      assert.match(await output.text(),/Authorized and CSP protected/);
      assert.equal(output.headers.get("x-frame-options"),"DENY");
      assert.equal(output.headers.get("cross-origin-resource-policy"),"same-origin");
      assert.equal(output.headers.get("cache-control"),"no-store, max-age=0");
      assert.equal(output.headers.get("x-robots-tag"),"noindex, nofollow, noarchive");
      assert.ok(output.headers.get("server-timing")?.includes("cove_catalog;dur=32"));
    }
  }
  console.log("PASS: single-wrap storefront security headers match the legacy CSP/HSTS policy");
}finally{rmSync(folder,{force:true,recursive:true});}
