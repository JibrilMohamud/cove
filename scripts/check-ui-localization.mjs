import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const root = "src/features/fore/";
const locales = ["en-US", "es-ES", "fr-FR", "de-DE", "ar-SA"];
const catalogs = Object.fromEntries(
  locales.map((locale) => [
    locale,
    JSON.parse(fs.readFileSync(`${root}locales/${locale}.json`, "utf8")),
  ]),
);
const keys = Object.keys(catalogs["en-US"]).sort();
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
for (const locale of locales) {
  assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys, `${locale}: complete catalog`);
  for (const key of keys) {
    const value = catalogs[locale][key];
    assert.ok(value.trim(), `${locale}: empty ${key}`);
    assert.deepEqual(placeholders(value), placeholders(key), `${locale}: placeholders in ${key}`);
  }
}
const invariant = new Set(["Aa", "px", "@username", "MB ·"]);
const surfaces = [
  "Stats",
  "Reader",
  "ReaderSoundtrack",
  "Community",
  "Collections",
  "Audio",
  "Sharing",
  "Auth",
  "RequestFailure",
];
for (const file of surfaces) {
  const path = `${root}${file}.tsx`,
    source = fs.readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      assert.ok(
        !/[A-Za-z]{2}/.test(text) || invariant.has(text),
        `${file}: untranslated visible text: ${text}`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "ui" &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      assert.ok(
        catalogs["en-US"][node.arguments[0].text],
        `${file}: missing UI phrase ${node.arguments[0].text}`,
      );
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(tree);
      if (
        ["aria-label", "placeholder", "title", "empty"].includes(name) &&
        ts.isStringLiteral(node.initializer)
      )
        assert.ok(
          !/[A-Za-z]{2}/.test(node.initializer.text) ||
            invariant.has(node.initializer.text) ||
            (file === "Auth" &&
              name === "placeholder" &&
              ["your_reading_name", "you@example.com"].includes(node.initializer.text)),
          `${file}: untranslated ${name}`,
        );
      if (
        name === "source" &&
        ts.isJsxSelfClosingElement(node.parent) &&
        node.parent.tagName.getText(tree) === "UiText" &&
        ts.isStringLiteral(node.initializer)
      )
        assert.ok(
          catalogs["en-US"][node.initializer.text],
          `${file}: missing rich UI phrase ${node.initializer.text}`,
        );
      if (["value", "className", "id", "href", "type"].includes(name))
        assert.ok(
          !/^\{ui\(/.test(node.initializer.getText(tree)),
          `${file}: translation must not change machine attribute ${name}`,
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
console.log(
  `PASS: ${keys.length} UI phrases in five locales, placeholder parity, no raw JSX labels in ${surfaces.length} reading/social/auth/recovery surfaces, stable machine attributes.`,
);
