/* Source-exact, synthetic payment QA D1 allowlist. Never infer authority from
 * a configurable primary ID or extend to a customer/production primary.
 * The separate-account QA primary must be common to owner-first settlement,
 * webhook, delivery, refunds and revocation, not only the front-end Worker.
 */
const QA_PRIMARY_IDS = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
  "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3",
  "f9354381-bd9f-496b-bd05-d6f62a32ec0c",
]);
export function isReviewedPaidQaPrimary(id: unknown): boolean {
  return typeof id === "string" && QA_PRIMARY_IDS.has(id);
}
