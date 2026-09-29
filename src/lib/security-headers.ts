export type SecurityHeaderEnv={
  FORE_PUBLIC_URL?:string;
  FORE_ENVIRONMENT?:string;
  FORE_CSP_REPORT_URI?:string;
  FORE_SECURITY_CONTACT_EMAIL?:string;
  FORE_SECURITY_POLICY_URL?:string;
};

function isHttps(request:Request,env:SecurityHeaderEnv){
  const publicUrl=env.FORE_PUBLIC_URL; if(publicUrl){try{return new URL(publicUrl).protocol==="https:";}catch{}}
  return new URL(request.url).protocol==="https:";
}

export function securityTxt(request:Request,env:SecurityHeaderEnv){
  const url=new URL(request.url);if(url.pathname!=="/.well-known/security.txt")return null;
  const contact=env.FORE_SECURITY_CONTACT_EMAIL?.trim();
  const policy=env.FORE_SECURITY_POLICY_URL?.trim()||`${(env.FORE_PUBLIC_URL||url.origin).replace(/\/$/,"")}/security`;
  const lines=[contact?`Contact: mailto:${contact}`:`Contact: ${policy}`,`Policy: ${policy}`,"Preferred-Languages: en","Canonical: "+`${(env.FORE_PUBLIC_URL||url.origin).replace(/\/$/,"")}/.well-known/security.txt`,`Expires: ${new Date(Date.now()+180*86400000).toISOString()}`];
  return new Response(lines.join("\n")+"\n",{headers:{"content-type":"text/plain; charset=utf-8","cache-control":"public, max-age=3600","x-content-type-options":"nosniff"}});
}

export function applySecurityHeaders(request:Request,response:Response,env:SecurityHeaderEnv){
  const headers=new Headers(response.headers),report=env.FORE_CSP_REPORT_URI?.trim();
  const csp=[
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
    ...(report?[`report-uri ${report}`]:[]),
  ].join("; ");
  headers.set("Content-Security-Policy",csp);
  headers.set("Permissions-Policy","camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), browsing-topics=(), interest-cohort=(), payment=(self)");
  headers.set("Referrer-Policy","strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options","nosniff");
  headers.set("X-Frame-Options","DENY");
  headers.set("Cross-Origin-Opener-Policy","same-origin");
  headers.set("Cross-Origin-Resource-Policy","same-origin");
  headers.set("Origin-Agent-Cluster","?1");
  if(isHttps(request,env)&&(env.FORE_ENVIRONMENT||"production")!=="development")headers.set("Strict-Transport-Security","max-age=31536000; includeSubDomains; preload");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
