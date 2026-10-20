import assert from "node:assert/strict";
import { connect } from "node:http2";
import { performance } from "node:perf_hooks";

// A separate diagnostic arm. Default requests retain native fetch/HTTP1.
// Both arms enforce identical status, body, rights and hard latency checks.
export const stageTransport = process.env.COVE_STAGE_HTTP2 === "1" ? "http2" : "native-fetch";
const origin = "https://cove-commercial-parity-ssr-staging-20261020.cove-jibrilmohamud.workers.dev";
let session;
let connecting;
const spans = new WeakMap();

async function getSession() {
  if (!connecting) {
    const client = connect(origin);
    session = client;
    client.setTimeout(15000, () => client.destroy(new Error("Protected stage session timed out")));
    // Always install an error listener; per-request failures remain visible.
    client.on("error", () => {});
    connecting = new Promise((resolve, reject) => {
      client.once("connect", () => {
        if (client.alpnProtocol !== "h2") {
          client.destroy();
          reject(new Error("Protected stage did not negotiate HTTP2"));
        } else resolve(client);
      });
      client.once("error", reject);
      client.once("close", () => {
        connecting = undefined;
        session = undefined;
      });
    });
  }
  return connecting;
}

export async function stageFetch(url, options = {}) {
  assert.equal(new URL(url).origin, origin, "Never send stage credentials to another origin");
  if (stageTransport !== "http2") return fetch(url, options);
  const started = performance.now();
  const client = await getSession();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const outgoing = {
      ":method": options.method || "GET",
      ":path": parsed.pathname + parsed.search,
      ...Object.fromEntries(new Headers(options.headers)),
    };
    const stream = client.request(outgoing);
    const span = { created: started };
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
    const abort = () => stream.destroy(new Error("Protected stage request timed out"));
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
      bodyResolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.once("error", (error) => {
      cleanup();
      bodyReject(error);
      if (!responded) reject(error);
    });
    stream.once("close", () => {
      cleanup();
      if (!finished) {
        const error = new Error("Protected stage stream closed before complete response");
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
  session?.close();
}
