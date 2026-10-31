import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyProductionOwnerBinding } from "../check-production-owner-binding.mjs";

// Provision fixed derived-job capabilities. Legal commands remain disabled.
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const account = "d26430caa63ec55f6612e32f36aca5e9";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/`;
async function api(method, path, body) {
  const form = body instanceof FormData;
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body && !form ? { "content-type": "application/json" } : {}),
    },
    body: form ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.ok(
    response.ok && result.success,
    `Literary capability provision failed: ${method} ${path} HTTP ${response.status}`,
  );
  return result.result;
}
const owner = await api("GET", "cove-legal-authority-production/settings");
verifyProductionOwnerBinding(owner);
const secretNames = ["READ", "HANDOFF", "PUBLICATION"].map(
  (role) => "COVE_LITERARY_" + role + "_SECRET",
);
const alreadyProvisioned = secretNames.every((name) =>
  owner.bindings.some((b) => b.name === name && b.type === "secret_text"),
);
const secrets = alreadyProvisioned
  ? {}
  : Object.fromEntries(
      ["READ", "HANDOFF", "PUBLICATION"].map((role) => [
        "COVE_LITERARY_" + role + "_SECRET",
        randomBytes(32).toString("hex"),
      ]),
    );
const metadata = {
  main_module: "legal-authority.mjs",
  keep_bindings: ["secret_text"],
  bindings: owner.bindings.filter(
    (b) => b.type !== "secret_text" && !["LITERARY_CONTENT_DB", "LITERARY_BUCKET"].includes(b.name),
  ),
};
for (const key of [
  "compatibility_date",
  "compatibility_flags",
  "limits",
  "logpush",
  "observability",
  "placement",
  "tail_consumers",
  "tags",
])
  if (owner[key] !== undefined) metadata[key] = owner[key];
metadata.bindings.push(
  { type: "d1", name: "LITERARY_CONTENT_DB", id: "400c3af3-5d40-41fd-83cc-98228e40ddac" },
  {
    type: "r2_bucket",
    name: "LITERARY_BUCKET",
    bucket_name: "cove-literary-originals-isolated-20261024",
  },
  ...Object.entries(secrets).map(([name, text]) => ({ type: "secret_text", name, text })),
);
const form = new FormData();
form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.set(
  "legal-authority.mjs",
  new Blob([readFileSync(".output/strangler/legal-authority.mjs", "utf8")], {
    type: "application/javascript+module",
  }),
  "legal-authority.mjs",
);
await api("PUT", "cove-legal-authority-production", form);
verifyProductionOwnerBinding(await api("GET", "cove-legal-authority-production/settings"));
for (const [worker, names] of [
  ["cove-literary-handoff-draining-20261025", ["HANDOFF"]],
  ["cove-literary-prepare-draining-20261025", ["READ"]],
  ["cove-literary-infer-isolated-disabled", ["READ"]],
  ["cove-literary-publisher-isolated-disabled", ["READ", "PUBLICATION"]],
])
  for (const role of names) {
    const name = "COVE_LITERARY_" + role + "_SECRET";
    if (alreadyProvisioned) {
      const current = await api("GET", worker + "/settings");
      assert.ok(
        current.bindings.some((b) => b.name === name && b.type === "secret_text"),
        "Incomplete earlier capability installation; do not silently rotate active credentials",
      );
    } else {
      await api("PUT", worker + "/secrets", { name, text: secrets[name], type: "secret_text" });
    }
  }
console.log(
  "PASS: separate fixed-read, bounded handoff and verified derived-profile credentials provisioned; legal owner remains disabled",
);
