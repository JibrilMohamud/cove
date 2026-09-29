import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fore-auth-"));
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
const originalFetch = globalThis.fetch;
async function request(env, path, body) {
  const response = await handleCoveApi(
    new Request("https://fore.test/api/fore" + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://fore.test",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  );
  return { status: response.status, data: await response.json() };
}
try {
  const env = localBindings(folder);
  Object.assign(env, {
    FORE_AUTH_MODE: "supabase",
    SUPABASE_URL: "https://confirmed.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  });
  assert.deepEqual((await request(env, "/auth/options")).data, { available: true, google: false });
  assert.equal(
    (
      await request(env, "/auth/signup", {
        username: "reader_one",
        email: "not-an-email",
        password: "a-good-password-123",
      })
    ).status,
    400,
  );
  let signupCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    if (pathname === "/auth/v1/settings") return Response.json({ mailer_autoconfirm: false });
    if (pathname === "/auth/v1/signup") {
      signupCalls++;
      const stamp = new Date().toISOString();
      return Response.json({
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          aud: "authenticated",
          role: "authenticated",
          email: "reader@example.com",
          phone: "",
          confirmation_sent_at: stamp,
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: { username: "reader_one" },
          identities: [],
          created_at: stamp,
          updated_at: stamp,
        },
        session: null,
      });
    }
    throw Error("Unexpected provider request " + url);
  };
  const created = await request(env, "/auth/signup", {
    username: "reader_one",
    email: "reader@example.com",
    password: "a-good-password-123",
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.data.verificationRequired, true);
  assert.equal(signupCalls, 1);
  const unsafe = localBindings(folder);
  Object.assign(unsafe, {
    FORE_AUTH_MODE: "supabase",
    SUPABASE_URL: "https://autoconfirm.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  });
  globalThis.fetch = async (input) =>
    new URL(String(input)).pathname === "/auth/v1/settings"
      ? Response.json({ mailer_autoconfirm: true })
      : Response.json({}, { status: 500 });
  const blocked = await request(unsafe, "/auth/signup", {
    username: "reader_two",
    email: "two@example.com",
    password: "another-password-123",
  });
  assert.equal(blocked.status, 503);
  assert.match(blocked.data.error, /Email verification must be enabled/);
  console.log(
    "PASS: account availability, email syntax, verified-email requirement, and fail-closed provider configuration.",
  );
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(folder, { recursive: true, force: true });
}
