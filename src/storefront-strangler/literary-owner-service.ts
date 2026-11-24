import type { CatalogDB } from "../features/fore/catalog-model.server";
import type { CoveEnv } from "../features/fore/api.server";
import { publishIsolatedLiteraryInference } from "../lib/literary-isolated-inference.server";
import { runBoundedLiteraryHandoffTick } from "../content-processing.worker";
import { admitCatalogBatch } from "../lib/catalog-ingestion-backpressure";
import { PRODUCTION_LEGAL_PRIMARY } from "./production-disabled-owner-attestation";
import {
  LITERARY_READ_ROUTE,
  LITERARY_READ_SCHEMA,
  LITERARY_HANDOFF_ROUTE,
  LITERARY_PUBLICATION_ROUTE,
  literaryReads,
} from "./literary-owner-protocol";

export type LiteraryOwnerServiceEnv = {
  PRIMARY_DB: CatalogDB;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  LITERARY_CONTENT_DB?: CatalogDB;
  LITERARY_BUCKET?: CoveEnv["BUCKET"];
  COVE_LITERARY_READ_SECRET?: string;
  COVE_LITERARY_HANDOFF_SECRET?: string;
  COVE_LITERARY_PUBLICATION_SECRET?: string;
};
const noStore = { "cache-control": "no-store" };
async function authenticated(request: Request, secret: string | undefined) {
  if (!/^[a-f0-9]{64}$/.test(secret || "")) return false;
  const supplied = request.headers.get("authorization") || "";
  if (!/^Bearer [a-f0-9]{64}$/.test(supplied)) return false;
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(supplied)),
    crypto.subtle.digest("SHA-256", encode.encode("Bearer " + secret)),
  ]);
  let difference = 0;
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
async function input(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw Error("body_missing");
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        text += decoder.decode();
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > 2048) {
        await reader.cancel();
        throw Error("body_oversize");
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("body_invalid");
  return parsed;
}
/** Owns derived literary job/profile effects only, never a legal grant or entitlement. */
export async function handleLiteraryOwnerService(request: Request, env: LiteraryOwnerServiceEnv) {
  const url = new URL(request.url),
    route = url.pathname;
  const secret =
    route === LITERARY_READ_ROUTE
      ? env.COVE_LITERARY_READ_SECRET
      : route === LITERARY_HANDOFF_ROUTE
        ? env.COVE_LITERARY_HANDOFF_SECRET
        : route === LITERARY_PUBLICATION_ROUTE
          ? env.COVE_LITERARY_PUBLICATION_SECRET
          : undefined;
  if (![LITERARY_READ_ROUTE, LITERARY_HANDOFF_ROUTE, LITERARY_PUBLICATION_ROUTE].includes(route))
    return new Response(null, { status: 404, headers: noStore });
  if (env.COVE_RIGHTS_OWNER_PRIMARY_ID !== PRODUCTION_LEGAL_PRIMARY || !secret)
    return new Response(null, { status: 503, headers: noStore });
  if (!(await authenticated(request, secret)))
    return new Response(null, { status: 401, headers: noStore });
  if (
    request.method !== "POST" ||
    url.search ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return new Response(null, { status: 405, headers: noStore });
  let body: Record<string, unknown>;
  try {
    body = await input(request);
  } catch {
    return new Response(null, { status: 400, headers: noStore });
  }
  try {
    if (route === LITERARY_READ_ROUTE) {
      if (
        Object.keys(body).sort().join(",") !== "args,op" ||
        typeof body.op !== "string" ||
        !Object.hasOwn(literaryReads, body.op) ||
        !Array.isArray(body.args)
      )
        return new Response(null, { status: 400, headers: noStore });
      const read = literaryReads[body.op as keyof typeof literaryReads];
      if (
        body.args.length !== read.count ||
        body.args.some((value) => typeof value !== "string" || !/^[\w:.-]{1,180}$/.test(value))
      )
        return new Response(null, { status: 400, headers: noStore });
      const row = await env.PRIMARY_DB.prepare(read.sql)
        .bind(...body.args)
        .first();
      console.info(JSON.stringify({ event: "literary_owner_read", operation: body.op }));
      return Response.json(
        { schema: LITERARY_READ_SCHEMA, op: body.op, row },
        { headers: noStore },
      );
    }
    // Actual handlers independently verify the isolated schema/domain and
    // canonical processing owner. Callers cannot supply flags, SQL or profiles.
    if (
      !env.LITERARY_CONTENT_DB ||
      env.LITERARY_CONTENT_DB === env.PRIMARY_DB ||
      !env.LITERARY_BUCKET
    )
      return new Response(null, { status: 503, headers: noStore });
    if (route === LITERARY_HANDOFF_ROUTE) {
      if (Object.keys(body).join(",") !== "reconcile" || typeof body.reconcile !== "boolean")
        return new Response(null, { status: 400, headers: noStore });
      const admission = await admitCatalogBatch(env.PRIMARY_DB, 100);
      if (!admission.allowed) {
        console.info(
          JSON.stringify({
            event: "literary_owner_handoff_deferred",
            reason: admission.reason,
            probeMs: admission.probeMs,
          }),
        );
        return Response.json(
          { skipped: admission.reason, probeMs: admission.probeMs },
          { headers: noStore },
        );
      }
      const result = await runBoundedLiteraryHandoffTick({
        DB: env.PRIMARY_DB,
        CONTENT_DB: env.LITERARY_CONTENT_DB,
        BUCKET: env.LITERARY_BUCKET,
        FORE_CONTENT_PROCESSOR_ROLE: "literary-handoff",
        FORE_CONTENT_PROCESSOR_ENABLED: "1",
        FORE_CONTENT_PREPARE_ENABLED: "1",
        FORE_CONTENT_HANDOFF_ENABLED: "1",
        FORE_LITERARY_DRAIN_RECONCILE_ENABLED: body.reconcile ? "1" : "0",
      });
      console.info(
        JSON.stringify({ event: "literary_owner_handoff", examined: result.handoffs.length }),
      );
      return Response.json(result, { headers: noStore });
    }
    if (
      Object.keys(body).join(",") !== "jobId" ||
      typeof body.jobId !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.jobId)
    )
      return new Response(null, { status: 400, headers: noStore });
    const result = await publishIsolatedLiteraryInference(
      {
        DB: env.PRIMARY_DB,
        CONTENT_DB: env.LITERARY_CONTENT_DB,
        BUCKET: env.LITERARY_BUCKET,
        FORE_LITERARY_INFERENCE_PUBLISH_ENABLED: "1",
      },
      body.jobId,
    );
    console.info(
      JSON.stringify({
        event: "literary_owner_publication",
        outcome: "published" in result ? "published" : "skipped",
      }),
    );
    return Response.json(result, { headers: noStore });
  } catch {
    console.error(JSON.stringify({ event: "literary_owner_unavailable", route }));
    return new Response(null, { status: 503, headers: noStore });
  }
}
