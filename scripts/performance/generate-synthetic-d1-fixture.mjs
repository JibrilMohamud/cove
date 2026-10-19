// Deterministic public synthetic catalog ONLY. Never export/copy production D1.
// Generate import-sized SQL chunks for fresh, already migrated isolated D1s.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const total = Number(process.env.COVE_SYNTHETIC_BOOKS || 50000);
const chunk = Number(process.env.COVE_SYNTHETIC_CHUNK || 1000);
assert.ok(Number.isSafeInteger(total) && total >= 40000 && total <= 65000);
assert.ok(Number.isSafeInteger(chunk) && chunk >= 100 && chunk <= 1000);
const outDir = process.argv[2] || "artifacts/perf-synthetic-fixture";
fs.mkdirSync(outDir, { recursive: true });
const ts = "2026-10-01T00:00:00.000Z";
const str = (v) => "'" + String(v).replaceAll("'", "''") + "'";
// Cloudflare D1 rejects a single 1,000-row literal INSERT as SQLITE_TOOBIG.
// Bound each statement separately while retaining restart-safe 1k-row files.
const INSERT_ROWS_PER_STATEMENT = 65;
const emitRows = (table, fields, values, numeric = false) => {
  const chunks = [];
  for (let i = 0; i < values.length; i += INSERT_ROWS_PER_STATEMENT) {
    const part = values.slice(i, i + INSERT_ROWS_PER_STATEMENT);
    chunks.push(
      `INSERT OR IGNORE INTO ${table}(${fields.join(",")}) VALUES ${part
        .map(
          (v) =>
            "(" +
            v.map((x) => (numeric && typeof x === "number" ? String(x) : str(x))).join(",") +
            ")",
        )
        .join(",")};\n`,
    );
  }
  return chunks.join("");
};
const rows = (table, fields, values) => emitRows(table, fields, values);
const numericRows = (table, fields, values) => emitRows(table, fields, values, true);
const id = (n) => "perf-synth-" + String(n).padStart(6, "0");
const inserts = [];
const seed = [
  rows(
    "publishers",
    ["id", "name", "created_at", "updated_at"],
    [["perf-publisher", "Synthetic Benchmark Press", ts, ts]],
  ).replace("INSERT INTO", "INSERT OR IGNORE INTO"),
  rows(
    "rights_parties",
    ["id", "display_name", "party_type", "status", "created_at", "updated_at"],
    [["perf-party", "Synthetic Test-Only Licensor", "publisher", "active", ts, ts]],
  ).replace("INSERT INTO", "INSERT OR IGNORE INTO"),
  rows(
    "storefront_markets",
    [
      "country_code",
      "display_name",
      "default_locale",
      "default_currency",
      "market_status",
      "created_at",
      "updated_at",
    ],
    [
      ["US", "United States", "en-US", "USD", "active", ts, ts],
      ["CA", "Canada", "en-CA", "CAD", "active", ts, ts],
    ],
  ).replace("INSERT INTO", "INSERT OR IGNORE INTO"),
  rows(
    "storefront_market_locales",
    ["country_code", "locale", "priority", "active"],
    [
      ["US", "en-US", 1, 1],
      ["CA", "en-CA", 1, 1],
    ],
  ).replace("INSERT INTO", "INSERT OR IGNORE INTO"),
].join("");
const firstName = path.join(outDir, "0000-seed.sql");
fs.writeFileSync(firstName, seed);
inserts.push(firstName);
for (let from = 1; from <= total; from += chunk) {
  const to = Math.min(total, from + chunk - 1);
  const numberRange = Array.from({ length: to - from + 1 }, (_, k) => k + from);
  const work = numberRange.map((n) => [id(n), "Synthetic Performance Book " + n, ts, ts]);
  const ed = numberRange.map((n) => [
    id(n),
    id(n),
    "perf-publisher",
    "Synthetic Performance Book " + n,
    "none",
    "available",
    ts,
    ts,
  ]);
  const prod = numberRange.map((n) => [
    id(n),
    id(n),
    "PERF-" + n,
    "ebook",
    n % 113 === 0 ? "draft" : "active",
    "gutenberg",
    id(n),
    ts,
    ts,
  ]);
  const asset = numberRange.map((n) => ["perf-asset-" + n, id(n), "epub", "none", ts, ts]);
  const lang = numberRange.map((n) => [id(n), n % 9 === 0 ? "fr" : "en", "content"]);
  const grants = numberRange.map((n) => [
    "perf-grant-" + n,
    id(n),
    "perf-publisher",
    "perf-party",
    "US",
    "ebook",
    "retail",
    "licensed",
    n % 103 === 0 ? "deny" : "allow",
    n % 97 === 0 ? "revoked" : "active",
    ts,
    ts,
  ]);
  const ca = numberRange
    .filter((n) => n % 31 === 0)
    .map((n) => [
      "perf-ca-" + n,
      id(n),
      "perf-publisher",
      "perf-party",
      "CA",
      "ebook",
      "retail",
      "licensed",
      "allow",
      "active",
      ts,
      ts,
    ]);
  // A separate negative grant overrules an otherwise live allow; never
  // collapse deny/revoke into a stale or preapproved authorization snapshot.
  const deny = numberRange
    .filter((n) => n % 107 === 0)
    .map((n) => [
      "perf-deny-" + n,
      id(n),
      "perf-publisher",
      "perf-party",
      "US",
      "ebook",
      "retail",
      "licensed",
      "deny",
      "active",
      ts,
      ts,
    ]);
  const docs = numberRange.map((n) => [
    id(n),
    id(n),
    "Synthetic Performance Book " + n,
    ts,
    ts,
    (n * 17) % 300,
    n % 9 === 0 ? "fr" : "en",
    n % 31 === 0 ? "CAD" : "USD",
    0,
    "available",
    0,
  ]);
  const lines = [
    rows("works", ["id", "title", "created_at", "updated_at"], work),
    rows(
      "editions",
      [
        "id",
        "work_id",
        "publisher_id",
        "title",
        "drm_status",
        "release_status",
        "created_at",
        "updated_at",
      ],
      ed,
    ),
    rows(
      "products",
      [
        "id",
        "edition_id",
        "sku",
        "format",
        "storefront_status",
        "source_name",
        "source_external_id",
        "created_at",
        "updated_at",
      ],
      prod,
    ),
    rows(
      "digital_assets",
      ["id", "edition_id", "kind", "drm_status", "created_at", "updated_at"],
      asset,
    ),
    rows("edition_languages", ["edition_id", "language_code", "kind"], lang),
    numericRows(
      "catalog_search_documents",
      [
        "product_id",
        "external_book_id",
        "title",
        "first_ingested_at",
        "updated_at",
        "download_count",
        "languages_text",
        "currency",
        "price_minor",
        "availability",
        "suppressed",
      ],
      docs,
    ),
    rows(
      "rights_grants",
      [
        "id",
        "edition_id",
        "rightsholder_id",
        "rightsholder_party_id",
        "territory_code",
        "format",
        "sales_channel",
        "license_type",
        "decision",
        "status",
        "created_at",
        "updated_at",
      ],
      grants,
    ),
    ...(ca.length
      ? [
          rows(
            "rights_grants",
            [
              "id",
              "edition_id",
              "rightsholder_id",
              "rightsholder_party_id",
              "territory_code",
              "format",
              "sales_channel",
              "license_type",
              "decision",
              "status",
              "created_at",
              "updated_at",
            ],
            ca,
          ),
        ]
      : []),
    ...(deny.length
      ? [
          rows(
            "rights_grants",
            [
              "id",
              "edition_id",
              "rightsholder_id",
              "rightsholder_party_id",
              "territory_code",
              "format",
              "sales_channel",
              "license_type",
              "decision",
              "status",
              "created_at",
              "updated_at",
            ],
            deny,
          ),
        ]
      : []),
  ];
  const name = path.join(
    outDir,
    String(Math.floor((from - 1) / chunk) + 1).padStart(4, "0") + "-books.sql",
  );
  fs.writeFileSync(name, lines.join(""));
  inserts.push(name);
}
const manifest = {
  syntheticOnly: true,
  generatedAt: ts,
  documents: total,
  chunkSize: chunk,
  files: inserts.map((f) => ({ name: path.basename(f), bytes: fs.statSync(f).size })),
};
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(
  "PASS: " +
    total +
    " deterministic synthetic documents across " +
    inserts.length +
    " SQL files; no production export",
);
