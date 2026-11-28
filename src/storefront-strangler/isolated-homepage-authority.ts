import { authorizeIsolatedContractlessPrefix } from "./isolated-contractless-authority";
import { bootstrapFailureKind } from "./failure";
import { readOnlyStageD1 } from "./readonly-stage-d1";
import { authorizeStorefrontPresentationIds } from "../features/fore/catalog-model.server";
import type { CatalogDB } from "../features/fore/catalog-model.server";

export const isolatedHomepageDatabase = "15ce2ea3-17f8-4d99-9015-a78a6a3af05d";
export type IsolatedHomepageAuthorityEnv = {
  COVE_SSR_STAGING?: string;
  COVE_STRANGLER_MODE?: string;
  COVE_STRANGLER_DATABASE_ID?: string;
  COVE_STRANGLER_READ_MODEL?: string;
  COVE_STRANGLER_RELEASE_CERTIFIED?: string;
  COVE_ISOLATED_HOMEPAGE_AUTHORITY?: { fetch(request: Request): Promise<Response> };
  COVE_HOMEPAGE_AUTHORITY_KEY?: string;
  COVE_SSR_STAGING_GATE_KEY?: string;
};

// This port checks current canonical rights in the isolated snapshot only.
// It is not a production legal owner or a legal-generation attestation.
export function hasIsolatedHomepageAuthority(env: IsolatedHomepageAuthorityEnv) {
  return (
    env.COVE_SSR_STAGING === "1" &&
    env.COVE_STRANGLER_MODE === "isolated-real-catalog" &&
    env.COVE_STRANGLER_DATABASE_ID === isolatedHomepageDatabase &&
    env.COVE_STRANGLER_READ_MODEL === "2" &&
    env.COVE_STRANGLER_RELEASE_CERTIFIED !== "1" &&
    typeof env.COVE_ISOLATED_HOMEPAGE_AUTHORITY?.fetch === "function" &&
    /^[a-f0-9]{64}$/.test(env.COVE_HOMEPAGE_AUTHORITY_KEY || "") &&
    env.COVE_HOMEPAGE_AUTHORITY_KEY !== env.COVE_SSR_STAGING_GATE_KEY
  );
}

export default {
  async fetch(
    request: Request,
    env: IsolatedHomepageAuthorityEnv & { DB: CatalogDB },
  ): Promise<Response> {
    const respond = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    // No production identifier, raw SQL, customer credential, or mutation API.
    if (
      env.COVE_SSR_STAGING !== "1" ||
      env.COVE_STRANGLER_MODE !== "isolated-real-catalog" ||
      env.COVE_STRANGLER_DATABASE_ID !== isolatedHomepageDatabase ||
      env.COVE_STRANGLER_RELEASE_CERTIFIED === "1" ||
      !/^[a-f0-9]{64}$/.test(env.COVE_HOMEPAGE_AUTHORITY_KEY || "") ||
      !env.DB
    )
      return respond(503);
    const url = new URL(request.url);
    if (
      url.origin !== "https://legal-authority.internal" ||
      url.pathname !== "/storefront/authorize-batch" ||
      url.search ||
      request.method !== "POST"
    )
      return respond(404);
    const supplied = request.headers.get("authorization") || "";
    const encoder = new TextEncoder();
    const [left, right] = await Promise.all(
      [supplied, "Bearer " + env.COVE_HOMEPAGE_AUTHORITY_KEY].map((value) =>
        crypto.subtle.digest("SHA-256", encoder.encode(value)),
      ),
    );
    let difference = 0;
    const a = new Uint8Array(left),
      b = new Uint8Array(right);
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    if (difference) return respond(401);
    try {
      const text = await request.text();
      if (text.length > 16384) return respond(413);
      const body = JSON.parse(text);
      if (
        !body ||
        Object.keys(body).sort().join(",") !== "currency,ids,territory" ||
        !Array.isArray(body.ids) ||
        body.ids.length < 1 ||
        body.ids.length > 128 ||
        new Set(body.ids).size !== body.ids.length ||
        body.ids.some(
          (id: unknown) => typeof id !== "string" || !/^prd_gutenberg_[1-9][0-9]{0,8}$/.test(id),
        ) ||
        !/^[A-Z]{2}$/.test(body.territory) ||
        !/^[A-Z]{3}$/.test(body.currency)
      )
        return respond(400);
      const native = env.DB as CatalogDB & { withSession?: (constraint: string) => CatalogDB };
      const primary = readOnlyStageD1(
        typeof native.withSession === "function" ? native.withSession("first-primary") : native,
      );
      const prefix = body.ids.slice(0, 25);
      let rows = await authorizeIsolatedContractlessPrefix(
        primary,
        prefix,
        body.territory,
        body.currency,
      );
      // Preserve stable replacements after withdrawal; never cache a decision.
      if (
        rows.length !== prefix.length ||
        rows.some((row, index) => row.product_id !== prefix[index])
      )
        rows = await authorizeStorefrontPresentationIds(
          primary,
          body.ids,
          body.territory,
          body.currency,
        );
      return respond(200, { schema: "cove.storefront-owner.v1", rows });
    } catch (error) {
      const response = respond(503);
      response.headers.set("x-cove-isolated-authority-failure", bootstrapFailureKind(error));
      return response;
    }
  },
};
