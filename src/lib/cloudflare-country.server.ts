/**
 * Only Workers' immutable request.cf geographic metadata can assert a legal
 * storefront country on a Worker-originated SSR request. Raw HTTP headers
 * claiming to be platform values must never authorize regional content.
 */
export function trustedWorkerCountry(request: Request): string | null {
  const cloudflare = request as Request & { cf?: { country?: unknown } };
  const country = String(cloudflare.cf?.country || "").toUpperCase();
  return /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null;
}

export function isolateWorkerCountry(request: Request): Request | null {
  const country = trustedWorkerCountry(request);
  if (!country) return null;
  const headers = new Headers(request.headers);
  headers.delete("x-cove-client-country");
  headers.delete("cf-ipcountry");
  headers.delete("x-vercel-ip-country");
  headers.set("x-cove-client-country", country);
  return new Request(request, { headers });
}
