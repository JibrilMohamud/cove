import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PRIVILEGED_JOBS = [
  ["continuous-publication-qa", "private-qa"],
  ["literary-activation-readiness", "protected-activation-readonly"],
  ["verify-production-disabled-owner-handshake", "verify-disabled-owner"],
];

export function verifySecretJobGuard(source, name) {
  const on = source.match(/^on:\n([\s\S]*?)(?=^permissions:)/m)?.[1];
  assert.ok(on, "Explicit events missing");
  assert.match(on, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(on, /^  push:/m, "Source push cannot access a broad token");
  assert.doesNotMatch(
    on,
    /^  schedule:/m,
    "This unscheduled workflow cannot obtain a scheduled broad token",
  );
  for (const input of [
    "reviewed_main_sha:",
    "confirm_protected_cloudflare_action:",
    "default: false",
  ]) {
    assert.ok(on.includes(input), "Missing manual authorization input: " + input);
  }
  const first = source.indexOf("  " + name + ":\n");
  assert.ok(first > 0, "Guarded job missing");
  const trailing = source.slice(first);
  const next = trailing.search(/\n  [a-z][a-z-]+:\n/);
  const job = next < 0 ? trailing : trailing.slice(0, next);
  const admission = job.match(/^    if: >-\n([\s\S]*?)(?=^    runs-on:)/m)?.[1];
  assert.ok(admission, "Missing explicit reviewed admission gate");
  for (const clause of [
    "github.repository == 'JibrilMohamud/cove'",
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    "inputs.confirm_protected_cloudflare_action == true",
    "inputs.reviewed_main_sha == github.sha",
  ]) {
    assert.ok(admission.includes(clause), "Missing gate: " + clause);
  }
  assert.match(job, /^    environment: cove-production-release-audit\s*$/m);
  // The reviewed literary audit now uses TWO independent provider-enforced
  // read-only credentials. Other protected consumer jobs retain the existing
  // broad-token inventory check until their own separately reviewed cutover.
  const credentials =
    name === "protected-activation-readonly"
      ? [
          "secrets.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN",
          "secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN",
        ]
      : ["secrets.CLOUDFLARE_API_TOKEN"];
  if (name === "protected-activation-readonly")
    assert.ok(
      !job.includes("secrets.CLOUDFLARE_API_TOKEN"),
      "Read-only literary audit must never receive the broad deployment token",
    );
  for (const credential of credentials) {
    assert.ok(job.includes(credential), "Protected job missing reviewed credential: " + credential);
    assert.ok(
      job.indexOf("environment: cove-production-release-audit") < job.indexOf(credential),
    );
  }
  assert.match(source, /^permissions:\n  contents: read\s*$/m);
  return true;
}

function mutateJob(source, name, original, replacement) {
  const first = source.indexOf("  " + name + ":\n");
  assert.ok(first > 0);
  const rest = source.slice(first),
    next = rest.search(/\n  [a-z][a-z-]+:\n/);
  const end = next < 0 ? source.length : first + next;
  const body = source.slice(first, end);
  assert.ok(body.includes(original), "Missing mutation target: " + original);
  return source.slice(0, first) + body.replace(original, replacement) + source.slice(end);
}

for (const [stem, name] of PRIVILEGED_JOBS) {
  const source = readFileSync(".github/workflows/" + stem + ".yml", "utf8");
  assert.equal(verifySecretJobGuard(source, name), true, stem);
  const withPush = source.replace("  workflow_dispatch:", "  push:");
  assert.notEqual(withPush, source);
  assert.throws(() => verifySecretJobGuard(withPush, name));
  const withSchedule = source.replace(
    "  workflow_dispatch:",
    "  schedule:\n    - cron: '17 * * * *'\n  workflow_dispatch:",
  );
  assert.notEqual(withSchedule, source);
  assert.throws(() => verifySecretJobGuard(withSchedule, name));
  for (const [from, to] of [
    ["    environment: cove-production-release-audit\n", ""],
    ["github.event_name == 'workflow_dispatch'", "github.event_name == 'schedule'"],
    ["github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/staging'"],
    ["inputs.confirm_protected_cloudflare_action == true", "true"],
    ["inputs.reviewed_main_sha == github.sha", "true"],
  ]) {
    const modified = mutateJob(source, name, from, to);
    assert.notEqual(modified, source);
    assert.throws(() => verifySecretJobGuard(modified, name));
  }
  if (name === "protected-activation-readonly") {
    for (const credential of [
      "secrets.COVE_CF_PRODUCTION_AUDIT_READ_TOKEN",
      "secrets.COVE_CF_WORKERS_METADATA_READ_TOKEN",
    ]) {
      const missing = mutateJob(source, name, credential, "secrets.CLOUDFLARE_API_TOKEN");
      assert.throws(
        () => verifySecretJobGuard(missing, name),
        "Returning either read-only role to broad token must be rejected",
      );
    }
  }
}
console.log(
  "PASS: three unscheduled Cloudflare consumers require protected manual-only token access",
);
