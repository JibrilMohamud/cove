import {
  handleCoveApi,
  kickCatalogIngestion,
  runCatalogIngestion,
  runPublishingReleaseMaintenance,
  runRecommendationMaintenance,
  type CoveEnv,
} from "./features/fore/api.server";

type BackendEnv = CoveEnv & {
  FORE_BACKEND_TOKEN?: string;
  FORE_PUBLIC_URL?: string;
  FORE_CATALOG_PAGES_PER_TICK?: string;
  FORE_CATALOG_EPUBS_PER_TICK?: string;
  FORE_INGESTION_TRIGGER_TOKEN?: string;
};

type ExecutionContextLike = {
  waitUntil?(promise: Promise<unknown>): void;
};

type CatalogBatchInput = {
  maxPages?: unknown;
  epubLimit?: unknown;
  maxMillis?: unknown;
};

type CoveCacheGlobal = typeof globalThis & {
  caches?: {
    default?: Cache;
  };
};

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorized(request: Request, env: BackendEnv) {
  const expected = env.FORE_BACKEND_TOKEN || "";
  const supplied = request.headers.get("x-cove-backend-token") || "";
  return expected.length >= 24 && safeEqual(expected, supplied);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function logicalRequest(request: Request, env: BackendEnv) {
  const backendUrl = new URL(request.url);
  const forwardedPublicUrl = request.headers.get("x-cove-public-url");
  let publicBase = env.FORE_PUBLIC_URL || "";
  if (forwardedPublicUrl) {
    try {
      const candidate = new URL(forwardedPublicUrl);
      if (
        candidate.protocol === "https:" ||
        candidate.hostname === "localhost"
      ) {
        publicBase = candidate.origin;
      }
    } catch {
      // Fall back to the configured canonical public origin.
    }
  }
  if (!publicBase) return request;

  const publicUrl = new URL(backendUrl.pathname + backendUrl.search, publicBase);
  const headers = new Headers(request.headers);
  headers.delete("x-cove-backend-token");
  headers.delete("x-cove-backend-host");
  headers.delete("x-cove-public-url");
  return new Request(publicUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: request.redirect,
  });
}

function cachePolicy(path: string) {
  if (path === "/api/fore/catalog") return 90;
  if (path === "/api/fore/taxonomy") return 900;
  if (path === "/api/fore/storefront/page") return 300;
  if (path === "/api/fore/search/suggest") return 60;
  if (path === "/api/fore/audiobooks") return 300;
  if (/^\/api\/fore\/audio\/[^/]+$/.test(path)) return 900;
  if (/^\/api\/fore\/books\/[^/]+(?:\/detail)?$/.test(path)) return 300;
  return 0;
}

function anonymousCacheable(request: Request) {
  if (request.method !== "GET") return false;
  if (request.headers.get("authorization")) return false;
  if (request.headers.get("cookie")) return false;
  if (request.headers.get("oai-authenticated-user-id")) return false;
  if (request.headers.get("range")) return false;
  return cachePolicy(new URL(request.url).pathname) > 0;
}

function cacheKey(request: Request) {
  const url = new URL(request.url);
  const country = (request.headers.get("cf-ipcountry") || "ZZ").toUpperCase();
  const language = (request.headers.get("accept-language") || "")
    .split(",")[0]
    .trim()
    .slice(0, 24);
  url.searchParams.set("__cove_country", country);
  if (language) url.searchParams.set("__cove_language", language);
  return new Request(url.toString(), { method: "GET" });
}

function edgeResponse(response: Response, state: "HIT" | "MISS") {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-cove-backend-cache", state);
  headers.set("x-cove-persistence", "d1-r2");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cachedApi(
  request: Request,
  cacheRequest: Request,
  env: BackendEnv,
  ctx: ExecutionContextLike,
) {
  const runtimeCache = (globalThis as CoveCacheGlobal).caches?.default;
  const ttl = cachePolicy(new URL(request.url).pathname);
  const canCache = runtimeCache && ttl > 0 && anonymousCacheable(request);
  const key = canCache ? cacheKey(cacheRequest) : null;

  if (runtimeCache && key) {
    const hit = await runtimeCache.match(key);
    if (hit) return edgeResponse(hit, "HIT");
  }

  const response = await handleCoveApi(request, env);
  if (!response) return null;

  if (
    runtimeCache &&
    key &&
    response.ok &&
    !response.headers.has("set-cookie")
  ) {
    const storageHeaders = new Headers(response.headers);
    storageHeaders.set("cache-control", `public, max-age=${ttl}`);
    storageHeaders.set("x-cove-backend-cache", "STORED");
    const storage = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers: storageHeaders,
    });
    ctx.waitUntil?.(
      runtimeCache.put(key, storage).catch((error) => {
        console.warn("Cove edge cache write failed", error);
      }),
    );
    return edgeResponse(response, "MISS");
  }

  return edgeResponse(response, "MISS");
}

function catalogInput(value: unknown): CatalogBatchInput {
  return value && typeof value === "object"
    ? (value as CatalogBatchInput)
    : {};
}

function terminalIngestionResult(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const result = value as { complete?: unknown; skipped?: unknown };
  return (
    result.complete === true ||
    result.skipped === "fresh" ||
    result.skipped === "backoff" ||
    result.skipped === "running"
  );
}

async function catalogBatch(request: Request, env: BackendEnv) {
  let input: CatalogBatchInput = {};
  try {
    input = catalogInput(await request.json());
  } catch {
    // Malformed control input uses the bounded defaults below.
  }

  const configuredPages = Number(env.FORE_CATALOG_PAGES_PER_TICK || 5);
  const configuredEpubs = Number(env.FORE_CATALOG_EPUBS_PER_TICK || 2);
  const maxPages = Math.max(
    1,
    Math.min(12, Number(input.maxPages || configuredPages) || 5),
  );
  const epubLimit = Math.max(
    1,
    Math.min(8, Number(input.epubLimit || configuredEpubs) || 2),
  );
  const maxMillis = Math.max(
    10_000,
    Math.min(240_000, Number(input.maxMillis || 220_000) || 220_000),
  );
  const deadline = Date.now() + maxMillis;
  const results: unknown[] = [];

  for (let i = 0; i < maxPages && Date.now() < deadline; i++) {
    const result = await runCatalogIngestion(env, epubLimit);
    results.push(result);
    if (terminalIngestionResult(result)) break;
  }

  return json({ ok: true, pagesAttempted: results.length, results });
}

async function maintenance(env: BackendEnv) {
  const [recommendations, publishing] = await Promise.allSettled([
    runRecommendationMaintenance(env),
    runPublishingReleaseMaintenance(env),
  ]);

  return json({
    ok: recommendations.status === "fulfilled" && publishing.status === "fulfilled",
    recommendations:
      recommendations.status === "fulfilled"
        ? recommendations.value
        : { error: String(recommendations.reason) },
    publishing:
      publishing.status === "fulfilled"
        ? publishing.value
        : { error: String(publishing.reason) },
  });
}

async function triggerVercelAudio(env: BackendEnv, path: string) {
  const secret = env.FORE_INGESTION_TRIGGER_TOKEN || "";
  if (!env.FORE_PUBLIC_URL || secret.length < 24) {
    throw new Error(
      "FORE_PUBLIC_URL and FORE_INGESTION_TRIGGER_TOKEN are required for audio scheduling.",
    );
  }

  const target = new URL(path, env.FORE_PUBLIC_URL);
  const response = await fetch(target, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(290_000),
  });
  if (!response.ok) {
    throw new Error(
      `Audio ingestion trigger failed (${response.status}): ${(
        await response.text()
      ).slice(0, 500)}`,
    );
  }
}

async function scheduledCatalog(env: BackendEnv) {
  const request = new Request(
    "https://cove.internal/__cove/ingestion/catalog",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxPages: 5, epubLimit: 2, maxMillis: 220_000 }),
    },
  );
  const response = await catalogBatch(request, env);
  if (!response.ok) {
    throw new Error("Scheduled catalog ingestion failed.");
  }
}

async function scheduledMaintenance(env: BackendEnv) {
  const response = await maintenance(env);
  if (!response.ok) throw new Error("Scheduled Cove maintenance failed.");
}

async function runScheduled(cron: string, env: BackendEnv) {
  if (cron === "*/5 * * * *") {
    await Promise.all([
      scheduledCatalog(env),
      triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-track"),
    ]);
    return;
  }
  if (cron === "*/10 * * * *") {
    await triggerVercelAudio(
      env,
      "/api/fore/internal/ingestion/audio-discover",
    );
    return;
  }
  if (cron === "23 * * * *") {
    await triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-align");
    return;
  }
  if (cron === "17 3 * * *") {
    await triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-scan");
    return;
  }
  if (cron === "41 4 * * *") {
    await scheduledMaintenance(env);
    return;
  }
  console.warn("Unknown Cove scheduled trigger", cron);
}

export default {
  async scheduled(
    controller: { cron: string },
    env: BackendEnv,
    ctx: ExecutionContextLike,
  ) {
    ctx.waitUntil?.(
      runScheduled(controller.cron, env).catch((error) => {
        console.error("Cove scheduled ingestion failed", controller.cron, error);
        throw error;
      }),
    );
  },

  async fetch(request: Request, env: BackendEnv, ctx: ExecutionContextLike) {
    if (!authorized(request, env)) {
      return json({ error: "Persistence gateway authorization required." }, 401);
    }

    const path = new URL(request.url).pathname;
    if (path === "/__cove/health" && request.method === "GET") {
      try {
        const row = await env.DB.prepare("SELECT 1 ok").first<{ ok?: number }>();
        return json({
          ok: row?.ok === 1,
          database: true,
          objectStorage: Boolean(env.BUCKET),
        });
      } catch {
        return json(
          {
            ok: false,
            database: false,
            objectStorage: Boolean(env.BUCKET),
          },
          503,
        );
      }
    }

    if (path === "/__cove/ingestion/catalog" && request.method === "POST") {
      return catalogBatch(request, env);
    }
    if (path === "/__cove/ingestion/maintenance" && request.method === "POST") {
      return maintenance(env);
    }
    if (!path.startsWith("/api/fore/")) {
      return json({ error: "Not found." }, 404);
    }

    const logical = logicalRequest(request, env);
    const response = await cachedApi(logical, request, env, ctx);
    if (!response) return json({ error: "Not found." }, 404);

    if (new URL(logical.url).pathname === "/api/fore/catalog") {
      ctx.waitUntil?.(
        kickCatalogIngestion(env).catch((error) => {
          console.warn("Opportunistic catalog ingestion failed", error);
        }),
      );
    }

    return response;
  },
};
