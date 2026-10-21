/** An explicit, authenticated trust boundary between Cove's Vercel ingress
 * and a standalone Cloudflare anonymous storefront. This module never trusts
 * client-supplied geographic headers at Cloudflare.
 */
export type FastCountryClaim = {
  country: string;
  ip: string;
  timestamp: number;
  nonce: string;
};

const encoder = new TextEncoder();
const signedHeaders = {
  country: "x-cove-fast-country",
  ip: "x-cove-fast-client",
  timestamp: "x-cove-fast-timestamp",
  nonce: "x-cove-fast-nonce",
  mac: "x-cove-fast-mac",
} as const;

function secretBytes(secret: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Fast storefront relay secret unavailable");
  return Uint8Array.from(secret.match(/.{2}/g)!, (part) => parseInt(part, 16));
}

function validClaim(claim: FastCountryClaim): boolean {
  return (
    /^[A-Z]{2}$/.test(claim.country) &&
    claim.country !== "XX" &&
    /^[a-fA-F0-9:.]{3,45}$/.test(claim.ip) &&
    Number.isSafeInteger(claim.timestamp) &&
    /^[a-f0-9]{32}$/.test(claim.nonce)
  );
}

function signedMessage(claim: FastCountryClaim): string {
  return ["cove-fast-home-v1", "GET", "/", claim.country, claim.ip, String(claim.timestamp), claim.nonce].join("\n");
}

async function macKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(secretBytes(secret)).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function verifiedVercelClient(request: Request): Pick<FastCountryClaim, "country" | "ip"> | null {
  // These are populated by Vercel ingress; do not trust similarly named
  // headers in the downstream Cloudflare Worker without the MAC.
  const country = (request.headers.get("x-vercel-ip-country") || "").toUpperCase();
  const ip = (request.headers.get("x-vercel-forwarded-for") || "").split(",")[0].trim();
  if (!/^[A-Z]{2}$/.test(country) || country === "XX") return null;
  if (!/^[a-fA-F0-9:.]{3,45}$/.test(ip)) return null;
  return { country, ip };
}

export async function signFastCountryClaim(
  claim: FastCountryClaim,
  secret: string,
): Promise<Headers> {
  if (!validClaim(claim)) throw new Error("Invalid fast storefront country claim");
  const key = await macKey(secret);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signedMessage(claim))));
  const mac = Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
  const headers = new Headers();
  headers.set(signedHeaders.country, claim.country);
  headers.set(signedHeaders.ip, claim.ip);
  headers.set(signedHeaders.timestamp, String(claim.timestamp));
  headers.set(signedHeaders.nonce, claim.nonce);
  headers.set(signedHeaders.mac, mac);
  return headers;
}

export async function verifyFastCountryClaim(
  headers: Headers,
  secret: string,
  now = Date.now(),
): Promise<FastCountryClaim | null> {
  const timestamp = Number(headers.get(signedHeaders.timestamp));
  const claim: FastCountryClaim = {
    country: headers.get(signedHeaders.country) || "",
    ip: headers.get(signedHeaders.ip) || "",
    timestamp,
    nonce: headers.get(signedHeaders.nonce) || "",
  };
  const signature = headers.get(signedHeaders.mac) || "";
  if (!validClaim(claim) || !/^[a-f0-9]{64}$/.test(signature)) return null;
  if (Math.abs(now - timestamp) > 15000) return null;
  try {
    const key = await macKey(secret);
    const data = Uint8Array.from(signature.match(/.{2}/g)!, (part) => parseInt(part, 16));
    const valid = await crypto.subtle.verify("HMAC", key, data, encoder.encode(signedMessage(claim)));
    return valid ? claim : null;
  } catch {
    return null;
  }
}
