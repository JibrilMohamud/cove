import { WorkerEntrypoint } from "cloudflare:workers";
import { boundedReadonlyPhaseMs } from "../../src/lib/readonly-transport-metric";

interface Env {
  D1_READ_API_TOKEN: string;
  // Only the separately named, protected staging read service may enable this.
  COVE_STAGE_READ_PHASE_DIAGNOSTICS?: string;
}
type Statement = { sql: string; params: unknown[] };
const endpoint =
  "https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/d1/database/4bd657ac-8789-403e-a28c-93aba8d0a989/query";

// No native D1 binding. The credential MUST have exactly D1 Read permission.
// Cloudflare's SQL engine denies writes even if a caller submits arbitrary SQL.
export default class CanonicalReadonly extends WorkerEntrypoint<Env> {
  // Cloudflare Smart Placement affects fetch handlers, not RPC methods.
  // Keep the production private service's fetch surface permanently closed.
  // Only the separately provisioned, non-routable D1 Read staging Worker
  // may accept this exact private service-binding transport.
  async fetch(request: Request) {
    const denied = { "cache-control": "no-store" };
    if (this.env.COVE_STAGE_READ_PHASE_DIAGNOSTICS !== "1")
      return new Response(null, { status: 404, headers: denied });
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__cove/stage/primary-read" ||
      (request.headers.get("content-type") || "").split(";")[0].trim() !== "application/json"
    )
      return new Response(null, { status: 404, headers: denied });
    try {
      if (!request.body) throw new Error("Missing canonical read body");
      // Do not trust Content-Length or materialize an unbounded request.
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 512 * 1024) {
            await reader.cancel();
            throw new Error("Canonical read input too large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const payload = JSON.parse(new TextDecoder().decode(data)) as { batch?: Statement[] };
      // query() preserves the existing primary-only D1 validation, bounded
      // REST response, SQL duration metrics and no-write credential.
      const result = await this.query(payload.batch as Statement[]);
      return Response.json({ result }, { headers: denied });
    } catch {
      // Never echo provider diagnostics, SQL, rights, account data or token.
      return new Response(null, { status: 503, headers: denied });
    }
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
    const remoteStarted = performance.now();
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
    const headersAt = performance.now();
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
    const bodyReadAt = performance.now();
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
    const decodedAt = performance.now();
    if (
      !body.success ||
      !Array.isArray(body.result) ||
      body.result.length !== statements.length ||
      body.result.some(
        (r) => !r.success || !Array.isArray(r.results) || r.meta?.served_by_primary !== true,
      )
    )
      throw new Error("Canonical primary read unavailable");
    // This source also backs the established shared private read service.
    // It MUST NOT emit experimental metadata in that service. Only a
    // separately provisioned staging service opts in; all other responses
    // retain the original production-compatible metadata contract.
    if (this.env.COVE_STAGE_READ_PHASE_DIAGNOSTICS !== "1") return body.result;
    // Numeric-only timings accompany the SAME verified primary D1 result.
    // No SQL text, parameters, identities, URLs or provider error messages.
    const phases = {
      cove_read_headers_ms: boundedReadonlyPhaseMs(remoteStarted, headersAt),
      cove_read_body_ms: boundedReadonlyPhaseMs(headersAt, bodyReadAt),
      cove_read_decode_ms: boundedReadonlyPhaseMs(bodyReadAt, decodedAt),
    };
    return body.result.map((row) => ({ ...row, meta: { ...row.meta, ...phases } }));
  }
}
