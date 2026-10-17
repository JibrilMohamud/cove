import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "vite";
import JSZip from "jszip";
import { localBindings } from "./local-api.mjs";

// Never use production credentials or data. This server is not shipped in the app.
for (const key of Object.keys(process.env))
  if (/^(SUPABASE_|FORE_BACKEND_|FORE_INGESTION_)/.test(key)) delete process.env[key];
process.env.FORE_AUTH_MODE = "browser-qa-managed";
const checkout = process.cwd();
execFileSync(process.execPath, ["scripts/build-offline-reader.mjs"], { stdio: "inherit" });
// Windows TEMP can use an 8.3 name (RUNNER~1). Vite deliberately rejects
// requests containing '~', even within its allow list. Expand the real path.
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cove-browser-qa-")));
for (const dir of ["src", "public", "drizzle"])
  fs.cpSync(path.join(checkout, dir), path.join(scratch, dir), { recursive: true });
fs.cpSync(path.join(checkout, ".output/public"), path.join(scratch, "public"), { recursive: true });
for (const file of ["package.json", "vite.config.ts", "tsconfig.json"])
  fs.copyFileSync(path.join(checkout, file), path.join(scratch, file));
fs.mkdirSync(path.join(scratch, "scripts"));
fs.copyFileSync(
  path.join(checkout, "scripts/local-api.mjs"),
  path.join(scratch, "scripts/local-api.mjs"),
);
fs.symlinkSync(path.join(checkout, "node_modules"), path.join(scratch, "node_modules"), "dir");
const env = { ...localBindings(scratch), FORE_AUTH_MODE: "browser-qa-managed" };
const users = new Map();
let ready = false,
  api;
let refuseOriginRequests = false;
const send = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const invoke = async (route, method = "GET", body, user) => {
  const response = await api.handleCoveApi(
    new Request(`http://127.0.0.1:4173/api/fore${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(user
          ? {
              "oai-authenticated-user-id": user.id,
              "oai-authenticated-user-email": `${user.username}@example.invalid`,
              "oai-authenticated-user-full-name": user.name,
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${method} ${route} (${response.status}): ${JSON.stringify(data)}`);
  return data;
};
async function seed(progress = 1) {
  const suffix = randomUUID().slice(0, 8),
    at = new Date().toISOString(),
    people = {};
  for (const who of ["alice", "bob", "charlie"]) {
    const user = {
      id: `qa_${who}_${suffix}`,
      username: `${who}_${suffix}`,
      name: `${who[0].toUpperCase() + who.slice(1)} QA`,
    };
    people[who] = user;
    users.set(user.id, user);
    await env.DB.prepare(
      "INSERT INTO auth_accounts(provider_id,app_id,email,username,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(user.id, user.id, `${user.username}@example.invalid`, user.username, at)
      .run();
    await env.DB.prepare("INSERT INTO profiles(user_id,name,created_at) VALUES(?,?,?)")
      .bind(user.id, user.name, at)
      .run();
    await invoke("/social/me", "GET", undefined, user);
    await invoke("/library", "POST", { bookId: "1342" }, user);
    await invoke("/library", "POST", { bookId: "1342", status: "reading", progress }, user);
  }
  const annotation = await invoke(
    "/annotations",
    "POST",
    {
      bookId: "1342",
      quote: "Browser QA passage for sharing.",
      note: "A note for the selected member only.",
      cfi: "epubcfi(/6/2!/4/4[passage]/1:0)",
      chapter: "Chapter 1",
      color: "yellow",
      progress: 0.5,
    },
    people.alice,
  );
  await invoke(
    `/social/highlights/${annotation.id}/share`,
    "POST",
    {
      visibility: "member",
      recipientUserId: people.bob.id,
      shareNote: true,
      expectedAnnotationVersion: annotation.version,
      audienceConfirmed: true,
    },
    people.alice,
  );
  const group = await invoke(
    "/social/groups",
    "POST",
    { name: `QA reading group ${suffix}`, visibility: "private" },
    people.alice,
  );
  await env.DB.prepare(
    "INSERT INTO reading_group_members(group_id,user_id,role,status,joined_at,created_at,updated_at) VALUES(?,?,'member','active',?,?,?)",
  )
    .bind(group.id, people.bob.id, at, at, at)
    .run();
  for (const who of ["alice", "bob"]) {
    await env.DB.prepare(
      "UPDATE social_reader_preferences SET enabled=1,audience_mode='group',group_id=?,show_discussions=1,show_highlights=1,density=100 WHERE user_id=?",
    )
      .bind(group.id, people[who].id)
      .run();
  }
  const post = await invoke(
    "/social/posts",
    "POST",
    {
      contextType: "margin",
      contextId: "1342",
      bookId: "1342",
      cfi: "epubcfi(/6/2!/4/4[passage]/1:0)",
      chapter: "Chapter 1",
      progress: 0,
      passageText: "Browser QA passage for sharing.",
      body: "A group discussion visible to joined members.",
      visibility: "group",
      groupId: group.id,
      audienceConfirmed: true,
    },
    people.alice,
  );
  const completed = await invoke(
    "/library",
    "POST",
    { bookId: "1342", status: "finished", progress: 1 },
    people.alice,
  );
  return {
    people,
    journeyId: completed.readingJourneyId,
    annotationId: annotation.id,
    groupId: group.id,
    groupName: `QA reading group ${suffix}`,
    postId: post.id,
  };
}
const fixturePlugin = {
  name: "cove-browser-qa-only",
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url || "/", "http://127.0.0.1:4173");
      // Firefox's Playwright offline flag does not reach service-worker fetches.
      // Refuse real origin traffic too; never replace it with a fake offline page.
      if (url.pathname === "/__qa/network" && req.method === "POST") {
        refuseOriginRequests = url.searchParams.get("offline") === "1";
        return send(res, { refusing: refuseOriginRequests });
      }
      if (refuseOriginRequests) return req.socket.destroy();
      if (url.pathname === "/__qa/health") return send(res, { ready }, ready ? 200 : 503);
      if (url.pathname === "/__qa/catalog")
        return send(res, {
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              id: 1342,
              title: "Browser QA Reading Book",
              authors: [{ name: "QA Author", birth_year: 1800, death_year: 1880 }],
              languages: ["en"],
              subjects: ["Fiction"],
              bookshelves: [],
              copyright: false,
              media_type: "Text",
              formats: {
                "application/epub+zip": "https://www.gutenberg.org/ebooks/1342.epub3.images",
              },
              download_count: 100,
            },
          ],
        });
      if (url.pathname === "/__qa/seed" && req.method === "POST") {
        try {
          return send(res, await seed(url.searchParams.get("progress") === "0" ? 0 : 1));
        } catch (error) {
          console.error(error);
          return send(res, { error: error.message }, 500);
        }
      }
      // Allow only server-created synthetic identities. Supplied production auth headers are removed.
      for (const key of Object.keys(req.headers))
        if (key.startsWith("oai-") || key.startsWith("x-cove-backend")) delete req.headers[key];
      const user = users.get(req.headers["x-cove-qa-user"]);
      if (user) {
        req.headers["oai-authenticated-user-id"] = user.id;
        req.headers["oai-authenticated-user-email"] = `${user.username}@example.invalid`;
        req.headers["oai-authenticated-user-full-name"] = user.name;
      }
      next();
    });
  },
};
process.env.GUTENDEX_BASE_URL = "http://127.0.0.1:4173/__qa/catalog";
env.GUTENDEX_BASE_URL = process.env.GUTENDEX_BASE_URL;
// Framework plugins resolve aliases/routes from cwd as well as Vite's root.
// Keep every component on the same copy so React contexts cannot be duplicated.
process.chdir(scratch);
const server = await createServer({
  root: scratch,
  configFile: path.join(scratch, "vite.config.ts"),
  // Prepare the first client graph before readiness. A cold dependency rebuild
  // previously canceled @tanstack/history imports in Firefox/WebKit.
  optimizeDeps: {
    // Hydration also uses dynamic framework imports. Freeze the known client
    // dependency set so discovering one cannot rebuild assets mid-navigation.
    noDiscovery: true,
    include: [
      "@noble/hashes/sha2.js",
      "@supabase/supabase-js",
      "@supabase/ssr",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-dialog",
      "@radix-ui/react-progress",
      "@radix-ui/react-select",
      "@radix-ui/react-slider",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@supabase/supabase-js",
      "@tanstack/history",
      "@tanstack/react-query",
      "@tanstack/react-router > @tanstack/react-store",
      "@tanstack/router-core/ssr/client",
      "class-variance-authority",
      "clsx",
      "epubjs",
      "jszip",
      "lucide-react",
      "react-dom",
      "react-dom/client",
      "react",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
      "sonner",
      "tailwind-merge",
      "zod",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    warmup: {
      clientFiles: [
        "./src/router.tsx",
        "./src/routes/__root.tsx",
        "./src/features/fore/{App,Store,Book,Edition,Community,Reader}.tsx",
      ],
    },
  },
  plugins: [fixturePlugin],
});
await server.listen();
api = await server.ssrLoadModule("/src/features/fore/api.server.ts");
await invoke("/catalog?q=pride");
const zip = new JSZip();
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
zip.file(
  "META-INF/container.xml",
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
);
zip.file(
  "OPS/book.opf",
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">cove-browser-qa</dc:identifier><dc:title>Browser QA Reading Book</dc:title><dc:creator>QA Author</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
);
zip.file(
  "OPS/nav.xhtml",
  '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter 1</a></li></ol></nav></body></html>',
);
zip.file(
  "OPS/chapter.xhtml",
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head><body><h1>Chapter 1</h1><p id="passage">Browser QA passage for sharing.</p>' +
    Array.from(
      { length: 30 },
      (_, i) =>
        `<p>Reading paragraph ${i + 1}. A calm passage to test pagination, annotations, and responsive reading.</p>`,
    ).join("") +
    "</body></html>",
);
const bytes = await zip.generateAsync({ type: "uint8array" });
await env.BUCKET.put("epubs/1342.epub", bytes);
const hash = createHash("sha256").update(bytes).digest("hex");
await env.DB.prepare(
  "UPDATE asset_versions SET object_key='epubs/1342.epub',sha256=?,size_bytes=? WHERE asset_id IN (SELECT a.id FROM digital_assets a JOIN products p ON p.edition_id=a.edition_id WHERE p.source_name='gutenberg' AND p.source_external_id='1342')",
)
  .bind(hash, bytes.length)
  .run();
const client = server.environments.client;
// The framework's virtual entry imports hydration-only dependencies that the
// router graph does not reach. Prepare that graph too, before browsers arrive.
const hydrationEntry = await client.transformRequest("virtual:tanstack-start-dev-client-entry");
if (!hydrationEntry) throw new Error("Browser QA hydration entry did not transform");
await client.warmupRequest("/src/router.tsx");
await client.waitForRequestsIdle();
await Promise.all(
  Object.values(client.depsOptimizer?.metadata.discovered || {}).map(
    (dependency) => dependency.processing,
  ),
);
ready = true;
console.log("Cove isolated browser QA ready at http://127.0.0.1:4173");
if (process.env.COVE_QA_SMOKE === "1") {
  const fixture = await seed();
  console.log(JSON.stringify(fixture));
  console.log(await invoke("/social/sharing?view=received", "GET", undefined, fixture.people.bob));
  const document = await fetch("http://127.0.0.1:4173/community?tab=received");
  const html = await document.text();
  if (document.status !== 200 || !html.includes("Sign in to see your private sharing."))
    throw new Error(`Community SSR failed: ${document.status} ${html.slice(0, 500)}`);
  console.log("PASS: real Community SSR document and seeded sharing API.");
  await close();
}
async function close() {
  await server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
