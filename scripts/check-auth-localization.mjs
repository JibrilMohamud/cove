import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";

// Exercise the real components and translation hooks. Dialog portals are replaced
// only so their contents can be inspected without a browser; this does not test AT.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cove-auth-locale-"));
const previousLocale = globalThis.__coveTestLocale;
try {
  fs.symlinkSync(path.resolve("node_modules"), path.join(scratch, "node_modules"), "dir");
  await build({
    entryPoints: {
      auth: "src/features/fore/Auth.tsx",
      failure: "src/features/fore/RequestFailure.tsx",
      text: "src/features/fore/ui-text.ts",
      transport: "src/features/fore/api-transport.ts",
    },
    outdir: scratch,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    packages: "external",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
    plugins: [
      {
        name: "render-fixtures",
        setup(plugin) {
          plugin.onResolve({ filter: /^react$/ }, () => ({ path: "react", external: true }));
          plugin.onResolve({ filter: /^@\/components\/ui\/dialog$/ }, () => ({
            path: "dialog",
            namespace: "fixture",
          }));
          plugin.onResolve({ filter: /^\.\/client$/ }, () => ({
            path: "client",
            namespace: "fixture",
          }));
          plugin.onResolve({ filter: /^\.\/localization$/ }, () => ({
            path: "locale",
            namespace: "fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => ({
            contents:
              name === "dialog"
                ? `import {createElement as h} from 'react'; export const Dialog=({open,children})=>open?h('section',null,children):null; export const DialogContent=({children,...props})=>h('div',props,children); export const DialogTitle=({children})=>h('h2',null,children); export const DialogDescription=({children})=>h('p',null,children);`
                : name === "client"
                  ? `export const api=()=>{throw Error('Unexpected API call during render')};`
                  : `export const useStorefrontLocale=()=>({locale:globalThis.__coveTestLocale});`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const load = (name) => import(pathToFileURL(path.join(scratch, `${name}.mjs`)).href);
  const { AuthDialog } = await load("auth");
  const { RequestFailure } = await load("failure");
  const { UiText, translateUi } = await load("text");
  const { CoveRequestError } = await load("transport");
  const escaped = (text) => render(h(Fragment, null, text));
  for (const locale of ["en-US", "es-ES", "fr-FR", "de-DE", "ar-SA"]) {
    globalThis.__coveTestLocale = locale;
    const text = (source, values) => translateUi(locale, source, values);
    for (const [mode, title, field] of [
      ["login", "Welcome back.", "Username or email"],
      ["signup", "A reading life of your own.", "Username"],
      ["verify", "Check your inbox.", "Verification code"],
      ["reset", "Find your way back.", "Email address"],
      ["new-password", "Choose a new password.", "Password"],
    ]) {
      const html = render(h(AuthDialog, { mode, onChange() {}, onSuccess: async () => {} }));
      assert.ok(html.includes(`<h2>${escaped(text(title))}</h2>`), `${locale}/${mode}: heading`);
      assert.ok(html.includes(escaped(text(field))), `${locale}/${mode}: input label`);
      if (mode === "signup") {
        assert.ok(html.includes('href="/terms"'));
        assert.ok(html.includes('href="/privacy"'));
        assert.ok(html.includes(escaped(text("Terms of Service"))));
        assert.ok(!html.includes("{terms}") && !html.includes("{privacy}"));
        assert.ok(html.includes('type="checkbox"') && html.includes("required="));
      }
      if (mode === "verify") {
        assert.ok(
          html.includes(
            escaped(
              text(
                "We sent a verification link to {email}. Open it to verify your account, then sign in. You can also enter the email code below if one is included.",
                { email: text("your email address") },
              ),
            ),
          ),
        );
      }
    }
    const reference = "req_locale_123";
    const error = new CoveRequestError("Provider details", 503, reference, true);
    const failure = render(h(RequestFailure, { error, retry() {} }));
    assert.ok(failure.includes(escaped(text("Request reference: {reference}", { reference }))));
    assert.ok(failure.includes(escaped(text("Try again"))));
    assert.ok(failure.includes(`/help?reference=${reference}`));
    assert.ok(
      render(h(RequestFailure, { error: null, retry() {} })).includes(
        escaped(text("Please try again.")),
      ),
    );
    const malicious = '<img src=x onerror="alert(1)">';
    const slots = render(
      h(UiText, {
        source: "I agree to Cove's {terms} and acknowledge its {privacy}.",
        values: {
          terms: h("a", { href: "/terms" }, malicious),
          privacy: h("a", { href: "/privacy" }, "Privacy"),
        },
      }),
    );
    assert.ok(slots.includes('href="/terms"') && slots.includes('href="/privacy"'));
    assert.ok(slots.includes("&lt;img") && !slots.includes("<img"), "slots are escaped React text");
  }
  globalThis.__coveTestLocale = "unknown";
  assert.equal(
    render(h(UiText, { source: "Unknown {slot}", values: { slot: "<safe>" } })),
    "Unknown &lt;safe&gt;",
  );
  console.log(
    "PASS: five auth modes in five locales, recovery references, linked consent, locale changes, and escaped rich-text slots (render checks; no browser/AT claim).",
  );
} finally {
  if (previousLocale === undefined) delete globalThis.__coveTestLocale;
  else globalThis.__coveTestLocale = previousLocale;
  fs.rmSync(scratch, { recursive: true, force: true });
}
