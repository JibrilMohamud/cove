import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fore-biosync-"));
await build({
  entryPoints: ["src/features/fore/biosync.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(folder, "biosync.mjs"),
  logLevel: "silent",
});
const { compareCfi, wordAtAudio, wordAtText } = await import(path.join(folder, "biosync.mjs"));
const words = [
  {
    cfi: "epubcfi(/6/6!/4/2/2/1:0)",
    endCfi: "epubcfi(/6/6!/4/2/2/1:6)",
    href: "poem.xhtml",
    text: "dreary",
    start: 21.72,
    end: 22.2,
    wordIndex: 10,
    probability: 0.96,
  },
  {
    cfi: "epubcfi(/6/6!/4/2/2/1:7)",
    endCfi: "epubcfi(/6/6!/4/2/2/1:12)",
    href: "poem.xhtml",
    text: "while",
    start: 23.04,
    end: 23.36,
    wordIndex: 11,
    probability: 0.94,
  },
  {
    cfi: "epubcfi(/6/6!/4/2/2/1:20)",
    endCfi: "epubcfi(/6/6!/4/2/2/1:26)",
    href: "poem.xhtml",
    text: "pondered",
    start: 28,
    end: 28.5,
    wordIndex: 15,
    probability: 0.91,
  },
];
const map = {
  version: 2,
  status: "checked",
  trackId: "01",
  epubSha256: "a".repeat(64),
  audioSha256: "b".repeat(64),
  duration: 60,
  engine: "test",
  words,
  verification: {
    method: "independent-asr-exact-text",
    automatic: true,
    minWordProbability: 0.72,
    matchedWords: 3,
    spokenWords: 3,
    coverage: 1,
    checkedAt: new Date().toISOString(),
  },
};
assert.equal(wordAtAudio(map, 10), null, "an unmatched introduction must not hand off");
assert.equal(
  wordAtAudio(map, 22.7),
  words[0],
  "a sub-second pause between consecutive words stays on the checked passage",
);
assert.equal(wordAtAudio(map, 25), null, "long or discontinuous gaps must not be interpolated");
assert.equal(wordAtText(map, "epubcfi(/6/6!/4/2/2/1:4)"), words[0]);
assert.equal(
  wordAtText(map, "epubcfi(/6/6!/4/2/2/1:18)"),
  null,
  "unmatched text must not produce an audio guess",
);
assert(compareCfi("epubcfi(/6/6!/4/2/2/1:7)", "epubcfi(/6/6!/4/2/2/1:20)") < 0);
assert.equal(
  compareCfi("epubcfi(/6/6[id]!/4/2/2/1:7)", "epubcfi(/6/6!/4/2/2/1:7)"),
  0,
  "CFI assertions do not change position ordering",
);
console.log(
  "PASS: checked-word handoff, introduction/gap exclusion, text lookup, and CFI ordering.",
);
fs.rmSync(folder, { recursive: true, force: true });
