# Cove catalog page-two capacity — causal evidence and architecture decision

Date: 2026-11-15
Status: **BLOCKING / not production certified**
Scope: synthetic, isolated Cloudflare staging; no customer routing, legal owner, payments or production D1 writes

## Experimental outcomes (do not extrapolate from successful-response latency)

| Candidate | Strict gate outcome | Genuine D1 7429 overload |
| --- | --- | --- |
| Full 96 ranked candidates with 49 live auth+offer witnesses | Failed 32-concurrent maximum first byte **817.92 ms** | Sustained phase not reached |
| 56-candidate prefix with 49 live witnesses, attempt 1 | 32 burst, 50 RPS, 100-RPS phase 1 passed; **100-RPS phase 2 failed** | **17 / 2000** |
| Same 56/49 candidate, independent rerun | 32 burst, 50 RPS passed; **100-RPS phase 1 failed** | **72 / 2000** |
| Same 56/49 candidate, but hydrate only 24 visible books after current rights | 32 burst, 50 RPS passed; **100-RPS phase 1 failed** | **240 / 2000** |
| Same 56/49 visible-only variant, independent corrected-source rerun | 32 burst, 50 RPS passed; **100-RPS phase 1 failed** | **381 / 2000** |

Source evidence:
- [96/49 strict run #43685466693](https://github.com/JibrilMohamud/cove/actions/runs/43685466693)
- [56/49 run #43685785336](https://github.com/JibrilMohamud/cove/actions/runs/43685785336)
- [56/49 rerun #43685892217](https://github.com/JibrilMohamud/cove/actions/runs/43685892217)
- [56/49 visible-only run #43686197913](https://github.com/JibrilMohamud/cove/actions/runs/43686197913)
- [56/49 visible-only rerun #43686320869](https://github.com/JibrilMohamud/cove/actions/runs/43686320869)
- First-page 25-authority-witness proof [#43685009745](https://github.com/JibrilMohamud/cove/actions/runs/43685009745): two 2000/2000 100-RPS phases, zero failures/drops, max 434.21/399.30ms.

All stage failures were preserved as failures. Candidate/private-driver restoration completed. The successes prove **only** guarded synthetic first-page capacity, not the customer-facing catalog or four-colo performance. Individual D1 SQL-time preflights are not load-test latency.

## Decision: stop SQL-only tuning and 49-authority-witness second-page hot reads

The 49th witness is necessary **only for page-number offset correctness** when `page=2` is re-ranked against every current pre-page withdrawal. Retrieving 49 real-time retail/rights witnesses for every subsequent page increases per-request primary D1 work. Reducing rows-read from ~1636 to ~1028 and hydrating just 24 display books did **not** cure sustained D1 resource-window overload. Do not keep nudging LIMIT/indexes and calling success based on non-overloaded responses.

### Next controlled design: rights-checked continuation cursors

1. **Stable, versioned public ranking manifest** is built asynchronously using the canonical search semantics. It is display-only and cannot authorize rights, offers, DRM, EPUB, entitlements, paid delivery or legal reinstatement. Partition by territory, market currency, sort/filter/query fingerprint; snapshots have immutable manifest IDs, publish epoch and strict bounded validity. The existing top-96 synthetic projection does **not** cover global catalog/search and cannot be used as the final production manifest.
2. After a page of up to 24 freshly authorized results, issue an **authenticated cursor** bound to manifest ID/digest, exact normalized query/filter/sort and territory/currency, last displayed canonical rank, generation and expiry. Use a separate HMAC key, constant-time verification, length caps and strict canonical parsing. A cursor is *not* a right or entitlement, and must not contain protected keys or user secrets.
3. The next page resumes **after the last shown rank**, using a small live D1 candidate subset (32 candidates for 25 live witnesses on the normal path), and on sparse rights falls back to **one fresh complete remaining-manifest-range check**, never combining older and newer positive decisions. All 24 returned items and the 25th next-page witness must pass active primary D1 rights, current offer and exact edition checks in the same statement. Stale metadata/license/revision fails closed.
4. A cursor anchored in the previous page is intentionally *not the same contract* as current `page=N` offset pagination. A withdrawal before the anchor must not duplicate previously viewed books, but may alter which earlier products appear. **Do not silently replace the public canonical page-number API**: implement explicit cursor semantics and either migrate the client with acceptance or continue serving old page-number routes through canonical search until genuine parity is demonstrated.
5. Real **exact catalog count, facets, query correction, ingestion metadata and comprehensive filters** come from an independently computed, versioned presentation index with a reviewed writer/mutation invalidation inventory. Cache values are not grant decisions; the canonical nine-field API must preserve exact vs pending/lower-bound flags without inventing totals or `next`. The 96-book synthetic R2 list is not an exact catalog-count source. Rebuild a new immutable generation before atomic pointer promotion; retain old snapshots only while still provably safe under the live D1 generation fence, so ordinary publication updates do not systematically cause 503s.
6. Track and cap live D1 cost by **actual per-request rights witness count, rows read, operations, and D1 resource-window overload**. Run paired guarded tests first (no DB, current 25-witness, cursor page-two, old 49-witness) under identical offered load. Then a *mixed page-one/page-two* 100-RPS campaign, geographic repetition and real customer SSR tests. A pass requires cold/warm 1/4/8/16/32 max <800ms with no drops, 2×20s at 100 offered RPS with 2000/2000 valid each, p95<600ms, p99<750ms, max<800ms, zero failures and drops, plus protected rollback. Verify publisher mutation/withdrawal/repricing during a cached cursor journey.
7. Before production cutover independently certify full canonical book and nine-field wire parity, publishing/search freshness, writer exclusivity, live legal owner revocation/reinstatement, Stripe LIVE charge→settlement→entitlement→protected EPUB/audio→refund→revocation, real production SSR/503 and ORD/LAX/IAD/DFW repeatability. Existing production routing/owner/Stripe remain unchanged.

**Release decision: BLOCKED.** No promotion from synthetic or document-only evidence.
