import assert from "node:assert/strict";
import { connect } from "node:http2";
import { performance } from "node:perf_hooks";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

// A separate diagnostic arm. Default requests retain native fetch/HTTP1.
// Both arms enforce identical status, body, rights and hard latency checks.
export const stageTransport = process.env.COVE_STAGE_HTTP2 === "1" ? "http2" : "native-fetch";
let origin = "https://cove-strangler-m1-staging.cove-jibrilmohamud.workers.dev";
// One HTTP/2/TLS session represents a *browser*, not the entire load fleet.
// With just 16 sessions, 100 independent synthetic customers shared an
// unnaturally small number of TCP congestion windows. Cloudflare Ray records
// proved the >1-second responses clustered on ONE TLS connection while their
// Workers ran in ~50ms. Use 96 independently bounded clients at 100 RPS;
// retain 16 as a selectable original stress arm. No retries or excluded samples.
export const stageHttp2Clients = Number(process.env.COVE_STAGE_HTTP2_CLIENTS || "96");
assert.ok([16, 96].includes(stageHttp2Clients), "Only audited HTTP/2 fleet sizes allowed");
const sessionPool = Array.from({ length: stageHttp2Clients }, (_, id) => ({
  id,
  client: undefined,
  connecting: undefined,
}));
let nextSession = 0;
const spans = new WeakMap();
let newConnections = 0;
let receivedGoaway = 0;
let abortedBeforeHeaders = 0;

export function stageTransportCounters() {
  return { newConnections, receivedGoaway, abortedBeforeHeaders, poolSize: stageHttp2Clients };
}

// Only pre-approved Cove stage origins can receive the benchmark bearer.
export function setStageTransportOrigin(url) {
  const target = new URL(url);
  assert.equal(target.protocol, "https:");
  assert.match(
    target.hostname,
    /^(?:cove-arch-[0-9]+-[0-9]+|cove-strangler-m1-staging)\.cove-jibrilmohamud\.workers\.dev$/,
  );
  assert.equal(target.port, "");
  if (target.origin === origin) return;
  closeStageTransport();
  origin = target.origin;
}

function retireSession(slot, client) {
  if (slot.client === client) {
    slot.client = undefined;
    slot.connecting = undefined;
  }
}

async function getSession(slot) {
  // HTTP/2 GOAWAY forbids creating new streams, even while earlier streams
  // finish successfully. Never reuse an ended/rejecting connect promise.
  if (slot.client?.closed || slot.client?.destroyed) retireSession(slot, slot.client);
  if (!slot.connecting) {
    const client = connect(origin);
    newConnections++;
    slot.client = client;
    client.setTimeout(15000, () => client.destroy(new Error("Protected stage session timed out")));
    // Individual streams record their own errors; protect the event emitter.
    client.on("error", () => {});
    client.on("goaway", () => {
      receivedGoaway++;
      retireSession(slot, client);
      client.close();
    });
    client.on("close", () => retireSession(slot, client));
    const pending = new Promise((resolve, reject) => {
      let established = false;
      client.once("connect", () => {
        established = true;
        if (client.alpnProtocol !== "h2") {
          retireSession(slot, client);
          client.destroy();
          reject(new Error("Protected stage did not negotiate HTTP2"));
        } else resolve(client);
      });
      client.once("error", (error) => {
        retireSession(slot, client);
        reject(error);
      });
      client.once("close", () => {
        if (!established) reject(new Error("Protected stage closed before connection"));
      });
    });
    slot.connecting = pending;
  }
  return slot.connecting;
}

export async function stageFetch(url, options = {}) {
  assert.equal(new URL(url).origin, origin, "Never send stage credentials to another origin");
  if (stageTransport !== "http2") return fetch(url, options);
  const started = performance.now();
  const parsed = new URL(url);
  const outgoing = {
    ":method": options.method || "GET",
    ":path": parsed.pathname + parsed.search,
    ...Object.fromEntries(new Headers(options.headers)),
  };
  // Fair dispatch across sixteen TLS/h2 sessions reduces connection-level
  // flow-control head-of-line blocking. Each request is still measured, not retried.
  const slot = sessionPool[nextSession++ % sessionPool.length];
  let client = await getSession(slot);
  let stream;
  try {
    stream = client.request(outgoing);
  } catch (error) {
    // Retry only an attempt that could not create an HTTP/2 stream. Do not
    // replay sent requests, unexpected failures, or response-bearing errors.
    if (!client.closed && !client.destroyed) throw error;
    retireSession(slot, client);
    client = await getSession(slot);
    stream = client.request(outgoing);
  }
  return new Promise((resolve, reject) => {
    const span = { created: started, sessionId: slot.id };
    if (!stream.pending) span.sent = performance.now();
    stream.once("ready", () => {
      span.sent = performance.now();
    });
    let responded = false;
    let finished = false;
    let bodyResolve;
    let bodyReject;
    const body = new Promise((resolveBody, rejectBody) => {
      bodyResolve = resolveBody;
      bodyReject = rejectBody;
    });
    // A reset before response headers must not cause an unhandled rejection.
    body.catch(() => {});
    const chunks = [];
    let bytes = 0;
    let encoding = "identity";
    const abort = () => {
      const error = new Error("Protected stage request timed out");
      error.code = "STAGE_HTTP2_DEADLINE";
      stream.destroy(error);
    };
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) {
      stream.destroy();
      reject(new Error("Protected stage request already aborted"));
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        stream.destroy(new Error("Protected stage response exceeds bounded fixture size"));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("response", (incoming) => {
      responded = true;
      span.received = performance.now();
      encoding = String(incoming["content-encoding"] || "identity").toLowerCase();
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming))
        if (!key.startsWith(":") && value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      const response = {
        status: Number(incoming[":status"]),
        headers,
        text: () => body,
      };
      spans.set(response, span);
      resolve(response);
    });
    stream.once("end", () => {
      finished = true;
      cleanup();
      try {
        const encoded = Buffer.concat(chunks);
        const options = { maxOutputLength: 4 * 1024 * 1024 };
        const decoded =
          encoding === "br"
            ? brotliDecompressSync(encoded, options)
            : encoding === "gzip"
              ? gunzipSync(encoded, options)
              : encoding === "deflate"
                ? inflateSync(encoded, options)
                : encoding === "identity"
                  ? encoded
                  : null;
        if (!decoded) throw new Error("Unsupported stage response content encoding");
        span.wireBytes = bytes;
        span.decodedBytes = decoded.length;
        bodyResolve(decoded.toString("utf8"));
      } catch (error) {
        bodyReject(error);
      }
    });
    stream.once("error", (error) => {
      cleanup();
      if (!responded) abortedBeforeHeaders++;
      bodyReject(error);
      if (!responded) reject(error);
    });
    stream.once("close", () => {
      cleanup();
      if (!finished) {
        const error = new Error("Protected stage stream closed before complete response");
        error.code = "STAGE_HTTP2_PREMATURE_CLOSE";
        bodyReject(error);
        if (!responded) reject(error);
      }
    });
    stream.end();
  });
}

export function stageTransportSpan(response) {
  return spans.get(response);
}

export function closeStageTransport() {
  for (const slot of sessionPool) {
    const live = slot.client;
    retireSession(slot, live);
    live?.close();
  }
}

/**
 * Diagnostic-only socket identifiers. No addresses, authentication headers,
 * TLS keys or payloads are exposed. Used to correlate kernel retransmission
 * counters with the exact HTTP/2 sessions of slow measured responses.
 */
export function stageTransportSessionSnapshot() {
  return sessionPool.flatMap(slot=>{
    const socket=slot.client?.socket;
    if(!socket || !Number.isInteger(socket.localPort)) return [];
    return [{
      sessionId:slot.id,
      localPort:socket.localPort,
      bytesRead:Number(socket.bytesRead)||0,
      bytesWritten:Number(socket.bytesWritten)||0,
      connected:!socket.destroyed
    }];
  });
}
