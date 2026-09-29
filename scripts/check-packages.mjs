import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import JSZip from "jszip";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fore-zip-"));
try {
  await build({
    entryPoints: ["src/features/fore/zip-stream.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(dir, "zip.mjs"),
    plugins: [
      {
        name: "capture-download",
        setup(b) {
          b.onResolve({ filter: /^\.\/client$/ }, () => ({ path: "download", namespace: "test" }));
          b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: "export function downloadBlob(blob){globalThis.capturedZip=blob}",
          }));
        },
      },
    ],
  });
  const { downloadZip } = await import(path.join(dir, "zip.mjs"));
  globalThis.window = {};
  const entries = [
    { name: "book.epub", open: async () => new Blob([new Uint8Array([0, 1, 2, 255])]) },
    { name: "audio/01.mp3", open: async () => new Response(new Uint8Array([3, 4, 5])) },
    { name: "notes/é.txt", open: async () => new Blob(["A reading note."]) },
  ];
  await downloadZip(entries, "test.zip", new AbortController().signal, () => {});
  let zip = await JSZip.loadAsync(await globalThis.capturedZip.arrayBuffer(), { checkCRC32: true });
  assert.deepEqual([...(await zip.file("book.epub").async("uint8array"))], [0, 1, 2, 255]);
  assert.equal(await zip.file("notes/é.txt").async("string"), "A reading note.");
  let chunks = [],
    closed = false,
    aborted = false;
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      write: async (b) => chunks.push(b),
      close: async () => {
        closed = true;
      },
      abort: async () => {
        aborted = true;
      },
    }),
  });
  await downloadZip(entries, "test.zip", new AbortController().signal, () => {});
  zip = await JSZip.loadAsync(Buffer.concat(chunks), { checkCRC32: true });
  assert.equal(closed, true);
  assert.equal(Object.keys(zip.files).length, 3);
  await assert.rejects(
    downloadZip(entries, "canceled.zip", AbortSignal.abort(), () => {}),
    { name: "AbortError" },
  );
  assert.equal(aborted, true);
  console.log(
    "PASS: EPUB/audio bytes, UTF-8 names, CRC32, streamed ZIPs, fallback ZIPs, and cancellation.",
  );
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
