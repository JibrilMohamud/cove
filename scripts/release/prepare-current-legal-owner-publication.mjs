import { compileCurrentLegalBaseline, hashCurrentBaseline } from "./current-legal-baseline.mjs";

// Offline preparation only. Neither a signing key nor a claimed allowance
// supplied by the caller can replace the original independently signed review.
export function prepareCurrentLegalOwnerPublication({ capture, review, trust, generation, nowMs }) {
  const d = capture?.descriptor,
    pages = capture?.pages;
  if (
    !d ||
    d.schema !== "cove.canonical-owner-paged-inventory.v1" ||
    d.defaultVerdict !== "deny" ||
    !Array.isArray(pages) ||
    pages.length !== d.pageCount ||
    pages.length > 70314 ||
    hashCurrentBaseline(d) !== capture.inventorySha256 ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !/^[a-f0-9-]{36}$/.test(capture.primaryId || "")
  )
    throw Error("publication_capture_invalid");
  let rolling = hashCurrentBaseline({
    schema: "cove.canonical-owner-capture-seed.v1",
    ownerEpoch: d.ownerEpoch,
    withdrawalSequence: d.withdrawalSequence,
  });
  const products = [],
    inventory = [];
  let scopesStarted = false;
  for (const [index, page] of pages.entries()) {
    if (
      page.index !== index ||
      !["products", "scopes"].includes(page.kind) ||
      !Array.isArray(page.rows) ||
      page.rows.length < 1 ||
      page.rows.length > (page.kind === "products" ? 128 : 16) ||
      (scopesStarted && page.kind === "products") ||
      hashCurrentBaseline({ kind: page.kind, rows: page.rows }) !== page.sha256
    )
      throw Error("publication_capture_page");
    scopesStarted ||= page.kind === "scopes";
    rolling = hashCurrentBaseline({ prior: rolling, index, kind: page.kind, sha256: page.sha256 });
    (page.kind === "products" ? products : inventory).push(...page.rows);
  }
  if (
    rolling !== d.rootSha256 ||
    products.length !== d.productCount ||
    products.length < 1 ||
    products.length > 1000000 ||
    inventory.length !== d.scopeCount ||
    inventory.length > 1000000
  )
    throw Error("publication_capture_partition");
  const ids = new Set(products.map((p) => p.productId));
  if (ids.size !== products.length || inventory.some((r) => !ids.has(r.productId)))
    throw Error("publication_capture_membership");
  const result = compileCurrentLegalBaseline({
    inventory,
    review,
    trust,
    ownerEpoch: d.ownerEpoch,
    nowMs,
  });
  const rows = result.manifest.decisions.map((r) => ({
    productId: r.productId,
    territory: r.territory,
    format: r.format,
    channel: r.channel,
    verdict: r.allowed
      ? "allow"
      : ["canonical_deny", "external_deny"].includes(r.reason)
        ? "deny"
        : "quarantine",
    artifactSha256: r.artifactSha256,
    policySha256: r.policySha256,
    basisSha256: r.basisSha256,
    validUntilMs: r.allowed ? Math.min(r.validUntilMs, result.manifest.validUntilMs) : 0,
  }));
  const batches = [];
  for (let i = 0; i < rows.length; i += 256) batches.push(rows.slice(i, i + 256));
  const header = {
    schema: "cove.owner-current-baseline.v1",
    primaryId: capture.primaryId,
    generation,
    ownerEpoch: d.ownerEpoch,
    withdrawalSequence: d.withdrawalSequence,
    inventorySha256: capture.inventorySha256,
    productCount: products.length,
    scopeCount: rows.length,
    batchSha256: batches.map(hashCurrentBaseline),
    observedAtMs: nowMs,
    validUntilMs: Math.min(result.manifest.validUntilMs, nowMs + 900000),
    defaultVerdict: "deny",
  };
  if (header.validUntilMs <= nowMs) throw Error("publication_evidence_expired");
  return {
    header,
    batches,
    counts: result.counts,
    requiresIndependentSignatures: true,
    authorizing: false,
  };
}
