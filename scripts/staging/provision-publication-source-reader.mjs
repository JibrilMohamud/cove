import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyProductionOwnerBinding } from "../check-production-owner-binding.mjs";

// Main-only installer. Keep every existing production binding and disable flag.
// This grants only the bounded public advisory reads; never enables legal commands.
const account = "d26430caa63ec55f6612e32f36aca5e9";
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.ok(token, "Cloudflare deployment authorization is required");
const base = "https://api.cloudflare.com/client/v4/accounts/" + account + "/workers/scripts/";
async function api(method, path, body) {
  const form = body instanceof FormData;
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(form || body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.ok(
    response.ok && result.success,
    "Source reader provisioning failed: " + method + " " + path + " HTTP " + response.status,
  );
  return result.result;
}
const owner = await api("GET", "cove-legal-authority-production/settings");
verifyProductionOwnerBinding(owner);
const secret = randomBytes(32).toString("hex");
const metadata = {
  main_module: "legal-authority.mjs",
  keep_bindings: ["secret_text"],
  bindings: owner.bindings.filter((b) => b.type !== "secret_text"),
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
metadata.bindings.push({
  name: "COVE_PUBLICATION_SOURCE_READER_SECRET",
  type: "secret_text",
  text: secret,
});
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
await api("PUT", "cove-pub-qa-continuous-capture/secrets", {
  name: "COVE_PUBLICATION_SOURCE_READER_SECRET",
  type: "secret_text",
  text: secret,
});
console.log(
  "PASS: independent fixed-read credential installed; production legal authority remains disabled and original bindings preserved",
);
