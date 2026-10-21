import type { CoveEnv } from "../features/fore/api.server";
import { isolateWorkerCountry } from "../lib/cloudflare-country.server";
import { verifyFastCountryClaim } from "../lib/fast-storefront-relay.server";
import {
  rejectUnauthenticatedStagingRequest,
  stageNoStore,
} from "../lib/cloudflare-ssr-stage-gate.server";
import { applySecurityHeaders } from "../lib/security-headers";
import {
  canUseLeanAnonymousBootstrap,
  serveLeanAnonymousBootstrap,
} from "./bootstrap-optimized.server";
import type { StorefrontBootstrap } from "../features/fore/storefront-bootstrap";
import { renderStranglerStorefront } from "./render";
import { bootstrapFailureKind } from "./failure";
import { syntheticBenchmarkClient } from "./synthetic-client";

/** Build-isolated serving boundary. No auth, orders, reader or background code.
 * Existing domain logic is reused through type-only references. This pilot is
 * deliberately non-routable: no production DNS, no customer credentials.
 */
export type StorefrontStranglerEnv = CoveEnv & {
  COVE_STRANGLER_MODE?: string;
  COVE_STRANGLER_DATABASE_ID?: string;
  COVE_STRANGLER_EXPERIENCE?: string;
  COVE_STRANGLER_RELEASE_CERTIFIED?: string;
  COVE_FAST_RELAY_KEY?: string;
  COVE_SSR_STAGING_GATE_KEY?: string;
  COVE_INTERNAL_CORE_STAGE_GATE_KEY?: string;
  CORE: { fetch(request: Request): Promise<Response> };
};

/** Hard prohibit D1 writes by the real-catalog, credential-gated preview. */
function readOnlyStageD1<T extends object>(db: T, approved = new WeakMap<object, object>()): T {
  const wrapStatement = (statement: object): object => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) =>
            wrapStatement((target as { bind(...values: unknown[]): object }).bind(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    approved.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          const trimmed = sql.trim();
          if (!/^(?:SELECT|WITH|EXPLAIN)\s/i.test(trimmed) || /;\s*\S/.test(trimmed))
            throw new Error("Production catalog acceptance is read-only");
          const real = (target as { prepare(sql: string): object }).prepare(sql);
          return wrapStatement(real);
        };
      }
      if (key === "withSession") {
        const open = (target as { withSession?: (arg: string) => object }).withSession;
        if (typeof open !== "function") return undefined;
        return (constraint: string) => readOnlyStageD1(open.call(target, constraint), approved);
      }
      if (key === "batch") {
        return (statements: object[]) => {
          if (
            !Array.isArray(statements) ||
            !statements.length ||
            statements.some((statement) => !approved.has(statement))
          )
            throw new Error("Only validated SELECT batches may query production D1");
          return (target as { batch(statements: object[]): unknown }).batch(
            statements.map((statement) => approved.get(statement)!),
          );
        };
      }
      if (key === "exec")
        return () => {
          throw new Error("Production catalog acceptance cannot exec SQL");
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default {
  async fetch(request: Request, env: StorefrontStranglerEnv): Promise<Response> {
    // Fail closed even under an accidental deployment or config substitution.
    // The reviewed config must also contain only the dedicated synthetic D1.
    const syntheticEvaluation =
      env.COVE_STRANGLER_MODE === "isolated-evaluation" &&
      env.COVE_STRANGLER_DATABASE_ID === "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
    const productionAcceptance =
      env.COVE_STRANGLER_MODE === "production-acceptance" &&
      env.COVE_STRANGLER_DATABASE_ID === "4bd657ac-8789-403e-a28c-93aba8d0a989";
    const customerGateway =
      env.COVE_SSR_STAGING !== "1" &&
      env.COVE_STRANGLER_MODE === "customer-gateway" &&
      env.COVE_STRANGLER_RELEASE_CERTIFIED === "1" &&
      env.COVE_STRANGLER_DATABASE_ID === "4bd657ac-8789-403e-a28c-93aba8d0a989";
    if (
      (!customerGateway && env.COVE_SSR_STAGING !== "1") ||
      (!customerGateway && !syntheticEvaluation && !productionAcceptance)
    )
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    if (!customerGateway) {
      const rejected = await rejectUnauthenticatedStagingRequest(request, env);
      if (rejected) return rejected;
    }
    // A signed homepage claim cannot authorize diagnostic, API, media,
    // checkout, or reader paths, even if a signed header is replayed.
    if (
      customerGateway &&
      (request.method !== "GET" ||
        new URL(request.url).pathname !== "/" ||
        new URL(request.url).search ||
        request.headers.has("cookie") ||
        request.headers.has("authorization"))
    )
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    // Production Worker accepts only HMAC-authenticated Vercel relay requests.
    // Cloudflare's Vercel-egress request.cf.country is NOT the customer's
    // territory, and must never authorize a licensed book.
    const relay = customerGateway
      ? await verifyFastCountryClaim(request.headers, env.COVE_FAST_RELAY_KEY || "")
      : null;
    if (customerGateway && !relay)
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    const finish = (response: Response) => {
      const secured = applySecurityHeaders(request, response, env);
      if (!customerGateway) return stageNoStore(secured, true);
      const headers = new Headers(secured.headers);
      headers.set("cache-control", "private, no-store");
      return new Response(secured.body, { status: secured.status, headers });
    };
    // Stage bearer authorizes this gateway, not a customer session at CORE.
    const delegate = () => {
      // This production-D1 acceptance origin has no authenticated CORE
      // service and must never become an alternate checkout/reader gateway.
      if (productionAcceptance || customerGateway)
        return Promise.resolve(new Response("Not an application route", { status: 404 }));
      const headers = new Headers(request.headers);
      // The operator's ingress token is NEVER a backend identity.
      // A different service-only secret can be provisioned for the private
      // real CORE Worker; never reuse or reflect the outer bearer.
      headers.delete("authorization");
      const internal = env.COVE_INTERNAL_CORE_STAGE_GATE_KEY;
      if (internal) {
        if (!/^[a-f0-9]{64}$/.test(internal) || internal === env.COVE_SSR_STAGING_GATE_KEY)
          return Promise.resolve(new Response(null, { status: 503 }));
        headers.set("authorization", "Bearer " + internal);
      }
      return env.CORE.fetch(new Request(request, { headers }));
    };
    let failurePhase = "entry";
    try {
      const url = new URL(request.url);
      const diagnostic = url.pathname === "/__cove_perf/bootstrap" && !url.search;
      const transportControl = url.pathname === "/__cove_perf/transport" && !url.search;
      // Authenticated transport control intentionally bypasses D1 and R2.
      // It establishes a same-gateway transport/runtime floor, not a claim
      // that the residual latency is all network time.
      if (
        request.method !== "GET" ||
        (!diagnostic && !transportControl && (url.pathname !== "/" || url.search))
      )
        return await delegate();
      if (transportControl)
        return finish(
          new Response("ok", {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-cove-renderer": "transport-control",
            },
          }),
        );
      const benchmarkRequest = syntheticEvaluation
        ? syntheticBenchmarkClient(request, env)
        : request;
      let safe: Request | null;
      if (customerGateway && relay) {
        const relayHeaders = new Headers(request.headers);
        relayHeaders.delete("cookie");
        relayHeaders.delete("authorization");
        relayHeaders.delete("x-cove-client-country");
        relayHeaders.delete("x-cove-client-ip");
        relayHeaders.set("x-cove-client-country", relay.country);
        relayHeaders.set("cf-connecting-ip", relay.ip);
        safe = new Request(request, { headers: relayHeaders });
      } else {
        safe = isolateWorkerCountry(benchmarkRequest);
      }
      if (!safe)
        return finish(new Response("Unable to verify storefront territory.", { status: 503 }));
      const headers = new Headers(safe.headers);
      headers.delete("authorization"); // staging gate credential is never an app identity
      const bootstrapRequest = new Request(new URL("/api/fore/storefront/bootstrap", request.url), {
        headers,
        signal: request.signal,
      });
      // Any cookie/identity hint uses the established application; preferences
      // and account state cannot leak into an anonymous response.
      if (!canUseLeanAnonymousBootstrap(bootstrapRequest, env)) return await delegate();
      failurePhase = "bootstrap";
      // The current main-branch canonical bootstrap has a two-argument API.
      // Preserve it unchanged; all failures remain fail-closed and classified.
      // No presentation cache or independent authorizer is activated here.
      // Main's authoritative live territorial-rights bootstrap remains unchanged.
      const bootstrapEnv =
        productionAcceptance || customerGateway ? { ...env, DB: readOnlyStageD1(env.DB) } : env;
      const response = await serveLeanAnonymousBootstrap(bootstrapRequest, bootstrapEnv);
      if (!response.ok) return finish(new Response(null, { status: response.status }));
      const bootstrap = (await response.json()) as StorefrontBootstrap;
      if (bootstrap.context.rightsCountry !== headers.get("x-cove-client-country"))
        throw new Error("Thin storefront territorial mismatch");
      if (diagnostic) {
        if (
          !Array.isArray(bootstrap.context.availableMarkets) ||
          !Array.isArray(bootstrap.catalog.results)
        )
          throw new Error("Anonymous market projection is unavailable.");
        return finish(
          new Response(
            JSON.stringify({
              stage: "bootstrap",
              ok: true,
              renderer: "thin",
              books: bootstrap.catalog.results.length,
              markets: bootstrap.context.availableMarkets.length,
            }),
            {
              headers: {
                "content-type": "application/json",
                "server-timing": response.headers.get("server-timing") || "",
              },
            },
          ),
        );
      }
      failurePhase = "render";
      return finish(
        new Response(
          renderStranglerStorefront(
            bootstrap,
            env.FORE_PUBLIC_URL || url.origin,
            env.COVE_STRANGLER_EXPERIENCE === "1",
          ),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "private, no-store",
              "x-cove-renderer": customerGateway ? "strangler-live" : "strangler-evaluation",
              "server-timing": response.headers.get("server-timing") || "",
            },
          },
        ),
      );
    } catch (error) {
      // A failed live-rights read never becomes a cached offer or success page.
      const status =
        typeof error === "object" && error !== null && "status" in error && error.status === 429
          ? 429
          : 503;
      console.error(
        JSON.stringify({
          event: "thin_storefront_failed",
          status,
          phase: failurePhase,
          kind: bootstrapFailureKind(error),
        }),
      );
      // Only a small allowlist of error-phase labels is visible in this
      // authenticated synthetic stage; never send SQL, book IDs, or secrets.
      const code = "bootstrap";
      return finish(
        new Response("Storefront temporarily unavailable.", {
          status,
          headers: { "x-cove-stage-failure": code },
        }),
      );
    }
  },
};
