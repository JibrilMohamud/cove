import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
const file = process.argv[2];
if (!file || fs.statSync(file).size > 450000)
  throw new Error("One bounded audio report is required");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-audio-boundary-"));
try {
  const output = path.join(root, "music-profile.mjs");
  await build({
    entryPoints: ["src/features/fore/music-profile.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { validateMusicReport } = await import(output);
  const report = validateMusicReport(JSON.parse(fs.readFileSync(file, "utf8")));
  console.log(
    JSON.stringify({
      validated: true,
      policy: report.policy,
      sourceSha1: report.sourceSha1,
      durationSeconds: report.durationSeconds,
      semanticWindows: report.semantics?.windows.length || 0,
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
