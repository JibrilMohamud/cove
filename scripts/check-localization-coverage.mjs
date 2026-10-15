import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve("src/features/fore");
const files = fs.readdirSync(root).filter((name) => name.endsWith(".tsx"));
const keys = new Set();
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(/\b(?:tr|t)\(\s*["']([^"']+)["']\s*,/g))
    keys.add(match[1]);
}
const py = String.raw`
import sqlite3,glob,json,sys
db=sqlite3.connect(':memory:')
for f in sorted(glob.glob('drizzle/*.sql')):
 db.executescript(open(f).read())
locales=['en-US','es-ES','fr-FR','de-DE','ar-SA']
required=json.loads(sys.argv[1])
missing={}
for locale in locales:
 bundles=db.execute("SELECT id FROM ui_translation_bundles WHERE locale=? AND status='active'",(locale,)).fetchall()
 if len(bundles)!=1:
  missing[locale]=['Expected exactly one active translation bundle']
  continue
 found={x[0] for x in db.execute('SELECT message_key FROM ui_translation_messages WHERE bundle_id=?',(bundles[0][0],))}
 missing[locale]=sorted(set(required)-found)
direction=db.execute("SELECT direction FROM storefront_locales WHERE locale='ar-SA'").fetchone()
print(json.dumps({'missing':missing,'direction':direction[0] if direction else None}))
`;
const result = spawnSync("python3", ["-c", py, JSON.stringify([...keys])], {
  encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr || result.stdout);
const parsed = JSON.parse(result.stdout);
for (const [locale, missing] of Object.entries(parsed.missing))
  assert.deepEqual(missing, [], locale + " must localize every wired UI label");
assert.equal(parsed.direction, "rtl", "Arabic storefront must declare RTL direction");
console.log(
  `PASS: ${keys.size} wired reader/account/stats labels have active translations in five locales, Arabic RTL`,
);
