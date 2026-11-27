import assert from "node:assert/strict";
import test from "node:test";
import { loadVisualCoverFixtures, coverFixtureForUrl } from "./visual-cover-fixtures.mjs";

test("24 approved covers have intact image checksums and edition-bound URLs", () => {
  const fixtures = loadVisualCoverFixtures();
  assert.equal(fixtures.size, 24);
  for (const [edition, f] of fixtures) {
    assert.equal(
      coverFixtureForUrl(
        fixtures,
        "https://candidate.test" + f.path + "?v=1",
        "https://candidate.test",
      ).editionId,
      edition,
    );
    assert.equal(
      coverFixtureForUrl(fixtures, f.source, "https://candidate.test").editionId,
      edition,
    );
    assert.equal(
      coverFixtureForUrl(fixtures, "https://unrelated.test" + f.path, "https://candidate.test"),
      null,
    );
  }
  assert.equal(
    coverFixtureForUrl(
      fixtures,
      "https://candidate.test/covers/99999999.jpg",
      "https://candidate.test",
    ),
    null,
  );
});
