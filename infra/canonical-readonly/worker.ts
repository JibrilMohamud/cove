import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  D1_READ_API_TOKEN: string;
}
type Statement = { sql: string; params: unknown[] };
const endpoint =
  "https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query";

// No native D1 binding. The credential MUST have exactly D1 Read permission.
// Cloudflare's SQL engine denies writes even if a caller submits arbitrary SQL.
export default class CanonicalReadonly extends WorkerEntrypoint<Env> {
  async fetch() {
    return new Response(null, { status: 404 });
  }

  async query(statements: Statement[]) {
    if (
      !Array.isArray(statements) ||
      !statements.length ||
      statements.length > 100 ||
      statements.some(
        (s) =>
          !s ||
          typeof s.sql !== "string" ||
          !s.sql.length ||
          s.sql.length > 100_000 ||
          !Array.isArray(s.params) ||
          s.params.length > 100,
      )
    )
      throw new Error("Invalid canonical read request");
    const encoded = JSON.stringify({ batch: statements });
    if (new TextEncoder().encode(encoded).length > 512 * 1024)
      throw new Error("Canonical read request too large");
    if (!this.env.D1_READ_API_TOKEN) throw new Error("Canonical read unavailable");
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${this.env.D1_READ_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: encoded,
      signal: AbortSignal.timeout(8_000),
    });
    // Do not propagate provider errors: they can contain SQL and customer values.
    if (!response.ok) {
      const details = (await response.json().catch(() => null)) as {
        errors?: { code?: number }[];
      } | null;
      const code = details?.errors?.[0]?.code;
      console.error(
        JSON.stringify({
          event: "canonical-read-upstream-failure",
          status: response.status,
          code: Number.isSafeInteger(code) ? code : null,
        }),
      );
      throw new Error(
        "Canonical read unavailable: HTTP " +
          response.status +
          " code " +
          (Number.isSafeInteger(code) ? code : "unknown"),
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Canonical read unavailable");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("Canonical read response too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder().decode(data)) as {
      success?: boolean;
      result?: Array<{
        success?: boolean;
        results?: unknown[];
        meta?: { served_by_primary?: boolean };
      }>;
    };
    if (
      !body.success ||
      !Array.isArray(body.result) ||
      body.result.length !== statements.length ||
      body.result.some(
        (r) => !r.success || !Array.isArray(r.results) || r.meta?.served_by_primary !== true,
      )
    )
      throw new Error("Canonical primary read unavailable");
    return body.result;
  }
}
