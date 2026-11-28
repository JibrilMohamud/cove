import { produceHomepagePresentation } from "./homepage-presentation.server";
import { checkedSource } from "./publication-capture.server";
import { PRODUCTION_LEGAL_PRIMARY } from "./production-disabled-owner-attestation";
import { PUBLICATION_SOURCE_ROUTE, PUBLICATION_SOURCE_SCHEMA } from "./publication-source-protocol";
type Env = {
  PRIMARY_DB: Parameters<typeof checkedSource>[0];
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_PUBLICATION_SOURCE_READER_SECRET?: string;
};
/** Advisory discovery only. No SQL, user identity, entitlement or legal command is accepted. */
export async function readPublicationSource(request: Request, env: Env): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (
    env.COVE_RIGHTS_OWNER_PRIMARY_ID !== PRODUCTION_LEGAL_PRIMARY ||
    !/^[a-f0-9]{64}$/.test(env.COVE_PUBLICATION_SOURCE_READER_SECRET || "")
  )
    return new Response(null, { status: 503, headers });
  if (
    request.headers.get("authorization") !==
    "Bearer " + env.COVE_PUBLICATION_SOURCE_READER_SECRET
  )
    return new Response(null, { status: 401, headers });
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== PUBLICATION_SOURCE_ROUTE ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return new Response(null, { status: 405, headers });
  let input: unknown;
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  try {
    let body = "",
      length = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const part = await reader.read();
      if (part.done) {
        body += decoder.decode();
        break;
      }
      length += part.value.byteLength;
      if (length > 128) {
        await reader.cancel();
        return new Response(null, { status: 413, headers });
      }
      body += decoder.decode(part.value, { stream: true });
    }
    input = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400, headers });
  } finally {
    reader.releaseLock();
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return new Response(null, { status: 400, headers });
  const keys = Object.keys(input),
    country = (input as { country?: unknown }).country;
  if (
    keys.length &&
    (keys.join(",") !== "country" || typeof country !== "string" || !/^[A-Z]{2}$/.test(country))
  )
    return new Response(null, { status: 400, headers });
  try {
    const db = checkedSource(env.PRIMARY_DB);
    const countries = (
      await db
        .prepare(
          "SELECT country_code FROM storefront_markets WHERE market_status='active' ORDER BY country_code LIMIT 33",
        )
        .all<{ country_code: string }>()
    ).results.map((x) => x.country_code);
    if (!countries.length || countries.length > 32 || countries.some((c) => !/^[A-Z]{2}$/.test(c)))
      throw Error("invalid_markets");
    if (!keys.length)
      return Response.json({ schema: PUBLICATION_SOURCE_SCHEMA, countries }, { headers });
    if (!countries.includes(country as string)) return new Response(null, { status: 409, headers });
    let body = "";
    const snapshot = await produceHomepagePresentation(db, country as string, {
      async get() {
        throw Error("publication_reader_cannot_read_serving_objects");
      },
      async put(_key, value) {
        body = value;
      },
    });
    if (
      !body ||
      new TextEncoder().encode(body).byteLength > 512 * 1024 ||
      snapshot.expiresAt <= Date.now()
    )
      throw Error("invalid_snapshot");
    return Response.json(
      { schema: PUBLICATION_SOURCE_SCHEMA, country, body, expiresAt: snapshot.expiresAt },
      { headers },
    );
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
