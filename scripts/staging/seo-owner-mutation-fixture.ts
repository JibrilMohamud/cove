/** Synthetic fixture shared by Node SQLite and pinned local workerd. */
import type { AuthoritySql } from "../../src/storefront-strangler/legal-authority-core";
import {
  createAuthoritySchema,
  createAuthorityProofSchema,
  persistSourceWithdrawal,
  applyAuthorityCommand,
  readAuthority,
} from "../../src/storefront-strangler/legal-authority-core";
import {
  createCommercialAuthoritySchema,
  denyCommercialProduct,
  denyCommercialSubject,
} from "../../src/storefront-strangler/commercial-legal-core";
import {
  createPaidEntitlementSchema,
  denyPaidOrder,
  denyPaidEntitlement,
} from "../../src/storefront-strangler/commercial-entitlement-core";
import { createCommercialStorefrontSchema } from "../../src/storefront-strangler/commercial-storefront-authority";
import {
  createMarketAuthoritySchema,
  denyMarket,
} from "../../src/storefront-strangler/market-authority-core";
import { createPublicationMaterializationSchema } from "../../src/storefront-strangler/publication-materialization-command";
import { createContractVersionOwnerSchema } from "../../src/storefront-strangler/owner-contract-version-executor";
import { beginPublicationCommand } from "../../src/storefront-strangler/publication-command-core";
import {
  enrollQaOwnerMutationFence,
  readQaOwnerMutationFence,
} from "../../src/storefront-strangler/seo-owner-mutation-fence-qa";

export const VERSION = "isolated-owner-mutation-qa-v1";
type Tx = <T>(fn: () => T) => T;
const check = (value: unknown, reason: string) => {
  if (!value) throw Error(reason);
};
export function createActualOwnerSchema(sql: AuthoritySql) {
  // Exactly the eight schema factories in CoveLegalAuthority's constructor.
  createAuthoritySchema(sql);
  createAuthorityProofSchema(sql);
  createCommercialAuthoritySchema(sql);
  createCommercialStorefrontSchema(sql);
  createPaidEntitlementSchema(sql);
  createMarketAuthoritySchema(sql);
  createPublicationMaterializationSchema(sql);
  createContractVersionOwnerSchema(sql);
}
export function runActualOwnerDenials(sql: AuthoritySql, tx: Tx) {
  const read = () => readQaOwnerMutationFence(sql, tx, VERSION);
  const before = read();
  const commands = [
    () =>
      persistSourceWithdrawal(sql, {
        sourceId: "2701",
        territory: "*",
        operationId: "qa-source-1",
      }),
    () => denyMarket(sql, { territory: "US", operationId: "qa-market-1" }),
    () =>
      denyCommercialProduct(sql, {
        productId: "prd_qa_distribution",
        operationId: "qa-distribution-1",
      }),
    () =>
      denyCommercialProduct(sql, { productId: "prd_qa_retail", operationId: "retail:qa-retail-1" }),
    () =>
      denyCommercialSubject(sql, {
        subjectKind: "contract",
        subjectId: "contract_qa",
        operationId: "qa-contract-1",
      }),
    () =>
      denyCommercialSubject(sql, {
        subjectKind: "grant",
        subjectId: "grant_qa",
        operationId: "qa-grant-1",
      }),
    () => denyPaidOrder(sql, { orderId: "order_qa_001", operationId: "qa-refund-1" }),
    () =>
      denyPaidEntitlement(sql, {
        entitlementId: "entitlement_qa_001",
        userId: "user_qa_001",
        productId: "prd_qa_paid",
        operationId: "qa-entitlement-1",
      }),
    () =>
      beginPublicationCommand(sql, {
        productId: "prd_qa_publication",
        operationId: "qa-publication-1",
        commandSha256: "a".repeat(64),
      }),
  ];
  for (const command of commands) {
    const start = Number(read().mutationEpoch);
    const receipt = tx(command);
    check(!("applied" in receipt) || receipt.applied, "qa_actual_denial_not_applied");
    const after = Number(read().mutationEpoch);
    check(after > start, "qa_actual_denial_not_fenced");
    tx(command);
    check(Number(read().mutationEpoch) === after, "qa_actual_replay_changed_epoch");
  }
  const start = read();
  let rolledBack = false;
  try {
    tx(() => {
      denyMarket(sql, { territory: "CA", operationId: "qa-rollback-1" });
      throw Error("qa_injected_after_denial");
    });
  } catch (e) {
    if ((e as Error).message !== "qa_injected_after_denial") throw e;
    rolledBack = true;
  }
  check(
    rolledBack && read().mutationEpoch === start.mutationEpoch,
    "qa_failed_denial_advanced_epoch",
  );
  check(
    sql.exec("SELECT 1 ok FROM cove_market_withdrawals WHERE territory='CA'").toArray().length ===
      0,
    "qa_failed_denial_left_state",
  );
  tx(() =>
    applyAuthorityCommand(sql, { sourceId: "2701", territory: "US", revision: 2, action: "allow" }),
  );
  check(readAuthority(sql, "2701", "US").allowed, "qa_positive_fixture_not_written");
  check(
    Number(read().mutationEpoch) > Number(start.mutationEpoch),
    "qa_positive_change_not_fenced",
  );
  const positiveEpoch = read().mutationEpoch;
  const stale = tx(() =>
    persistSourceWithdrawal(sql, {
      sourceId: "2701",
      territory: "*",
      operationId: "qa-source-1",
    }),
  );
  check(
    !stale.applied && readAuthority(sql, "2701", "US").allowed,
    "qa_old_denial_replay_reapplied_after_allow",
  );
  check(read().mutationEpoch === positiveEpoch, "qa_rejected_replay_changed_epoch");
  // REPLACE may bypass DELETE triggers when recursive_triggers is disabled.
  // The independent BEFORE INSERT guard must reject it in both runtimes.
  let replacementRejected = false;
  try {
    tx(() =>
      sql.exec(
        "INSERT OR REPLACE INTO cove_qa_owner_mutation_fence(slot,owner_version,epoch) SELECT slot,owner_version,0 FROM cove_qa_owner_mutation_fence",
      ),
    );
  } catch (error) {
    if (!String(error).includes("qa_owner_mutation_counter_immutable")) throw error;
    replacementRejected = true;
  }
  check(replacementRejected && read().mutationEpoch === positiveEpoch, "qa_replace_reset_epoch");
  return { before, after: read(), commands: commands.length, rolledBack };
}

/** This class is exported only into the loopback-only test bundle. */
export class MutationFenceFixture {
  sql: AuthoritySql;
  tx: Tx;
  constructor(ctx: { storage: { sql: AuthoritySql; transactionSync: Tx } }) {
    this.sql = ctx.storage.sql;
    this.tx = (fn) => ctx.storage.transactionSync(fn);
    createActualOwnerSchema(this.sql);
    enrollQaOwnerMutationFence(this.sql, this.tx, VERSION);
  }
  fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/exercise") return Response.json(runActualOwnerDenials(this.sql, this.tx));
    if (path === "/withdraw-again") {
      this.tx(() => denyMarket(this.sql, { territory: "DE", operationId: "qa-market-2" }));
    }
    return Response.json(readQaOwnerMutationFence(this.sql, this.tx, VERSION));
  }
}
