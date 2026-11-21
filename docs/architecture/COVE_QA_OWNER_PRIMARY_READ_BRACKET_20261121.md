# Cove owner-primary current-read bracket (isolated QA prototype)

**Status: not deployed, not a rights-grant authority, and not release-certified.**

Cove's legal owner can acknowledge a withdrawal before the corresponding
primary-D1 reconciliation commits. A D1-only snapshot, even if it says
"current" in its own generation, cannot prove no owner-denial has happened
since. Catalog and paid-entitlement reads need a separately queried owner
epoch, bound to the same independently versioned primary projection.

## Implemented in this source candidate

- `src/storefront-strangler/current-owner-primary-read-bracket.stage.ts`
  accepts only one of Cove's **two synthetic QA D1 identities**, an exact
  64-hex journal version and secret, a private fixed owner port and a D1 port
  exposing `withSession("first-primary")`. No public route, client-supplied
  URLs, generic SQL write executor, production database ID, or deployment
  feature flag is available.
- Every owner read calls the existing private
  `/qa/current-mutation-fence` endpoint with its **own unpredictable
  128-bit challenge**, no-store cache directives and private auth. Receipts
  must include the exact journal schema, full reviewed 24-table/78-trigger
  inventory, matching challenge, QA primary UUID, journal version, a positive
  decimal epoch, `authorizing:false`, and an explicit A/B rehearsal revision.
  Missing/extra fields, invalid proof/transport, cached or oversized receipts,
  virgin epoch zero and disabled production owner all fail closed.
- An independently supplied primary QA publication row must attest **the
  same owner version, rehearsal revision and mutation epoch**, plus
  `dirty=0`, `pending_withdrawals=0`, `pending_writes=0`, and an
  **absolute** legal-eligibility horizon that is both in the future and at
  most five minutes out. The reader cannot publish, repair or initialize
  this row, and cannot fall back to a replica or R2 when it is unavailable.
- The caller's already-authorized catalog/entitlement read runs only after
  matching owner and primary checks. A new first-primary session rechecks
  the row, then a **fresh owner** challenge rechecks its epoch, then a final
  first-primary check closes obvious owner/primary reconciliation races.
  No response leaves this wrapper when the owner changes in between.
- The fixture verifies 2 independent owner challenges, 3 first-primary
  reads, malformed current receipts, version and horizon faults, pending
  reconciliation, and a withdrawal ACK that outruns D1. Existing CI also
  runs the real owner handlers and native workerd owner journal regression.
  All of these checks are local; no Cloudflare/Stripe credentials are used.

This is an **additional invalidation condition**, not a grant of access. The
callback MUST perform the complete independently reviewed live deny-first
rights/offer and customer-entitlement authorization on the same primary
generation. A current epoch does not imply a product has distribution rights.

## Still unimplemented — critical release blockers

1. The `cove_qa_owner_primary_publication_fence` QA table is a **required
   interface**, not an existing production table or authorized migration. A
   legal owner must create and maintain it with an atomic **owner-epoch CAS**
   after proving the initial historical catalog and all denial sources.
   No code here fabricates epoch zero or writes this row.
2. Positive rights, expiry changes, contract and source rebinding, refunds,
   customer entitlements, account erasure, legal owner KV state and all other
   mutation families must be enrolled in the independent owner epoch and the
   primary generation. The current QA journal counts 24 SQL tables but
   cannot attest to its private KV state or historical production records.
3. The final owner check and network response are not one atomic operation.
   A withdrawal may occur immediately after the last check. Production
   instant-revocation requirements need a separately proven service-level
   linearization/routing protocol, not this prototype alone.
4. The backend still has a native production D1 binding and live cron jobs,
   the owner remains disabled, and broad account/user API token permissions
   still need removal after safe command migration. This prototype never
   grants owner, primary-D1 or token privileges.
5. Real catalog parity, live full-catalog snapshot/denial provenance,
   customer 503 elimination, Stripe LIVE settlement/refund/revocation,
   strict ORD/LAX/IAD/DFW performance and 100-RPS acceptance, and an actual
   protected rollback remain separate gates.

No production D1 migration, Worker deploy, Stripe action, permissions,
customer traffic or cron scheduling is performed by this PR. Cove is NO-GO.
