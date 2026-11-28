/* eslint-disable prettier/prettier -- Fixed historical risk inventory; reductions remain mandatory. */
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";

/**
 * Historical known-unsafe sources, not a grant of permission to keep using
 * the broad token. Changes may REMOVE names, never add new consumers.
 * This list must shrink to zero before credential revocation.
 */
const knownUnsafe=new Set([]);
const files=readdirSync(".github/workflows").filter(name=>/\.ya?ml$/.test(name));
const matches=files.filter(name=>{
  const raw=readFileSync(".github/workflows/"+name,"utf8");
  return raw.includes("secrets.CLOUDFLARE_API_TOKEN");
}).map(name=>name.replace(/\.ya?ml$/,"")).sort();
assert.ok(matches.every(name=>knownUnsafe.has(name)),
  "Unreviewed broad Cloudflare deployment secret use was introduced: "+
  matches.filter(name=>!knownUnsafe.has(name)).join(", "));
assert.ok(matches.length<=knownUnsafe.size,
  "Broad Cloudflare token references increased since baseline");
const removed=[...knownUnsafe].filter(name=>!matches.includes(name)).sort();
assert.ok(!matches.includes("hosted-music-supply-disabled-qa"),
  "The isolated music QA must never regain the broad token");
console.log("BROAD_CF_TOKEN_REMAINING="+matches.length);
console.log("BROAD_CF_TOKEN_REMOVED="+removed.length);
console.log("PASS: no broad Cloudflare secret references are permitted; physical revocation proof remains independent");
