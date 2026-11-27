import { requireIsolatedMembershipProfile } from "./isolated-membership-profile.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withStagePresentationStore } from "./stage-presentation-storage.mjs";
import { requireIsolatedCatalogSnapshotTarget } from "../performance/real-catalog-snapshot-safety.mjs";
import { produceHomepagePresentation } from "../../.output/strangler/presentation.mjs";
import { createIsolatedPresentationReader } from "./isolated-presentation-read.mjs";

/** A bounded, read-only QA seed, never a production publication pipeline.
 * Only public catalog/presentation data is written to the private stage R2.
 * No source database mutation, user identity or access grant is copied. */
export async function seedReadOnlyPresentation({
  readToken,
  source,
  sourceName,
  prefix,
  directory,
  kvNamespaceId,
  assertContractlessView = false,
}) {
  assert.ok(readToken && readToken.length >= 20);
  assert.equal(requireIsolatedCatalogSnapshotTarget(source, sourceName).id, source);
  assert.match(prefix, /^campaign\/\d+\/real\/$/);
  assert.equal(prefix, `campaign/${process.env.GITHUB_RUN_ID}/real/`);
  if (kvNamespaceId) assert.equal(kvNamespaceId, "8245d5f2116a445d9571405b41b7c8c3");
  const db = createIsolatedPresentationReader({ readToken, source, sourceName });
  if (assertContractlessView) {
    const profile = await requireIsolatedMembershipProfile(db);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(directory + "/authority-profile.json", JSON.stringify(profile), {
      mode: 0o600,
    });
  }
  await withStagePresentationStore("real", async (storage) => {
    await produceHomepagePresentation(db, "US", {
      async get() {
        throw Error("Producer must not read a serving snapshot");
      },
      async put(key, body) {
        fs.mkdirSync(directory, { recursive: true });
        const file = directory + "/private-presentation.json";
        fs.writeFileSync(file, body, { mode: 0o600 });
        assert.equal(key, "private/presentation/v2/home/US.json");
        await storage.put("US", body);
      },
    });
  });
}
