import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const names = [
  "cove-owned-homepage-authority",
  "cove-owned-homepage-stage",
  "cove-asset-auth-stage",
  "cove-asset-auth-gateway",
];
const script = path.resolve("scripts/staging/owned-storefront-rollback.mjs");
const sha = "a".repeat(40),
  runId = "12345",
  id = "12345678-1234-1234-1234-123456789abc";
function fixture(mutate = () => {}, denied = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-rollback-"));
  fs.mkdirSync(path.join(root, "artifacts/owned-storefront"), { recursive: true });
  const captured = { sha, runId, versions: names.map((name) => ({ name, id })) };
  mutate(captured);
  fs.writeFileSync(path.join(root, ".owned-rollback.json"), JSON.stringify(captured));
  fs.writeFileSync(
    path.join(root, "mock.mjs"),
    `
    import fs from 'node:fs';
    const captured=${JSON.stringify(captured)};
    globalThis.fetch=async (url,init={})=>{
      fs.appendFileSync('requests.jsonl',JSON.stringify({url,method:init.method,body:init.body})+'\\n');
      if(url.startsWith('https://api.cloudflare.com/')){
        if(${denied} && init.method==='POST')return Response.json({success:false,errors:[{code:10001,message:'private-provider-text'}]},{status:403});
        const version={version_id:'${id}',percentage:100};
        return Response.json({success:true,result:init.method==='GET'?{deployments:[{versions:[version]}]}:{}});
      }
      if(url==='https://ssr-canary.covereads.com/')return new Response('<div class="book-card"></div>',{headers:{'x-cove-homepage-authority':'isolated-canonical-primary'}});
      if(url==='https://ssr-canary.covereads.com/covers/1.jpg')return new Response(null,{status:401});
      throw Error('Unexpected network target');
    };
  `,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", path.join(root, "mock.mjs"), script, "restore"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: runId,
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        CLOUDFLARE_ACCOUNT_ID: "d26430caa63ec55f6612e32f36aca5e9",
        CLOUDFLARE_API_TOKEN: "offline-fixture-token",
        COVE_OWNED_ROLLBACK_GATE_KEY: "b".repeat(64),
      },
    },
  );
  const file = path.join(root, "requests.jsonl");
  const requests = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  fs.rmSync(root, { recursive: true, force: true });
  return { result, requests };
}
test("rollback across cold-trial secrets uses force only on four same-run pinned QA versions and verifies deployments", () => {
  const { result, requests } = fixture();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.filter((r) => r.method === "POST").length, 4);
  for (const [i, r] of requests.filter((r) => r.method === "POST").entries()) {
    assert.equal(
      r.url,
      `https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9/workers/scripts/${names[i]}/deployments?force=true`,
    );
    assert.deepEqual(JSON.parse(r.body), {
      strategy: "percentage",
      versions: [{ version_id: id, percentage: 100 }],
    });
  }
  assert.equal(requests.filter((r) => r.method === "GET").length, 4);
});
test("wrong SHA, run, script or malformed version fails before any deployment", () => {
  for (const mutate of [
    (c) => (c.sha = "c".repeat(40)),
    (c) => (c.runId = "999"),
    (c) => (c.versions[3].name = "production"),
    (c) => (c.versions[3].id = "bad"),
  ]) {
    const { result, requests } = fixture(mutate);
    assert.notEqual(result.status, 0);
    assert.deepEqual(requests, []);
  }
});
test("failed rollback exposes only HTTP status and fixed numeric codes", () => {
  const { result } = fixture(() => {}, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status=403 codes=10001/);
  assert.ok(!result.stderr.includes("private-provider-text"));
});
