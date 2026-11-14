import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { transform } from "esbuild";

// Exercise the actual TypeScript function body in a minimal isolated fixture:
// this avoids a synthetic DB masking an unnecessary service operation.
const source = readFileSync("src/features/fore/search.server.ts", "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sourceSha256 = digest(source);
const projectionSiteId = digest(JSON.stringify([
  "src/features/fore/search.server.ts",
  sourceSha256,
  "refreshSearchQualitySignals",
  "catalog_search_documents",
  "UPDATE",
  "b44b6a38f0afbbebca207293beeb8f920a9ab2f4d9429e3735fd6df1735d4846",
  1,
]));
console.log("__COVE_SYNONYM_WRITER_SOURCE__" + sourceSha256 + "__SITE__" + projectionSiteId + "__END__");
const start = source.indexOf("async function ftsExpression(");
const end = source.indexOf("\nfunction buildSqlFilters(", start);
assert.ok(start >= 0 && end > start, "Locate the real FTS expression function");
const actual = source.slice(start, end);
const fixture = `
const normalizeQuery = (s) => String(s).toLowerCase().trim();
const compactIdentifier = (s) => String(s).replace(/[^a-z0-9]/gi, "");
const isbnLike = () => false;
const queryTokens = (s) => String(s).toLowerCase().match(/[a-z]+/g) || [];
const quoteFts = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const synonyms = async (db) => {
  await db.prepare("SELECT term,synonyms_json FROM search_synonyms WHERE enabled=1").all();
  return new Map([["hello", ["hi"]]]);
};
${actual}
export { ftsExpression };
`;
const { code } = await transform(fixture, { loader: "ts", format: "esm" });
const { ftsExpression } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
let calls = 0;
const db = {
  prepare(sql) {
    assert.equal(sql, "SELECT term,synonyms_json FROM search_synonyms WHERE enabled=1");
    calls += 1;
    return { all: async () => ({ results: [] }) };
  },
};
assert.equal(await ftsExpression(db, { query: "", topic: undefined }), "");
assert.equal(calls, 0, "Anonymous empty query must perform zero synonym D1 reads");
assert.equal(await ftsExpression(db, { query: "   ", topic: "science" }), 'categories_text : "science"*');
assert.equal(calls, 0, "Topic-only query must not fetch synonyms for absent query tokens");
const withTerms = await ftsExpression(db, { query: "hello" });
assert.match(withTerms, /"hello"/);
assert.match(withTerms, /"hi"/);
assert.equal(calls, 1, "Real text query must still expand synonyms as before");
console.log("PASS: guest and topic-only browse eliminate optional D1 synonym read; typed text retains expansion");
