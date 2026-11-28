import { compileCurrentLegalBaseline, hashCurrentBaseline } from "./current-legal-baseline.mjs";

const scope = (row) => JSON.stringify([row.productId, row.territory, row.format, row.channel]);

/**
 * Non-authorizing reference generation store. Input must be a fresh canonical
 * inventory and independently signed review, not a caller-supplied manifest.
 * Transaction couples the generation pointer with the exact manifest.
 * This is deliberately not connected to production serving or D1.
 */
export function initializeBaselineStore(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS baseline_generation (generation INTEGER PRIMARY KEY, owner_epoch INTEGER NOT NULL, inventory_sha TEXT NOT NULL, manifest_sha TEXT NOT NULL, manifest_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS baseline_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, owner_epoch INTEGER NOT NULL);",
  );
}

export function sealBaselineGeneration(db, input, expectedGeneration) {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
    throw Error("baseline_expected_generation");
  db.exec("BEGIN IMMEDIATE");
  try {
    const head = db
      .prepare("SELECT generation,owner_epoch FROM baseline_head WHERE singleton=1")
      .get();
    if (
      (head?.generation || 0) !== expectedGeneration ||
      (head && input.ownerEpoch < head.owner_epoch)
    )
      throw Error("baseline_generation_conflict");
    const candidate = compileCurrentLegalBaseline(input);
    if (candidate.manifest.validUntilMs <= input.nowMs) throw Error("baseline_generation_expired");
    const generation = expectedGeneration + 1;
    db.prepare("INSERT INTO baseline_generation VALUES(?,?,?,?,?)").run(
      generation,
      input.ownerEpoch,
      candidate.manifest.inventorySha256,
      candidate.manifestSha256,
      JSON.stringify(candidate.manifest),
    );
    db.prepare(
      "INSERT INTO baseline_head VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,owner_epoch=excluded.owner_epoch",
    ).run(generation, input.ownerEpoch);
    db.exec("COMMIT");
    return { generation, manifestSha256: candidate.manifestSha256, authorizing: false };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** A simulated consumer requires current scope facts and current owner epoch.
 * Missing scope, mismatch, expired generation and any current deny/hold fail.
 * The result is a candidate decision, never a legal serving grant.
 */
export function inspectBaselineCandidate(db, current, ownerEpoch, nowMs) {
  const deny = { candidateAllowed: false, authorizing: false };
  if (!current || current.outstandingHold !== false || current.canonicalAllowed !== true)
    return deny;
  const head = db
    .prepare(
      "SELECT g.* FROM baseline_head h JOIN baseline_generation g ON g.generation=h.generation WHERE h.singleton=1 AND h.owner_epoch=g.owner_epoch",
    )
    .get();
  if (!head || head.owner_epoch !== ownerEpoch) return deny;
  let manifest;
  try {
    manifest = JSON.parse(head.manifest_json);
  } catch {
    return deny;
  }
  if (
    hashCurrentBaseline(manifest) !== head.manifest_sha ||
    manifest.inventorySha256 !== head.inventory_sha ||
    manifest.ownerEpoch !== ownerEpoch ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < manifest.evaluatedAtMs ||
    nowMs >= manifest.validUntilMs
  )
    return deny;
  const row = manifest.decisions.find((decision) => scope(decision) === scope(current));
  if (
    !row?.allowed ||
    nowMs >= row.validUntilMs ||
    row.source !== current.source ||
    row.sourceItemId !== current.sourceItemId ||
    row.artifactSha256 !== current.artifactSha256 ||
    row.policySha256 !== current.policySha256
  )
    return deny;
  return { candidateAllowed: true, authorizing: false };
}
