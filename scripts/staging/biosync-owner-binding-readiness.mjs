/* eslint-disable prettier/prettier -- Protected synthetic owner transport guard; never mutate. */
/**
 * Cloudflare's temporary external ingress can appear before the private
 * Worker -> service binding -> Durable Object version is live in every colo.
 * Only an authenticated, side-effect-free owner GET 405 can prove it.
 * No owner command, D1/R2 SQL, rights or payment may be replayed here.
 */
const SCHEMA="cove.qa.biosync-owner-binding-readiness.v1";
const CONCURRENCY=32,MAX_ROUNDS=12,STABLE_WAVES=2;
export async function stabilizeBiosyncOwnerBinding(probe,sleep){
  if(typeof probe!=="function"||typeof sleep!=="function")
    throw Error("biosync_owner_binding_readiness_invalid");
  let consecutive=0,edge404=0,unavailable503=0,edge502=0,edge504=0,probeTimeouts=0;
  for(let round=1;round<=MAX_ROUNDS;round++){
    // A measured commit is NEVER issued here, and the subsequent positive
    // owner command is deliberately NOT retried on any ambiguous response.
    const receipts=await Promise.all(Array.from({length:CONCURRENCY},()=>probe()));
    let fullyReady=true;
    for(const response of receipts){
      // A generated application 404 (our gateway always sets no-store) is
      // a wrong route, NOT an edge propagation receipt. Likewise only bare
      // 502/504 edge errors may delay a synthetic, non-mutating readiness
      // wave. 401/403/405 and malformed owner receipts fail immediately.
      if(response?.status===404&&response.noStore===true)
        throw Error("biosync_owner_binding_readiness_receipt_denied:HTTP_404");
      // Only explicitly tagged AbortSignal timeout on the authenticated
      // READINESS GET may delay a wave. An absent positive receipt never
      // constitutes success, and no owner command is replayed here.
      if(response?.status===0&&response.preflightTimeout===true){
        fullyReady=false;
        probeTimeouts++;
        continue;
      }
      if(response?.status===404||response?.status===503||
        ((response?.status===502||response?.status===504)&&response.noStore!==true)){
        fullyReady=false;
        if(response.status===404)edge404++;
        else if(response.status===503)unavailable503++;
        else if(response.status===502)edge502++;
        else edge504++;
        continue;
      }
      if(response?.status!==200||response.body?.schema!==SCHEMA||
         response.noStore!==true)
        throw Error("biosync_owner_binding_readiness_receipt_denied:HTTP_"+
          String(response?.status??0));
    }
    consecutive=fullyReady?consecutive+1:0;
    if(consecutive===STABLE_WAVES)
      return {schema:"cove.qa.biosync-binding-stable.v1",completedWaves:round,
        edge404,unavailable503,consecutive,
        ...(edge502?{edge502}:{}),...(edge504?{edge504}:{}),
        ...(probeTimeouts?{probeTimeouts}:{})};
    if(round<MAX_ROUNDS)await sleep(3000);
  }
  throw Error("biosync_owner_binding_readiness_unstable:"+edge404+":"+unavailable503+
    (edge502||edge504?":edge502="+edge502+":edge504="+edge504:"")+
    (probeTimeouts?":timeouts="+probeTimeouts:""));
}
