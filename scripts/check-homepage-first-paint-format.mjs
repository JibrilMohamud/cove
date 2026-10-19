import assert from "node:assert/strict";
import { build } from "esbuild";
async function bundle(file) {
  const built = await build({
    entryPoints: [file], bundle: true, platform: "node", format: "esm", write: false,
  });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}
const { formatHomepageFirstPaintPage } = await bundle(
  "src/features/fore/homepage-first-paint-format.server.ts",
);
const { formatGenericStorefrontPageRecord } = await bundle(
  "src/features/fore/taxonomy.server.ts",
);
const rows = [
  null,
  {
    path: "/", page_type: "home", title: "Tailored",
    heading: "Bookstore", eyebrow: null, description: "Books",
    seo_title: "Custom", seo_description: null, noindex: 0,
    query_json: '{"sort":"popular","language":"en"}',
  },
  {
    path: "/", page_type: "category", title: "Page",
    heading: null, noindex: 1, query_json: "malformed{",
  },
  {
    path: "/", page_type: "home", title: "Page",
    heading: "Good books", noindex: 0, query_json: '["not an object"]',
  },
];
for (const row of rows)
  assert.deepEqual(
    formatHomepageFirstPaintPage(row),
    formatGenericStorefrontPageRecord("/", row),
    "Homepage formatter must retain exactly the existing CMS/root presentation contract",
  );
console.log("Homepage first-paint presentation format matches canonical taxonomy path PASS");
