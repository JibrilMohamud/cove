import { readFileSync, writeFileSync } from "node:fs";
import { prepareCurrentLegalOwnerPublication } from "./prepare-current-legal-owner-publication.mjs";
const [captureFile, reviewFile, trustFile, generationText, outputFile] = process.argv.slice(2);
if (
  !captureFile ||
  !reviewFile ||
  !trustFile ||
  !outputFile ||
  !/^[1-9][0-9]*$/.test(generationText || "")
)
  throw Error(
    "Usage: node prepare-current-legal-owner-publication.local.mjs CAPTURE REVIEW TRUST GENERATION OUTPUT",
  );
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const result = prepareCurrentLegalOwnerPublication({
  capture: read(captureFile),
  review: read(reviewFile),
  trust: read(trustFile),
  generation: Number(generationText),
  nowMs: Date.now(),
});
writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(
  "Prepared nonauthorizing publication batches; independent publisher and reviewer signatures remain required.",
);
