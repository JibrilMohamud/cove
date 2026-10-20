import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cove-auth-attacher-"));
const key = "__coveAuthAttacherFixture";
const fixture = { loads: 0, sessions: 0, configured: true, session: null, error: null };
globalThis[key] = fixture;
try {
  await build({
    entryPoints: ["src/integrations/supabase/auth-attacher.ts"],
    outfile: path.join(root, "attacher.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "browser-session-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({
            path: "middleware",
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /^\.\/client$/ }, () => ({
            path: "client",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: module }) => ({
            contents:
              module === "middleware"
                ? "export const createMiddleware = () => ({ client: callback => callback });"
                : `const fixture = globalThis[${JSON.stringify(key)}];
                   fixture.loads++;
                   export function getSupabaseClient() {
                     if (!fixture.configured) return null;
                     return { auth: { async getSession() {
                       fixture.sessions++;
                       if (fixture.error) throw fixture.error;
                       return { data: { session: fixture.session } };
                     } } };
                   }`,
          }));
        },
      },
    ],
  });
  const { attachSupabaseAuth } = await import(path.join(root, "attacher.mjs"));
  assert.equal(fixture.loads, 0, "Importing SSR middleware must not initialize the browser SDK");
  let forwarded = 0;
  const next = async (options) => {
    forwarded++;
    return options;
  };
  assert.equal(typeof window, "undefined");
  assert.deepEqual(await attachSupabaseAuth({ next }), { headers: {} });
  assert.equal(fixture.loads, 0, "SSR loader invocation must not initialize the browser SDK");
  globalThis.window = {};
  assert.deepEqual(await attachSupabaseAuth({ next }), { headers: {} });
  assert.equal(fixture.loads, 1);
  for (const token of ["synthetic.initial.token", "synthetic.refreshed.token"]) {
    fixture.session = { access_token: token };
    assert.deepEqual(await attachSupabaseAuth({ next }), {
      headers: { Authorization: "Bearer " + token },
    });
  }
  assert.equal(fixture.loads, 1, "The imported module may be reused, never a session token");
  fixture.session = null;
  assert.deepEqual(await attachSupabaseAuth({ next }), { headers: {} });
  const beforeFailure = forwarded;
  fixture.error = new Error("Synthetic session read failed");
  await assert.rejects(attachSupabaseAuth({ next }), /Synthetic session read failed/);
  assert.equal(forwarded, beforeFailure, "A failed session read must not continue as a guest");
  fixture.configured = false;
  assert.deepEqual(await attachSupabaseAuth({ next }), { headers: {} });
  assert.equal(fixture.sessions, 5);
  console.log(
    "PASS: browser SDK deferred, refreshed tokens forwarded, logout and optional auth preserved, session errors fail closed.",
  );
} finally {
  delete globalThis.window;
  delete globalThis[key];
  await fs.rm(root, { recursive: true, force: true });
}
