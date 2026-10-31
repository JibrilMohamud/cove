import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cove-legal-"));
const originalDateNow = Date.now;
const fixedRateMinute = originalDateNow();
Date.now = () => fixedRateMinute;
try {
  fs.cpSync("drizzle", path.join(folder, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(folder, "api.mjs"),
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(folder, "api.mjs"));
  const env = localBindings(folder);
  const req = async ({
    origin = "https://fore.test",
    method = "POST",
    data,
    ip = "198.51.100.9",
  }) => {
    const response = await handleCoveApi(
      new Request("https://fore.test/api/fore/legal/contact", {
        method,
        headers: { origin: origin, "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(data),
      }),
      env,
    );
    return { status: response.status, data: await response.json() };
  };
  const payload = {
    category: "privacy-access",
    email: "Reader@Example.com",
    message: "Please export all the data that Cove stores about my reading life.",
    website: "",
  };
  const good = await req({ data: payload });
  assert.equal(good.status, 201, JSON.stringify(good));
  assert.match(good.data.reference, /^legal_[a-f0-9-]+$/);
  const rows = (await env.DB.prepare("SELECT * FROM legal_contact_requests").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "reader@example.com");
  assert.equal(rows[0].category, "privacy-access");
  assert.equal(rows[0].state, "open");
  assert.equal(
    (await req({ origin: "https://attacker.example", data: payload, ip: "198.51.100.10" })).status,
    403,
  );
  assert.equal(
    (await req({ data: { ...payload, message: "tiny" }, ip: "198.51.100.11" })).status,
    400,
  );
  assert.equal(
    (await req({ data: { ...payload, website: "spam.example" }, ip: "198.51.100.12" })).status,
    200,
  );
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) n FROM legal_contact_requests").first()).n,
    1,
  );
  for (let i = 0; i < 4; i++) assert.equal((await req({ data: payload })).status, 201);
  assert.equal((await req({ data: payload })).status, 429);
  console.log(
    "PASS: durable anonymous privacy requests, origin isolation, validation, spam trap and rate limiting.",
  );
} finally {
  Date.now = originalDateNow;
  fs.rmSync(folder, { recursive: true, force: true });
}
