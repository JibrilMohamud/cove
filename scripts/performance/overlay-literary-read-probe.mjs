// Apply identical, temporary read-only adaptation AFTER Git SHA verification.
// Do not mutate the live D1 database with synthetic recommendation impressions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const baseline = path.resolve(root, "../baseline/src/server.ts");
const candidate = path.resolve(root, "src/server.ts");
const anchor =
  "      const ingestionControl = await handleVercelIngestionControl(request, foreEnv);";
const original = fs.readFileSync(baseline, "utf8");
assert.equal(original, fs.readFileSync(candidate, "utf8"));
assert.equal(original.split(anchor).length, 2);
// The generated source is a deliberately exact TS fixture, not a formatted JS value.
// prettier-ignore
const extension = "      // STAGING_ONLY_LITERARY_READ_PROBE: identical in both benchmark builds.\n      // Never included in committed production application source.\n      if (\n        staging &&\n        request.method === \"GET\" &&\n        new URL(request.url).pathname === \"/api/fore/benchmark/literary-candidates\"\n      ) {\n        const country = request.headers.get(\"x-cove-client-country\") || \"\";\n        if (!/^[A-Z]{2}$/.test(country))\n          return new Response(\"Unverified country\", { status: 503 });\n        const term = new URL(request.url).searchParams.get(\"term\") || \"\";\n        if (![\"friendship\", \"reflective\", \"mystery\"].includes(term))\n          return new Response(\"Invalid bounded probe term\", { status: 400 });\n        const { retrieveLiteraryCandidates } = await import(\n          \"./features/fore/discovery-intelligence.server\"\n        );\n        const terms = [\n          \"genres\",\n          \"themes\",\n          \"moods\",\n          \"literaryStyle\",\n          \"geography\",\n          \"sensoryAtmosphere\",\n        ].map((dimension) => ({ dimension, feature: term, confidence: 1 }));\n        const started = performance.now();\n        const ids = await retrieveLiteraryCandidates(foreEnv.DB, terms, country);\n        const hash = await crypto.subtle.digest(\n          \"SHA-256\",\n          new TextEncoder().encode([...ids].sort().join(\",\")),\n        );\n        const digest = [...new Uint8Array(hash)]\n          .map((byte) => byte.toString(16).padStart(2, \"0\"))\n          .join(\"\");\n        return stageNoStore(\n          new Response(\n            JSON.stringify({\n              schema: \"cove-stage-literary-rights-read-v1\",\n              count: ids.length,\n              fingerprint: digest,\n              rightsSource: \"primary-d1-live\",\n            }),\n            {\n              status: 200,\n              headers: {\n                \"content-type\": \"application/json; charset=utf-8\",\n                \"server-timing\": \"cove_literary_read;dur=\" + (performance.now() - started).toFixed(1),\n                \"x-content-type-options\": \"nosniff\",\n              },\n            },\n          ),\n          true,\n        );\n      }\n";
const patched = original.replace(anchor, extension + anchor);
fs.writeFileSync(baseline, patched);
fs.writeFileSync(candidate, patched);
const digest = (x) => createHash("sha256").update(x).digest("hex");
process.stdout.write(
  JSON.stringify({
    stageOnly: true,
    identicalOriginalSourceSha256: digest(original),
    identicalPatchedSourceSha256: digest(patched),
  }) + "\n",
);
