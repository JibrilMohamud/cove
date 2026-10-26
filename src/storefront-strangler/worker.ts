import type { CoveEnv } from "../features/fore/api.server";
import { isolateWorkerCountry } from "../lib/cloudflare-country.server";
import { verifyFastCountryClaim } from "../lib/fast-storefront-relay.server";
import { rejectUnauthenticatedStagingRequest } from "../lib/cloudflare-ssr-stage-gate.server";
import { buildSecurityHeaders } from "../lib/security-headers";
import {
  canUseLeanAnonymousBootstrap,
  readTrustedLeanBootstrapJson,
  serveLeanAnonymousBootstrap,
} from "./bootstrap-optimized.server";
import type { StorefrontBootstrap } from "../features/fore/storefront-bootstrap";
import { renderStranglerStorefront } from "./render";
import { bootstrapFailureKind } from "./failure";
import { syntheticBenchmarkClient } from "./synthetic-client";
import { readHomepagePresentation } from "./homepage-presentation.server";
import {
  namespacedPresentationStore,
  type PrivatePresentationStore,
} from "./prepared-catalog.server";

// Stage-only isolate request ordinal. Workerd clocks cannot be reliably
// sampled during module evaluation; avoid reporting a fictitious isolate age.
// Customer responses never expose this measurement.
let isolateRequestOrdinal = 0;

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
  COVE_GEO_PROBE_ENABLED?: string;
  COVE_GEO_PROBE_RELEASE_SHA?: string;
  COVE_INTERNAL_CORE_STAGE_GATE_KEY?: string;
  COVE_STRANGLER_READ_MODEL?: string;
  PRESENTATION?: PrivatePresentationStore;
  PRESENTATION_KV?: {
    get(key: string, options: { type: "text"; cacheTtl: number }): Promise<string | null>;
  };
  COVE_PRESENTATION_KV_ACCELERATE?: string;
  COVE_PRESENTATION_PREFIX?: string;
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
          if (
            !/^(?:SELECT|WITH)\s/i.test(trimmed) ||
            /;\s*\S/.test(trimmed) ||
            /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(
              trimmed,
            )
          )
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
    // Never classify client/edge ingress time as database time.
    const enteredAt = performance.now();
    const isolateOrdinal = ++isolateRequestOrdinal;
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
      env.COVE_STRANGLER_DATABASE_ID === "4bd657ac-8789-403e-a28c-93aba8d0a989" &&
      // A certified deployment must use the same v2 private presentation
      // pipeline as acceptance: defaulting to the canonical SQL fallback is
      // NOT a certified production configuration.
      env.COVE_STRANGLER_READ_MODEL === "2" &&
      env.COVE_PRESENTATION_KV_ACCELERATE === "1" &&
      typeof env.PRESENTATION?.get === "function" &&
      typeof env.PRESENTATION_KV?.get === "function" &&
      /^production\/[a-z0-9._-]+\/$/.test(env.COVE_PRESENTATION_PREFIX || "");
    if (
      (!customerGateway && env.COVE_SSR_STAGING !== "1") ||
      (!customerGateway && !syntheticEvaluation && !productionAcceptance)
    )
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    // Ephemeral, content-free geo ingress probe. Only the reviewed
    // production-catalog *acceptance* mode can expose this path, and only
    // when an explicit short-lived test flag and immutable SHA are installed.
    // No SQL, R2, auth credential, customer rights or catalog is touched.
    if (
      productionAcceptance &&
      env.COVE_GEO_PROBE_ENABLED === "1" &&
      /^[a-f0-9]{40}$/.test(env.COVE_GEO_PROBE_RELEASE_SHA || "") &&
      request.method === "GET" &&
      new URL(request.url).pathname === "/__cove_geo_probe" &&
      !new URL(request.url).search &&
      !request.headers.has("authorization") &&
      !request.headers.has("cookie")
    ) {
      const cf = (request as Request & { cf?: { colo?: string; country?: string } }).cf;
      return new Response(
        JSON.stringify({
          schema: "cove.geo-ingress.v1",
          sha: env.COVE_GEO_PROBE_RELEASE_SHA,
          colo: cf?.colo || null,
          country: cf?.country || null,
        }),
        {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
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
      // Materialized bootstrap HTML is already legal-authorized. Build all
      // security/stage headers first and wrap its body exactly ONCE.
      // The prior path constructed three additional Responses around the
      // same stream after authorization. Those extra workerd streaming
      // boundaries can defer first-header delivery without improving safety.
      const headers = buildSecurityHeaders(request, response.headers, env);
      if (!customerGateway) {
        headers.set(
          "server-timing",
          [
            headers.get("server-timing"),
            `cove_handler;dur=${(performance.now() - enteredAt).toFixed(1)}`,
            `cove_isolate_first;desc="${isolateOrdinal === 1 ? 1 : 0}"`,
            `cove_isolate_seen;desc="${Math.min(isolateOrdinal, 999)}"`,
          ]
            .filter(Boolean)
            .join(", "),
        );
        const placement = request.headers.get("cf-placement") || "";
        if (/^(?:remote|local)-[A-Z]{3}$/.test(placement))
          headers.set("x-cove-stage-placement", placement);
        headers.set("cache-control", "no-store, max-age=0");
        headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      } else {
        headers.set("cache-control", "private, no-store");
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
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
    let bootstrapSubphase: string | null = null;
    let bootstrapSubkind: string | null = null;
    let trustedStageCountry: string | null = null;
    try {
      const url = new URL(request.url);
      const diagnostic = url.pathname === "/__cove_perf/bootstrap" && !url.search;
      const transportControl = url.pathname === "/__cove_perf/transport" && !url.search;
      const presentationControl =
        syntheticEvaluation && url.pathname === "/__cove_perf/presentation" && !url.search;
      // Authenticated transport control intentionally bypasses D1 and R2.
      // It establishes a same-gateway transport/runtime floor, not a claim
      // that the residual latency is all network time.
      if (
        request.method !== "GET" ||
        (!diagnostic &&
          !transportControl &&
          !presentationControl &&
          (url.pathname !== "/" || url.search))
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
      // The ingress-gated stage records only the normalized edge-derived country.
      if (!customerGateway && /^[A-Z]{2}$/.test(headers.get("x-cove-client-country") || ""))
        trustedStageCountry = headers.get("x-cove-client-country");
      headers.delete("authorization"); // staging gate credential is never an app identity
      const bootstrapRequest = new Request(new URL("/api/fore/storefront/bootstrap", request.url), {
        headers,
        signal: request.signal,
      });
      // Any cookie/identity hint uses the established application; preferences
      // and account state cannot leak into an anonymous response.
      if (!canUseLeanAnonymousBootstrap(bootstrapRequest, env)) return await delegate();
      if (presentationControl) {
        const started = performance.now();
        if (!env.PRESENTATION) throw Error("Private presentation binding required");
        const snapshot = await readHomepagePresentation(
          namespacedPresentationStore(env.PRESENTATION, env.COVE_PRESENTATION_PREFIX),
          bootstrapRequest,
          headers.get("x-cove-client-country")!,
        );
        return finish(
          new Response(
            JSON.stringify({
              country: snapshot.candidates.country,
              candidates: snapshot.candidates.productIds.length,
            }),
            {
              headers: {
                "content-type": "application/json",
                "server-timing": `cove_presentation;dur=${(performance.now() - started).toFixed(1)}`,
              },
            },
          ),
        );
      }
      failurePhase = "bootstrap";
      // The current main-branch canonical bootstrap has a two-argument API.
      // Preserve it unchanged; all failures remain fail-closed and classified.
      // No presentation cache or independent authorizer is activated here.
      // Main's authoritative live territorial-rights bootstrap remains unchanged.
      let bootstrapEnv =
        productionAcceptance || customerGateway ? { ...env, DB: readOnlyStageD1(env.DB) } : env;
      // Matched ABBA experiment: only the bearer-protected synthetic Worker
      // can select the canonical control. No client-controlled legal bypass.
      if (syntheticEvaluation && request.headers.get("x-cove-perf-serving-model") === "canonical")
        bootstrapEnv = { ...bootstrapEnv, COVE_STRANGLER_READ_MODEL: "0" };
      const response = await serveLeanAnonymousBootstrap(
        bootstrapRequest,
        bootstrapEnv,
        (phase, error) => {
          // A presentation rejection also rejects dependent context/catalog
          // promises. Keep the original R2 failure rather than its echo.
          if (bootstrapSubphase === null || phase === "presentation") {
            bootstrapSubphase = ["presentation", "context", "catalog", "limit"].includes(phase)
              ? phase
              : "unknown";
            bootstrapSubkind = bootstrapFailureKind(error);
          }
        },
      );
      if (!response.ok) return finish(new Response(null, { status: response.status }));
      // This Response was assembled from the freshly checked authority result
      // in this same isolate. Parse its identical serialized JSON directly,
      // avoiding an extra asynchronous workerd body-stream roundtrip.
      // Foreign/unexpected Responses still use the original body-read path.
      const serialized = readTrustedLeanBootstrapJson(response);
      const bootstrap = JSON.parse(serialized ?? (await response.text())) as StorefrontBootstrap;
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
          subphase: bootstrapSubphase,
          subkind: bootstrapSubkind,
        }),
      );
      // Only a small allowlist of error-phase labels is visible in this
      // authenticated synthetic stage; never send SQL, book IDs, or secrets.
      const code = "bootstrap";
      return finish(
        new Response("Storefront temporarily unavailable.", {
          status,
          headers: {
            "x-cove-stage-failure": code,
            ...(customerGateway
              ? {}
              : {
                  "x-cove-stage-country": trustedStageCountry || "unknown",
                  "x-cove-stage-failure-subphase": bootstrapSubphase || "unknown",
                  "x-cove-stage-failure-kind": bootstrapSubkind || bootstrapFailureKind(error),
                }),
          },
        }),
      );
    }
  },
};
