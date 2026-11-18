/** Non-shipping experiment. Installed source, lockfile and audit stay intact. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { collapseCandidate, PUBLISHED_COMMIT } from "./picomatch-407-collapse-candidate.mjs";

const original = resolve("node_modules/picomatch");
const installed = JSON.parse(readFileSync(join(original, "package.json"), "utf8"));
assert.equal(installed.name, "picomatch");
assert.equal(installed.version, "4.0.7");
const originalParser = readFileSync(join(original, "lib/parse.js"), "utf8");
const packageBefore = readFileSync("package.json", "utf8");
const lockBefore = readFileSync("package-lock.json", "utf8");
const work = mkdtempSync(join(tmpdir(), "cove-picomatch-407-collapse-"));
function child(script, args, timeout = 10_000) {
  return spawnSync(process.execPath, ["-e", script, ...args], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 32_768,
  });
}
try {
  const patched = join(work, "picomatch");
  cpSync(original, patched, { recursive: true });
  writeFileSync(join(patched, "lib/parse.js"), collapseCandidate(originalParser));
  // Actual CPU stall on the original failed match; kill only the subprocess.
  const attack = `const pm=require(process.argv[1]);
    const result=pm.isMatch('a'.repeat(64)+'!', '+(*a)');
    process.stdout.write(JSON.stringify(result));`;
  const vulnerable = child(attack, [original], 1_500);
  assert.equal(vulnerable.error?.code, "ETIMEDOUT", "original must reproduce actual CPU stall");
  assert.equal(vulnerable.signal, "SIGKILL");
  const bounded = child(attack, [patched], 1_500);
  assert.equal(bounded.status, 0, "candidate timed out or crashed: " + bounded.stderr);
  assert.equal(bounded.stdout, "false");
  const compare = `
    const assert=require('node:assert/strict');
    const original=require(process.argv[1]);
    const candidate=require(process.argv[2]);
    const patterns=['+(*)','+(*a)','*(*a)','+(a*)','+(a*b)','+(a?*b)',
      '*(*.js)','+(*)c','+(*a)b','pre+(a*b)post','*(a*b)','+(*a*b)'];
    const options=[{}, {dot:true}, {windows:true}, {bash:true},
      {nocase:true}, {dot:true,windows:true,bash:true}];
    const alphabet=['a','b','.','/','\\\\','!',' '];
    const inputs=['','abc','abcabc','a.a','foo.js','foo.ts','preaxbpost'];
    let layer=[''];
    for(let length=1;length<=4;length++){
      layer=layer.flatMap(prefix=>alphabet.map(char=>prefix+char));
      inputs.push(...layer);
    }
    let compared=0;
    for(const pattern of patterns)for(const opts of options){
      const before=original(pattern,opts),after=candidate(pattern,opts);
      for(const input of inputs){
        assert.equal(after(input),before(input),JSON.stringify({pattern,opts,input}));
        compared++;
      }
    }
    assert.equal(candidate.isMatch('abc','+(*)c'),true);
    assert.equal(candidate.isMatch('aaa','+(*a)'),true);
    assert.equal(candidate.isMatch('a'.repeat(64)+'!','+(*)'),true);
    for(const pattern of ['+("*a")','+(\\\\*a)','+([ab]*a)',
      '+(**a)','+(a/*b)','+(*(ab)c)','+(a|*a)'])
      assert.equal(candidate.makeRe(pattern).source,original.makeRe(pattern).source,
        'excluded syntax changed: '+pattern);
    for(const captureOption of [true,1,'yes']){
      const capture=candidate.makeRe('+(*a)',{capture:captureOption});
      assert.equal(capture.test('aaa'),false);
      assert.equal(capture.test('+(*a)'),true);
    }
    assert.equal(candidate.makeRe('+(*a)',{maxExtglobRecursion:false}).source,
      original.makeRe('+(*a)',{maxExtglobRecursion:false}).source);
    for(const pattern of ['+(*a)','*(*a)','+(*)b','+(a*)b','+(*a*b)c']){
      const regex=candidate.makeRe(pattern);
      assert.equal(/\\)[+*]/.test(regex.source),false,pattern+' retains outer repetition');
      regex.test('a'.repeat(20_000)+'!');
    }
    console.log('PASS '+compared+' differential matches; actual baseline stall / bounded candidate; excluded grammar and capture fallback');
  `;
  const result = child(compare, [original, patched]);
  assert.equal(result.status, 0, "candidate compatibility failed: " + result.stderr);
  console.log(result.stdout.trim());
  const upstream = process.env.COVE_PICOMATCH_UPSTREAM_TEST_ROOT;
  if (upstream) {
    const root = resolve(upstream);
    const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert.equal(revision.status, 0);
    assert.equal(revision.stdout.trim(), PUBLISHED_COMMIT);
    assert.equal(readFileSync(join(root, "lib/parse.js"), "utf8"), originalParser);
    cpSync(join(root, "test"), join(patched, "test"), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(patched, "node_modules"), "dir");
    const require = createRequire(join(root, "package.json"));
    const mocha = require.resolve("mocha/bin/mocha.js");
    const full = spawnSync(process.execPath, [mocha, "--reporter", "dot", "test/**/*.js"], {
      cwd: patched,
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 65_536,
    });
    assert.equal(full.status, 0, "published-suite regression: " + full.stdout + full.stderr);
    console.log(full.stdout.trim());
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  assert.equal(readFileSync(join(original, "lib/parse.js"), "utf8"), originalParser);
  assert.equal(readFileSync("package.json", "utf8"), packageBefore);
  assert.equal(readFileSync("package-lock.json", "utf8"), lockBefore);
}
console.log(
  "NON-SHIPPING: installed dependency and mandatory audit unchanged; no release clearance",
);
