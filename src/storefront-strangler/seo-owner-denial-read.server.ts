/**
 * Source-only private-service-binding client for a fresh canonical owner DO
 * denial epoch. THIS DOES NOT CREATE A LIVE OWNER ROUTE.
 *
 * No CDN, KV, account request headers or replica may supply legal proof.
 * Owner must be enabled, authenticated and independently certified before
 * a protected staging caller is ever wired to this port.
 */
import {
  SEO_OWNER_DENIAL_AUTHORITY,
  SEO_OWNER_DENIAL_ROUTE,
  SEO_OWNER_DENIAL_SCHEMA,
} from "./seo-owner-denial-epoch";
import {
  readSeoCountEvidence,
  type SeoPrimaryDb,
  type VerifiedSeoOwner,
} from "./seo-primary-d1-counts.server";
import type {
  SeoCountServingEvidence,
  SeoOwnerDenialProof,
} from "../features/fore/seo-count-projection";

type PrivateOwner = { fetch(request: Request): Promise<Response> };
function safeEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
function freshChallenge() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

/** Fails on unavailable/mismatched/unauthenticated/replayed owner response. */
export async function readFreshSeoOwnerDenialProof(
  owner: PrivateOwner,
  secret: string,
  ownerVersion: string,
): Promise<SeoOwnerDenialProof> {
  if (
    !owner ||
    typeof owner.fetch !== "function" ||
    typeof secret !== "string" ||
    !/^[a-f0-9]{64}$/.test(secret) ||
    typeof ownerVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerVersion)
  )
    throw Error("seo_owner_proof_binding_invalid");
  const challenge = freshChallenge();
  const req = new Request("https://legal-authority.internal" + SEO_OWNER_DENIAL_ROUTE, {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify({ challenge }),
  });
  const response = await owner.fetch(req);
  if (
    response.status !== 200 ||
    response.headers.get("set-cookie") !== null ||
    !/\bno-store\b/i.test(response.headers.get("cache-control") || "") ||
    !/application\/json/i.test(response.headers.get("content-type") || "")
  )
    throw Error("seo_owner_proof_unavailable");
  const body = await response.text();
  if (body.length > 512) throw Error("seo_owner_proof_invalid");
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw Error("seo_owner_proof_invalid");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw Error("seo_owner_proof_invalid");
  const x = doc as Record<string, unknown>;
  if (
    Object.keys(x).sort().join(",") !== "authority,challenge,denialEpoch,ownerVersion,schema" ||
    x.schema !== SEO_OWNER_DENIAL_SCHEMA ||
    x.authority !== SEO_OWNER_DENIAL_AUTHORITY ||
    x.ownerVersion !== ownerVersion ||
    x.challenge !== challenge ||
    !safeEpoch(x.denialEpoch)
  )
    throw Error("seo_owner_proof_invalid");
  return {
    schema: SEO_OWNER_DENIAL_SCHEMA,
    ownerVersion,
    denialEpoch: x.denialEpoch,
    authority: SEO_OWNER_DENIAL_AUTHORITY,
  };
}

/**
 * Order is intentional: first one atomic primary-D1 snapshot/fence SELECT,
 * then a new DO read. A denial acknowledged after the D1 read but before the
 * owner read is detected, and the sitemap handler fails closed.
 *
 * There is no retry that serves a previously accepted snapshot on DO error.
 * The linearization point is the final owner read. A later denial cannot
 * retroactively retract a response already sent; request-level page URL
 * authorization remains an independent mandatory prerequisite.
 */
export async function loadSeoCountEvidenceWithOwner(
  primary: SeoPrimaryDb,
  witness: VerifiedSeoOwner,
  owner: PrivateOwner,
  secret: string,
): Promise<SeoCountServingEvidence> {
  const d1 = await readSeoCountEvidence(primary, witness);
  const ownerDenialProof = await readFreshSeoOwnerDenialProof(owner, secret, witness.ownerVersion);
  return { ...d1, ownerDenialProof };
}
