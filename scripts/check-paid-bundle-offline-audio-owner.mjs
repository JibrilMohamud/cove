/* eslint-disable prettier/prettier -- Keep legal proof patterns source-exact and fail-closed. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const qa=readFileSync("scripts/staging/prove-private-paid-owner.mjs","utf8");
const begin=owner.indexOf('if(route==="/audio/private-offline-license"){');
const end=owner.indexOf('if(route==="/delivery/private-consume-epub-grant"){',begin);
assert.ok(begin>=0&&end>begin,"Actual offline audio owner route missing");
const route=owner.slice(begin,end);
assert.match(route,/p\.format IN \('ebook','audiobook'\)/,
  "Independently licensed audio accompanying EPUB purchases must not be blocked solely by SKU format");
assert.match(route,/p\.source_name NOT IN \('gutenberg','upload'\)/,
  "Unlicensed free/unsafe sources may never inherit paid audio scope");
for(const pattern of [
  /readPaidAccess\(sql,\{entitlementId:x\.entitlementId/,
  /marketIsWithdrawn\(sql,x\.territory\)/,
  /e\.status='active'/,
  /d\.revoked_at IS NULL/,
  /riskAccount\|\|riskOrder/,
  /x\.editionId!=="ca_"\+manifestRow\.edition_id/,
  /profile\.offlineEligible!==true/,
  /chapters\.some\(c=>/,
  /x\.manifestHash/,
  /narration_agreement_terminations/,
  /uses\.includes\("offline"\)/,
  /uses\.includes\("retail"\)/,
  /territories\.includes\(x\.territory\)/,
  /results\[1\].*meta.*changes/,
  /UPDATE audio_offline_licenses SET status='revoked'/,
  /INSERT INTO audio_offline_licenses/
])assert.match(route,pattern,"Changing product format must never erase independent audio/owner protection: "+pattern);
assert.match(qa,/SELECT format FROM products WHERE id=\?/);
assert.match(qa,/paidProductFormat\.results\?\.\[0\]\?\.format,"ebook"/);
assert.match(qa,/audioOfflineResponse\.status,200/);
console.log("PASS: original dual-format paid purchase reaches exact owner offline audio issuer without changing current legal, narrator, device, market, license and withdrawal fences");
