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
  if (response?.status === 404 && response.ingressColo === null) return "edge_404";
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
 * fail immediately. A persistent provider edge 404 fails after a hard bound.
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
  for (let round = 1; round <= rounds; round++) {
    let entireWaveReady = true;
    for (const { route } of PAID_QA_READ_PROBES) {
      const requestBody = route === "/qa/native-first-paint" ? nativeInput : {};
      const receipts = await Promise.all(
        Array.from({ length: parallel }, () => probe(route, requestBody)),
      );
      for (const response of receipts) {
        if (checkedReadReceipt(route, response) === "edge_404") {
          entireWaveReady = false;
          edge404++;
        }
      }
    }
    clean = entireWaveReady ? clean + 1 : 0;
    if (clean === stableWaves) return { globallyReady: true, completeWaves: round, edge404 };
    if (round < rounds) await sleep(3000);
  }
  throw Error("paid_qa_ingress_edge_404_unstable:observed=" + edge404);
}
