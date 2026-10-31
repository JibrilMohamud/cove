/* eslint-disable prettier/prettier -- Regression proof: customer media routes must not bypass the authoritative rights owner. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const delivery=readFileSync("src/features/fore/delivery.server.ts","utf8");
const audio=readFileSync("src/features/fore/commercial-audio.server.ts","utf8");
const offlineEpub=readFileSync("src/features/fore/offline-epub.server.ts","utf8");
const offlineAudio=readFileSync("src/features/fore/offline-audio.server.ts","utf8");

const block=(source,begin,end)=>{
  const a=source.indexOf(begin);
  assert.ok(a>=0,"Missing media entrypoint: "+begin);
  const b=source.indexOf(end,a+begin.length);
  assert.ok(b>a,"Missing media boundary: "+end);
  return source.slice(a,b);
};
const before=(source,guard,effect)=>{
  const a=source.indexOf(guard),b=source.indexOf(effect);
  assert.ok(a>=0&&b>=0&&a<b,
    "Authoritative owner must precede release/mutation: "+guard+" => "+effect);
};
const epubIssue=block(delivery,"export async function issueCommercialEpubGrant(",
  "async function watermarkEpub(");
before(epubIssue,"await requireStagePaidEntitlementAccess(env,",
  "await dispatchPrivateCommercialEpubGrant(db,");
const epubServe=block(delivery,"export async function serveCommercialEpubGrant(",
  "export async function revokeDeliveryGrant(");
before(epubServe,"await requireStagePaidEntitlementAccess(env,",
  "await env.BUCKET?.get(");
const tracks=block(audio,'if (match[2] === "tracks"',
  'if (match[2] === "playback")');
before(tracks,"await requireCommercialAudioOwner(env,",
  "return serveStoredAudio(");
const offlineAudioIssue=audio.slice(audio.lastIndexOf(
  'if (match[2] === "offline-license" && !match[3]'));
assert.ok(offlineAudioIssue.length>1000);
before(offlineAudioIssue,"await requireCommercialAudioOwner(",
  "await signOfflineAudioLicense(");
const offlineAudioVerify=block(audio,
  'if (match[2] === "offline-license" && match[3] === "verify"',
  'if (match[2] === "complete"');
// Verification's owner guard lives inside verifyStoredAudioLicense itself.
// Assert the real call graph, not a redundant second owner round-trip in the
// route that would add avoidable latency and duplicate the authorization.
assert.ok(offlineAudioVerify.includes("await verifyStoredAudioLicense("));
before(offlineAudio,"await requireStagePaidEntitlementAccess(env,",
  "return { valid: true, expiresAt: current.expires_at }");
before(offlineEpub,"await issueCommercialEpubGrant(",
  "await crypto.subtle.sign(");
before(offlineEpub,"await requireStagePaidEntitlementAccess(env,",
  "await crypto.subtle.sign(");
assert.ok(offlineEpub.includes('purpose: "offline_package"'),
  "Offline EPUB cannot bypass the grant's contract-offline restrictions");
assert.ok(offlineAudio.includes("l.status='active'") &&
  offlineAudio.includes("e.status='active'"),
  "Commercial offline audio verification must reject terminal buyer license state");
console.log("PASS: customer EPUB grant, R2 bytes, audio chapter stream, offline EPUB signing and audio license issuance/verification all require live owner before protected effects");
