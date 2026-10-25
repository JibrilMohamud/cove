/* eslint-disable prettier/prettier -- Keep bounded token fencing and executable SQLite race proof together. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { transform } from "esbuild";

const source = fs.readFileSync("src/features/fore/search-outbox-ack.ts", "utf8");
const caller = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { searchOutboxAcknowledgement: acknowledge } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
for (const bad of [
  [], Array(501).fill({ product_id: "x", change_token: "t" }),
  [{ product_id: "", change_token: "t" }],
  [{ product_id: "a", change_token: "" }],
  [{ product_id: "a", change_token: undefined }],
]) assert.throws(() => acknowledge(bad));

const sql = acknowledge([
  { product_id: "p-old", change_token: "t1" },
  { product_id: "p-new", change_token: "t1" },
  { product_id: "p-inject'); DROP TABLE search_index_outbox; --", change_token: "t1" },
]);
assert.match(sql.sql, /^DELETE FROM search_index_outbox/);
assert.equal(sql.binds.length, 6);
assert.match(sql.sql, /WHERE \(product_id,change_token\) IN \(VALUES/);
assert.ok(!sql.sql.includes("DROP TABLE"));
assert.equal(acknowledge(Array(500).fill({ product_id: "a", change_token: "t" })).binds.length, 1000);
assert.match(caller, /await env\.DB\.prepare\(ack\.sql\)\s*\.bind\(\.\.\.ack\.binds\)\s*\.run\(\)/);
assert.doesNotMatch(caller, /pending\.results\.map\(\(row:.*change_token/);

const python = String.raw`
import sqlite3,sys,json
case=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.execute('CREATE TABLE search_index_outbox(product_id TEXT PRIMARY KEY,change_token TEXT NOT NULL)')
rows=[
 ('p-old','t1'), ('p-new','t2'), ('p-not-acked','t1'),
 ("p-inject'); DROP TABLE search_index_outbox; --",'t1')
]
db.executemany('INSERT INTO search_index_outbox VALUES(?,?)',rows)
cursor=db.execute(case['sql'],case['binds'])
assert cursor.rowcount==2, cursor.rowcount
rem=db.execute('SELECT product_id,change_token FROM search_index_outbox ORDER BY product_id').fetchall()
assert rem==[('p-new','t2'),('p-not-acked','t1')], rem
# Retry of same old acknowledgement is idempotent.
assert db.execute(case['sql'],case['binds']).rowcount==0
assert db.execute('SELECT count(*) FROM search_index_outbox').fetchone()[0]==2
print('PASS: exact fenced acknowledgements, replaced token survives, SQL injection is data, replay safe')
`;
const result = spawnSync("python3", ["-c", python], {
  encoding: "utf8",
  input: JSON.stringify(sql),
});
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(result.stdout.trim());
console.log("PASS: bounded single-statement generation and caller wiring");
