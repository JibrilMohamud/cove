type PersistenceEnv = {
  FORE_BACKEND_URL?: string;
  FORE_BACKEND_TOKEN?: string;
  FORE_PUBLIC_URL?: string;
  COVE_AUDIO_PIPELINE_URL?: string;
  CRON_SECRET?: string;
  FORE_INGESTION_TRIGGER_TOKEN?: string;
  FORE_INGESTION_VERIFY_JWK?: string;
};

const gatewayHeader = "x-cove-backend-token";

function configured(env: PersistenceEnv) {
  return Boolean(env.FORE_BACKEND_URL && env.FORE_BACKEND_TOKEN);
}

function safePublicFallback(request: Request) {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  const path = new URL(request.url).pathname;
  return (
    path === "/api/fore/catalog" ||
    path === "/api/fore/taxonomy" ||
    path === "/api/fore/storefront/context" ||
    path === "/api/fore/storefront/page" ||
    path === "/api/fore/search/suggest" ||
    path === "/api/fore/audiobooks" ||
    /^\/api\/fore\/books\/[1-9][0-9]{0,8}(?:\/(?:detail|epub|download\/epub))?$/.test(path) ||
    /^\/api\/fore\/audio\/pg-[1-9][0-9]{0,8}(?:\/tracks\/[^/]+)?$/.test(path)
  );
}

function requestTimeout(path: string) {
  return /\/(?:epub|download\/epub|tracks\/|pipeline\/(?:media|text)|publishing\/.+upload)/.test(
    path,
  )
    ? 240_000
    : 30_000;
}

function backendUrl(env: PersistenceEnv, requestUrl: URL) {
  const base = new URL(env.FORE_BACKEND_URL!);
  if (base.protocol !== "https:") {
    throw new Error("FORE_BACKEND_URL must use HTTPS.");
  }
  return new URL(requestUrl.pathname + requestUrl.search, base);
}

function gatewayHeaders(request: Request, env: PersistenceEnv, target: URL) {
  const headers = new Headers(request.headers);

  // Cloudflare owns the cf-* namespace. Forwarding client-supplied or upstream
  // cf-* headers to workers.dev can be rejected at the edge before Cove runs.
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith("cf-")) headers.delete(name);
  }
  for (const name of [
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "x-cove-backend-token",
    "x-cove-public-url",
    "x-cove-client-country",
    "x-cove-client-ip",
    "x-cove-backend-host",
  ]) {
    headers.delete(name);
  }

  headers.set(gatewayHeader, env.FORE_BACKEND_TOKEN!);
  headers.set("x-cove-public-url", request.url);

  const country = request.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (country && /^[A-Z]{2}$/.test(country)) {
    headers.set("x-cove-client-country", country);
  }

  const forwarded = request.headers.get("x-forwarded-for");
  const clientIp = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
  if (clientIp) headers.set("x-cove-client-ip", clientIp.slice(0, 128));

  headers.set("x-cove-backend-host", target.host);
  return headers;
}

async function rewriteResponse(response: Response, env: PersistenceEnv) {
  const headers = new Headers(response.headers);
  headers.set("x-cove-persistence", "remote-d1-r2");
  const location = headers.get("location");
  if (location && env.FORE_BACKEND_URL && env.FORE_PUBLIC_URL) {
    try {
      const resolved = new URL(location, env.FORE_BACKEND_URL);
      const backend = new URL(env.FORE_BACKEND_URL);
      if (resolved.origin === backend.origin) {
        const publicBase = new URL(env.FORE_PUBLIC_URL);
        headers.set(
          "location",
          new URL(resolved.pathname + resolved.search + resolved.hash, publicBase).toString(),
        );
      }
    } catch {
      // Ignore malformed or non-HTTP redirect locations from the private backend.
    }
  }

  // Vercel's TanStack/Nitro handoff can lose a nested fetch ReadableStream even
  // though status and headers survive. Materialize bounded textual API responses
  // before crossing that handoff; keep EPUB/audio/binary payloads streamed.
  const contentType = (headers.get("content-type") || "").toLowerCase();
  const materialize =
    contentType.includes("application/json") ||
    contentType.startsWith("text/") ||
    contentType.includes("+json");

  if (materialize && !["HEAD", "204", "304"].includes(String(response.status))) {
    const body = await response.arrayBuffer();
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function proxyPersistenceApi(
  request: Request,
  env: PersistenceEnv,
): Promise<Response | null> {
  const requestUrl = new URL(request.url);
  if (!requestUrl.pathname.startsWith("/api/fore/")) return null;
  if (requestUrl.pathname.startsWith("/api/fore/internal/ingestion/")) {
    return null;
  }
  if (!configured(env)) return null;

  let target: URL;
  try {
    target = backendUrl(env, requestUrl);
  } catch (error) {
    console.error("Invalid persistence backend configuration", error);
    return new Response(JSON.stringify({ error: "Cove persistence is misconfigured." }), {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout(requestUrl.pathname));
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: gatewayHeaders(request, env, target),
      redirect: "manual",
      signal: controller.signal,
    };
    if (!["GET", "HEAD"].includes(request.method)) {
      init.body = request.body;
      init.duplex = "half";
    }
    const response = await fetch(target, init);
    if ([502, 503, 504].includes(response.status) && safePublicFallback(request)) {
      console.warn("Persistent backend unavailable; using public-domain fallback", response.status);
      return null;
    }
    return await rewriteResponse(response, env);
  } catch (error) {
    if (safePublicFallback(request)) {
      console.warn("Persistent backend request failed; using public-domain fallback", error);
      return null;
    }
    console.error("Persistent backend request failed", error);
    return new Response(JSON.stringify({ error: "Cove persistence is temporarily unavailable." }), {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function backendControl(env: PersistenceEnv, path: string, payload: Record<string, unknown>) {
  if (!configured(env)) {
    return new Response(JSON.stringify({ error: "Persistent backend is not configured." }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const base = new URL(env.FORE_BACKEND_URL!);
  const target = new URL(path, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    return await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [gatewayHeader]: env.FORE_BACKEND_TOKEN!,
        "x-cove-public-url": env.FORE_PUBLIC_URL || "",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function audioControl(env: PersistenceEnv, payload: Record<string, unknown>) {
  if (!env.COVE_AUDIO_PIPELINE_URL) {
    return new Response(
      JSON.stringify({
        error: "Audio pipeline service binding is unavailable.",
      }),
      {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  const target = new URL("/run", env.COVE_AUDIO_PIPELINE_URL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 285_000);
  try {
    return await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function base64urlBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function cronAuthorized(request: Request, env: PersistenceEnv) {
  const secret = env.FORE_INGESTION_TRIGGER_TOKEN || env.CRON_SECRET || "";
  if (secret.length >= 24 && request.headers.get("authorization") === `Bearer ${secret}`) {
    return true;
  }

  const timestamp = request.headers.get("x-cove-ingestion-timestamp") || "";
  const signature = request.headers.get("x-cove-ingestion-signature") || "";
  const publicKey = env.FORE_INGESTION_VERIFY_JWK || "";
  const timestampMs = Number(timestamp);
  if (
    !publicKey ||
    !signature ||
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > 5 * 60_000
  ) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(publicKey) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const url = new URL(request.url);
    const message = `${timestamp}\n${request.method}\n${url.pathname}${url.search}`;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlBytes(signature),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

async function passthroughJson(response: Response, stage: string) {
  const text = await response.text();
  const headers = new Headers({
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-cove-ingestion-stage": stage,
  });
  return new Response(text, { status: response.status, headers });
}

export async function handleVercelIngestionControl(
  request: Request,
  env: PersistenceEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/fore/internal/ingestion/")) return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!(await cronAuthorized(request, env))) {
    return new Response(JSON.stringify({ error: "Unauthorized ingestion controller." }), {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/api/fore/internal/ingestion/catalog") {
    const response = await backendControl(env, "/__cove/ingestion/catalog", {
      maxPages: 5,
      epubLimit: 2,
      maxMillis: 220_000,
    });
    return passthroughJson(response, "catalog");
  }
  if (path === "/api/fore/internal/ingestion/maintenance") {
    const response = await backendControl(env, "/__cove/ingestion/maintenance", {});
    return passthroughJson(response, "maintenance");
  }

  const jobs: Record<string, Record<string, unknown>> = {
    "/api/fore/internal/ingestion/audio-scan": {
      max_jobs: 0,
      minutes: 4,
      no_discovery: false,
      threads: 2,
    },
    "/api/fore/internal/ingestion/audio-discover": {
      kind: "discover",
      max_jobs: 12,
      minutes: 4,
      no_discovery: true,
      threads: 2,
    },
    "/api/fore/internal/ingestion/audio-track": {
      kind: "track",
      max_jobs: 2,
      minutes: 4,
      no_discovery: true,
      threads: 2,
    },
    "/api/fore/internal/ingestion/audio-align": {
      kind: "align",
      max_jobs: 1,
      minutes: 4,
      no_discovery: true,
      threads: 2,
    },
  };
  const payload = jobs[path];
  if (!payload) {
    return new Response(JSON.stringify({ error: "Unknown ingestion controller." }), {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  const response = await audioControl(env, payload);
  return passthroughJson(response, path.split("/").pop() || "audio");
}
