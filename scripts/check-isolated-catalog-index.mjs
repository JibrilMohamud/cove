/* eslint-disable prettier/prettier -- Bounded isolated SQL fences and adversarial publication proofs are deliberately kept adjacent. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { transform } from "esbuild";

const source = fs.readFileSync("src/storefront-strangler/catalog-index-core.ts", "utf8");
const capture = fs.readFileSync("src/storefront-strangler/catalog-index-capture.server.ts", "utf8");
const worker = fs.readFileSync("src/storefront-strangler/catalog-index-capture.worker.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { normalizeCatalogIndexRow: normalize, catalogIndexWrite: write } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const row = {
  id: "2701", title: "  Moby Dick  ", summary: "  Ocean and obsession  ",
  authors_json: '[{"name":"Herman Melville"}]',
  subjects_json: '["Whaling","Fiction"]', bookshelves_json: '["Adventure"]',
  languages_json: '["en"]', rights_status: "public-domain",
  commercial_use_status: "approved", ingest_status: "active", copyright: 0,
  updated_at: "2026-10-25T12:00:00Z"
};
const doc = normalize(row, "2701", 4);
assert.equal(doc.visible, 1);
assert.equal(doc.title, "Moby Dick");
assert.equal(doc.authors, "Herman Melville");
assert.equal(doc.productId, "prd_gutenberg_2701");
assert.equal(doc.revision, 4);
assert.equal(normalize({...row, rights_status: "rejected"}, "2701", 5).visible, 0);
assert.equal(normalize({...row, ingest_status: "quarantined"}, "2701", 5).visible, 0);
assert.equal(normalize({...row, copyright: 1}, "2701", 5).visible, 0);
assert.equal(normalize(null, "2701", 5).title, "");
assert.throws(() => normalize(row, "2701", -1), /revision/);
assert.throws(() => normalize(row, "2701", 1.5), /revision/);
assert.throws(() => normalize(row, "2701';drop table", 5), /source_id/);
assert.throws(() => normalize({...row, id: "wrong"}, "2701", 5), /mismatch/);
assert.match(write(doc).sql, /excluded\.revision>catalog_index_documents\.revision/);
assert.match(capture, /withSession\("first-unconstrained"\)/);
assert.match(capture, /SELECT seq,cache_id id,operation FROM catalog_index_changefeed/);
assert.match(capture, /lease_until>\?/);
assert.doesNotMatch(capture, /UPDATE rights_grants|INSERT INTO rights_grants/);
assert.match(capture, /COVE_CATALOG_INDEX_CAPTURE_ENABLED/);
assert.match(worker, /captureIsolatedCatalogIndex/);
// Prove SQLite's actual mutation/FTS behavior, not just SQL-text presence.
const python = String.raw`
import sqlite3,sys,json
from pathlib import Path
p=json.load(sys.stdin)
source=sqlite3.connect(':memory:')
source.execute("""CREATE TABLE gutenberg_source_cache (
  id TEXT PRIMARY KEY, title TEXT, summary TEXT, authors_json TEXT,
  subjects_json TEXT, bookshelves_json TEXT, languages_json TEXT,
  formats_json TEXT, rights_status TEXT, commercial_use_status TEXT,
  ingest_status TEXT,copyright INTEGER,download_count INTEGER,
  source_id TEXT,rights_territories_json TEXT,rights_evidence_url TEXT,
  source_metadata_json TEXT DEFAULT '{}'
)""")
source.executescript(Path('drizzle/0085_isolated_catalog_changefeed.sql').read_text())
source.execute("INSERT INTO gutenberg_source_cache(id,title) VALUES('2701','Initial')")
assert source.execute('SELECT operation FROM catalog_index_changefeed').fetchall()==[('upsert',)]
source.execute("UPDATE gutenberg_source_cache SET download_count=42 WHERE id='2701'")
assert source.execute('SELECT count(*) FROM catalog_index_changefeed').fetchone()[0]==1
source.execute("UPDATE gutenberg_source_cache SET title=title WHERE id='2701'")
assert source.execute('SELECT count(*) FROM catalog_index_changefeed').fetchone()[0]==1
source.execute("UPDATE gutenberg_source_cache SET rights_status='rejected' WHERE id='2701'")
source.execute("DELETE FROM gutenberg_source_cache WHERE id='2701'")
events=source.execute('SELECT seq,operation FROM catalog_index_changefeed ORDER BY seq').fetchall()
assert len(events)==3 and [e[1] for e in events]==['upsert','upsert','delete'],events
assert events[0][0]<events[1][0]<events[2][0]
index=sqlite3.connect(':memory:')
index.executescript(Path('infra/catalog-index/0001_isolated_search.sql').read_text())
sql=p['sql']
def put(doc):
    return index.execute(sql,doc).rowcount
assert put(p['v4'])==1
assert index.execute("SELECT count(*) FROM catalog_index_fts WHERE catalog_index_fts MATCH 'Moby'").fetchone()[0]==1
assert put(p['v3'])==0
assert index.execute("SELECT title FROM catalog_index_documents WHERE product_id='prd_gutenberg_2701'").fetchone()[0]=='Moby Dick'
assert put(p['withdrawn'])==1
assert index.execute("SELECT count(*) FROM catalog_index_fts WHERE catalog_index_fts MATCH 'Moby'").fetchone()[0]==0
assert put(p['v4'])==0, 'stale retry resurrected rights-withdrawn text'
assert index.execute("SELECT visible,revision FROM catalog_index_documents").fetchone()==(0,5)
assert put(p['restored'])==1
assert index.execute("SELECT count(*) FROM catalog_index_fts WHERE catalog_index_fts MATCH 'Moby'").fetchone()[0]==1
print("PASS sqlite isolated FTS, monotonic fences, withdrawals, restoration and source changefeed")
`;
const ordered = (d) => write(d).binds;
const result = spawnSync("python3", ["-c", python], {
  input: JSON.stringify({
    sql: write(doc).sql,
    v4: ordered(doc),
    v3: ordered(normalize({...row,title:"Older title"}, "2701", 3)),
    withdrawn: ordered(normalize({...row,rights_status:"rejected"}, "2701", 5)),
    restored: ordered(normalize(row, "2701", 6))
  }),
  encoding: "utf8"
});
assert.equal(result.status,0,result.stderr || result.stdout);
console.log(result.stdout.trim());
console.log("PASS: isolated normalization refuses invalid source identity and stale revisions");
