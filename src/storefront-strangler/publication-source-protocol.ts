export const PUBLICATION_SOURCE_ROUTE = "/__cove/publication/advisory-source";
export const PUBLICATION_SOURCE_SCHEMA = "cove.publication-advisory-source.v1";
export type PublicationSourcePort = { fetch(request: Request): Promise<Response> };
export async function requestPublicationSource(
  port: PublicationSourcePort,
  secret: string,
  country?: string,
) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("publication_reader_secret_missing");
  const response = await port.fetch(
    new Request("https://legal-authority.internal" + PUBLICATION_SOURCE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + secret },
      body: JSON.stringify(country ? { country } : {}),
      signal: AbortSignal.timeout(25_000),
    }),
  );
  if (response.status !== 200) throw Error("publication_reader_unavailable");
  const payload = (await response.json()) as {
    schema?: string;
    country?: string;
    countries?: string[];
    body?: string;
    expiresAt?: number;
  };
  if (payload.schema !== PUBLICATION_SOURCE_SCHEMA) throw Error("publication_reader_invalid");
  if (!country) {
    if (
      !Array.isArray(payload.countries) ||
      !payload.countries.length ||
      payload.countries.length > 32 ||
      payload.countries.some((c) => !/^[A-Z]{2}$/.test(c)) ||
      new Set(payload.countries).size !== payload.countries.length
    )
      throw Error("publication_reader_invalid_markets");
  } else if (
    payload.country !== country ||
    typeof payload.body !== "string" ||
    new TextEncoder().encode(payload.body).byteLength > 512 * 1024 ||
    !Number.isSafeInteger(payload.expiresAt) ||
    Number(payload.expiresAt) <= Date.now()
  )
    throw Error("publication_reader_invalid_snapshot");
  return payload;
}
