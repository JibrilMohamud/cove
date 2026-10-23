// Only entirely original QA media is generated and uploaded to the dedicated
// private R2 bucket. NEVER read production EPUB/audio or user uploads.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";

const bucket = "cove-commerce-original-media-qa-20261022";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, "d26430caa63ec55f6612e32f36aca5e9");
assert.ok(process.env.CLOUDFLARE_API_TOKEN);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cove-original-qa-"));
const zip = new JSZip();
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
zip.file(
  "META-INF/container.xml",
  '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
);
zip.file(
  "book.opf",
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:cove-original-qa-2026</dc:identifier><dc:title>Cove Synthetic QA Edition</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
);
zip.file(
  "chapter.xhtml",
  '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Original synthetic chapter</title></head><body><p>Original synthetic content for Cove sandbox fulfillment validation.</p></body></html>',
);
const epub = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
const frames = 8000 * 3,
  sampleRate = 8000;
const wav = Buffer.alloc(44 + frames * 2);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
wav.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++)
  wav.writeInt16LE(Math.round(Math.sin((i * Math.PI * 2 * 440) / sampleRate) * 9500), 44 + i * 2);
const assets = [
  {
    name: "epub",
    key: "original-fixtures/cove-synthetic-qa.epub",
    data: epub,
    type: "application/epub+zip",
  },
  { name: "audio", key: "original-fixtures/cove-synthetic-tone.wav", data: wav, type: "audio/wav" },
];
for (const asset of assets) {
  const filename = path.join(out, asset.name === "epub" ? "original.epub" : "original.wav");
  fs.writeFileSync(filename, asset.data);
  const proc = spawnSync(
    "npm",
    [
      "exec",
      "--yes",
      "--package=wrangler@4.151.0",
      "--",
      "wrangler",
      "r2",
      "object",
      "put",
      bucket + "/" + asset.key,
      "--remote",
      "--file",
      filename,
      "--content-type",
      asset.type,
    ],
    {
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
      encoding: "utf8",
      timeout: 120000,
    },
  );
  if (proc.status !== 0) throw Error("QA original-media R2 upload failed for " + asset.name);
  // Never certify uploads just because Wrangler exited 0. Read back the
  // *remote* private R2 object and compare its bytes with the original.
  const verified = path.join(out, "r2-verified-" + asset.name);
  const read = spawnSync(
    "npm",
    [
      "exec",
      "--yes",
      "--package=wrangler@4.151.0",
      "--",
      "wrangler",
      "r2",
      "object",
      "get",
      bucket + "/" + asset.key,
      "--remote",
      "--file",
      verified,
    ],
    {
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
      encoding: "utf8",
      timeout: 120000,
    },
  );
  assert.equal(read.status, 0, "Remote QA R2 readback failed for " + asset.name);
  assert.ok(fs.readFileSync(verified).equals(asset.data), "Remote QA R2 bytes differ");
}
const report = assets.map((a) => ({
  kind: a.name,
  bucket,
  objectKey: a.key,
  sha256: createHash("sha256").update(a.data).digest("hex"),
  sizeBytes: a.data.length,
  mimeType: a.type,
}));
fs.mkdirSync("artifacts/deployed-commerce", { recursive: true });
fs.writeFileSync(
  "artifacts/deployed-commerce/original-media.json",
  JSON.stringify(report, null, 2),
);
console.log(
  "PASS: original synthetic QA EPUB and WAV in separate private R2; checksum evidence preserved.",
);
