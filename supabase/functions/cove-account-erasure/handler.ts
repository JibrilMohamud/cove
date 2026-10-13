const context = "cove-account-erasure:v1\n";
const decode = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192) throw new Error("invalid_proof");
  return Uint8Array.from(
    atob(
      value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
};
export async function handleErasure(
  request: Request,
  trustKey: JsonWebKey,
  erase: (providerId: string) => Promise<boolean>,
) {
  const reply = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "cache-control": "no-store" } });
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  let providerId: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("invalid_proof");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 12000) {
        await reader.cancel();
        throw new Error("invalid_proof");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const { payload, signature } = JSON.parse(new TextDecoder().decode(bytes)) as {
      payload: string;
      signature: string;
    };
    const key = await crypto.subtle.importKey(
      "jwk",
      trustKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        decode(signature),
        new TextEncoder().encode(context + payload),
      ))
    )
      throw new Error("invalid_proof");
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    const now = Date.now();
    if (
      claims.version !== 1 ||
      claims.audience !== "cove-account-erasure" ||
      claims.action !== "erase" ||
      !Number.isFinite(claims.issuedAt) ||
      !Number.isFinite(claims.expiresAt) ||
      claims.issuedAt > now + 30000 ||
      claims.expiresAt <= now ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > 120000 ||
      !/^[0-9a-f-]{36}$/i.test(claims.providerId) ||
      claims.userId !== `sb:${claims.providerId}` ||
      !/^delete_[0-9a-f-]{36}$/i.test(claims.requestId)
    )
      throw new Error("invalid_proof");
    providerId = claims.providerId;
  } catch {
    return reply({ error: "invalid_erasure_proof" }, 401);
  }
  try {
    if (!(await erase(providerId))) return reply({ error: "identity_erasure_unconfirmed" }, 503);
    return reply({ deleted: true, providerId });
  } catch {
    return reply({ error: "identity_erasure_unconfirmed" }, 503);
  }
}
