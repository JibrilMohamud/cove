/* eslint-disable prettier/prettier -- Retired shared-D1 refund executor; production-only fallback must fail closed. */
import {ApiError} from "./service";
import type {CatalogDB} from "./catalog-model.server";

/**
 * This API was previously a shared-D1 mutation executor. Refund bookkeeping
 * is now implemented only in the private legal-owner Durable Object, where
 * provider proof, a durable revocation and the atomic ledger are enforced.
 *
 * Do not revive a caller-side transaction or return fabricated success.
 * The exact former implementation is frozen under scripts/test-* ONLY for
 * private-owner parity and failure-boundary test coverage.
 */
export async function postRefundAccounting(
  _db:CatalogDB,_refundId:string,_at:string,_ownerEnrolled:boolean
):Promise<never> {
  throw new ApiError(503,"Direct refund accounting retired; private owner required.");
}
