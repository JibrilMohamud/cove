/**
 * A temporary Workers.dev script can serve a correct private owner 200 in
 * one colo while another colo still serves an edge 404 before Worker entry.
 * Stabilize ONLY the authenticated, read-only QA probes before measurement.
 * Never retry a measured sample, canonical write, refund or Stripe request.
 */
export const PAID_QA_READ_PROBES = Object.freeze([
  { route: "/qa/transport-caller-ping", schema: "cove.qa.transport-caller-ping.v1" },
  { route: "/qa/transport-owner-ping", schema: "cove.qa.transport-owner-ping.v1" },
  { route: "/qa/native-first-paint", schema: "cove.qa.owner-native-first-paint.v1" },
]);

function checkedReadReceipt(route, response) {
  const definition = PAID_QA_READ_PROBES.find((item) => item.route === route);
  if (!definition) throw Error("paid_qa_ingress_unreviewed_probe");
  // A 404 *without* the authenticated Worker's marker may be edge version
  // propagation. A 404 from inside the Worker is an application failure.
  // A runner-side timeout on a PRE-MEASUREMENT, read-only probe is not
  // proof of readiness or of an application denial. Do not retry the same
  // request, issue writes, or discard any measured latency sample here.
  if (response?.status === 0 && response.preflightTimeout === true) return "preflight_timeout";
  if (response?.status === 404 && response.ingressColo === null) return "edge_404";
  // This endpoint never touches owner/D1, cannot mutate anything and emits
  // its ingress marker before every successful response. Only an unmarked
  // 500 on the exact caller-only ping can delay pre-measurement readiness.
  // Other 5xx, any 500 from owner/native routes or any marked 500 fails now.
  if (
    route === "/qa/transport-caller-ping" &&
    response?.status === 500 &&
    response.ingressColo === null &&
    response.bindingHeadersMs === null &&
    response.ownerRouteMs === null
  )
    return "edge_500";
  const expected =
    response?.status === 200 &&
    response.body?.schema === definition.schema &&
    typeof response.ingressColo === "string" &&
    /^[A-Z]{3}$/.test(response.ingressColo);
  const metrics =
    route !== "/qa/transport-owner-ping" ||
    (typeof response.bindingHeadersMs === "number" && typeof response.ownerRouteMs === "number");
  const authorized =
    route !== "/qa/native-first-paint" ||
    (Array.isArray(response.body?.rows) && response.body.rows.length === 1);
  if (!expected || !metrics || !authorized)
    throw Error(
      "paid_qa_ingress_probe_contract_denied:" + route + ":HTTP_" + String(response?.status ?? 0),
    );
  return "ready";
}

/**
 * Every wave exercises three fixed read-only paths at the full 32-request
 * parallelism. Two *consecutive* entirely clean waves are required, with no
 * selected/discarded latency samples. Uncertain network/owner/5xx failures
 * fail immediately; only an unmarked 500 from the nonmutating, no-D1 caller
 * ping is treated as not-ready. Persistent 404/500 fails after a hard bound.
 */
export async function stabilizePrivatePaidQaIngress({
  probe,
  sleep,
  nativeInput,
  parallel = 32,
  rounds = 12,
  stableWaves = 2,
}) {
  if (
    typeof probe !== "function" ||
    typeof sleep !== "function" ||
    !nativeInput ||
    !Array.isArray(nativeInput.ids) ||
    nativeInput.ids.length !== 1 ||
    nativeInput.territory !== "US" ||
    nativeInput.currency !== "USD" ||
    parallel !== 32 ||
    rounds !== 12 ||
    stableWaves !== 2
  )
    throw Error("paid_qa_ingress_unsafe_configuration");
  let clean = 0;
  let edge404 = 0;
  let edge500 = 0;
  let preflightTimeouts = 0;
  for (let round = 1; round <= rounds; round++) {
    let entireWaveReady = true;
    for (const { route } of PAID_QA_READ_PROBES) {
      const requestBody = route === "/qa/native-first-paint" ? nativeInput : {};
      const receipts = await Promise.all(
        Array.from({ length: parallel }, async () => {
          try {
            return await probe(route, requestBody);
          } catch (error) {
            // Only the standard AbortSignal.timeout error may delay this
            // isolated READINESS wave; unknown transport/code errors still
            // fail. No purchase, owner write, or measured sample is retried.
            if (error instanceof Error && error.name === "TimeoutError")
              return { status: 0, preflightTimeout: true };
            throw error;
          }
        }),
      );
      for (const response of receipts) {
        const verdict = checkedReadReceipt(route, response);
        if (verdict !== "ready") {
          entireWaveReady = false;
          if (verdict === "edge_404") edge404++;
          else if (verdict === "edge_500") edge500++;
          else if (verdict === "preflight_timeout") preflightTimeouts++;
        }
      }
    }
    clean = entireWaveReady ? clean + 1 : 0;
    if (clean === stableWaves)
      return {
        globallyReady: true,
        completeWaves: round,
        edge404,
        edge500,
        ...(preflightTimeouts ? { preflightTimeouts } : {}),
      };
    if (round < rounds) await sleep(3000);
  }
  throw Error(
    "paid_qa_ingress_readonly_unstable:edge404=" + edge404 +
      ":edge500=" + edge500 + ":timeouts=" + preflightTimeouts,
  );
}
