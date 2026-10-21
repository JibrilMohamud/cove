import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const dir = fs.mkdtempSync(path.join(process.cwd(), ".cove-home-prefetch-"));
const sqlite = new DatabaseSync(":memory:");
try {
  await build({
    entryPoints: ["src/features/fore/taxonomy.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(dir, "page.mjs"),
    packages: "external",
    logLevel: "silent",
  });
  const {
    resolveStorefrontPage,
    prefetchAnonymousHomepageCandidates,
    resolvePrefetchedAnonymousHomepage,
  } = await import(path.join(dir, "page.mjs"));
  sqlite.exec(`CREATE TABLE storefront_pages (
    id TEXT PRIMARY KEY, path TEXT, status TEXT, territory_code TEXT,
    language_code TEXT, starts_at TEXT, ends_at TEXT, page_type TEXT,
    title TEXT, heading TEXT, eyebrow TEXT, description TEXT,
    seo_title TEXT, seo_description TEXT, noindex INTEGER, query_json TEXT
  );`);
  let reads = 0;
  const db = {
    prepare(sql) {
      assert.ok(/^SELECT/i.test(sql.trim()), "Homepage prefetch must never write D1");
      reads++;
      const q = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() {
              return q.get(...params) || null;
            },
            async all() {
              return { results: q.all(...params) };
            },
          };
        },
      };
    },
  };
  async function parity(territory, language, locale) {
    const candidates = await prefetchAnonymousHomepageCandidates(db, territory);
    const optimized = await resolvePrefetchedAnonymousHomepage(
      db,
      candidates,
      territory,
      language,
      locale,
    );
    const original = await resolveStorefrontPage(db, "/", territory, language, locale);
    assert.deepEqual(optimized, original, "No localization/merchandising/page regression");
  }
  const insert = sqlite.prepare(
    "INSERT INTO storefront_pages VALUES(?, '/', 'published', ?, ?, NULL, NULL," +
      " 'campaign', ?, ?, 'Featured', 'Hand-picked', ?, ?, 0, ?)",
  );
  await parity("US", "en", "en-US"); // no published homepage
  insert.run(
    "us_en",
    "US",
    "en",
    "US-English",
    "US-English",
    "US-SEO",
    "US-summary",
    '{"sort":"popular"}',
  );
  await parity("US", "en", "en-US");
  await parity("US", "fr", "fr-FR"); // only one row but wrong language, defaults
  await parity("AU", "en", "en-AU"); // only US page, defaults
  insert.run(
    "us_fr",
    "US",
    "fr",
    "US-French",
    "US-French",
    "US-fr",
    "French summary",
    '{"sort":"new"}',
  );
  await parity("US", "en", "en-US"); // multiple candidates; exact SQL fallback
  await parity("US", "fr", "fr-FR");
  sqlite.prepare("UPDATE storefront_pages SET ends_at='2000-01-01' WHERE id='us_fr'").run();
  await parity("US", "en", "en-US"); // expired definitions excluded
  sqlite.prepare("UPDATE storefront_pages SET status='archived' WHERE id='us_en'").run();
  await parity("US", "en", "en-US"); // withdrawn page not served
  await assert.rejects(
    prefetchAnonymousHomepageCandidates(db, "ZZZ"),
    /Invalid homepage territory/,
  );
  assert.ok(reads >= 18);
  console.log(
    "Anonymous home page prefetch: no/one/ambiguous/wrong-locale/wrong-country/expired/archived parity passed.",
  );
} finally {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
