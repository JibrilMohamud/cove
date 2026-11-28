/* eslint-disable prettier/prettier -- Signed private evidence boundary. */
import {createHash,createPublicKey,verify} from "node:crypto";
import {compileCurrentLegalBaseline,hashCurrentBaseline} from "./current-legal-baseline.mjs";

const digest=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const scope=r=>JSON.stringify([r.productId,r.territory,r.format,r.channel]);
const exact=(x,keys)=>!!x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).sort().join("|")===keys.split("|").sort().join("|");
const fail=code=>{throw Error("owner_inventory_"+code);};
const sorted=rows=>[...rows].sort((a,b)=>scope(a)<scope(b)?-1:scope(a)>scope(b)?1:0);

/**
 * Offline evidence handoff, NOT a production owner or serving grant.
 * The trusted operator pins the current discovery digest, epoch, owner key
 * and independent reviewer key outside the signed input archives.
 */
export function compileAttestedCurrentLegalBaseline({discovery,inventory,attestation,ownerTrust,review,trust,ownerEpoch,nowMs}){
  const m=discovery?.manifest;
  if(!m||m.schema!=="cove.legal-scope-discovery.v1"||!Array.isArray(m.products)||
    !Array.isArray(m.scopes)||!Array.isArray(m.unresolvedGrantIds)||!Array.isArray(m.productsWithoutRecordedScopes)||
    !digest(ownerTrust?.discoverySha256)||hashCurrentBaseline(m)!==ownerTrust.discoverySha256||
    discovery.manifestSha256!==ownerTrust.discoverySha256)fail("discovery_pin");
  // Unresolved grant identity can conceal a deny affecting a recorded scope.
  // Never promote a partially resolved inventory.
  if(m.unresolvedGrantIds.length)fail("unresolved_grants");
  if(!Array.isArray(inventory)||inventory.length!==m.scopes.length||!inventory.length||inventory.length>1000000)fail("scope_coverage");
  const products=new Map(m.products.map(p=>[p.productId,p]));
  const expected=new Set(m.scopes.map(scope));
  if(products.size!==m.products.length||expected.size!==m.scopes.length)fail("duplicate_discovery");
  const actual=new Set();
  for(const r of inventory){
    const k=scope(r),p=products.get(r.productId);
    if(actual.has(k)||!expected.has(k)||!p||p.format!==r.format||
      (p.status!=="active"&&r.canonicalAllowed!==false))fail("scope_coverage");
    actual.add(k);
  }
  const covered=new Set(inventory.map(r=>r.productId));
  const quarantined=[...products.keys()].filter(id=>!covered.has(id)).sort();
  if(JSON.stringify(quarantined)!==JSON.stringify([...m.productsWithoutRecordedScopes].sort()))fail("product_coverage");
  const inventorySha256=hashCurrentBaseline(sorted(inventory));
  if(!exact(attestation,"schema|issuer|primaryId|ownerEpoch|discoverySha256|inventorySha256|observedAtMs|validUntilMs|signature")||
    attestation.schema!=="cove.owner-inventory-attestation.v1"||
    attestation.issuer!==ownerTrust.issuer||attestation.primaryId!==ownerTrust.primaryId||
    !ownerTrust.primaryId||attestation.ownerEpoch!==ownerEpoch||ownerEpoch!==ownerTrust.ownerEpoch||
    attestation.discoverySha256!==ownerTrust.discoverySha256||attestation.inventorySha256!==inventorySha256||
    !Number.isSafeInteger(nowMs)||!Number.isSafeInteger(attestation.observedAtMs)||!Number.isSafeInteger(attestation.validUntilMs)||
    attestation.observedAtMs>nowMs||attestation.validUntilMs<=nowMs||
    attestation.validUntilMs-attestation.observedAtMs>900000)fail("attestation_scope_or_time");
  if(!digest(ownerTrust.spkiSha256)||ownerTrust.spkiSha256===trust?.spkiSha256||
    ownerTrust.issuer===trust?.issuer)fail("independent_signers");
  const key=createPublicKey(ownerTrust.publicKeyPem);
  if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1"||
    createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex")!==ownerTrust.spkiSha256)fail("owner_key_pin");
  const {signature,...payload}=attestation;
  if(typeof signature!=="string"||!/^[A-Za-z0-9_-]{80,110}$/.test(signature))fail("signature");
  const sig=Buffer.from(signature,"base64url");
  if(sig.toString("base64url")!==signature||
    !verify("sha256",Buffer.from(hashCurrentBaseline(payload),"utf8"),key,sig))fail("signature");
  if(trust.inventorySha256!==inventorySha256||review.observedAtMs<attestation.observedAtMs)fail("review_binding");
  const result=compileCurrentLegalBaseline({inventory,review,trust,ownerEpoch,nowMs});
  const manifest={...result.manifest,ownerAttestationSha256:hashCurrentBaseline(attestation),
    discoverySha256:ownerTrust.discoverySha256,productsWithoutRecordedScopes:quarantined,
    validUntilMs:Math.min(result.manifest.validUntilMs,attestation.validUntilMs)};
  return {...result,manifest,manifestSha256:hashCurrentBaseline(manifest),productsQuarantined:quarantined.length,
    authorizing:false,permitsPublication:false,releaseCertified:false};
}
