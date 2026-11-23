/* eslint-disable prettier/prettier -- An explicit read/write credential partition for detached music jobs. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
const read=p=>readFileSync(p,"utf8");
const scoped="secrets.COVE_CF_STAGE_DATA_PLANE_READ_TOKEN";
const broad="secrets.CLOUDFLARE_API_TOKEN";
test("scheduled detached Commons audio inspection cannot use the broad D1 writer",()=>{
  const w=read(".github/workflows/isolated-commons-audio-technical-qa.yml");
  const dry=w.split("  detached-one-original-dry-run:")[1]?.split("  detached-private-qualification:")[0];
  const apply=w.split("  detached-private-qualification:")[1];
  assert.ok(dry&&apply);
  assert.ok(dry.includes(scoped));
  assert.ok(!dry.includes(broad));
  assert.ok(dry.includes("--max-recordings 1"));
  assert.ok(!dry.includes("--apply-private"));
  assert.ok(apply.includes(broad),"Writer migration requires independent D1/R2 proof before removal");
  const py=read("scripts/soundtracks/qualify-isolated-commons.py");
  assert.ok(py.includes("if not apply:"));
  assert.ok(py.includes('r2 = (r2 or make_r2()) if apply else None'));
});
test("daily isolated music accounting uses D1 READ only, not the broad bearer",()=>{
  const w=read(".github/workflows/isolated-open-license-discovery.yml");
  const report=w.split("  isolated-daily-throughput:")[1];
  const discovery=w.split("  read-only-candidate-discovery:")[1]?.split("  isolated-daily-throughput:")[0];
  assert.ok(report&&discovery);
  assert.ok(report.includes(scoped));
  assert.ok(!report.includes(broad));
  assert.ok(discovery.includes(broad),"Discovery still mutates detached records; do not silently disable");
  assert.ok(report.includes("report-isolated-supply.py"));
  const py=read("scripts/soundtracks/report-isolated-supply.py");
  assert.ok(py.includes('allowed = ("SELECT", "WITH")'));
  assert.ok(py.includes("Read-only detached reports only"));
  assert.ok(py.includes('DB = "fe9a9dd2-64b8-451c-a356-9ec71d9ee211"'));
  assert.ok(!py.includes("4bd657ac-8789-403e-a28c-93aba8d0a989"));
});
