import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const script = readFileSync("scripts/staging/certify-literary-remote-synthetic-journey.mjs","utf8");
const workflow = readFileSync(".github/workflows/literary-remote-staging-e2e.yml","utf8");
for(const token of [
  "24c0eda2-6a43-4d7e-b787-502745d4d781",
  "fce5742c-29ca-4bc3-85da-e174dd9bf42e",
  "cove-literary-cutover-qa-objects-20261024",
  "canonicalOwnerDrainDenied: true",
  "publisherServiceBindingEmulated: true",
  "productionTouched: false",
  "runIsolatedLiteraryPreparationTick",
  "runIsolatedLiteraryInferenceTick",
  "publishOnePrivateLiteraryInference",
  "canonicalRevision: canonical.revision",
]) assert.ok(script.includes(token), "Stage flow absent: " + token);
for(const id of [
  "4bd657ac-8789-403e-a28c-93aba8d0a989",
  "400c3af3-5d40-41fd-83cc-98228e40ddac",
  "cove-production-media",
  "cove-literary-originals-isolated-20261024",
]) assert.ok(!script.includes(id), "Production data-plane reference forbidden");
assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
assert.ok(workflow.includes("needs: static-synthetic-only"));
assert.ok(workflow.includes("persist-credentials: false"));
assert.ok(workflow.includes("cancel-in-progress: false"));
assert.ok(workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
console.log("LITERARY_REMOTE_QA_CONTAINMENT_PASS no primary production bindings, synthetic staged assets");
