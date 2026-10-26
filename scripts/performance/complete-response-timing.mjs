/**
 * Completion-time accounting for strict hosted capacity acceptance.
 * The first HTTP/2 response headers are diagnostic, never the release clock.
 * Failure to receive/decode the entire body rejects the promise and fails
 * the request; no body timeout or transmission is silently discarded.
 */
export async function measureCompleteStageResponse(response, started, now=()=>performance.now()) {
  const firstHeadersMs=now()-started;
  const body=await response.text();
  const ms=now()-started;
  if(!Number.isFinite(firstHeadersMs)||!Number.isFinite(ms)||
      firstHeadersMs<0||ms<firstHeadersMs)
    throw Error("invalid_stage_delivery_clock");
  return {body,ms,firstHeadersMs,completedAtUnixMs:Date.now()};
}
