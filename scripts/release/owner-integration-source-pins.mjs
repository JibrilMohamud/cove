/* eslint-disable prettier/prettier -- Historic retirement receipts are immutable; only independently reviewed current source can supersede the byte-pin. */
import assert from "node:assert/strict";

// Exact source bytes from the independent 2026-11-22 integration scanner.
// These are a *new* review boundary, not edits to historical attestations and
// NEVER evidence of current external legal authority or production exclusivity.
const integrated=Object.freeze({
 "src/features/fore/account-management.server.ts":"53e136af17170a9e05bf111a20b3ebebd6d950a2c0ad5a9a9ed0ed4a7664bfb5",
 "src/features/fore/api.server.ts":"9082ea9d354c964ee4955c11fb26472b637092806d30f7b2ec9cbaba15749a85",
 "src/features/fore/catalog-model.server.ts":"c4d03da0a2428d5290c000d5d39f6129f2491254335c975e3acb0a340c0f172b",
 "src/features/fore/commerce.server.ts":"68843d3739fcb765c9f40873601b0e685fcc590db73bd55cd0b606a716d7b830",
 "src/features/fore/delivery.server.ts":"0f95dd892fe1ca1277d7dd412139586debaad5acd70ad5f9496f420d5a8a1347",
 "src/features/fore/localization.server.ts":"02852814c24e749359ed751717a8387ab6dc75ba4ecba78d6058ecbbfba919e1",
 "src/features/fore/promotions.server.ts":"05c37488918235a18839605db9873bc9f645b465e238ffcf9680bbd4b0618047",
 "src/features/fore/publishing.server.ts":"0518338b3a9512c82075dc89fcba927f80d04b54ec7e57ba8a3b3726d069b2a8",
 "src/features/fore/publishing-trust.server.ts":"7b712809bd58a2d0456ad38da3b0ecb75621688dedd070a2f8687ebef6765590",
 "src/features/fore/regional-epub-asset-repair.server.ts":"27322f92d09b409c0913cdc96e523f0b610999a685a325fd3a0642fdb98c0443",
 "src/features/fore/rights.server.ts":"a7839d53ae20ffa3351bd6fbef797bd3d06dfb30c7d390168c195be8680e5fa2",
 "src/features/fore/search.server.ts":"6058f067527184f817f2759c0385129a344c67ea995d4fe46a58e53ea561f356",
 "src/features/fore/traditional-publishing.server.ts":"364406b8ed38f06563a6e307aa0512e64b41c926ee7236bf34e216e8f0166191",
 "src/storefront-strangler/legal-authority.worker.ts":"d8872ecce04958036b03036995c934dfe9d4de615a612a6714fc11b3573f8c9e"
});
export function expectedCurrentOwnerIntegrationHash(path,historicalSha256) {
 assert.match(path,/^(?:src|scripts)\/[a-zA-Z0-9_./-]+\.[a-z]+$/);
 assert.match(historicalSha256,/^[a-f0-9]{64}$/,"Historical SHA receipt must remain valid");
 return integrated[path]||historicalSha256;
}
export const currentOwnerIntegrationSourcePins=integrated;
