/**
 * Offline, non-production security experiment. Proves whether a MINIMAL
 * backport of upstream picomatch PR #194 can be applied to the exact locked
 * picomatch@4.0.7 without reverting later security fixes.
 *
 * This script NEVER changes node_modules, package-lock.json, npm audit,
 * build outputs, or a runtime Worker. The patched package exists only in
 * an automatically deleted temp directory. It does NOT certify a shipped
 * mitigation, and npm audit must remain strict until a reviewed fix lands.
 */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {cpSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";

const original=resolve("node_modules/picomatch");
const installed=JSON.parse(readFileSync(join(original,"package.json"),"utf8"));
assert.equal(installed.name,"picomatch");
assert.equal(installed.version,"4.0.7","Only test the exact locked, vendor-released 4.0.7");

const work=mkdtempSync(join(tmpdir(),"cove-picomatch-cve-2026-112366-"));
try{
  const patched=join(work,"picomatch");
  cpSync(original,patched,{recursive:true});
  const parsePath=join(patched,"lib","parse.js");
  let parser=readFileSync(parsePath,"utf8");
  assert.ok(!parser.includes("const hasMixedWildcards ="),
    "Candidate is already patched; update review constraints");
  const anchor="const hasRepeatedCharPrefixOverlap = branches => {";
  const hook=`/**
 * Strict top-level mixed wildcard recognition, adapted from upstream
 * micromatch/picomatch PR #194. Bracket/escaped/nested tokens are ignored.
 */
const hasMixedWildcards = branch => {
  let escaped = false;
  let bracket = 0;
  let paren = 0;
  let star = false;
  let qmark = false;

  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      bracket++;
      continue;
    }
    if (ch === ']' && bracket > 0) {
      bracket--;
      continue;
    }
    if (ch === '(') {
      paren++;
      continue;
    }
    if (ch === ')' && paren > 0) {
      paren--;
      continue;
    }
    if (bracket > 0 || paren > 0) continue;
    if (ch === '*' || ch === '?') {
      if (branch[i + 1] === '(') continue;
      if (ch === '*') star = true;
      else qmark = true;
    }
  }
  return star && qmark;
};

`;
  assert.equal(parser.split(anchor).length,2,"Source moved; update reviewed patch");
  parser=parser.replace(anchor,hook+anchor);
  const block="  const branches = splitTopLevel(body).map(branch => branch.trim());";
  const patch=`  const branches = splitTopLevel(body).map(branch => branch.trim());
  // These strings otherwise cause nested unbounded regex repetition.
  // A single branch is sufficient to create catastrophic backtracking.
  if (branches.some(hasMixedWildcards)) {
    return { risky: true };
  }`;
  // Only patch the analyzeRepeatedExtglob call, not earlier helper functions
  // with their own distinct splitTopLevel loops.
  const fn=parser.indexOf("const analyzeRepeatedExtglob = (body, options) => {");
  const at=parser.indexOf(block,fn);
  assert.ok(fn>0&&at>fn&&at<fn+900,"Missing exact 4.0.7 risky-extglob analysis");
  parser=parser.slice(0,at)+parser.slice(at).replace(block,patch);
  writeFileSync(parsePath,parser);

  const script=`
    const assert=require('node:assert/strict');
    const pm=require(process.argv[1]);
    for(const pattern of ['+(?*a)','*(?*a)','+(*?a)','+(?*[ab])','+(?*a|b)']){
      const regex=pm.makeRe(pattern);
      assert(!regex.test('a'.repeat(48)+'!'),pattern+' returned true');
      // PR #194 also changes glob parsing semantics. Existing 4.0.7
      // may represent repeated extglobs as safely partially literalized.
      // The authoritative safety test is a bounded pathological match.
      process.stdout.write('COVE_CANDIDATE_REGEX '+pattern+' '+regex.source+'\\n');
      assert(regex.source.length<1000,'Invalid oversized regex source');
    }
    for(const [candidate,pattern,expected] of [
      ['src/index.ts','src/**/*.ts',true],
      ['src/index.jsx','src/**/*.ts',false],
      ['readme.md','*.md',true],
      ['abcabc','+(abc)',true],
      ['foobar','*(foo|bar)',true],
      ['a/b/c.js','**/*.js',true],
      ['a/b/c.js','**/*.ts',false],
    ])assert.equal(pm.isMatch(candidate,pattern),expected,pattern);
    process.stdout.write('COVE_PICOMATCH_BACKPORT_SPIKE_PASS\\n');
  `;
  const child=spawnSync(process.execPath,["-e",script,patched],{
    encoding:"utf8",timeout:3500,maxBuffer:8192
  });
  assert.equal(child.status,0,
    "Patched transient package failed strict ReDoS/compatibility test: "+
    (child.error?.code||child.stderr?.slice(0,450)||child.signal));
  assert.match(child.stdout,/COVE_PICOMATCH_BACKPORT_SPIKE_PASS/);
  assert.equal(readFileSync(join(original,"lib","parse.js"),"utf8").includes("const hasMixedWildcards ="),false,
    "Testing MUST NOT mutate npm-installed source");
  console.log("PASS offline 4.0.7 ReDoS patch feasibility; NOT installed, shipped or audit-certified");
} finally {
  rmSync(work,{recursive:true,force:true});
}
