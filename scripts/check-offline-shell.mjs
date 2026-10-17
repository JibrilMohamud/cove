import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const handlers = {},
  storage = new Map();
function cache(name) {
  if (!storage.has(name)) storage.set(name, new Map());
  const values = storage.get(name);
  return {
    async put(key, value) {
      values.set(
        typeof key === "string" ? new URL(key, "https://cove.test").href : key.url,
        value.clone(),
      );
    },
    async match(key) {
      return values
        .get(typeof key === "string" ? new URL(key, "https://cove.test").href : key.url)
        ?.clone();
    },
    async keys() {
      return [...values.keys()].map((k) => new Request(k));
    },
  };
}
let online = true,
  missing = false;
const context = {
  self: {
    location: { origin: "https://cove.test" },
    addEventListener: (name, fn) => (handlers[name] = fn),
    clients: { claim: async () => {} },
  },
  caches: {
    open: async (name) => cache(name),
    keys: async () => [...storage.keys()],
    delete: async (name) => storage.delete(name),
  },
  fetch: async (request) => {
    if (!online) throw Error("offline");
    const path = typeof request === "string" ? request : new URL(request.url).pathname;
    if (path === "/offline-manifest.json")
      return Response.json({
        version: "__COVE_OFFLINE_BUILD__",
        assets: ["/offline.html", "/offline-assets/app.js"],
      });
    if (path === "/offline.html") return new Response("PUBLIC OFFLINE READER");
    if (path === "/offline-assets/app.js")
      return new Response("reader code", { status: missing ? 503 : 200 });
    return new Response("PRIVATE ACCOUNT HTML");
  },
  Response,
  Request,
  URL,
  console,
};
vm.runInNewContext(fs.readFileSync("public/sw.js", "utf8"), context);
let installed;
handlers.install({ waitUntil: (p) => (installed = p) });
await installed;
let activated;
storage.set("cove-shell-v1", new Map([["https://cove.test/library", new Response("OLD PRIVATE")]]));
handlers.activate({ waitUntil: (p) => (activated = p) });
await activated;
assert.ok(!storage.has("cove-shell-v1"));
async function navigate() {
  let result;
  handlers.fetch({
    request: { method: "GET", mode: "navigate", url: "https://cove.test/library?auth=secret" },
    respondWith: (p) => (result = p),
  });
  return result;
}
assert.equal(await (await navigate()).text(), "PRIVATE ACCOUNT HTML");
for (const entries of storage.values())
  assert.ok(
    ![...entries.keys()].some((k) => k.includes("library") || k.includes("secret")),
    "navigation data never persisted",
  );
online = false;
assert.equal(await (await navigate()).text(), "PUBLIC OFFLINE READER");
online = true;
missing = true;
handlers.install({ waitUntil: (p) => (installed = p) });
await assert.rejects(installed, /Incomplete offline shell/);
assert.ok(
  !storage.has("cove-shell-__COVE_OFFLINE_BUILD__"),
  "partial install is not reported ready",
);
console.log(
  "PASS: complete offline installation, partial-install rejection, legacy-private-cache removal, no document persistence and safe offline navigation.",
);
