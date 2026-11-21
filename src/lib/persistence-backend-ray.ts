/**
 * Correlation-only Cloudflare Ray evidence for failed persistence responses.
 * A Ray is not proof of a failing service. Never log raw upstream headers,
 * URL, identity, cookies, SQL, credentials, response body or exception text.
 */
export function validatedBackendFailureRay(headers: Pick<Headers, "get">): string {
  const ray = headers.get("cf-ray");
  return ray && /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : "unavailable";
}
