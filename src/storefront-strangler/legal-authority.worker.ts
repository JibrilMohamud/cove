/* eslint-disable prettier/prettier -- Private legal-authority boundary is security-sensitive. */
import {validateStoredEpub} from "../features/fore/stored-epub.server";
import JSZip from "jszip";
import {recordAccountSecurityEvent} from "../features/fore/account-management.server";
import {eraseProviderIdentity} from "../features/fore/account-erasure.server";
import {formatMinorCurrency} from "../features/fore/currency";
import {bindPrivateFinanceExecutors} from "./finance-owner-routing.server";
import {runAutomatedPublishingReview} from "../features/fore/moderation.server";
import {upsertRightsContract} from "../features/fore/rights.server";
import {FORE_AI_POLICY_VERSION,FORE_RIGHTS_POLICY_VERSION,assessSubmissionContentPolicy,publisherRightsSnapshot,recordAssetFingerprint,scanAccountRiskLinks,scanIdentitySimilarity} from "../features/fore/publishing-trust.server";
import {commercialAudioReadiness,commercialAudioSubmissionEvidence} from "../features/fore/commercial-audio.server";
import {assessUsageRisk,effectivePublisherWithholding,assessPayoutRisk,assessPublisherRisk} from "../features/fore/risk-tax.server";
import {ensurePreorderReleasePlan} from "../features/fore/preorder.server";
import {hasPublicationOwner,dispatchPublicationActivation,dispatchPublicationPreorder,dispatchPublicationRecovery,dispatchPublicationMaterialization,dispatchPublishingOnboardingReview,dispatchPublishingOwnerValidationJob} from "./publication-owner-routing.server";
import {uploadPublishingAsset,publishingUploadLimit} from "../features/fore/publishing.server";
import {checkoutQuote} from "../features/fore/commerce.server";
import {sha256 as partnerFeedSha256,partnerAudit as partnerFeedAudit,
  normalizedCountryList as partnerNormalizedCountryList} from "../features/fore/traditional-publishing.server";
import type {PartnerProduct} from "../features/fore/traditional-publishing.server";
import type {CoveEnv} from "../features/fore/api.server";
import {ownerSettlementDiagnostic} from "./owner-settlement-diagnostic";
import { DurableObject } from "cloudflare:workers";
import {DISABLED_OWNER_ATTEST_ROUTE,PRODUCTION_OWNER_OBJECT,isDisabledProductionOwner,validOwnerChallenge,disabledOwnerReceipt} from "./production-disabled-owner-attestation";
import {publishVerifiedPaidOrderAtomic,type VerifiedPaidOrderLine} from "./paid-order-atomic-publication";
import {executeOwnerRefundAccounting} from "./refund-accounting-owner-executor";
import {independentlyVerifyOwnerStripeRefund} from "./refund-provider-independent-verification";
import {verifyOwnerStripeDispute} from "./stripe-dispute-owner-proof";

import {reverseRoyaltiesForChargeback} from "../features/fore/finance.server";
import {executeOwnerRefundReservation} from "./refund-reservation-owner-executor";
import {executeOwnerCheckoutPaymentBinding} from "./checkout-payment-binding-owner-executor";
import {checkoutDraftCommand,planOwnerCheckoutDraft,ownerCheckoutPreparationMatchesQuote} from "./checkout-draft-owner-plan";
import {assessBuyerOrderRisk} from "../features/fore/risk-tax.server";
import {stationBySlug} from "../features/fore/cove-sounds-stations";
import {executeOwnerPaidSettlement} from "./paid-settlement-owner-executor";
import {channelSchema,scopeRuleSchema,restrictionsSchema,grantScopeFromInput,drmSatisfiesRequirement,normalizeTerritoryCode,upsertRightsGrant} from "../features/fore/rights.server";
import {z} from "zod/v3";
import {createRoyaltyContractVersion} from "../features/fore/royalty-engine.server";
import {resolvePricingDecision} from "../features/fore/pricing.server";
import {emitNotification} from "../features/fore/notifications.server";
import {ensureOwnershipSnapshot} from "../features/fore/delivery.server";
import {
  stableJson,safeJson,audit,
  scopeToGrant,bucketBytes,publicationVersionManifest,
} from "../features/fore/publishing.server";
import {ownerContractVersionSchema} from "./owner-contract-version-schema";
import {ApiError,now} from "../features/fore/service";
import {recordAction,assertScope,sha256} from "../features/fore/support.server";
import {createModerationCase,type StaffContext,type ModerationDB} from "../features/fore/moderation.server";
import {mirrorPublishingMalwareResult} from "../features/fore/security.server";
import {createContractVersionOwnerSchema,executeOwnerContractVersion} from "./owner-contract-version-executor";
import {createMarketAuthoritySchema,denyMarket,marketIsWithdrawn} from "./market-authority-core";
import { authorizeStorefrontPresentationIds,catalogIds, type CatalogDB } from "../features/fore/catalog-model.server";
import { resolveProductRights,detectRightsConflicts } from "../features/fore/rights.server";
import {createPublicationMaterializationSchema,executePublicationMaterialization} from "./publication-materialization-command";
import type {PublishingEnv,PublishingDB} from "../features/fore/publishing.server";
import {executePublicationPreorder} from "./publication-preorder-command";
import {beginPublicationCommand,commitPublicationCommand,readPublicationCommand,markPublicationPublished,recordPublicationRecovery} from "./publication-command-core";
import {recoverPublicationCommands} from "./publication-command-recovery";
import {
  captureEntitlementEpoch,createPaidEntitlementSchema,denyAccountAccess,
  denyPaidOrder,denyPaidEntitlement,denyPaidEntitlementsBatch,
  publishFreshEntitlement,readPaidAccess,readPaidOrderPermission,
  validatePaidEntitlementScope,
} from "./commercial-entitlement-core";
import {
  captureCommercialEpoch, createCommercialAuthoritySchema,
  denyCommercialProduct, denyCommercialProductsBatch, denyCommercialSubject,
  publishFreshCommercialProof, readCommercialProofs,
  commercialProductId, type CommercialChannel,
} from "./commercial-legal-core";
import {
  createCommercialStorefrontSchema,publishCommercialStorefront,readCommercialStorefront,
} from "./commercial-storefront-authority";
import {
  applyAuthorityCommand, capturePositiveVerificationFence, commitFreshPositiveVerification,
  createAuthoritySchema, createAuthorityProofSchema,
  readAuthority, readAuthorizedPresentations,
  persistSourceWithdrawal, persistSourceWithdrawalsBatch,
  validateAuthorityCommand, type AuthoritySql,
} from "./legal-authority-core";

type LegalAuthorityEnv = Pick<CoveEnv,"FORE_AUTH_MODE"|"SUPABASE_URL"|"SUPABASE_SECRET_KEY"|"FORE_INGESTION_SIGNING_KEY"> & {
  PRIMARY_DB: CatalogDB;
  BUCKET?:PublishingEnv["BUCKET"];
  FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK?:string;
  COVE_RIGHTS_OWNER_SECRET?: string;
  COVE_RIGHTS_OWNER_ENABLED?: string;
  COVE_RIGHTS_OWNER_PRIMARY_ID?: string;
  COVE_RIGHTS_OWNER_TEST_EXPIRES_AT?: string;
  STRIPE_SECRET_KEY?:string;
  STRIPE_LIVEMODE?:string;
  STRIPE_TAX_ENABLED?:string;
  STRIPE_MINIMUM_CHARGE_MINOR?:string;
  LEGAL_AUTHORITY?: {getByName(name:string):{fetch(request:Request):Promise<Response>}};
};
// Never accept an unspecified primary binding. This is a newly provisioned,
// completely separate canonical QA D1. Real production is NOT enrolled.
// Only these two physically separate, synthetic QA databases can issue a
// short-lived owner lease. The second has canonical paid-commerce schema;
// neither is the capacity fixture or a customer production database.
const QA_PRIMARIES = new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);
function qaOwnerLeaseLive(env:LegalAuthorityEnv) {
  const expires=Number(env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT);
  const now=Date.now();
  // An interrupted GitHub job cannot accidentally leave the QA legal owner
  // operable. A fresh, strictly bounded lease is required by BOTH the Worker
  // entrypoint and its Durable Object; no stale toggle can bypass this fence.
  return env.COVE_RIGHTS_OWNER_ENABLED==="1" &&
    QA_PRIMARIES.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID||"") &&
    Number.isSafeInteger(expires) && expires>now &&
    expires<=now+15*60*1000 &&
    !!env.COVE_RIGHTS_OWNER_SECRET &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET);
}

// Canonical publishing-managed rights contract writes are privately owned.
// This implementation is not exported to an API, scheduler, or external D1 caller.
// The publication materialization command independently checks the immutable
// submission, reviewer, legal proof and durable owner hold before invoking it.
/* eslint-disable @typescript-eslint/no-explicit-any -- Byte-exact transplanted historical rights-contract SQL, independently source-parity tested. */
async function upsertRightsContractPrivate(db: CatalogDB, raw: unknown) {
  const channelSchema=z.enum(["retail","subscription","library"]);
  const now=()=>new Date().toISOString();
  const languageRule = z.object({
    languageCode: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .transform((v) => v.toLowerCase()),
    decision: z.enum(["allow", "deny"]).default("allow"),
    format: z.string().max(40).nullable().optional(),
    salesChannel: channelSchema.nullable().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    notes: z.string().max(500).default(""),
  });
  const x = z
    .object({
      id: z.string().max(180).optional(),
      referenceCode: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(240),
      rightsholderPartyId: z.string().max(180).nullable().optional(),
      status: z.enum(["draft", "active", "suspended", "expired", "terminated"]).default("active"),
      effectiveFrom: z.string().datetime().nullable().optional(),
      effectiveTo: z.string().datetime().nullable().optional(),
      languageMatchMode: z.enum(["any", "all"]).default("all"),
      source: z.string().max(120).default("operator"),
      notes: z.string().max(2000).default(""),
      languages: z.array(languageRule).max(250).default([]),
    })
    .parse(raw);
  if (x.effectiveFrom && x.effectiveTo && x.effectiveTo <= x.effectiveFrom)
    throw new ApiError(400, "Contract end date must be after its start date.");
  if (x.rightsholderPartyId) {
    const party = await db
      .prepare("SELECT id FROM rights_parties WHERE id=? AND status='active'")
      .bind(x.rightsholderPartyId)
      .first<any>();
    if (!party) throw new ApiError(400, "Unknown or inactive contract rightsholder.");
  }
  const id = x.id || `rcontract_${crypto.randomUUID()}`,
    at = now(),
    before = x.id
      ? await db.prepare("SELECT created_at FROM rights_contracts WHERE id=?").bind(id).first<any>()
      : null;
  const statements: any[] = [
    db
      .prepare(
        `INSERT INTO rights_contracts(id,reference_code,name,rightsholder_party_id,status,effective_from,effective_to,language_match_mode,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET reference_code=excluded.reference_code,name=excluded.name,rightsholder_party_id=excluded.rightsholder_party_id,status=excluded.status,effective_from=excluded.effective_from,effective_to=excluded.effective_to,language_match_mode=excluded.language_match_mode,source=excluded.source,notes=excluded.notes,updated_at=excluded.updated_at`,
      )
      .bind(
        id,
        x.referenceCode,
        x.name,
        x.rightsholderPartyId || null,
        x.status,
        x.effectiveFrom || null,
        x.effectiveTo || null,
        x.languageMatchMode,
        x.source,
        x.notes,
        before?.created_at || at,
        at,
      ),
    db.prepare("DELETE FROM rights_contract_languages WHERE contract_id=?").bind(id),
  ];
  x.languages.forEach((r) => {
    if (r.startsAt && r.endsAt && r.endsAt <= r.startsAt)
      throw new ApiError(
        400,
        `Language-right end date must follow its start for ${r.languageCode}.`,
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO rights_contract_languages(id,contract_id,language_code,decision,format,sales_channel,starts_at,ends_at,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          `rclang_${crypto.randomUUID()}`,
          id,
          r.languageCode,
          r.decision,
          r.format || null,
          r.salesChannel || null,
          r.startsAt || null,
          r.endsAt || null,
          r.notes,
          at,
        ),
    );
  });
  statements.push(
    db
      .prepare(
        "INSERT INTO rights_configuration_audit(id,entity_type,entity_id,action,snapshot_json,recorded_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        `rca_${crypto.randomUUID()}`,
        "contract",
        id,
        x.id ? "update" : "insert",
        JSON.stringify(x),
        at,
      ),
  );
  await db.batch(statements);
  return { id, conflicts: await detectRightsConflicts(db) };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
// Owner-private rights grant mutation. No API, scheduled worker or direct D1
// caller can import this implementation. Publishing materialization calls it
// under its existing checked owner command/hold/replay boundary.
/* eslint-disable @typescript-eslint/no-explicit-any -- Byte-exact historical rights-grant implementation, source-parity verified. */
async function upsertRightsGrantPrivate(db: CatalogDB, raw: unknown) {
  const now=()=>new Date().toISOString();
  const hist = z.object({ code: z.string().max(2), asOfDate: z.string().nullable().optional() });
  const x = z
    .object({
      id: z.string().max(180).optional(),
      editionId: z.string().min(1).max(180),
      rightsholderPartyId: z.string().max(180).nullable().optional(),
      rightsholderId: z.string().max(180).nullable().optional(),
      territory: z.string().max(2).default("US"),
      territoryName: z.string().max(120).optional(),
      scopeMode: z.enum(["single", "set", "worldwide", "expression"]).default("single"),
      territorySetId: z.string().max(180).nullable().optional(),
      scopeRules: z.array(scopeRuleSchema).max(500).optional(),
      includeTerritories: z.array(z.string().max(2)).max(300).default([]),
      excludeTerritories: z.array(z.string().max(2)).max(300).default([]),
      includeSetIds: z.array(z.string().max(180)).max(100).default([]),
      excludeSetIds: z.array(z.string().max(180)).max(100).default([]),
      includeHistorical: z.array(hist).max(50).default([]),
      excludeHistorical: z.array(hist).max(50).default([]),
      format: z.string().trim().min(1).max(40),
      salesChannel: channelSchema.default("retail"),
      startsAt: z.string().datetime().nullable().optional(),
      endsAt: z.string().datetime().nullable().optional(),
      licenseType: z.string().trim().min(1).max(80),
      contractId: z.string().max(180).nullable().optional(),
      contractVersionId: z.string().max(180).nullable().optional(),
      exclusivity: z.enum(["nonexclusive", "exclusive", "sole"]).default("nonexclusive"),
      drmRequirement: z.string().trim().min(1).max(80).default("none"),
      subscriptionPermitted: z.boolean().default(false),
      libraryPermitted: z.boolean().default(false),
      decision: z.enum(["allow", "deny"]).default("allow"),
      status: z.enum(["draft", "active", "suspended", "revoked", "expired"]).default("active"),
      promotionRestrictions: restrictionsSchema.default({}),
      contractReference: z.string().max(200).default(""),
      source: z.string().max(120).default("operator"),
      notes: z.string().max(2000).default(""),
    })
    .parse(raw);
  if (x.startsAt && x.endsAt && x.endsAt <= x.startsAt)
    throw new ApiError(400, "Rights end date must be after the start date.");
  if (
    !x.rightsholderPartyId &&
    !x.rightsholderId &&
    x.licenseType.trim().toLowerCase() !== "public-domain"
  )
    throw new ApiError(
      400,
      "A rightsholder is required for licensed distribution rights. Public-domain determinations are the only rightsholder-free exception.",
    );
  const edition = await db
    .prepare("SELECT id,title FROM editions WHERE id=?")
    .bind(x.editionId)
    .first<any>();
  if (!edition) throw new ApiError(400, "Unknown edition.");
  let holderName = "";
  if (x.rightsholderPartyId) {
    const party = await db
      .prepare("SELECT id,display_name FROM rights_parties WHERE id=? AND status='active'")
      .bind(x.rightsholderPartyId)
      .first<any>();
    if (!party) throw new ApiError(400, "Unknown or inactive rights party.");
    holderName = String(party.display_name || "");
  }
  let contractVersionId = x.contractVersionId || null;
  if (x.contractId) {
    const contract = await db
      .prepare(
        "SELECT id,rightsholder_party_id,reference_code FROM rights_contracts WHERE id=? AND status IN ('draft','active')",
      )
      .bind(x.contractId)
      .first<any>();
    if (!contract) throw new ApiError(400, "Unknown or inactive rights contract.");
    if (
      contract.rightsholder_party_id &&
      x.rightsholderPartyId &&
      String(contract.rightsholder_party_id) !== x.rightsholderPartyId
    )
      throw new ApiError(400, "Grant rightsholder does not match the selected contract.");
    if (!x.contractReference) x.contractReference = String(contract.reference_code || "");
    if (contractVersionId) {
      const v = await db
        .prepare(
          "SELECT id,status,effective_from,effective_to FROM rights_contract_versions WHERE id=? AND contract_id=?",
        )
        .bind(contractVersionId, x.contractId)
        .first<any>();
      if (!v)
        throw new ApiError(400, "The selected contract version does not belong to this contract.");
      if (x.status === "active" && String(v.status) !== "active")
        throw new ApiError(409, "Active rights grants must reference an active contract version.");
    } else {
      const v = await db
        .prepare(
          "SELECT id FROM rights_contract_versions WHERE contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY version_number DESC LIMIT 1",
        )
        .bind(x.contractId, now(), now())
        .first<any>();
      if (v) contractVersionId = String(v.id);
      else {
        const versions = await db
          .prepare("SELECT count(*) n FROM rights_contract_versions WHERE contract_id=?")
          .bind(x.contractId)
          .first<any>();
        if (x.status === "active" && Number(versions?.n || 0) > 0)
          throw new ApiError(
            409,
            "This contract has versioned policy but no active effective version. Activate a contract version before the grant.",
          );
      }
    }
  } else if (contractVersionId) throw new ApiError(400, "contractVersionId requires contractId.");
  const id = x.id || `right_${crypto.randomUUID()}`,
    at = now(),
    scope = await grantScopeFromInput(db, x),
    before = x.id
      ? await db.prepare("SELECT created_at FROM rights_grants WHERE id=?").bind(id).first<any>()
      : null;
  if (contractVersionId && ["draft", "active"].includes(x.status)) {
    const [tv, fv, cv] = await Promise.all([
      db
        .prepare(
          `SELECT territory_code,decision FROM rights_contract_version_territories WHERE contract_version_id=?`,
        )
        .bind(contractVersionId)
        .all<any>(),
      db
        .prepare(
          "SELECT decision,drm_requirement FROM rights_contract_version_formats WHERE contract_version_id=? AND lower(format)=lower(?)",
        )
        .bind(contractVersionId, x.format)
        .first<any>(),
      db
        .prepare(
          "SELECT permitted FROM rights_contract_version_channels WHERE contract_version_id=? AND sales_channel=?",
        )
        .bind(contractVersionId, x.salesChannel)
        .first<any>(),
    ]);
    const allowed = new Set(
      tv.results
        .filter((r: any) => r.decision === "allow")
        .map((r: any) => String(r.territory_code)),
    );
    const denied = new Set(
      tv.results
        .filter((r: any) => r.decision === "deny")
        .map((r: any) => String(r.territory_code)),
    );
    if (
      tv.results.length &&
      scope.territories.some((t: string) => denied.has(t) || !allowed.has(t))
    )
      throw new ApiError(409, "The grant territory scope exceeds the selected contract version.");
    if (!fv || String(fv.decision) !== "allow")
      throw new ApiError(
        409,
        "The grant format is not permitted by the selected contract version.",
      );
    if (!cv || !Number(cv.permitted))
      throw new ApiError(
        409,
        "The grant sales channel is not permitted by the selected contract version.",
      );
    if (!drmSatisfiesRequirement(String(fv.drm_requirement || "none"), x.drmRequirement))
      throw new ApiError(
        409,
        "The grant DRM policy is weaker than the selected contract version requires.",
      );
  }

  const candidate: any = {
    id,
    edition_id: x.editionId,
    edition_title: String(edition.title || x.editionId),
    rightsholder_id: x.rightsholderId || null,
    rightsholder_party_id: x.rightsholderPartyId || null,
    rightsholder_name: holderName,
    format: x.format,
    sales_channel: x.salesChannel,
    starts_at: x.startsAt || null,
    ends_at: x.endsAt || null,
    contract_id: x.contractId || null,
    contract_version_id: contractVersionId,
    exclusivity: x.exclusivity,
    subscription_permitted: x.subscriptionPermitted ? 1 : 0,
    library_permitted: x.libraryPermitted ? 1 : 0,
    decision: x.decision,
    status: x.status,
    territories: scope.territories,
  };
  const preflight = await detectRightsConflicts(db, candidate),
    blocking = preflight.filter(
      (c) => c.severity === "error" && (c.grantAId === id || c.grantBId === id),
    );
  if (x.status === "active" && blocking.length)
    throw new ApiError(
      409,
      `Rights conflict: ${blocking[0].message} Conflicting grant ${blocking[0].grantAId === id ? blocking[0].grantBId : blocking[0].grantAId}.`,
    );
  const statements: any[] = [
    db
      .prepare(
        `INSERT INTO rights_grants(id,edition_id,rightsholder_id,rightsholder_party_id,territory_code,format,sales_channel,starts_at,ends_at,license_type,drm_requirement,subscription_permitted,library_permitted,decision,status,promotion_restrictions_json,contract_reference,source,notes,created_at,updated_at,contract_id,contract_version_id,exclusivity,scope_summary)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET edition_id=excluded.edition_id,rightsholder_id=excluded.rightsholder_id,rightsholder_party_id=excluded.rightsholder_party_id,territory_code=excluded.territory_code,format=excluded.format,sales_channel=excluded.sales_channel,starts_at=excluded.starts_at,ends_at=excluded.ends_at,license_type=excluded.license_type,drm_requirement=excluded.drm_requirement,subscription_permitted=excluded.subscription_permitted,library_permitted=excluded.library_permitted,decision=excluded.decision,status=excluded.status,promotion_restrictions_json=excluded.promotion_restrictions_json,contract_reference=excluded.contract_reference,source=excluded.source,notes=excluded.notes,updated_at=excluded.updated_at,contract_id=excluded.contract_id,contract_version_id=excluded.contract_version_id,exclusivity=excluded.exclusivity,scope_summary=excluded.scope_summary`,
      )
      .bind(
        id,
        x.editionId,
        x.rightsholderId || null,
        x.rightsholderPartyId || null,
        scope.legacyCode,
        x.format,
        x.salesChannel,
        x.startsAt || null,
        x.endsAt || null,
        x.licenseType,
        x.drmRequirement,
        x.subscriptionPermitted ? 1 : 0,
        x.libraryPermitted ? 1 : 0,
        x.decision,
        x.status,
        JSON.stringify(x.promotionRestrictions),
        x.contractReference,
        x.source,
        x.notes,
        before?.created_at || at,
        at,
        x.contractId || null,
        contractVersionId,
        x.exclusivity,
        scope.summary,
      ),
    db.prepare("DELETE FROM rights_grant_territory_scopes WHERE grant_id=?").bind(id),
    db.prepare("DELETE FROM rights_grant_territories WHERE grant_id=?").bind(id),
  ];
  scope.rules.forEach((r, i) =>
    statements.push(
      db
        .prepare(
          `INSERT INTO rights_grant_territory_scopes(id,grant_id,effect,target_type,territory_code,territory_set_id,historical_code,as_of_date,position,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          `rgscope_${crypto.randomUUID()}`,
          id,
          r.effect,
          r.targetType,
          r.territoryCode ? normalizeTerritoryCode(r.territoryCode) : null,
          r.territorySetId || null,
          r.historicalCode ? String(r.historicalCode).toUpperCase() : null,
          r.asOfDate || null,
          i,
          at,
        ),
    ),
  );
  for (let i = 0; i < scope.territories.length; i += 80) {
    const chunk = scope.territories.slice(i, i + 80),
      values = chunk.map(() => "(?,?,?,?)").join(","),
      st = db.prepare(
        `INSERT INTO rights_grant_territories(grant_id,territory_code,resolved_from,snapshotted_at) VALUES ${values}`,
      ),
      binds: any[] = [];
    for (const code of chunk) binds.push(id, code, scope.summary, at);
    statements.push(st.bind(...binds));
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO rights_grant_scope_snapshots(id,grant_id,scope_json,territories_json,recorded_at) VALUES(?,?,?,?,?)",
      )
      .bind(
        `rgss_${crypto.randomUUID()}`,
        id,
        JSON.stringify({ mode: x.scopeMode, rules: scope.rules, summary: scope.summary }),
        JSON.stringify(scope.territories),
        at,
      ),
  );
  await db.batch(statements);
  return {
    id,
    territoryCount: scope.territories.length,
    territories: scope.territories,
    scopeSummary: scope.summary,
    conflicts: preflight.filter((c) => c.grantAId === id || c.grantBId === id),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
// The only physical executor of distribution-contract D1 mutations is compiled
// into this private service-binding-only Durable Object. Never import or export
// this function to an API, scheduled worker, or a second D1 binding.
const nowContract=()=>new Date().toISOString();
const contractIdFor=(prefix:string)=>prefix+"_"+crypto.randomUUID();
async function writeContractVersionPrimary(db: CatalogDB, actorUserId: string, raw: unknown) {
  const x = ownerContractVersionSchema.parse(raw);
  const contract = await db
    .prepare("SELECT * FROM rights_contracts WHERE id=?")
    .bind(x.contractId)
    .first<{id:string}>();
  if (!contract) throw new ApiError(404, "Rights contract not found.");
  if (x.effectiveTo && x.effectiveTo <= x.effectiveFrom)
    throw new ApiError(400, "Contract version end date must follow its effective date.");
  const existing = await db
    .prepare("SELECT * FROM rights_contract_versions WHERE contract_id=? AND version_number=?")
    .bind(x.contractId, x.versionNumber)
    .first<{id:string;status:string;created_at:string}>();
  if (existing && existing.status !== "draft")
    throw new ApiError(
      409,
      "Activated contract versions are immutable. Create a new version instead.",
    );
  if (x.status === "active") {
    const futureConflict = await db
      .prepare(
        "SELECT id FROM rights_contract_versions WHERE contract_id=? AND status='active' AND id<>COALESCE(?, '') AND effective_from>=? AND (? IS NULL OR effective_from<?) LIMIT 1",
      )
      .bind(
        x.contractId,
        existing?.id || null,
        x.effectiveFrom,
        x.effectiveTo || null,
        x.effectiveTo || "9999",
      )
      .first<{id:string}>();
    if (futureConflict)
      throw new ApiError(
        409,
        "This contract already has an active version beginning inside the proposed effective window.",
      );
  }
  const versionId = existing?.id || contractIdFor("rcontractv"),
    at = nowContract(),
    approvedAt = x.status === "active" ? at : null;
  const statements:Parameters<CatalogDB["batch"]>[0] = [
    db
      .prepare(
        `INSERT INTO rights_contract_versions(id,contract_id,version_number,status,effective_from,effective_to,retailer_commission_bps,payment_schedule_json,returns_policy_json,subscription_terms_json,marketing_permissions_json,drm_requirements_json,delivery_rules_json,termination_policy_json,post_termination_access_policy,document_sha256,source_document_object_key,approved_by_user_id,approved_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,effective_from=excluded.effective_from,effective_to=excluded.effective_to,retailer_commission_bps=excluded.retailer_commission_bps,payment_schedule_json=excluded.payment_schedule_json,returns_policy_json=excluded.returns_policy_json,subscription_terms_json=excluded.subscription_terms_json,marketing_permissions_json=excluded.marketing_permissions_json,drm_requirements_json=excluded.drm_requirements_json,delivery_rules_json=excluded.delivery_rules_json,termination_policy_json=excluded.termination_policy_json,post_termination_access_policy=excluded.post_termination_access_policy,document_sha256=excluded.document_sha256,source_document_object_key=excluded.source_document_object_key,approved_by_user_id=excluded.approved_by_user_id,approved_at=excluded.approved_at`,
      )
      .bind(
        versionId,
        x.contractId,
        x.versionNumber,
        "draft",
        x.effectiveFrom,
        x.effectiveTo || null,
        x.retailerCommissionBps,
        JSON.stringify(x.paymentSchedule),
        JSON.stringify(x.returnsPolicy),
        JSON.stringify(x.subscriptionTerms),
        JSON.stringify(x.marketingPermissions),
        JSON.stringify(x.drmRequirements),
        JSON.stringify(x.deliveryRules),
        JSON.stringify(x.terminationPolicy),
        x.postTerminationAccessPolicy,
        x.documentSha256,
        x.sourceDocumentObjectKey || null,
        null,
        null,
        existing?.created_at || at,
      ),
    db
      .prepare("DELETE FROM rights_contract_version_territories WHERE contract_version_id=?")
      .bind(versionId),
    db
      .prepare("DELETE FROM rights_contract_version_formats WHERE contract_version_id=?")
      .bind(versionId),
    db
      .prepare("DELETE FROM rights_contract_version_channels WHERE contract_version_id=?")
      .bind(versionId),
  ];
  for (const t of x.territories)
    statements.push(
      db
        .prepare(
          "INSERT INTO rights_contract_version_territories(contract_version_id,territory_code,decision) VALUES(?,?,?)",
        )
        .bind(versionId, t.territoryCode, t.decision),
    );
  for (const f of x.formats)
    statements.push(
      db
        .prepare(
          "INSERT INTO rights_contract_version_formats(contract_version_id,format,decision,drm_requirement,download_limit,device_limit,offline_permitted) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          versionId,
          f.format,
          f.decision,
          f.drmRequirement,
          f.downloadLimit ?? null,
          f.deviceLimit ?? null,
          f.offlinePermitted ? 1 : 0,
        ),
    );
  for (const c of x.channels)
    statements.push(
      db
        .prepare(
          "INSERT INTO rights_contract_version_channels(contract_version_id,sales_channel,permitted,terms_json) VALUES(?,?,?,?)",
        )
        .bind(versionId, c.salesChannel, c.permitted ? 1 : 0, JSON.stringify(c.terms)),
    );
  if (x.status === "active")
    statements.push(
      db
        .prepare(
          "UPDATE rights_contract_versions SET status='superseded',effective_to=CASE WHEN effective_to IS NULL OR effective_to>? THEN ? ELSE effective_to END WHERE contract_id=? AND id<>? AND status='active' AND effective_from<?",
        )
        .bind(x.effectiveFrom, x.effectiveFrom, x.contractId, versionId, x.effectiveFrom),
    );
  if (x.status !== "draft")
    statements.push(
      db
        .prepare(
          "UPDATE rights_contract_versions SET status=?,approved_by_user_id=?,approved_at=? WHERE id=? AND status='draft'",
        )
        .bind(
          x.status,
          x.status === "active" ? actorUserId : null,
          x.status === "active" ? approvedAt : null,
          versionId,
        ),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO rights_contract_audit(id,contract_id,contract_version_id,action,actor_user_id,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        contractIdFor("rcaudit"),
        x.contractId,
        versionId,
        existing ? "version_updated" : "version_created",
        actorUserId,
        JSON.stringify(x),
        at,
      ),
  );
  await db.batch(statements);
  return {
    id: versionId,
    contractId: x.contractId,
    versionNumber: x.versionNumber,
    status: x.status,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Private migrated owner-only materializer preserves legacy API record shapes. */
const publishingNow=()=>new Date().toISOString();
const publishingId=(prefix:string)=>prefix+"_"+crypto.randomUUID();
async function materializePublishingSubmissionOwned(
  env: PublishingEnv,
  submissionId: string,
  reviewerUserId: string,
  owned?: {
    workId: string;
    editionId: string;
    productId: string;
    commandSha256: string;
    preparePresentation?: () => Promise<void>;
  },
) {
  const db = env.DB;
  const submission = await db
    .prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?")
    .bind(submissionId)
    .first<any>();
  if (!submission) throw new ApiError(404, "Publishing submission not found.");
  const existing = await db
    .prepare("SELECT * FROM publishing_publications WHERE submission_id=?")
    .bind(submissionId)
    .first<any>();
  if (existing) return existing;
  if (!["approved", "in_review", "submitted"].includes(String(submission.status)))
    throw new ApiError(409, "This submission cannot be published from its current state.");
  const snapshot = safeJson<any>(submission.snapshot_json, {}),
    currentAccount = await db
      .prepare("SELECT * FROM publishing_accounts WHERE id=?")
      .bind(submission.account_id)
      .first<any>();
  if (!currentAccount) throw new ApiError(409, "Publishing account no longer exists.");
  if (submission.status !== "approved")
    throw new ApiError(409, "Only an approved immutable submission can be materialized.");
  if (
    currentAccount.identity_status !== "verified" ||
    currentAccount.tax_status !== "verified" ||
    currentAccount.payout_status !== "verified"
  )
    throw new ApiError(
      409,
      "Publisher compliance status changed after submission; re-review is required.",
    );
  const draftState = await db
    .prepare("SELECT id,revision,status FROM publishing_edition_drafts WHERE id=?")
    .bind(submission.edition_id)
    .first<any>();
  if (
    !draftState ||
    Number(draftState.revision) !== Number(submission.revision) ||
    draftState.status !== "approved"
  )
    throw new ApiError(
      409,
      "The publishing draft revision no longer matches the approved submission.",
    );
  const frozenTax = snapshot.tax || {},
    frozenPayout = snapshot.payout || {};
  const activeTax = frozenTax.id
    ? await db
        .prepare("SELECT id,status FROM publishing_tax_profiles WHERE id=? AND account_id=?")
        .bind(frozenTax.id, currentAccount.id)
        .first<any>()
    : await db
        .prepare(
          "SELECT id,status FROM publishing_tax_profiles WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(currentAccount.id)
        .first<any>();
  const activePayout = frozenPayout.id
    ? await db
        .prepare("SELECT id,status FROM publishing_payout_accounts WHERE id=? AND account_id=?")
        .bind(frozenPayout.id, currentAccount.id)
        .first<any>()
    : await db
        .prepare(
          "SELECT id,status FROM publishing_payout_accounts WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(currentAccount.id)
        .first<any>();
  if (activeTax?.status !== "verified" || activePayout?.status !== "verified")
    throw new ApiError(
      409,
      "The tax or payout profile attached to this submission is no longer verified; submit a new revision.",
    );
  const frozenAccount = snapshot.account || {},
    account = {
      ...frozenAccount,
      id: currentAccount.id,
      publisher_id: currentAccount.publisher_id,
      finance_party_id: currentAccount.finance_party_id,
      rights_party_id: currentAccount.rights_party_id,
    };
  const tax = frozenTax,
    payout = frozenPayout,
    frozenTitle = snapshot.title || {},
    frozenEdition = snapshot.edition || {};
  if (
    !frozenTitle.id ||
    !frozenEdition.id ||
    !Array.isArray(snapshot.contributors) ||
    !Array.isArray(snapshot.assets)
  )
    throw new ApiError(409, "The immutable submission snapshot is incomplete.");
  const edition = {
    ...frozenTitle,
    ...frozenEdition,
    publishing_edition_id: frozenEdition.id,
    publishing_title_id: frozenTitle.id,
    title: frozenTitle.title,
    subtitle: frozenTitle.subtitle || "",
    description: frozenTitle.description || "",
    title_language: frozenTitle.language || frozenEdition.language,
    categories_json: frozenTitle.categories_json || "[]",
    keywords_json: frozenTitle.keywords_json || "[]",
    publisher_name: frozenTitle.publisher_name || "",
    imprint_name: frozenTitle.imprint_name || "",
    series_name: frozenTitle.series_name || "",
    series_relationship: frozenTitle.series_relationship || "main",
    series_position: frozenTitle.series_position ?? null,
  };
  const frozenContributors = snapshot.contributors,
    frozenAssets = snapshot.assets;
  const lifecycle = await ensurePublishingLifecycle(db, String(frozenEdition.id));
  if (["suppressed", "takedown", "retired"].includes(String(lifecycle.state)))
    throw new ApiError(
      409,
      "This release is under staff enforcement and cannot be materialized until Cove restores it.",
    );
  const priorVersion = await db
    .prepare(
      "SELECT * FROM publishing_publication_versions WHERE lifecycle_id=? ORDER BY version_number DESC LIMIT 1",
    )
    .bind(lifecycle.id)
    .first<any>();
  const servingVersion = await publicationVersionManifest(
    db,
    lifecycle.current_publication_version_id,
  );
  const at = publishingNow(),
    releaseAt = edition.release_date ? new Date(edition.release_date).getTime() : Date.now(),
    futureRelease = Number.isFinite(releaseAt) && releaseAt > Date.now(),
    preorderAt = edition.preorder_date ? new Date(edition.preorder_date).getTime() : NaN;
  const desiredState = priorVersion
      ? futureRelease
        ? "scheduled"
        : "updated"
      : futureRelease
        ? Number.isFinite(preorderAt) && preorderAt <= Date.now()
          ? "preorder"
          : "scheduled"
        : "live",
    stageOnly = !!priorVersion && futureRelease,
    commercialActive = !stageOnly && ["preorder", "live", "updated"].includes(desiredState);
  const { publisherId, financePartyId, rightsPartyId } = await ensureCatalogParties(
    db,
    account,
    tax,
    payout,
  );
  let imprintId: string | null = null;
  if (String(edition.imprint_name || "").trim()) {
    const old = await db
      .prepare("SELECT id FROM imprints WHERE publisher_id=? AND lower(name)=lower(?)")
      .bind(publisherId, edition.imprint_name)
      .first<any>();
    imprintId = old?.id || publishingId("imprint");
    if (!old)
      await db
        .prepare(
          "INSERT INTO imprints(id,publisher_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
        )
        .bind(imprintId, publisherId, edition.imprint_name, at, at)
        .run();
  }
  const workId = edition.catalog_work_id || owned?.workId || publishingId("work"),
    catalogEditionId = edition.catalog_edition_id || owned?.editionId || publishingId("edition"),
    productId = edition.catalog_product_id || owned?.productId || publishingId("product");
  if (!stageOnly) {
    if (!edition.catalog_work_id)
      await db
        .prepare(
          `INSERT INTO works(id,title,subtitle,description,original_language,min_age,max_age,work_type,canonical_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?, ?,?)`,
        )
        .bind(
          workId,
          edition.title,
          edition.subtitle || "",
          edition.description || "",
          edition.title_language || edition.language,
          null,
          null,
          edition.rights_basis === "public_domain" ? "public_domain" : "original",
          "canonical",
          at,
          at,
        )
        .run();
    else
      await db
        .prepare(
          "UPDATE works SET title=?,subtitle=?,description=?,original_language=COALESCE(?,original_language),work_type=CASE WHEN ?='public_domain' THEN 'public_domain' ELSE work_type END,updated_at=? WHERE id=?",
        )
        .bind(
          edition.title,
          edition.subtitle || "",
          edition.description || "",
          edition.title_language || edition.language,
          edition.rights_basis,
          at,
          workId,
        )
        .run();
    await db
      .prepare(
        `INSERT INTO editions(id,work_id,publisher_id,imprint_id,title,subtitle,description,edition_number,language,publication_date,release_date,preorder_date,isbn13,publisher_identifier,layout,drm_status,downloadable,release_status,subscription_eligible,library_eligible,publisher_description,edition_type,differentiation_status,differentiation_summary,canonical_public_domain,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET publisher_id=excluded.publisher_id,imprint_id=excluded.imprint_id,title=excluded.title,subtitle=excluded.subtitle,description=excluded.description,edition_number=excluded.edition_number,language=excluded.language,release_date=excluded.release_date,preorder_date=excluded.preorder_date,isbn13=excluded.isbn13,publisher_identifier=excluded.publisher_identifier,drm_status=excluded.drm_status,downloadable=excluded.downloadable,release_status=excluded.release_status,subscription_eligible=excluded.subscription_eligible,library_eligible=excluded.library_eligible,publisher_description=excluded.publisher_description,edition_type=excluded.edition_type,differentiation_status=excluded.differentiation_status,differentiation_summary=excluded.differentiation_summary,canonical_public_domain=excluded.canonical_public_domain,updated_at=excluded.updated_at`,
      )
      .bind(
        catalogEditionId,
        workId,
        publisherId,
        imprintId,
        edition.title,
        edition.subtitle || "",
        edition.description || "",
        edition.edition_label || "",
        edition.language,
        edition.release_date,
        edition.release_date,
        edition.preorder_date,
        edition.isbn13 || null,
        edition.publisher_identifier || "",
        "reflowable",
        edition.drm_requirement || "none",
        Number(edition.downloadable),
        desiredState === "scheduled"
          ? "scheduled"
          : desiredState === "preorder"
            ? "preorder"
            : "available",
        Number(edition.subscription_permitted),
        Number(edition.library_permitted),
        edition.description || "",
        edition.edition_type || "original",
        edition.rights_basis === "public_domain" ? "pending" : "not_required",
        edition.differentiation_summary || "",
        0,
        at,
        at,
      )
      .run();
    await db
      .prepare("DELETE FROM edition_languages WHERE edition_id=? AND kind='content'")
      .bind(catalogEditionId)
      .run();
    await db
      .prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,'content')")
      .bind(catalogEditionId, String(edition.language).toLowerCase())
      .run();
    await db
      .prepare("DELETE FROM edition_contributors WHERE edition_id=?")
      .bind(catalogEditionId)
      .run();
    await db
      .prepare("DELETE FROM series_memberships WHERE edition_id=?")
      .bind(catalogEditionId)
      .run();
    await db
      .prepare("DELETE FROM edition_categories WHERE edition_id=?")
      .bind(catalogEditionId)
      .run();
    await db
      .prepare("DELETE FROM edition_keywords WHERE edition_id=?")
      .bind(catalogEditionId)
      .run();
  }
  const contributors = frozenContributors,
    contributorLinks: any[] = [];
  for (const c of contributors) {
    let contributorId: string | null = null,
      pen: any = null;
    if (c.pen_name_id) {
      pen = await db
        .prepare("SELECT id,contributor_id FROM publishing_pen_names WHERE id=? AND account_id=?")
        .bind(c.pen_name_id, account.id)
        .first<any>();
      if (pen?.contributor_id) {
        const linked = await db
          .prepare("SELECT id,name FROM contributors WHERE id=?")
          .bind(pen.contributor_id)
          .first<any>();
        if (linked && String(linked.name).toLowerCase() === String(c.display_name).toLowerCase())
          contributorId = linked.id;
      }
    }
    if (!contributorId) {
      const old = await db
        .prepare(
          "SELECT id FROM contributors WHERE lower(name)=lower(?) ORDER BY created_at LIMIT 1",
        )
        .bind(c.display_name)
        .first<any>();
      contributorId = old?.id || publishingId("contrib");
      if (!old)
        await db
          .prepare(
            "INSERT INTO contributors(id,name,sort_name,bio,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .bind(contributorId, c.display_name, c.display_name, "", at, at)
          .run();
      if (pen && !pen.contributor_id)
        await db
          .prepare("UPDATE publishing_pen_names SET contributor_id=?,updated_at=? WHERE id=?")
          .bind(contributorId, at, pen.id)
          .run();
    }
    contributorLinks.push({ contributorId, role: c.role, position: Number(c.position || 0) });
    if (!stageOnly)
      await db
        .prepare(
          "INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?,?,?)",
        )
        .bind(catalogEditionId, contributorId, c.role, Number(c.position || 0))
        .run();
  }
  let seriesLink: any = null;
  if (edition.series_name) {
    const seriesRow = await db
      .prepare("SELECT id FROM series WHERE publisher_id=? AND lower(name)=lower(?)")
      .bind(publisherId, edition.series_name)
      .first<any>();
    const seriesId = seriesRow?.id || publishingId("series");
    if (!seriesRow)
      await db
        .prepare(
          "INSERT INTO series(id,name,description,publisher_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(seriesId, edition.series_name, "", publisherId, at, at)
        .run();
    seriesLink = {
      seriesId,
      position: edition.series_position || null,
      label: "",
      relationship: edition.series_relationship || "main",
      readingOrder: edition.series_position || null,
      displayOrder: Number(edition.series_position || 0) * 100,
    };
    if (!stageOnly)
      await db
        .prepare(
          `INSERT INTO series_memberships(series_id,edition_id,position,label,relationship,reading_order,display_order) VALUES(?,?,?,?,?,?,?)`,
        )
        .bind(
          seriesId,
          catalogEditionId,
          seriesLink.position,
          "",
          seriesLink.relationship,
          seriesLink.readingOrder,
          seriesLink.displayOrder,
        )
        .run();
  }
  const categoryLinks: any[] = [];
  for (const [i, name] of safeJson<string[]>(edition.categories_json, []).entries()) {
    const cat = await db
      .prepare("SELECT id FROM categories WHERE scheme='publisher' AND lower(name)=lower(?)")
      .bind(name)
      .first<any>();
    const catId = cat?.id || publishingId("cat");
    if (!cat)
      await db
        .prepare(
          "INSERT INTO categories(id,scheme,code,name,parent_id) VALUES(?,'publisher','',?,NULL)",
        )
        .bind(catId, name)
        .run();
    categoryLinks.push({ categoryId: catId, position: i });
    if (!stageOnly)
      await db
        .prepare("INSERT INTO edition_categories(edition_id,category_id,position) VALUES(?,?,?)")
        .bind(catalogEditionId, catId, i)
        .run();
  }
  const keywordLinks: any[] = [];
  for (const kw of safeJson<string[]>(edition.keywords_json, [])) {
    const row = await db
      .prepare("SELECT id FROM keywords WHERE value=? COLLATE NOCASE")
      .bind(kw)
      .first<any>();
    const kid = row?.id || publishingId("kw");
    if (!row) await db.prepare("INSERT INTO keywords(id,value) VALUES(?,?)").bind(kid, kw).run();
    keywordLinks.push({ keywordId: kid });
    if (!stageOnly)
      await db
        .prepare("INSERT INTO edition_keywords(edition_id,keyword_id) VALUES(?,?)")
        .bind(catalogEditionId, kid)
        .run();
  }
  const storefrontStatus = desiredState === "scheduled" && !priorVersion ? "inactive" : "active";
  await db
    .prepare(
      `INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,?,?,'fore_publishing',?,?,?) ON CONFLICT(id) DO UPDATE SET storefront_status=excluded.storefront_status,updated_at=excluded.updated_at`,
    )
    .bind(
      productId,
      catalogEditionId,
      `FORE-${productId.slice(-18)}`,
      edition.format,
      storefrontStatus,
      edition.publishing_edition_id,
      at,
      at,
    )
    .run();
  const assets = frozenAssets;
  let manuscriptVersion: any = null,
    coverVersion: any = null;
  const catalogAssets: any[] = [];
  for (const pa of assets) {
    if (!pa.current_version_id) continue;
    const sourceVersion = await db
      .prepare(
        "SELECT id,object_key,mime_type,size_bytes,sha256 FROM publishing_asset_versions WHERE id=? AND asset_id=?",
      )
      .bind(pa.current_version_id, pa.id)
      .first<any>();
    if (
      !sourceVersion ||
      sourceVersion.object_key !== pa.object_key ||
      sourceVersion.sha256 !== pa.sha256 ||
      Number(sourceVersion.size_bytes) !== Number(pa.size_bytes)
    )
      throw new ApiError(409, "A submitted asset no longer matches its immutable snapshot.");
    const liveKey = `publishing/live/${catalogEditionId}/${pa.kind}/${pa.sha256}.${pa.kind === "cover" ? (String(pa.mime_type) === "image/png" ? "png" : "jpg") : pa.kind === "manuscript" ? "epub" : "bin"}`;
    if (env.BUCKET) {
      const bytes = await bucketBytes(env, String(pa.object_key));
      await env.BUCKET.put(liveKey, bytes, {
        httpMetadata: { contentType: pa.mime_type },
        customMetadata: { sha256: pa.sha256, source: "fore-publishing-live" },
      });
    }
    const catalogKind = pa.kind === "manuscript" ? "epub" : pa.kind,
      daId = `asset_${pa.kind}_${catalogEditionId}`,
      avId = `assetver_${pa.kind}_${catalogEditionId}_${pa.sha256.slice(0, 12)}`;
    const priorAsset = await db
      .prepare("SELECT id,current_version_id FROM digital_assets WHERE edition_id=? AND kind=?")
      .bind(catalogEditionId, catalogKind)
      .first<any>();
    if (!priorAsset)
      await db
        .prepare(
          "INSERT INTO digital_assets(id,edition_id,kind,current_version_id,drm_status,downloadable,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          daId,
          catalogEditionId,
          catalogKind,
          stageOnly ? null : avId,
          edition.drm_requirement || "none",
          Number(edition.downloadable),
          at,
          at,
        )
        .run();
    else if (!stageOnly)
      await db
        .prepare(
          "UPDATE digital_assets SET current_version_id=?,drm_status=?,downloadable=?,updated_at=? WHERE id=?",
        )
        .bind(
          avId,
          edition.drm_requirement || "none",
          Number(edition.downloadable),
          at,
          priorAsset.id,
        )
        .run();
    const existingAssetVersion = await db
      .prepare("SELECT id,version_number FROM asset_versions WHERE id=?")
      .bind(avId)
      .first<any>();
    if (!existingAssetVersion) {
      const maxVersion = Number(
        (
          await db
            .prepare(
              "SELECT COALESCE(MAX(version_number),0) n FROM asset_versions WHERE asset_id=?",
            )
            .bind(priorAsset?.id || daId)
            .first<any>()
        )?.n || 0,
      );
      const publicUrl =
        pa.kind === "cover" ? `/api/fore/catalog-assets/${encodeURIComponent(avId)}` : null;
      await db
        .prepare(
          "INSERT INTO asset_versions(id,asset_id,version_number,object_key,source_url,mime_type,size_bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          avId,
          priorAsset?.id || daId,
          maxVersion + 1,
          liveKey,
          publicUrl,
          pa.mime_type,
          pa.size_bytes,
          pa.sha256,
          at,
        )
        .run();
    }
    catalogAssets.push({
      kind: catalogKind,
      digitalAssetId: priorAsset?.id || daId,
      catalogAssetVersionId: avId,
      publishingAssetVersionId: pa.current_version_id,
      sha256: pa.sha256,
      mimeType: pa.mime_type,
      sizeBytes: pa.size_bytes,
    });
    if (pa.kind === "manuscript") manuscriptVersion = pa;
    if (pa.kind === "cover") coverVersion = pa;
    await db
      .prepare("UPDATE publishing_asset_versions SET quarantine_status='promoted' WHERE id=?")
      .bind(pa.current_version_id)
      .run();
  }
  let accessibilityProfile: any = null,
    formatProfile: any = null,
    manuscriptCatalogAssetVersionId: string | null = null;
  if (manuscriptVersion?.current_version_id) {
    const inspection = await db
      .prepare(
        "SELECT inspection_version,accessibility_json,format_profile_json,issue_summary_json,created_at FROM publishing_epub_inspections WHERE asset_version_id=?",
      )
      .bind(manuscriptVersion.current_version_id)
      .first<any>();
    if (inspection) {
      accessibilityProfile = safeJson<any>(inspection.accessibility_json, {});
      formatProfile = safeJson<any>(inspection.format_profile_json, {});
      const mapped = catalogAssets.find(
        (a: any) =>
          a.kind === "epub" && a.publishingAssetVersionId === manuscriptVersion.current_version_id,
      );
      manuscriptCatalogAssetVersionId = mapped?.catalogAssetVersionId || null;
      const frozenDeclaration = safeJson<any>(
        snapshot.accessibilityDeclaration?.declaration_json,
        {},
      );
      if (
        String(frozenDeclaration.sourceAssetVersionId || "") !==
        String(manuscriptVersion.current_version_id)
      )
        throw new ApiError(
          409,
          "The approved accessibility declaration does not match the submitted manuscript asset.",
        );
      const publisher = frozenDeclaration.publisher || {};
      accessibilityProfile.publisherDeclaration = {
        summary: String(publisher.summary || ""),
        knownLimitations: String(publisher.knownLimitations || ""),
        claimsConformance: !!publisher.claimsConformance,
        certifier: String(publisher.certifier || ""),
        credential: String(publisher.credential || ""),
        policyVersion: String(
          snapshot.accessibilityDeclaration?.policy_version || "fore-epub-accessibility-v1",
        ),
        declaredAt: String(snapshot.accessibilityDeclaration?.created_at || ""),
      };
      accessibilityProfile.validationReport = {
        sourcePublishingAssetVersionId: manuscriptVersion.current_version_id,
        inspectionVersion: String(inspection.inspection_version || ""),
        inspectedAt: String(inspection.created_at || ""),
        issues: safeJson<any[]>(inspection.issue_summary_json, []),
      };
    }
  }
  let rightsContract: any,
    rightsContractManagedByPublication = false;
  if (edition.contract_id) {
    const assigned = await db
      .prepare(
        `SELECT rc.*,rcv.id active_version_id FROM publisher_contract_assignments a JOIN rights_contracts rc ON rc.id=a.contract_id LEFT JOIN rights_contract_versions rcv ON rcv.id=? AND rcv.contract_id=rc.id AND rcv.status='active' AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?) WHERE a.account_id=? AND a.contract_id=? AND a.status='active' AND rc.status='active' AND (a.starts_at IS NULL OR a.starts_at<=?) AND (a.ends_at IS NULL OR a.ends_at>?)`,
      )
      .bind(edition.contract_version_id || null, at, at, account.id, edition.contract_id, at, at)
      .first<any>();
    if (!assigned)
      throw new ApiError(
        409,
        "The approved submission's distribution contract is no longer assigned to this publisher.",
      );
    if (edition.contract_version_id && !assigned.active_version_id)
      throw new ApiError(
        409,
        "The approved submission's contract version is no longer active/effective; resubmit against the current approved contract version.",
      );
    rightsContract = { id: String(assigned.id) };
  } else {
    rightsContract = await upsertRightsContractPrivate(db, {
      referenceCode: `FORE-PUBLISH-${submissionId}`,
      name: `Cove Publishing rights — ${edition.title}`,
      rightsholderPartyId: rightsPartyId,
      status: "draft",
      effectiveFrom: edition.rights_start_at || edition.release_date || at,
      effectiveTo: edition.rights_end_at || null,
      languageMatchMode: "all",
      source: "fore-publishing",
      languages: [
        {
          languageCode: String(edition.language).toLowerCase(),
          decision: "allow",
          format: edition.format,
        },
      ],
    });
    rightsContractManagedByPublication = true;
  }
  const scope = safeJson<any>(edition.territory_scope_json, { mode: "worldwide", exclude: [] }),
    channels = safeJson<string[]>(edition.sales_channels_json, ["retail"]),
    rightsGrantIds: string[] = [];
  for (const channel of channels) {
    const grant = await upsertRightsGrantPrivate(db, {
      editionId: catalogEditionId,
      rightsholderPartyId: rightsPartyId,
      format: edition.format,
      salesChannel: channel,
      startsAt: edition.rights_start_at || edition.release_date || null,
      endsAt: edition.rights_end_at || null,
      licenseType:
        edition.rights_basis === "licensed"
          ? "publisher-license"
          : edition.rights_basis === "public_domain"
            ? "public-domain"
            : "copyright-owner",
      contractId: rightsContract.id,
      contractVersionId: edition.contract_version_id || null,
      drmRequirement: edition.drm_requirement || "none",
      subscriptionPermitted: !!edition.subscription_permitted,
      libraryPermitted: !!edition.library_permitted,
      decision: "allow",
      status: "draft",
      source: "fore-publishing",
      notes: `Materialized from ${submissionId}`,
      ...scopeToGrant(scope),
    });
    rightsGrantIds.push(grant.id);
  }
  if (!stageOnly && edition.rights_basis === "public_domain") {
    const manuscript = catalogAssets.find((a: any) => a.kind === "epub"),
      translator = contributorLinks.find((c: any) => c.role === "translator");
    await db
      .prepare(
        `INSERT INTO edition_distinctions(edition_id,edition_type,differentiation_summary,translator_contributor_id,source_text_fingerprint,asset_sha256,verification_status,verified_by_user_id,verified_at,policy_version,created_at,updated_at) VALUES(?,?,?,?,?,?,'verified',?,?,'fore-public-domain-editions-v1',?,?) ON CONFLICT(edition_id) DO UPDATE SET edition_type=excluded.edition_type,differentiation_summary=excluded.differentiation_summary,translator_contributor_id=excluded.translator_contributor_id,asset_sha256=excluded.asset_sha256,verification_status='verified',verified_by_user_id=excluded.verified_by_user_id,verified_at=excluded.verified_at,updated_at=excluded.updated_at`,
      )
      .bind(
        catalogEditionId,
        edition.edition_type || "original",
        edition.differentiation_summary || "",
        translator?.contributorId || null,
        "",
        manuscript?.sha256 || "",
        reviewerUserId,
        at,
        at,
        at,
      )
      .run();
    await db.batch([
      db
        .prepare("UPDATE editions SET differentiation_status='verified',updated_at=? WHERE id=?")
        .bind(at, catalogEditionId),
      db
        .prepare(
          "INSERT INTO edition_duplicate_policy_decisions(id,edition_id,policy_version,decision,reason_code,evidence_json,decided_by,created_at) VALUES(?,?,'fore-public-domain-editions-v1','allow','DIFFERENTIATED_PUBLIC_DOMAIN_EDITION',?,'system',?)",
        )
        .bind(
          publishingId("pddecision"),
          catalogEditionId,
          JSON.stringify({
            editionType: edition.edition_type || "original",
            assetSha256: manuscript?.sha256 || "",
            differentiationSummary: edition.differentiation_summary || "",
          }),
          at,
        ),
    ]);
  }
  const offerId = publishingId("offer");
  await db
    .prepare(
      "INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,active,starts_at,ends_at,created_at,updated_at) VALUES(?,?,'purchase',?,?,0,?,?,?,?)",
    )
    .bind(
      offerId,
      productId,
      edition.list_currency,
      edition.list_price_minor,
      edition.preorder_date || edition.release_date || at,
      edition.rights_end_at || null,
      at,
      at,
    )
    .run();
  let foreCommissionBps = 3000,
    paymentTermsDays = 60,
    royaltyTermsSource = "Cove Publishing default terms";
  if (edition.contract_version_id) {
    const commercialTerms = await db
      .prepare(
        "SELECT retailer_commission_bps,payment_schedule_json FROM rights_contract_versions WHERE id=? AND contract_id=?",
      )
      .bind(edition.contract_version_id, rightsContract.id)
      .first<any>();
    if (!commercialTerms)
      throw new ApiError(
        409,
        "The approved distribution contract version is unavailable for finance materialization.",
      );
    const schedule = safeJson<any>(commercialTerms.payment_schedule_json, {});
    foreCommissionBps = Number(commercialTerms.retailer_commission_bps);
    paymentTermsDays = Math.max(0, Math.min(180, Number(schedule.netDays ?? 30)));
    royaltyTermsSource = `Distribution contract version ${edition.contract_version_id}`;
  }
  const royaltyContractId = publishingId("royalty");
  await db
    .prepare(
      `INSERT INTO finance_royalty_contracts(id,name,publisher_id,product_id,edition_id,format,sales_channel,effective_from,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'retail',?,'draft',?,?)`,
    )
    .bind(
      royaltyContractId,
      `Cove Publishing — ${edition.title}`,
      publisherId,
      productId,
      catalogEditionId,
      edition.format,
      edition.rights_start_at || edition.release_date || at,
      at,
      at,
    )
    .run();
  await createRoyaltyContractVersion(db as any, {
    contractId: royaltyContractId,
    effectiveFrom: edition.rights_start_at || edition.release_date || at,
    effectiveTo: edition.rights_end_at || null,
    basis: "net_revenue",
    foreCommissionBps,
    paymentTermsDays,
    reserveBps: 0,
    notes: `${royaltyTermsSource}; immutable finance terms materialized with publication.`,
    changeReason: "Initial commercial terms created with approved publication.",
    createdByUserId: reviewerUserId,
    splits: [{ partyId: financePartyId, shareBps: 10000 }],
    rules: [
      {
        key: "default_retail",
        priority: 100,
        conditions: { salesChannels: ["retail"] },
        action: {
          basis: "net_receipts",
          foreCommissionBps,
          processorFeeTreatment: "deduct",
          taxTreatment: "deduct",
          foreFundedDiscountTreatment: "add_back",
          publisherFundedDiscountTreatment: "deduct",
          paymentTermsDays,
        },
      },
    ],
  });
  const publicationId = publishingId("publication"),
    materializationKey = `submission:${submissionId}:v2`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO publishing_publications(id,submission_id,publishing_account_id,work_id,edition_id,product_id,rights_contract_id,royalty_contract_id,offer_id,manuscript_asset_version_id,cover_asset_version_id,materialization_key,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        publicationId,
        submissionId,
        account.id,
        workId,
        catalogEditionId,
        productId,
        rightsContract.id,
        royaltyContractId,
        offerId,
        manuscriptVersion?.current_version_id || null,
        coverVersion?.current_version_id || null,
        materializationKey,
        at,
      ),
    db
      .prepare(
        "UPDATE publishing_submission_snapshots SET status='published',published_at=?,decided_at=COALESCE(decided_at,?) WHERE id=?",
      )
      .bind(at, at, submissionId),
    db
      .prepare(
        "UPDATE publishing_edition_drafts SET status='published',catalog_edition_id=?,catalog_product_id=?,updated_at=? WHERE id=?",
      )
      .bind(catalogEditionId, productId, at, edition.publishing_edition_id),
    db
      .prepare(
        "UPDATE publishing_titles SET status='published',catalog_work_id=?,updated_at=? WHERE id=?",
      )
      .bind(workId, at, edition.publishing_title_id),
    db
      .prepare(
        "INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,available_at,created_at) VALUES(?,'publishing.published','publication',?,?,?,?)",
      )
      .bind(
        publishingId("pubout"),
        publicationId,
        JSON.stringify({
          publicationId,
          submissionId,
          workId,
          editionId: catalogEditionId,
          productId,
          releaseState: desiredState,
        }),
        at,
        at,
      ),
  ]);
  await db
    .prepare(
      "UPDATE publisher_catalog_mappings SET catalog_work_id=?,catalog_edition_id=?,catalog_product_id=?,status='active',updated_at=? WHERE account_id=? AND publishing_edition_id=?",
    )
    .bind(workId, catalogEditionId, productId, at, account.id, edition.publishing_edition_id)
    .run();
  const latestLifecycle = await ensurePublishingLifecycle(db, edition.publishing_edition_id),
    versionNumber =
      Number(
        (
          await db
            .prepare(
              "SELECT COALESCE(MAX(version_number),0) n FROM publishing_publication_versions WHERE lifecycle_id=?",
            )
            .bind(latestLifecycle.id)
            .first<any>()
        )?.n || 0,
      ) + 1,
    publicationVersionId = publishingId("pubver");
  const manifest = {
    schemaVersion: 4,
    submissionId,
    snapshotSha256: submission.snapshot_sha256,
    publishingAccountId: account.id,
    workId,
    catalogEditionId,
    productId,
    publisherId,
    imprintId,
    offerId,
    rightsContractId: rightsContract.id,
    rightsContractVersionId: edition.contract_version_id || null,
    rightsContractManagedByPublication,
    rightsGrantIds,
    royaltyContractId,
    catalogAssets,
    contributorLinks,
    seriesLink,
    categoryLinks,
    keywordLinks,
    accessibilityProfile,
    formatProfile,
    manuscriptCatalogAssetVersionId,
    metadata: {
      title: edition.title,
      subtitle: edition.subtitle || "",
      description: edition.description || "",
      editionLabel: edition.edition_label || "",
      language: edition.language,
      isbn13: edition.isbn13 || null,
      publisherIdentifier: edition.publisher_identifier || "",
      releaseDate: edition.release_date || null,
      preorderDate: edition.preorder_date || null,
      drmRequirement: edition.drm_requirement || "none",
      downloadable: Number(edition.downloadable),
      subscriptionPermitted: Number(edition.subscription_permitted),
      libraryPermitted: Number(edition.library_permitted),
      listCurrency: edition.list_currency,
      listPriceMinor: Number(edition.list_price_minor || 0),
    },
    sourceSnapshot: snapshot,
  };
  const publishedAi = snapshot.aiDisclosure;
  if (!publishedAi?.id || !publishedAi?.policy_version)
    throw new ApiError(
      409,
      "The approved submission is missing its immutable AI-content disclosure evidence.",
    );
  const publicAiBadges: any[] = [];
  if (["ai_generated", "mixed"].includes(String(publishedAi.text_origin)))
    publicAiBadges.push({ key: "ai_generated_text", label: "Contains AI-generated text" });
  if (["ai_generated", "mixed"].includes(String(publishedAi.cover_origin)))
    publicAiBadges.push({ key: "ai_generated_cover", label: "AI-generated cover art" });
  if (["ai_generated", "mixed"].includes(String(publishedAi.narration_origin)))
    publicAiBadges.push({
      key: "synthetic_narration",
      label: String(publishedAi.synthetic_voice_label || "Synthetic narration"),
    });
  if (["ai_generated", "mixed"].includes(String(publishedAi.translation_origin)))
    publicAiBadges.push({
      key: "ai_generated_translation",
      label: "Contains AI-generated translation",
    });
  await db.batch([
    db
      .prepare(
        "INSERT INTO publishing_publication_versions(id,lifecycle_id,publication_id,submission_id,version_number,previous_version_id,snapshot_sha256,manifest_json,owner_delivery_policy,release_state,activated_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        publicationVersionId,
        latestLifecycle.id,
        publicationId,
        submissionId,
        versionNumber,
        priorVersion?.id || null,
        submission.snapshot_sha256,
        stableJson(manifest),
        latestLifecycle.owner_update_policy || "auto_update",
        desiredState,
        commercialActive ? at : null,
        reviewerUserId,
        at,
      ),
    db
      .prepare(
        "INSERT INTO publishing_publication_disclosures(publication_version_id,ai_disclosure_id,policy_version,text_origin,cover_origin,narration_origin,translation_origin,synthetic_voice_label,public_badges_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        publicationVersionId,
        publishedAi.id,
        publishedAi.policy_version,
        publishedAi.text_origin,
        publishedAi.cover_origin,
        publishedAi.narration_origin,
        publishedAi.translation_origin,
        publishedAi.synthetic_voice_label || "",
        JSON.stringify(publicAiBadges),
        at,
      ),
  ]);
  if (commercialActive) {
    await activatePublicationCommercialTerms(db, manifest, servingVersion?.manifest || null, at);
    await recordPublicationActivation(db, {
      lifecycleId: latestLifecycle.id,
      publicationVersionId,
      fromPublicationVersionId: servingVersion?.id || null,
      activationType: versionNumber > 1 ? "update" : "initial",
      actorUserId: reviewerUserId,
      reasonCode:
        desiredState === "preorder" ? "preorder_materialized" : "approved_and_materialized",
      metadata: { publicationId, versionNumber, releaseState: desiredState },
      at,
    });
  }
  if (stageOnly)
    await db
      .prepare(
        "UPDATE publishing_release_lifecycles SET state='scheduled',pending_publication_version_id=?,scheduled_at=COALESCE(scheduled_at,?),state_reason='approved_update_waiting_release',updated_at=? WHERE id=?",
      )
      .bind(publicationVersionId, at, at, latestLifecycle.id)
      .run();
  else
    await db
      .prepare(
        "UPDATE publishing_release_lifecycles SET state=?,current_publication_version_id=?,pending_publication_version_id=NULL,state_reason='approved_and_materialized',live_at=CASE WHEN ? IN ('live','updated') THEN COALESCE(live_at,?) ELSE live_at END,preorder_at=CASE WHEN ?='preorder' THEN COALESCE(preorder_at,?) ELSE preorder_at END,scheduled_at=CASE WHEN ?='scheduled' THEN COALESCE(scheduled_at,?) ELSE scheduled_at END,updated_at=? WHERE id=?",
      )
      .bind(
        desiredState,
        publicationVersionId,
        desiredState,
        at,
        desiredState,
        at,
        desiredState,
        at,
        at,
        latestLifecycle.id,
      )
      .run();
  await db
    .prepare(
      "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?, 'staff',?,?,?,?)",
    )
    .bind(
      publishingId("lifeevt"),
      latestLifecycle.id,
      latestLifecycle.state,
      desiredState,
      reviewerUserId,
      "approved_and_materialized",
      JSON.stringify({ publicationId, publicationVersionId, versionNumber, stageOnly }),
      at,
    )
    .run();
  if (["preorder", "scheduled"].includes(desiredState) && edition.release_date)
    try {
      await privatePreorder.ensurePreorderReleasePlan(db as any, productId, reviewerUserId);
    } catch (e) {
      console.error("Unable to materialize preorder operations plan", e);
    }
  if (owned?.preparePresentation) await owned.preparePresentation();
  await audit(db, account.id, reviewerUserId, "publishing_submission", submissionId, "published", {
    publicationId,
    publicationVersionId,
    versionNumber,
    workId,
    editionId: catalogEditionId,
    productId,
    releaseState: desiredState,
    ownerUpdatePolicy: latestLifecycle.owner_update_policy || "auto_update",
    ...(owned ? { ownerCommandSha256: owned.commandSha256 } : {}),
  });
  return {
    ...(await db
      .prepare("SELECT * FROM publishing_publications WHERE id=?")
      .bind(publicationId)
      .first<any>()),
    publicationVersionId,
    versionNumber,
    releaseState: desiredState,
    ownerUpdatePolicy: latestLifecycle.owner_update_policy || "auto_update",
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- Private owner-only publication activation preserves legacy record shapes. */
async function syncCatalogAccessibility(db: PublishingDB, manifest: any, at: string) {
  if (!manifest?.catalogEditionId) return;
  const a = manifest.accessibilityProfile || null,
    f = manifest.formatProfile || null;
  if (a) {
    await db
      .prepare(
        `INSERT INTO accessibility_metadata(edition_id,screen_reader_compatible,alt_text_complete,semantic_structure,accessibility_summary,certifier,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET screen_reader_compatible=excluded.screen_reader_compatible,alt_text_complete=excluded.alt_text_complete,semantic_structure=excluded.semantic_structure,accessibility_summary=excluded.accessibility_summary,certifier=excluded.certifier,updated_at=excluded.updated_at`,
      )
      .bind(
        manifest.catalogEditionId,
        a.nonvisualReading === "supported" ? 1 : a.nonvisualReading === "not_supported" ? 0 : null,
        a.altTextComplete ? 1 : 0,
        a.semanticStructure ? 1 : 0,
        a.summary || "",
        a.certification?.certifier || "",
        at,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO edition_accessibility_profiles(edition_id,source_asset_version_id,visual_adjustments,nonvisual_reading,primary_language_declared,reading_order_verified,table_semantics_complete,mathml_present,mathml_accessible,page_navigation,accessibility_navigation,access_modes_json,access_mode_sufficient_json,features_json,hazards_json,conforms_to_json,certification_json,accessibility_summary,validation_policy_version,validation_status,validation_report_json,publisher_declaration_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET source_asset_version_id=excluded.source_asset_version_id,visual_adjustments=excluded.visual_adjustments,nonvisual_reading=excluded.nonvisual_reading,primary_language_declared=excluded.primary_language_declared,reading_order_verified=excluded.reading_order_verified,table_semantics_complete=excluded.table_semantics_complete,mathml_present=excluded.mathml_present,mathml_accessible=excluded.mathml_accessible,page_navigation=excluded.page_navigation,accessibility_navigation=excluded.accessibility_navigation,access_modes_json=excluded.access_modes_json,access_mode_sufficient_json=excluded.access_mode_sufficient_json,features_json=excluded.features_json,hazards_json=excluded.hazards_json,conforms_to_json=excluded.conforms_to_json,certification_json=excluded.certification_json,accessibility_summary=excluded.accessibility_summary,validation_policy_version=excluded.validation_policy_version,validation_status=excluded.validation_status,validation_report_json=excluded.validation_report_json,publisher_declaration_json=excluded.publisher_declaration_json,updated_at=excluded.updated_at`,
      )
      .bind(
        manifest.catalogEditionId,
        manifest.manuscriptCatalogAssetVersionId || null,
        a.visualAdjustments || "unknown",
        a.nonvisualReading || "unknown",
        a.primaryLanguageDeclared ? 1 : 0,
        a.readingOrderVerified ? 1 : 0,
        a.tableSemanticsComplete ? 1 : 0,
        a.mathmlPresent ? 1 : 0,
        a.mathmlAccessible ? 1 : 0,
        a.pageNavigation ? 1 : 0,
        a.accessibilityNavigation ? 1 : 0,
        JSON.stringify(a.accessModes || []),
        JSON.stringify(a.accessModeSufficient || []),
        JSON.stringify(a.features || []),
        JSON.stringify(a.hazards || []),
        JSON.stringify(a.conformsTo || []),
        JSON.stringify(a.certification || {}),
        a.summary || "",
        a.validationPolicyVersion || "fore-epub-accessibility-v1",
        a.validationStatus || "unknown",
        JSON.stringify(a.validationReport || {}),
        JSON.stringify(a.publisherDeclaration || {}),
        at,
      )
      .run();
  }
  if (f) {
    await db
      .prepare(
        `INSERT INTO edition_format_profiles(edition_id,source_asset_version_id,epub_version,package_version,navigation_type,rendition_layout,page_progression_direction,writing_mode,rtl,vertical_writing,complex_css,embedded_fonts,svg,mathml,complex_tables,footnotes,endnotes,dictionary_content,media_overlays,oversized_images,accessibility_navigation,compatibility_class,reader_support,features_json,warnings_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET source_asset_version_id=excluded.source_asset_version_id,epub_version=excluded.epub_version,package_version=excluded.package_version,navigation_type=excluded.navigation_type,rendition_layout=excluded.rendition_layout,page_progression_direction=excluded.page_progression_direction,writing_mode=excluded.writing_mode,rtl=excluded.rtl,vertical_writing=excluded.vertical_writing,complex_css=excluded.complex_css,embedded_fonts=excluded.embedded_fonts,svg=excluded.svg,mathml=excluded.mathml,complex_tables=excluded.complex_tables,footnotes=excluded.footnotes,endnotes=excluded.endnotes,dictionary_content=excluded.dictionary_content,media_overlays=excluded.media_overlays,oversized_images=excluded.oversized_images,accessibility_navigation=excluded.accessibility_navigation,compatibility_class=excluded.compatibility_class,reader_support=excluded.reader_support,features_json=excluded.features_json,warnings_json=excluded.warnings_json,updated_at=excluded.updated_at`,
      )
      .bind(
        manifest.catalogEditionId,
        manifest.manuscriptCatalogAssetVersionId || null,
        f.epubVersion || "",
        f.packageVersion || "",
        f.navigationType || "unknown",
        f.renditionLayout || "reflowable",
        f.pageProgressionDirection || "default",
        f.writingMode || "horizontal-tb",
        f.rtl ? 1 : 0,
        f.verticalWriting ? 1 : 0,
        f.complexCss ? 1 : 0,
        f.embeddedFonts ? 1 : 0,
        f.svg ? 1 : 0,
        f.mathml ? 1 : 0,
        f.complexTables ? 1 : 0,
        f.footnotes ? 1 : 0,
        f.endnotes ? 1 : 0,
        f.dictionaryContent ? 1 : 0,
        f.mediaOverlays ? 1 : 0,
        f.oversizedImages ? 1 : 0,
        f.accessibilityNavigation ? 1 : 0,
        f.compatibilityClass || "unknown",
        f.readerSupport || "supported_with_limits",
        JSON.stringify(f.features || {}),
        JSON.stringify(f.warnings || []),
        at,
      )
      .run();
    await db
      .prepare("UPDATE editions SET layout=?,epub_version=?,updated_at=? WHERE id=?")
      .bind(
        f.renditionLayout === "pre-paginated" ? "fixed" : "reflowable",
        f.epubVersion || null,
        at,
        manifest.catalogEditionId,
      )
      .run();
  }
}


async function activatePublicationCommercialTerms(
  db: PublishingDB,
  currentManifest: any,
  previousManifest: any | null,
  at: string,
) {
  const statements: any[] = [];
  const prior = previousManifest || {};
  // Publication approval can precede release by months. Revalidate the exact
  // immutable B2B contract version at the moment commercial terms go live so
  // a scheduled title cannot activate after its distribution authority ended.
  if (currentManifest.rightsContractVersionId) {
    const contract = await db
      .prepare(
        `SELECT rcv.id,rcv.status,rcv.effective_from,rcv.effective_to,rc.id contract_id,rc.status contract_status,rc.effective_from contract_effective_from,rc.effective_to contract_effective_to
      FROM rights_contract_versions rcv JOIN rights_contracts rc ON rc.id=rcv.contract_id WHERE rcv.id=? AND rc.id=?`,
      )
      .bind(currentManifest.rightsContractVersionId, currentManifest.rightsContractId)
      .first<any>();
    const effective =
      contract &&
      String(contract.status) === "active" &&
      String(contract.contract_status) === "active" &&
      String(contract.effective_from) <= at &&
      (!contract.effective_to || String(contract.effective_to) > at) &&
      (!contract.contract_effective_from || String(contract.contract_effective_from) <= at) &&
      (!contract.contract_effective_to || String(contract.contract_effective_to) > at);
    if (!effective)
      throw new ApiError(
        409,
        "This publication's approved distribution contract version is no longer active/effective. Cove will not activate the scheduled commercial release until a new approved submission references current contract authority.",
      );
    if (
      currentManifest.publishingAccountId &&
      !currentManifest.rightsContractManagedByPublication
    ) {
      const assignment = await db
        .prepare(
          `SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)`,
        )
        .bind(currentManifest.publishingAccountId, currentManifest.rightsContractId, at, at)
        .first<any>();
      if (!assignment)
        throw new ApiError(
          409,
          "This publisher is no longer assigned to the distribution contract referenced by the scheduled release.",
        );
    }
  }
  const ids = (value: any) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  let activatingIds = ids(currentManifest.rightsGrantIds),
    previousIds = ids(prior.rightsGrantIds);
  // Compatibility for publication versions created before grant ids were frozen into the manifest.
  if (
    !activatingIds.length &&
    currentManifest.rightsContractManagedByPublication &&
    currentManifest.rightsContractId
  )
    activatingIds = (
      await db
        .prepare("SELECT id FROM rights_grants WHERE contract_id=?")
        .bind(currentManifest.rightsContractId)
        .all<any>()
    ).results.map((r: any) => String(r.id));
  if (!previousIds.length && prior.rightsContractManagedByPublication && prior.rightsContractId)
    previousIds = (
      await db
        .prepare("SELECT id FROM rights_grants WHERE contract_id=?")
        .bind(prior.rightsContractId)
        .all<any>()
    ).results.map((r: any) => String(r.id));
  if (activatingIds.length) {
    const conflicts = await detectRightsConflicts(db as any),
      activating = new Set(activatingIds),
      replaced = new Set(previousIds);
    const blocking = conflicts.find((conflict: any) => {
      if (conflict.severity !== "error") return false;
      const a = String(conflict.grantAId),
        b = String(conflict.grantBId);
      if (!activating.has(a) && !activating.has(b)) return false;
      const counterpart = activating.has(a) ? b : a;
      return !activating.has(counterpart) && !replaced.has(counterpart);
    });
    if (blocking)
      throw new ApiError(
        409,
        `Rights conflict at activation: ${blocking.message} Conflicting grant ${activating.has(String(blocking.grantAId)) ? blocking.grantBId : blocking.grantAId}.`,
      );
  }
  if (prior.offerId && prior.offerId !== currentManifest.offerId)
    statements.push(
      db.prepare("UPDATE offers SET active=0,updated_at=? WHERE id=?").bind(at, prior.offerId),
    );
  if (prior.royaltyContractId && prior.royaltyContractId !== currentManifest.royaltyContractId)
    statements.push(
      db
        .prepare("UPDATE finance_royalty_contracts SET status='retired',updated_at=? WHERE id=?")
        .bind(at, prior.royaltyContractId),
    );
  const retiringIds = previousIds.filter((grantId) => !activatingIds.includes(grantId));
  if (retiringIds.length) {
    const placeholders = retiringIds.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `UPDATE rights_grants SET status='revoked',updated_at=? WHERE id IN (${placeholders}) AND status IN ('draft','active','suspended')`,
        )
        .bind(at, ...retiringIds),
    );
  }
  if (
    prior.rightsContractManagedByPublication &&
    prior.rightsContractId &&
    prior.rightsContractId !== currentManifest.rightsContractId
  )
    statements.push(
      db
        .prepare("UPDATE rights_contracts SET status='terminated',updated_at=? WHERE id=?")
        .bind(at, prior.rightsContractId),
    );
  // A scheduled release or an old rollback manifest must NEVER turn a
  // suspended/terminated contract, revoked grant, or retired royalty agreement
  // back into a positive authority. Those states require fresh independent
  // reapproval and new authority evidence, not a stale publication replay.
  // Conditional SQL below is evaluated again in D1's batch transaction,
  // not only during this function's earlier preflight reads.
  if (currentManifest.rightsContractManagedByPublication && currentManifest.rightsContractId)
    statements.push(
      db
        .prepare(
          "UPDATE rights_contracts SET status='active',updated_at=? WHERE id=? AND status IN ('draft','active')",
        )
        .bind(at, currentManifest.rightsContractId),
    );
  if (activatingIds.length) {
    const placeholders = activatingIds.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `UPDATE rights_grants SET status='active',updated_at=? WHERE id IN (${placeholders}) AND status IN ('draft','active')`,
        )
        .bind(at, ...activatingIds),
    );
  }
  if (currentManifest.royaltyContractId)
    statements.push(
      db
        .prepare(
          "UPDATE finance_royalty_contracts SET status='active',updated_at=? WHERE id=? AND status IN ('draft','active')",
        )
        .bind(at, currentManifest.royaltyContractId),
    );
  if (currentManifest.offerId) {
    // Every scheduled attempt recomputes retail visibility atomically. An
    // already-active offer must be DEACTIVATED if a grant was subsequently
    // revoked; simply issuing a conditional active=1 UPDATE would leave the
    // stale active=1 row untouched and mistakenly succeed on the follow-up read.
    // Any other grant is never a substitute for this frozen legal manifest.
    if (!activatingIds.length)
      throw new ApiError(409, "A retail offer requires a frozen approved rights-grant manifest.");
    const grantPlaceholders = activatingIds.map(() => "?").join(",");
    const contractId = currentManifest.rightsContractId || null;
    const contractVersionId = currentManifest.rightsContractVersionId || null;
    statements.push(
      db
        .prepare(
          `UPDATE offers SET active=CASE WHEN EXISTS (
             SELECT 1 FROM products p
             JOIN rights_grants g ON g.edition_id=p.edition_id
             LEFT JOIN rights_contracts rc ON rc.id=g.contract_id
             WHERE p.id=offers.product_id
               AND g.id IN (${grantPlaceholders})
               AND g.status='active' AND g.decision='allow'
               AND g.sales_channel='retail'
               AND (? IS NULL OR g.contract_id=?)
               AND (? IS NULL OR g.contract_version_id=?)
               AND (g.contract_id IS NULL OR rc.status='active')
               AND (g.contract_version_id IS NULL OR EXISTS (
                 SELECT 1 FROM rights_contract_versions rcv
                 WHERE rcv.id=g.contract_version_id
                   AND rcv.contract_id=g.contract_id
                   AND rcv.status='active'
                   AND rcv.effective_from<=?
                   AND (rcv.effective_to IS NULL OR rcv.effective_to>?)
               ))
           ) THEN 1 ELSE 0 END,updated_at=? WHERE id=?`,
        )
        .bind(
          ...activatingIds,
          contractId,
          contractId,
          contractVersionId,
          contractVersionId,
          at,
          at,
          at,
          currentManifest.offerId,
        ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO product_pricing_assignments(product_id,policy_id,base_offer_id,preorder_guarantee,publisher_floor_minor,updated_at) VALUES(?,'pricing_default',?,1,NULL,?) ON CONFLICT(product_id) DO UPDATE SET base_offer_id=excluded.base_offer_id,updated_at=excluded.updated_at",
        )
        .bind(currentManifest.productId, currentManifest.offerId, at),
    );
  }
  if (statements.length) await db.batch(statements);
  if (currentManifest.offerId) {
    // A revoked/suspended legal scope may have changed between preflight and
    // this D1 transaction. Do not report publication activation or expose a
    // product when the conditional offer activation was denied.
    const offer = await db
      .prepare("SELECT active FROM offers WHERE id=? AND product_id=?")
      .bind(currentManifest.offerId, currentManifest.productId)
      .first<{ active: number }>();
    if (Number(offer?.active || 0) !== 1)
      throw new ApiError(
        409,
        "Commercial offer activation is blocked until current rights are independently reverified.",
      );
  }
  await syncCatalogAccessibility(db, currentManifest, at);
}

async function activatePublicationVersionOwned(
  db: PublishingDB,
  publicationVersionId: string,
  actorUserId: string | null,
  triggerType: "schedule" | "rollback" | "staff",
) {
  const v = await db
    .prepare(
      `SELECT pv.*,l.publishing_edition_id,l.state,l.current_publication_version_id,l.owner_update_policy FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id WHERE pv.id=?`,
    )
    .bind(publicationVersionId)
    .first<any>();
  if (!v) throw new ApiError(404, "Publication version not found.");
  if (["suppressed", "takedown", "retired"].includes(String(v.state)))
    throw new ApiError(
      409,
      "An enforced or retired release cannot activate another publication version until staff restores it.",
    );
  const m = safeJson<any>(v.manifest_json, {}),
    meta = m.metadata || {},
    at = publishingNow(),
    previousServing =
      v.current_publication_version_id === publicationVersionId
        ? null
        : await publicationVersionManifest(db, v.current_publication_version_id);
  if (!m.workId || !m.catalogEditionId || !m.productId)
    throw new ApiError(409, "Publication version manifest is incomplete.");
  await db
    .prepare(
      "UPDATE works SET title=?,subtitle=?,description=?,original_language=COALESCE(?,original_language),updated_at=? WHERE id=?",
    )
    .bind(
      meta.title || "",
      meta.subtitle || "",
      meta.description || "",
      meta.language || null,
      at,
      m.workId,
    )
    .run();
  await db
    .prepare(
      "UPDATE editions SET publisher_id=COALESCE(?,publisher_id),imprint_id=?,title=?,subtitle=?,description=?,edition_number=?,language=?,release_date=?,preorder_date=?,isbn13=?,publisher_identifier=?,drm_status=?,downloadable=?,subscription_eligible=?,library_eligible=?,release_status='available',publisher_description=?,updated_at=? WHERE id=?",
    )
    .bind(
      m.publisherId || null,
      m.imprintId || null,
      meta.title || "",
      meta.subtitle || "",
      meta.description || "",
      meta.editionLabel || "",
      meta.language || "en",
      meta.releaseDate || null,
      meta.preorderDate || null,
      meta.isbn13 || null,
      meta.publisherIdentifier || "",
      meta.drmRequirement || "none",
      Number(meta.downloadable ?? 1),
      Number(meta.subscriptionPermitted || 0),
      Number(meta.libraryPermitted || 0),
      meta.description || "",
      at,
      m.catalogEditionId,
    )
    .run();
  await db
    .prepare("DELETE FROM edition_languages WHERE edition_id=? AND kind='content'")
    .bind(m.catalogEditionId)
    .run();
  await db
    .prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,'content')")
    .bind(m.catalogEditionId, String(meta.language || "en").toLowerCase())
    .run();
  await db
    .prepare("DELETE FROM edition_contributors WHERE edition_id=?")
    .bind(m.catalogEditionId)
    .run();
  for (const c of m.contributorLinks || [])
    await db
      .prepare(
        "INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?,?,?)",
      )
      .bind(m.catalogEditionId, c.contributorId, c.role, Number(c.position || 0))
      .run();
  await db
    .prepare("DELETE FROM series_memberships WHERE edition_id=?")
    .bind(m.catalogEditionId)
    .run();
  if (m.seriesLink)
    await db
      .prepare(
        "INSERT INTO series_memberships(series_id,edition_id,position,label,relationship,reading_order,display_order) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        m.seriesLink.seriesId,
        m.catalogEditionId,
        m.seriesLink.position ?? null,
        m.seriesLink.label || "",
        m.seriesLink.relationship || "main",
        m.seriesLink.readingOrder ?? null,
        Number(m.seriesLink.displayOrder || 0),
      )
      .run();
  await db
    .prepare("DELETE FROM edition_categories WHERE edition_id=?")
    .bind(m.catalogEditionId)
    .run();
  for (const c of m.categoryLinks || [])
    await db
      .prepare("INSERT INTO edition_categories(edition_id,category_id,position) VALUES(?,?,?)")
      .bind(m.catalogEditionId, c.categoryId, Number(c.position || 0))
      .run();
  await db
    .prepare("DELETE FROM edition_keywords WHERE edition_id=?")
    .bind(m.catalogEditionId)
    .run();
  for (const k of m.keywordLinks || [])
    await db
      .prepare("INSERT INTO edition_keywords(edition_id,keyword_id) VALUES(?,?)")
      .bind(m.catalogEditionId, k.keywordId)
      .run();
  for (const a of m.catalogAssets || [])
    await db
      .prepare(
        "UPDATE digital_assets SET current_version_id=?,drm_status=?,downloadable=?,updated_at=? WHERE id=?",
      )
      .bind(
        a.catalogAssetVersionId,
        meta.drmRequirement || "none",
        Number(meta.downloadable ?? 1),
        at,
        a.digitalAssetId,
      )
      .run();
  await activatePublicationCommercialTerms(db, m, previousServing?.manifest || null, at);
  await db
    .prepare("UPDATE products SET storefront_status='active',updated_at=? WHERE id=?")
    .bind(at, m.productId)
    .run();
  const nextState =
    triggerType === "rollback" ? "updated" : Number(v.version_number) > 1 ? "updated" : "live";
  await db
    .prepare(
      "UPDATE publishing_release_lifecycles SET state=?,current_publication_version_id=?,pending_publication_version_id=NULL,state_reason=?,live_at=COALESCE(live_at,?),updated_at=? WHERE id=?",
    )
    .bind(
      nextState,
      publicationVersionId,
      triggerType === "rollback" ? "rollback_activated" : "scheduled_version_activated",
      at,
      at,
      v.lifecycle_id,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      publishingId("lifeevt"),
      v.lifecycle_id,
      v.state,
      nextState,
      triggerType,
      actorUserId,
      triggerType === "rollback" ? "rollback" : "activation",
      JSON.stringify({
        publicationVersionId,
        versionNumber: v.version_number,
        previousCurrentVersionId: v.current_publication_version_id,
      }),
      at,
    )
    .run();
  await recordPublicationActivation(db, {
    lifecycleId: v.lifecycle_id,
    publicationVersionId,
    fromPublicationVersionId: v.current_publication_version_id || null,
    activationType:
      triggerType === "rollback" ? "rollback" : triggerType === "schedule" ? "schedule" : "staff",
    actorUserId,
    reasonCode: triggerType === "rollback" ? "rollback_activated" : "publication_version_activated",
    metadata: { versionNumber: Number(v.version_number), fromState: v.state, toState: nextState },
    at,
  });
  return { publicationVersionId, state: nextState, versionNumber: Number(v.version_number) };
}

async function openPublicationPreorderOwned(db: PublishingDB, publicationVersionId: string) {
  const row = await db
    .prepare(
      "SELECT l.*,pv.id version_id,pv.manifest_json,pv.version_number FROM publishing_release_lifecycles l JOIN publishing_publication_versions pv ON pv.lifecycle_id=l.id AND pv.id=l.current_publication_version_id WHERE pv.id=?",
    )
    .bind(publicationVersionId)
    .first<{
      id: string;
      state: string;
      pending_publication_version_id: string | null;
      version_id: string;
      manifest_json: string;
      version_number: number;
    }>();
  if (!row || row.state !== "scheduled" || row.pending_publication_version_id)
    throw new ApiError(
      409,
      "This publication is no longer scheduled for its initial preorder window.",
    );
  const m = safeJson<any>(row.manifest_json, {}),
    meta = m.metadata || {},
    releaseMs = Date.parse(String(meta.releaseDate || "")),
    preorderMs = Date.parse(String(meta.preorderDate || ""));
  if (
    !m.productId ||
    !m.catalogEditionId ||
    !Number.isFinite(releaseMs) ||
    releaseMs <= Date.now() ||
    !Number.isFinite(preorderMs) ||
    preorderMs > Date.now()
  )
    throw new ApiError(409, "The publication preorder window is not open.");
  const at = publishingNow();
  await activatePublicationCommercialTerms(db, m, null, at);
  await db
    .prepare(
      "UPDATE publishing_release_lifecycles SET state='preorder',preorder_at=COALESCE(preorder_at,?),state_reason='preorder_window_open',updated_at=? WHERE id=?",
    )
    .bind(at, at, row.id)
    .run();
  if (m.productId)
    await db
      .prepare("UPDATE products SET storefront_status='active',updated_at=? WHERE id=?")
      .bind(at, m.productId)
      .run();
  if (m.catalogEditionId)
    await db
      .prepare("UPDATE editions SET release_status='preorder',updated_at=? WHERE id=?")
      .bind(at, m.catalogEditionId)
      .run();
  if (m.productId)
    try {
      await privatePreorder.ensurePreorderReleasePlan(db as any, String(m.productId), null);
    } catch (e) {
      console.error("Unable to activate preorder operations plan", e);
    }
  await db
    .prepare(
      "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,reason_code,metadata_json,created_at) VALUES(?,?,?,'preorder','schedule','preorder_opened',?,?)",
    )
    .bind(
      publishingId("lifeevt"),
      row.id,
      row.state,
      JSON.stringify({ publicationVersionId: row.version_id }),
      at,
    )
    .run();
  await recordPublicationActivation(db, {
    lifecycleId: row.id,
    publicationVersionId: row.version_id,
    fromPublicationVersionId: null,
    activationType: "schedule",
    reasonCode: "preorder_opened",
    metadata: { versionNumber: Number(row.version_number), visibility: "preorder" },
    at,
  });
  return {
    publicationVersionId: row.version_id,
    state: "preorder",
    versionNumber: Number(row.version_number),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- Private refund posting mirrors existing production D1 transaction. */
type RefundRecord={id:string;order_id:string;amount_minor:number;gift_card_amount_minor:number;
  store_credit_amount_minor:number;stripe_amount_minor:number;currency:string;succeeded_at:string|null};
type OrderRecord={id:string;user_id:string;currency:string;total_minor:number;refunded_minor:number;
  tax_minor:number;tax_inclusive_minor:number;status:string};
async function postRefundAccountingPrivate(
  db:CatalogDB,refundId:string,at:string,ownerEnrolled:boolean
) {
  const refund=await db.prepare("SELECT * FROM commerce_refunds WHERE id=?")
    .bind(refundId).first<RefundRecord>();
  if(!refund)throw new ApiError(404,"Refund intent not found.");
  const order=await db.prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(refund.order_id).first<OrderRecord>();
  if(!order)throw new ApiError(404,"Refund order not found.");
  if(refund.succeeded_at)return {refund,order,applied:false};
  const amount=Number(refund.amount_minor),gift=Number(refund.gift_card_amount_minor||0),
    store=Number(refund.store_credit_amount_minor||0),stripe=Number(refund.stripe_amount_minor||0);
  const total=Number(order.total_minor),previous=Number(order.refunded_minor||0),
    totalTax=Number(order.tax_minor||0)+Number(order.tax_inclusive_minor||0);
  if(!Number.isSafeInteger(total)||total<=0||!Number.isSafeInteger(previous)||previous<0||
     previous+amount>total||!Number.isSafeInteger(totalTax)||totalTax<0||totalTax>total||
     !Number.isSafeInteger(amount)||amount<=0||
     [gift,store,stripe].some(n=>!Number.isSafeInteger(n)||n<0)||
     gift+store+stripe!==amount||refund.currency!==order.currency)
    throw new ApiError(409,"Refund tender accounting is invalid.");
  const statements:Parameters<CatalogDB["batch"]>[0]=[];
  const pending="EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.id=? AND r.succeeded_at IS NULL)";
  const full="EXISTS(SELECT 1 FROM commerce_orders o WHERE o.id=? AND o.refunded_minor>=o.total_minor)";
  if(gift){
    const reservation=await db.prepare("SELECT source_key FROM commerce_balance_reservations WHERE order_id=? AND source_type='gift_card' AND status='consumed' LIMIT 1")
      .bind(order.id).first<{source_key:string}>();
    if(!reservation?.source_key||!await db.prepare("SELECT 1 ok FROM commerce_gift_cards WHERE code_hash=?")
      .bind(reservation.source_key).first())
      throw new ApiError(500,"The original gift-card tender could not be restored.");
    statements.push(db.prepare("UPDATE commerce_gift_cards SET balance_minor=balance_minor+?,status=CASE WHEN status='exhausted' AND (expires_at IS NULL OR expires_at>?) THEN 'active' ELSE status END,updated_at=? WHERE code_hash=? AND "+pending)
      .bind(gift,at,at,reservation.source_key,refundId));
    statements.push(db.prepare("INSERT INTO commerce_gift_card_ledger(id,code_hash,order_id,entry_type,amount_minor,balance_after_minor,created_at) SELECT ?,code_hash,?,'refund',?,balance_minor,? FROM commerce_gift_cards WHERE code_hash=? AND "+pending)
      .bind("gift_refund:"+refundId,order.id,gift,at,reservation.source_key,refundId));
  }
  if(store)statements.push(db.prepare("INSERT INTO commerce_store_credit_ledger(id,user_id,order_id,entry_type,amount_minor,currency,reference,created_at) SELECT ?,?,?,'refund',?,?,?,? WHERE "+pending)
    .bind("credit_refund:"+refundId,order.user_id,order.id,store,order.currency,"refund:"+refundId,at,refundId));
  // Derive tax allocation from transaction-current order totals, rather than
  // two callers' stale preflight reads. Successive partial refunds sum to
  // the same final rounded tax as one full refund.
  const tax="MAX(0,ROUND((COALESCE(o.tax_minor,0)+COALESCE(o.tax_inclusive_minor,0))*MIN(o.total_minor,o.refunded_minor+r.amount_minor)*1.0/MAX(1,o.total_minor))-ROUND((COALESCE(o.tax_minor,0)+COALESCE(o.tax_inclusive_minor,0))*o.refunded_minor*1.0/MAX(1,o.total_minor)))";
  for(const [type,account,expression] of [
    ["refund","sales_returns","r.amount_minor-("+tax+")"],
    ["tax_refund","tax_payable",tax],
    ["refund_tender","stripe_receivable","-r.stripe_amount_minor"],
    ["refund_tender","gift_card_liability","-r.gift_card_amount_minor"],
    ["refund_tender","store_credit_liability","-r.store_credit_amount_minor"],
  ])statements.push(db.prepare("INSERT INTO commerce_ledger_entries(id,order_id,refund_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) SELECT ?,o.id,r.id,o.user_id,?,?,"+expression+",o.currency,r.id,?,? FROM commerce_refunds r JOIN commerce_orders o ON o.id=r.order_id WHERE r.id=? AND r.succeeded_at IS NULL AND ("+expression+")<>0")
    .bind("led_refund:"+refundId+":"+account,type,account,JSON.stringify({refundId}),at,refundId));
  statements.push(db.prepare("UPDATE commerce_orders SET refunded_minor=refunded_minor+?,status=CASE WHEN status='chargeback_lost' THEN status WHEN refunded_minor+?>=total_minor THEN 'refunded' ELSE 'partially_refunded' END,updated_at=? WHERE id=? AND "+pending)
    .bind(amount,amount,at,order.id,refundId));
  if(!ownerEnrolled)statements.push(db.prepare("UPDATE entitlements SET status='revoked',updated_at=? WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase' AND "+pending+" AND "+full)
    .bind(at,order.user_id,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_order_items SET entitlement_status='revoked' WHERE order_id=? AND "+pending+" AND "+full)
    .bind(order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE preorders SET status='refunded',updated_at=? WHERE order_id=? AND status NOT IN ('released','refunded') AND "+pending+" AND "+full)
    .bind(at,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_promo_codes SET redemptions=MAX(0,redemptions-1),updated_at=? WHERE code_hash IN (SELECT code_hash FROM commerce_promo_redemptions WHERE order_id=? AND status='applied') AND "+pending+" AND "+full)
    .bind(at,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_promo_redemptions SET status='refunded',updated_at=? WHERE order_id=? AND status='applied' AND "+pending+" AND "+full)
    .bind(at,order.id,refundId,order.id));
  statements.push(db.prepare("UPDATE commerce_refunds SET status='succeeded',succeeded_at=?,updated_at=? WHERE id=? AND succeeded_at IS NULL")
    .bind(at,at,refundId));
  const results=await db.batch(statements) as Array<{meta?:{changes?:number}}>;
  const updated=await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(order.id)
    .first<OrderRecord>();
  return {refund,order:updated||order,applied:Number(results.at(-1)?.meta?.changes||0)>0};
}

/* eslint-enable @typescript-eslint/no-explicit-any */
/** Private SQL executor: only CoveLegalAuthority may call these methods. */
const cancellableOrderId=/^[a-zA-Z0-9_-]{8,160}$/;
type CancellableOrder={id:string;user_id:string;status:string;currency:string;
  stripe_due_minor:number;stripe_payment_intent_id:string|null;stripe_customer_id:string|null};
export async function executeOwnerUnpaidCancellation(env:LegalAuthorityEnv,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("owner_cancellation_payload_invalid");
  const q=raw as Record<string,unknown>;
  if(Object.keys(q).sort().join(",")!=="orderId,source,userId"||
     typeof q.orderId!=="string"||!cancellableOrderId.test(q.orderId)||
     typeof q.userId!=="string"||!cancellableOrderId.test(q.userId)||
     !["customer","reconciliation"].includes(String(q.source)))
    throw Error("owner_cancellation_scope_invalid");
  const db=env.PRIMARY_DB;
  const order=await db.prepare(
    "SELECT id,user_id,status,currency,stripe_due_minor,stripe_payment_intent_id,stripe_customer_id FROM commerce_orders WHERE id=? AND user_id=?"
  ).bind(q.orderId,q.userId).first<CancellableOrder>();
  if(!order||order.id!==q.orderId||order.user_id!==q.userId||
     !["pending_payment","payment_failed","authorized","processing","canceled"].includes(order.status)||
     typeof order.currency!=="string"||!/^[A-Z]{3}$/.test(order.currency)||
     !Number.isSafeInteger(order.stripe_due_minor)||order.stripe_due_minor<0)
    throw Error("owner_cancellation_not_unpaid");
  if(order.stripe_payment_intent_id){
    const live=env.STRIPE_LIVEMODE==="true",key=env.STRIPE_SECRET_KEY||"";
    if(!(live?/^(sk|rk)_live_/:/^(sk|rk|rkcs)_test_/).test(key)||
       !/^pi_[A-Za-z0-9_-]{4,150}$/.test(order.stripe_payment_intent_id))
      throw Error("owner_cancellation_provider_unavailable");
    const response=await fetch("https://api.stripe.com/v1/payment_intents/"+
      encodeURIComponent(order.stripe_payment_intent_id),{
        method:"GET",headers:{authorization:"Bearer "+key},
        redirect:"manual",signal:AbortSignal.timeout(15000)
      });
    if(response.status!==200)throw Error("owner_cancellation_provider_unverified");
    const payload=await response.text();
    if(payload.length>131072)throw Error("owner_cancellation_provider_response_large");
    let pi:Record<string,unknown>;
    try{pi=JSON.parse(payload)}catch{throw Error("owner_cancellation_provider_invalid")}
    const meta=pi?.metadata&&typeof pi.metadata==="object"&&!Array.isArray(pi.metadata)?
      pi.metadata as Record<string,unknown>:null;
    if(pi?.object!=="payment_intent"||pi.id!==order.stripe_payment_intent_id||
       pi.status!=="canceled"||pi.livemode!==live||
       !Number.isSafeInteger(pi.amount)||pi.amount!==order.stripe_due_minor||
       typeof pi.currency!=="string"||pi.currency.toUpperCase()!==order.currency||
       !meta||meta.fore_order_id!==order.id||
       (order.stripe_customer_id!==null&&pi.customer!==order.stripe_customer_id))
      throw Error("owner_cancellation_provider_not_canceled");
  }
  const at=new Date().toISOString();
  const stmts=[
    db.prepare(
      "UPDATE commerce_orders SET status='canceled',canceled_at=COALESCE(canceled_at,?),updated_at=? WHERE id=? AND user_id=? AND status IN ('pending_payment','payment_failed','authorized','processing')"
    ).bind(at,at,order.id,order.user_id),
    db.prepare(
      "UPDATE commerce_balance_reservations SET status='released',updated_at=? WHERE order_id=? AND status='reserved' AND EXISTS(SELECT 1 FROM commerce_orders WHERE id=? AND user_id=? AND status='canceled')"
    ).bind(at,order.id,order.id,order.user_id),
    db.prepare(
      "UPDATE commerce_promo_redemptions SET status='released',updated_at=? WHERE order_id=? AND status='reserved' AND EXISTS(SELECT 1 FROM commerce_orders WHERE id=? AND user_id=? AND status='canceled')"
    ).bind(at,order.id,order.id,order.user_id)
  ];
  await db.batch(stmts);
  const confirmed=await db.prepare(
    "SELECT status FROM commerce_orders WHERE id=? AND user_id=?"
  ).bind(order.id,order.user_id).first<{status:string}>();
  if(confirmed?.status!=="canceled")
    throw Error("owner_cancellation_canonical_confirmation_failed");
  const still=await db.prepare(
    "SELECT (SELECT COUNT(*) FROM commerce_balance_reservations WHERE order_id=? AND status='reserved')+(SELECT COUNT(*) FROM commerce_promo_redemptions WHERE order_id=? AND status='reserved') remaining"
  ).bind(order.id,order.id).first<{remaining:number}>();
  if(still?.remaining!==0)throw Error("owner_cancellation_reserved_funds_unreconciled");
  return {schema:"cove.owner-unpaid-cancellation.v1",orderId:order.id,userId:order.user_id,
    canceled:true,providerVerified:!!order.stripe_payment_intent_id,tenderReleased:true};
}

/** This is a diagnostic record, not a payment or entitlement authority.
 * Fixed schema + replay collision detection prevent an adapter from issuing
 * arbitrary SQL or silently changing a completed reconciliation report. */
export async function recordOwnerReconciliationRun(db:CatalogDB,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("owner_reconcile_report_invalid");
  const q=raw as Record<string,unknown>;
  if(Object.keys(q).sort().join(",")!=="checked,details,finishedAt,mismatches,repaired,runId,startedAt"||
     typeof q.runId!=="string"||!/^recon_[0-9a-f-]{36}$/.test(q.runId)||
     ![q.checked,q.mismatches,q.repaired].every(x=>Number.isSafeInteger(x)&&Number(x)>=0&&Number(x)<=500)||
     typeof q.startedAt!=="string"||typeof q.finishedAt!=="string"||
     !Number.isFinite(Date.parse(q.startedAt))||!Number.isFinite(Date.parse(q.finishedAt))||
     Date.parse(q.finishedAt)<Date.parse(q.startedAt)||
     !Array.isArray(q.details)||q.details.length>100||
     !q.details.every(x=>x&&typeof x==="object"&&!Array.isArray(x)&&
       Object.keys(x).every(k=>["orderId","action","error","foreStatus","stripeStatus"].includes(k))&&
       Object.values(x).every(v=>typeof v==="string"&&v.length<=200)))
    throw Error("owner_reconcile_report_scope_invalid");
  const json=JSON.stringify(q.details),at=q.finishedAt as string;
  if(json.length>12000)throw Error("owner_reconcile_report_oversize");
  await db.prepare(
    "INSERT INTO commerce_reconciliation_runs(id,started_at,finished_at,status,checked_orders,mismatches,repaired,details_json) VALUES(?,?,?,'complete',?,?,?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(q.runId,q.startedAt,at,q.checked,q.mismatches,q.repaired,json).run();
  const saved=await db.prepare(
    "SELECT started_at,finished_at,status,checked_orders,mismatches,repaired,details_json FROM commerce_reconciliation_runs WHERE id=?"
  ).bind(q.runId).first<{started_at:string;finished_at:string;status:string;checked_orders:number;
    mismatches:number;repaired:number;details_json:string}>();
  if(!saved||saved.started_at!==q.startedAt||saved.finished_at!==at||
     saved.status!=="complete"||saved.checked_orders!==q.checked||
     saved.mismatches!==q.mismatches||saved.repaired!==q.repaired||
     saved.details_json!==json)throw Error("owner_reconcile_report_replay_collision");
  return {schema:"cove.owner-reconciliation-report.v1",runId:q.runId,
    recorded:true,checked:q.checked,mismatches:q.mismatches,repaired:q.repaired};
}


/** These monetary staff writers are executable ONLY within the private DO.
 * The caller's commerce.manage result is NOT accepted as owner authority:
 * independently check canonical active staff principal, SSO and MFA. */
const ownerMonetaryAdminCommand=z.object({
  action:z.enum(["promo","gift-card","store-credit"]),
  operationId:z.string().min(16).max(150).regex(/^[A-Za-z0-9_.:-]+$/),
  actor:z.object({userId:z.string().min(3).max(180),
    authProvider:z.string().max(120),authSubject:z.string().max(240),
    aal:z.enum(["aal1","aal2"])}).strict(),
  payload:z.record(z.string(),z.unknown())
}).strict();
const ownerPromo=z.object({
  code:z.string().min(3).max(80),
  kind:z.enum(["percent","amount"]),value:z.number().int().positive(),
  currency:z.string().regex(/^[A-Za-z]{3}$/).nullable().optional(),
  minimumSubtotalMinor:z.number().int().min(0).default(0),
  maxRedemptions:z.number().int().positive().nullable().optional(),
  maxPerUser:z.number().int().positive().default(1),
  startsAt:z.string().datetime().nullable().optional(),
  endsAt:z.string().datetime().nullable().optional(),
  active:z.boolean().default(true)
});
const ownerGift=z.object({currency:z.string().regex(/^[A-Za-z]{3}$/).default("USD"),
  amountMinor:z.number().int().positive().max(1_000_000_000_000),
  expiresAt:z.string().datetime().nullable().optional()});
const ownerCredit=z.object({userId:z.string().min(1).max(180),
  currency:z.string().regex(/^[A-Za-z]{3}$/).default("USD"),
  amountMinor:z.number().int().refine(v=>v!==0&&Math.abs(v)<=1_000_000_000_000),
  reference:z.string().max(300).default("operator adjustment")});
const ownerHex=(b:ArrayBuffer)=>[...new Uint8Array(b)]
  .map(x=>x.toString(16).padStart(2,"0")).join("");
async function ownerMonetarySha256(s:string){
  return ownerHex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));
}
async function executeOwnerMonetaryAdmin(env:LegalAuthorityEnv,raw:unknown){
  const q=ownerMonetaryAdminCommand.parse(raw),db=env.PRIMARY_DB,actor=q.actor;
  const p=await db.prepare("SELECT status,mfa_required,sso_provider,sso_subject FROM staff_principals WHERE user_id=?")
    .bind(actor.userId).first<{status:string;mfa_required:number;sso_provider:string|null;sso_subject:string|null}>();
  if(!p||p.status!=="active"||(Number(p.mfa_required)===1&&actor.aal!=="aal2")||
     (p.sso_provider&&p.sso_provider!==actor.authProvider)||
     (p.sso_subject&&p.sso_subject!==actor.authSubject))
    throw Error("owner_admin_staff_identity_denied");
  const permission=await db.prepare(
    "SELECT 1 ok FROM staff_principal_roles pr JOIN staff_role_permissions perm ON perm.role_id=pr.role_id WHERE pr.user_id=? AND perm.permission IN ('commerce.manage','staff.manage') LIMIT 1"
  ).bind(actor.userId).first<{ok:number}>();
  if(permission?.ok!==1)throw Error("owner_admin_commerce_permission_denied");
  const at=new Date().toISOString();
  if(q.action==="promo"){
    const x=ownerPromo.parse(q.payload),code=x.code.trim().replace(/\s+/g,"").toUpperCase();
    if(x.kind==="percent"&&x.value>100)throw Error("owner_admin_invalid_percent");
    const hash=await ownerMonetarySha256(code);
    await db.prepare(
      "INSERT INTO commerce_promo_codes(code_hash,code_label,kind,value,currency,minimum_subtotal_minor,max_redemptions,max_per_user,active,starts_at,ends_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code_hash) DO UPDATE SET kind=excluded.kind,value=excluded.value,currency=excluded.currency,minimum_subtotal_minor=excluded.minimum_subtotal_minor,max_redemptions=excluded.max_redemptions,max_per_user=excluded.max_per_user,active=excluded.active,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at"
    ).bind(hash,code,x.kind,x.value,x.currency?.toUpperCase()||null,
      x.minimumSubtotalMinor,x.maxRedemptions||null,x.maxPerUser,
      x.active?1:0,x.startsAt||null,x.endsAt||null,at,at).run();
    const saved=await db.prepare(
      "SELECT code_label,kind,value,currency,minimum_subtotal_minor,max_redemptions,max_per_user,active,starts_at,ends_at FROM commerce_promo_codes WHERE code_hash=?"
    ).bind(hash).first<Record<string,unknown>>();
    if(!saved||saved.code_label!==code||saved.kind!==x.kind||saved.value!==x.value||
       saved.currency!==(x.currency?.toUpperCase()||null)||saved.minimum_subtotal_minor!==x.minimumSubtotalMinor||
       saved.max_redemptions!==(x.maxRedemptions||null)||saved.max_per_user!==x.maxPerUser||
       saved.active!==(x.active?1:0)||saved.starts_at!==(x.startsAt||null)||
       saved.ends_at!==(x.endsAt||null))
      throw Error("owner_admin_promo_commit_unconfirmed");
    return {schema:"cove.owner-monetary-admin.v1",action:q.action,operationId:q.operationId,
      applied:true,codeLabel:code,active:x.active};
  }
  if(q.action==="gift-card"){
    const x=ownerGift.parse(q.payload),currency=x.currency.toUpperCase();
    // HMAC with the private owner-only credential makes gift issuance
    // deterministic across a lost ACK without revealing the secret.
    const key=await crypto.subtle.importKey("raw",
      new TextEncoder().encode(env.COVE_RIGHTS_OWNER_SECRET||""),
      {name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const signed=ownerHex(await crypto.subtle.sign("HMAC",key,
      new TextEncoder().encode("cove-gift-card-v1:"+q.operationId)));
    const code="FORE-"+signed.slice(0,16).toUpperCase(),
      hash=await ownerMonetarySha256(code);
    await db.prepare(
      "INSERT INTO commerce_gift_cards(code_hash,last4,currency,original_balance_minor,balance_minor,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?) ON CONFLICT(code_hash) DO NOTHING"
    ).bind(hash,code.slice(-4),currency,x.amountMinor,x.amountMinor,
      x.expiresAt||null,at,at).run();
    const saved=await db.prepare(
      "SELECT last4,currency,original_balance_minor,expires_at FROM commerce_gift_cards WHERE code_hash=?"
    ).bind(hash).first<{last4:string;currency:string;original_balance_minor:number;expires_at:string|null}>();
    if(!saved||saved.last4!==code.slice(-4)||saved.currency!==currency||
       saved.original_balance_minor!==x.amountMinor||saved.expires_at!==(x.expiresAt||null))
      throw Error("owner_admin_gift_replay_collision");
    return {schema:"cove.owner-monetary-admin.v1",action:q.action,operationId:q.operationId,
      applied:true,code,currency,amountMinor:x.amountMinor,expiresAt:x.expiresAt||null};
  }
  const x=ownerCredit.parse(q.payload),currency=x.currency.toUpperCase();
  const keyHash=await ownerMonetarySha256("cove-credit-v1:"+q.operationId),
    id="cred_"+keyHash.slice(0,32);
  // Only a single atomic D1 SQL statement can apply a negative adjustment;
  // a separate available-balance read allows concurrent overdrafts.
  await db.prepare(
    "INSERT INTO commerce_store_credit_ledger(id,user_id,entry_type,amount_minor,currency,reference,created_at) SELECT ?,?,'adjustment',?,?,?,? WHERE ? > 0 OR (COALESCE((SELECT SUM(amount_minor) FROM commerce_store_credit_ledger WHERE user_id=? AND currency=?),0)-COALESCE((SELECT SUM(amount_minor) FROM commerce_balance_reservations WHERE source_type='store_credit' AND source_key=? AND currency=? AND status='reserved'),0)) >= ? ON CONFLICT(id) DO NOTHING"
  ).bind(id,x.userId,x.amountMinor,currency,x.reference,at,x.amountMinor,
    x.userId,currency,x.userId,currency,Math.abs(x.amountMinor)).run();
  const saved=await db.prepare(
    "SELECT user_id,entry_type,amount_minor,currency,reference FROM commerce_store_credit_ledger WHERE id=?"
  ).bind(id).first<{user_id:string;entry_type:string;amount_minor:number;currency:string;reference:string}>();
  if(!saved||saved.user_id!==x.userId||saved.entry_type!=="adjustment"||
     saved.amount_minor!==x.amountMinor||saved.currency!==currency||saved.reference!==x.reference)
    throw Error("owner_admin_credit_overspend_or_replay_collision");
  const [ledger,reserved]=await Promise.all([
    db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM commerce_store_credit_ledger WHERE user_id=? AND currency=?")
      .bind(x.userId,currency).first<{n:number}>(),
    db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM commerce_balance_reservations WHERE source_type='store_credit' AND source_key=? AND currency=? AND status='reserved'")
      .bind(x.userId,currency).first<{n:number}>()
  ]);
  return {schema:"cove.owner-monetary-admin.v1",action:q.action,operationId:q.operationId,
    applied:true,userId:x.userId,currency,balanceMinor:Math.max(0,Number(ledger?.n||0)-Number(reserved?.n||0))};
}


// The following physically retired 25 authorizing partner-feed SQL literals live
// only in this lease-gated Durable Object. The executable queue is strictly
// sandbox preview; no production feed may activate products, grants or offers.
/* eslint-disable @typescript-eslint/no-explicit-any -- Byte-exact historical partner feed executor, isolated behind strict private QA sandbox owner guards. */
const processPartnerFeedQueuePrivate = (() => {
  const now = () => new Date().toISOString();
  const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
  const clean = (v: unknown, max = 1000) => String(v ?? "").trim().slice(0,max);
  const sha256 = partnerFeedSha256;
  const partnerAudit = partnerFeedAudit;
  const normalizedCountryList = partnerNormalizedCountryList;
  const parseJson = <T,>(v:unknown,fallback:T):T => {
    try { return (typeof v==="string"?JSON.parse(v):v)??fallback; }
    catch { return fallback; }
  };
async function candidateWorkIdentityKeys(p: PartnerProduct) {
  const norm = (v: string) =>
      clean(v)
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    author = norm(p.contributors?.find((c) => c.role === "author")?.name || "");
  const keys: { key: string; scheme: string }[] = [];
  if (p.workReference)
    keys.push({
      key: `wref_${await sha256(clean(p.workReference, 500).toLowerCase())}`,
      scheme: "external_work_reference",
    });
  const sourceTitle = norm(p.originalWorkTitle || p.title || "");
  if (sourceTitle && author)
    keys.push({
      key: `wkeyta_${await sha256(`${sourceTitle}|${author}`)}`,
      scheme: "title_author",
    });
  if (sourceTitle)
    keys.push({
      key: `wkey_${await sha256(`${sourceTitle}|${author}|${clean(p.language || "en").toLowerCase()}`)}`,
      scheme: "title_author_language",
    });
  return keys;
}

async function activeContractVersion(db: CatalogDB, accountId: string, contractReference?: string) {
  let contract: any = null;
  const at = now();
  if (contractReference)
    contract = await db
      .prepare(
        `SELECT rc.* FROM rights_contracts rc JOIN publisher_contract_assignments a ON a.contract_id=rc.id WHERE a.account_id=? AND a.status='active' AND (a.starts_at IS NULL OR a.starts_at<=?) AND (a.ends_at IS NULL OR a.ends_at>?) AND (rc.reference_code=? OR rc.id=?) AND rc.status='active' LIMIT 1`,
      )
      .bind(accountId, at, at, contractReference, contractReference)
      .first<any>();
  if (!contract)
    contract = await db
      .prepare(
        `SELECT rc.* FROM publisher_partner_profiles p JOIN rights_contracts rc ON rc.id=p.default_contract_id JOIN publisher_contract_assignments a ON a.contract_id=rc.id AND a.account_id=p.account_id WHERE p.account_id=? AND a.status='active' AND (a.starts_at IS NULL OR a.starts_at<=?) AND (a.ends_at IS NULL OR a.ends_at>?) AND rc.status='active' LIMIT 1`,
      )
      .bind(accountId, at, at)
      .first<any>();
  if (!contract) return null;
  const version = await db
    .prepare(
      "SELECT * FROM rights_contract_versions WHERE contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY version_number DESC LIMIT 1",
    )
    .bind(contract.id, now(), now())
    .first<any>();
  return version ? { contract, version } : null;
}

async function assertPartnerProductWithinContract(
  db: CatalogDB,
  contractVersionId: string,
  p: PartnerProduct,
) {
  const [territoryRows, formatRow, channelRows, allTerritories] = await Promise.all([
    db
      .prepare(
        "SELECT territory_code,decision FROM rights_contract_version_territories WHERE contract_version_id=?",
      )
      .bind(contractVersionId)
      .all<any>(),
    db
      .prepare(
        "SELECT decision,drm_requirement FROM rights_contract_version_formats WHERE contract_version_id=? AND lower(format)=lower(?)",
      )
      .bind(contractVersionId, p.format || "ebook")
      .first<any>(),
    db
      .prepare(
        "SELECT sales_channel,permitted FROM rights_contract_version_channels WHERE contract_version_id=?",
      )
      .bind(contractVersionId)
      .all<any>(),
    db.prepare("SELECT code FROM territories WHERE is_sellable=1").all<any>(),
  ]);
  if (!formatRow || String(formatRow.decision) !== "allow")
    throw new ApiError(409, `Contract does not permit ${p.format || "ebook"} distribution.`);
  if (
    !drmSatisfiesRequirement(
      String(formatRow.drm_requirement || "none"),
      String(p.drmRequirement || "none"),
    )
  )
    throw new ApiError(409, "Feed DRM policy is weaker than the assigned contract requires.");
  const requestedChannels = [
    "retail",
    ...(p.subscriptionPermitted ? ["subscription"] : []),
    ...(p.libraryPermitted ? ["library"] : []),
  ];
  if (channelRows.results.length) {
    const permitted = new Set(
      channelRows.results
        .filter((r: any) => Number(r.permitted))
        .map((r: any) => String(r.sales_channel)),
    );
    for (const channel of requestedChannels)
      if (!permitted.has(channel))
        throw new ApiError(409, `Contract does not permit ${channel} distribution.`);
  }
  if (territoryRows.results.length && p.territories) {
    const allow = new Set(
        territoryRows.results
          .filter((r: any) => r.decision === "allow")
          .map((r: any) => String(r.territory_code)),
      ),
      deny = new Set(
        territoryRows.results
          .filter((r: any) => r.decision === "deny")
          .map((r: any) => String(r.territory_code)),
      );
    let requested: string[];
    if (p.territories.mode === "worldwide") {
      const excluded = new Set(normalizedCountryList(p.territories.exclude || []));
      requested = allTerritories.results
        .map((r: any) => String(r.code))
        .filter((c: string) => !excluded.has(c));
    } else
      requested = normalizedCountryList(p.territories.include || []).filter(
        (c) => !new Set(normalizedCountryList(p.territories?.exclude || [])).has(c),
      );
    if (requested.some((c: string) => deny.has(c) || !allow.has(c)))
      throw new ApiError(409, "Feed territory scope exceeds the assigned contract version.");
  }
}

async function applyMetadataItem(db: CatalogDB, submission: any, item: any, p: PartnerProduct) {
  const at = now(),
    mapping = await db
      .prepare(
        "SELECT * FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=?",
      )
      .bind(submission.account_id, p.productKey)
      .first<any>();
  if (p.notificationType === "delete") {
    if (!mapping)
      return {
        type: "mapping",
        id: "",
        skipped: true,
        message: "No mapped title existed for delete notice.",
      };
    const statements: any[] = [
      db
        .prepare(
          "UPDATE publisher_catalog_mappings SET status='withdrawn',updated_at=? WHERE account_id=? AND environment='production' AND partner_product_key=?",
        )
        .bind(at, submission.account_id, p.productKey),
    ];
    if (mapping.publishing_edition_id)
      statements.push(
        db
          .prepare(
            "UPDATE publishing_edition_drafts SET status='withdrawn',updated_at=? WHERE id=? AND status NOT IN ('published')",
          )
          .bind(at, mapping.publishing_edition_id),
      );
    if (mapping.catalog_product_id)
      statements.push(
        db
          .prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?")
          .bind(at, mapping.catalog_product_id),
      );
    await db.batch(statements);
    return {
      type: "mapping",
      id: String(mapping.publishing_edition_id || mapping.catalog_product_id || ""),
      message: "Partner product withdrawn.",
    };
  }
  const contract = await activeContractVersion(
    db,
    String(submission.account_id),
    p.contractReference,
  );
  if (!contract)
    throw new ApiError(
      409,
      `No active versioned retailer contract covers partner product ${p.productKey}.`,
    );
  await assertPartnerProductWithinContract(db, String(contract.version.id), p);
  const titleId = mapping?.publishing_title_id
      ? String(mapping.publishing_title_id)
      : id("pubtitle"),
    editionId = mapping?.publishing_edition_id
      ? String(mapping.publishing_edition_id)
      : id("pubed");
  const identityKeys = await candidateWorkIdentityKeys(p);
  let existingIdentity: any = null;
  for (const candidate of identityKeys) {
    existingIdentity = await db
      .prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?")
      .bind(candidate.key)
      .first<any>();
    if (existingIdentity) break;
  }
  const catalogWorkId = existingIdentity?.work_id || mapping?.catalog_work_id || null;
  const profile = await db
    .prepare("SELECT * FROM publisher_partner_profiles WHERE account_id=?")
    .bind(submission.account_id)
    .first<any>();
  const existingTitle = await db
    .prepare("SELECT id FROM publishing_titles WHERE id=?")
    .bind(titleId)
    .first<any>();
  if (!existingTitle)
    await db
      .prepare(
        "INSERT INTO publishing_titles(id,account_id,title,subtitle,description,language,audience,publisher_name,imprint_name,series_name,series_relationship,categories_json,keywords_json,status,catalog_work_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'general',?,?,?,'main','[]','[]','draft',?,?,?)",
      )
      .bind(
        titleId,
        submission.account_id,
        p.title || "Untitled",
        p.subtitle || "",
        p.description || "",
        p.language || "en",
        p.publisherName || profile?.partner_code || "",
        p.imprintName || "",
        "",
        catalogWorkId,
        at,
        at,
      )
      .run();
  else
    await db
      .prepare(
        "UPDATE publishing_titles SET title=?,subtitle=?,description=?,language=?,publisher_name=?,imprint_name=?,catalog_work_id=COALESCE(catalog_work_id,?),updated_at=? WHERE id=?",
      )
      .bind(
        p.title || "Untitled",
        p.subtitle || "",
        p.description || "",
        p.language || "en",
        p.publisherName || "",
        p.imprintName || "",
        catalogWorkId,
        at,
        titleId,
      )
      .run();
  const territoryScope = {
    mode: p.territories?.mode || "worldwide",
    include: normalizedCountryList(p.territories?.include || []),
    exclude: normalizedCountryList(p.territories?.exclude || []),
    includeSetIds: [],
    excludeSetIds: [],
  };
  const existingEdition = await db
    .prepare("SELECT id,status,revision FROM publishing_edition_drafts WHERE id=?")
    .bind(editionId)
    .first<any>();
  const editableStatus =
    existingEdition &&
    ["submitted", "approved", "published"].includes(String(existingEdition.status))
      ? "changes_requested"
      : existingEdition?.status || "draft";
  const revision =
    Number(existingEdition?.revision || 1) + (editableStatus === "changes_requested" ? 1 : 0);
  await db
    .prepare(
      `INSERT INTO publishing_edition_drafts(id,title_id,format,edition_label,language,isbn13,publisher_identifier,rights_basis,territory_scope_json,release_date,preorder_date,list_currency,list_price_minor,drm_requirement,downloadable,subscription_permitted,library_permitted,sales_channels_json,status,revision,edition_type,differentiation_summary,contract_id,contract_version_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET format=excluded.format,edition_label=excluded.edition_label,language=excluded.language,isbn13=excluded.isbn13,publisher_identifier=excluded.publisher_identifier,rights_basis=excluded.rights_basis,territory_scope_json=excluded.territory_scope_json,release_date=excluded.release_date,preorder_date=excluded.preorder_date,list_currency=excluded.list_currency,list_price_minor=excluded.list_price_minor,drm_requirement=excluded.drm_requirement,downloadable=excluded.downloadable,subscription_permitted=excluded.subscription_permitted,library_permitted=excluded.library_permitted,sales_channels_json=excluded.sales_channels_json,status=excluded.status,revision=excluded.revision,edition_type=excluded.edition_type,differentiation_summary=excluded.differentiation_summary,contract_id=excluded.contract_id,contract_version_id=excluded.contract_version_id,updated_at=excluded.updated_at`,
    )
    .bind(
      editionId,
      titleId,
      p.format || "ebook",
      p.editionLabel || "",
      p.language || "en",
      p.isbn13 || null,
      p.publisherIdentifier || p.productKey,
      p.rightsBasis || "licensed",
      JSON.stringify(territoryScope),
      p.releaseDate || null,
      p.preorderDate || null,
      p.currency || "USD",
      p.priceMinor || 0,
      p.drmRequirement || "none",
      p.downloadable === false ? 0 : 1,
      p.subscriptionPermitted ? 1 : 0,
      p.libraryPermitted ? 1 : 0,
      JSON.stringify([
        "retail",
        ...(p.subscriptionPermitted ? ["subscription"] : []),
        ...(p.libraryPermitted ? ["library"] : []),
      ]),
      editableStatus,
      revision,
      p.editionType || "original",
      p.differentiationSummary || "",
      contract?.contract.id || null,
      contract?.version.id || null,
      at,
      at,
    )
    .run();
  await db
    .prepare("DELETE FROM publishing_edition_contributors WHERE edition_id=?")
    .bind(editionId)
    .run();
  for (const c of p.contributors || [])
    await db
      .prepare(
        "INSERT INTO publishing_edition_contributors(edition_id,display_name,role,position) VALUES(?,?,?,?)",
      )
      .bind(editionId, c.name, c.role, c.position)
      .run();
  await db
    .prepare(
      `INSERT INTO publisher_catalog_mappings(account_id,environment,partner_product_key,publishing_title_id,publishing_edition_id,catalog_work_id,partner_record_reference,work_reference,original_work_title,status,source_revision,updated_at) VALUES(?,'production',?,?,?,?,?,?,?,'active',?,?)
    ON CONFLICT(account_id,environment,partner_product_key) DO UPDATE SET publishing_title_id=excluded.publishing_title_id,publishing_edition_id=excluded.publishing_edition_id,catalog_work_id=COALESCE(excluded.catalog_work_id,publisher_catalog_mappings.catalog_work_id),partner_record_reference=excluded.partner_record_reference,work_reference=excluded.work_reference,original_work_title=excluded.original_work_title,status='active',source_revision=excluded.source_revision,updated_at=excluded.updated_at`,
    )
    .bind(
      submission.account_id,
      p.productKey,
      titleId,
      editionId,
      catalogWorkId,
      p.recordReference || "",
      p.workReference || "",
      p.originalWorkTitle || "",
      p.sourceRevision || "",
      at,
    )
    .run();
  if (catalogWorkId)
    for (const candidate of identityKeys)
      await db
        .prepare(
          "INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          candidate.key,
          catalogWorkId,
          candidate.scheme,
          candidate.scheme === "external_work_reference" ? 1 : 0.82,
          `partner:${submission.account_id}`,
          at,
          at,
        )
        .run();
  return {
    type: "publishing_edition",
    id: editionId,
    titleId,
    catalogWorkId,
    contractId: contract?.contract.id || null,
    contractVersionId: contract?.version.id || null,
  };
}

async function matchAssetExpectations(
  db: CatalogDB,
  input: {
    accountId: string;
    environment: string;
    productKey: string;
    assetKind: string;
    filename: string;
    sha256: string;
    sizeBytes: number;
    mimeType: string;
    assetId: string;
  },
) {
  const rows = (
    await db
      .prepare(
        "SELECT * FROM publisher_asset_expectations WHERE account_id=? AND environment=? AND partner_product_key=? AND asset_kind=? AND status IN ('waiting','mismatch') ORDER BY created_at",
      )
      .bind(input.accountId, input.environment, input.productKey, input.assetKind)
      .all<any>()
  ).results;
  let matched = 0,
    mismatched = 0;
  const at = now();
  for (const row of rows) {
    const checksum = String(row.expected_sha256).toLowerCase() === input.sha256.toLowerCase(),
      size = row.expected_size_bytes == null || Number(row.expected_size_bytes) === input.sizeBytes,
      mime =
        !row.expected_mime_type ||
        String(row.expected_mime_type).toLowerCase() === input.mimeType.toLowerCase();
    if (checksum && size && mime) {
      await db
        .prepare(
          "UPDATE publisher_asset_expectations SET status='matched',matched_asset_id=?,validation_json='[]',matched_at=? WHERE id=?",
        )
        .bind(input.assetId, at, row.id)
        .run();
      matched++;
    } else if (String(row.source_filename) === input.filename || checksum) {
      await db
        .prepare(
          "UPDATE publisher_asset_expectations SET status='mismatch',matched_asset_id=?,validation_json=? WHERE id=?",
        )
        .bind(
          input.assetId,
          JSON.stringify([
            {
              severity: "error",
              code: "ASSET_BINARY_MISMATCH",
              message: !checksum
                ? "Uploaded asset checksum does not match the manifest."
                : !size
                  ? "Uploaded asset size does not match the manifest."
                  : "Uploaded asset MIME type does not match the manifest.",
            },
          ]),
          row.id,
        )
        .run();
      mismatched++;
    }
  }
  if (matched)
    await db
      .prepare("UPDATE publisher_feed_assets SET status='accepted',updated_at=? WHERE id=?")
      .bind(at, input.assetId)
      .run();
  return { matched, mismatched };
}

async function applyAssetManifestItem(db: CatalogDB, submission: any, p: PartnerProduct) {
  if (!p.assetKind || !p.filename || !p.sha256 || p.sizeBytes == null)
    throw new ApiError(400, "Asset manifest item is incomplete.");
  if (submission.environment === "production") {
    const mapping = await db
      .prepare(
        "SELECT publishing_edition_id FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=? AND status='active'",
      )
      .bind(submission.account_id, p.productKey)
      .first<any>();
    if (!mapping?.publishing_edition_id)
      throw new ApiError(
        409,
        `No production catalog mapping exists for ${p.productKey}. Submit metadata before the asset manifest.`,
      );
  }
  const at = now();
  const existing = await db
    .prepare(
      `SELECT * FROM publisher_feed_assets WHERE account_id=? AND environment=? AND partner_product_key=? AND asset_kind=? AND (lower(sha256)=lower(?) OR source_filename=?) ORDER BY CASE WHEN lower(sha256)=lower(?) THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    )
    .bind(
      submission.account_id,
      submission.environment,
      p.productKey,
      p.assetKind,
      p.sha256,
      p.filename,
      p.sha256,
    )
    .first<any>();
  let status = "waiting",
    matchedAssetId: string | null = null,
    matchedAt: string | null = null,
    validation: any[] = [];
  if (existing) {
    const checksum = String(existing.sha256 || "").toLowerCase() === p.sha256.toLowerCase();
    const size = Number(existing.size_bytes) === Number(p.sizeBytes);
    const mime =
      !p.mimeType ||
      !existing.mime_type ||
      String(existing.mime_type).toLowerCase() === String(p.mimeType).toLowerCase();
    matchedAssetId = String(existing.id);
    if (checksum && size && mime) {
      status = "matched";
      matchedAt = at;
      await db
        .prepare("UPDATE publisher_feed_assets SET status='accepted',updated_at=? WHERE id=?")
        .bind(at, existing.id)
        .run();
    } else {
      status = "mismatch";
      validation = [
        {
          severity: "error",
          code: "ASSET_BINARY_MISMATCH",
          message: !checksum
            ? "Existing asset checksum does not match the manifest."
            : !size
              ? "Existing asset size does not match the manifest."
              : "Existing asset MIME type does not match the manifest.",
        },
      ];
    }
  }
  const expectationId = id("pasexp");
  await db
    .prepare(
      `INSERT INTO publisher_asset_expectations(id,submission_id,account_id,environment,partner_product_key,asset_kind,source_filename,expected_mime_type,expected_size_bytes,expected_sha256,status,matched_asset_id,validation_json,created_at,matched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      expectationId,
      submission.id,
      submission.account_id,
      submission.environment,
      p.productKey,
      p.assetKind,
      p.filename,
      p.mimeType || "",
      p.sizeBytes,
      p.sha256,
      status,
      matchedAssetId,
      JSON.stringify(validation),
      at,
      matchedAt,
    )
    .run();
  return { type: "asset_expectation", id: expectationId, status, matchedAssetId };
}

async function applyDeltaItem(db: CatalogDB, submission: any, p: PartnerProduct) {
  const mapping = await db
    .prepare(
      "SELECT * FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=?",
    )
    .bind(submission.account_id, p.productKey)
    .first<any>();
  if (!mapping?.publishing_edition_id)
    throw new ApiError(
      409,
      `No production catalog mapping exists for ${p.productKey}. Submit metadata before ${submission.feed_type} deltas.`,
    );
  const editionId = String(mapping.publishing_edition_id),
    at = now(),
    draft = await db
      .prepare("SELECT * FROM publishing_edition_drafts WHERE id=?")
      .bind(editionId)
      .first<any>();
  if (!draft) throw new ApiError(409, "Mapped publishing edition no longer exists.");
  if (submission.feed_type === "price") {
    if (p.priceMinor == null) throw new ApiError(400, "Price delta is missing priceMinor.");
    await db
      .prepare(
        "UPDATE publishing_edition_drafts SET list_currency=?,list_price_minor=?,updated_at=? WHERE id=?",
      )
      .bind(p.currency || draft.list_currency || "USD", p.priceMinor, at, editionId)
      .run();
    if (mapping.catalog_product_id) {
      const prior = await db
        .prepare(
          "SELECT id FROM offers WHERE product_id=? AND offer_type='purchase' AND active=1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(mapping.catalog_product_id)
        .first<any>();
      const offerId = id("offer");
      const statements: any[] = [];
      if (prior)
        statements.push(
          db
            .prepare(
              "UPDATE offers SET active=0,ends_at=COALESCE(ends_at,?),updated_at=? WHERE id=?",
            )
            .bind(at, at, prior.id),
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,active,starts_at,ends_at,created_at,updated_at) VALUES(?,?,'purchase',?,?,1,?,NULL,?,?)",
          )
          .bind(
            offerId,
            mapping.catalog_product_id,
            p.currency || draft.list_currency || "USD",
            p.priceMinor,
            at,
            at,
            at,
          ),
      );
      await db.batch(statements);
      return { type: "price_offer", id: offerId };
    }
  } else if (submission.feed_type === "territory") {
    if (!p.territories) throw new ApiError(400, "Territory delta is missing territory scope.");
    const contract = await activeContractVersion(
      db,
      String(submission.account_id),
      p.contractReference || draft.contract_id || "",
    );
    if (draft.rights_basis !== "public_domain" && !contract)
      throw new ApiError(
        409,
        "No effective assigned contract version is available for this territory update.",
      );
    if (contract)
      await assertPartnerProductWithinContract(db, String(contract.version.id), {
        ...p,
        format: draft.format,
        drmRequirement: draft.drm_requirement,
        subscriptionPermitted: !!draft.subscription_permitted,
        libraryPermitted: !!draft.library_permitted,
      });
    const scope = {
      mode: p.territories.mode || "worldwide",
      include: normalizedCountryList(p.territories.include || []),
      exclude: normalizedCountryList(p.territories.exclude || []),
      includeSetIds: [],
      excludeSetIds: [],
    };
    await db
      .prepare(
        "UPDATE publishing_edition_drafts SET territory_scope_json=?,contract_id=COALESCE(?,contract_id),contract_version_id=COALESCE(?,contract_version_id),updated_at=? WHERE id=?",
      )
      .bind(
        JSON.stringify(scope),
        contract?.contract.id || null,
        contract?.version.id || null,
        at,
        editionId,
      )
      .run();
    if (mapping.catalog_edition_id) {
      const grants = (
        await db
          .prepare("SELECT * FROM rights_grants WHERE edition_id=? AND status='active'")
          .bind(mapping.catalog_edition_id)
          .all<any>()
      ).results;
      for (const grant of grants) {
        await upsertRightsGrant(db as any, {
          id: String(grant.id),
          editionId: String(mapping.catalog_edition_id),
          rightsholderId: grant.rightsholder_id || null,
          rightsholderPartyId: grant.rightsholder_party_id || null,
          scopeMode: scope.mode === "worldwide" ? "worldwide" : "expression",
          includeTerritories: scope.include,
          excludeTerritories: scope.exclude,
          format: String(grant.format),
          salesChannel: String(grant.sales_channel) as any,
          startsAt: grant.starts_at || null,
          endsAt: grant.ends_at || null,
          licenseType: String(grant.license_type),
          contractId: contract?.contract.id || grant.contract_id || null,
          contractVersionId: contract?.version.id || grant.contract_version_id || null,
          exclusivity: (grant.exclusivity || "nonexclusive") as any,
          drmRequirement: String(grant.drm_requirement || "none"),
          subscriptionPermitted: !!grant.subscription_permitted,
          libraryPermitted: !!grant.library_permitted,
          decision: "allow",
          status: "active",
          promotionRestrictions: parseJson(grant.promotion_restrictions_json, {}),
          contractReference: String(grant.contract_reference || ""),
          source: "publisher-territory-feed",
          notes: `Updated by partner feed ${submission.id}`,
        });
      }
    }
    return { type: "territory_rights", id: editionId };
  } else if (submission.feed_type === "availability") {
    if (!p.availability) throw new ApiError(400, "Availability delta is missing availability.");
    if (p.availability === "withdrawn")
      await db
        .prepare("UPDATE publishing_edition_drafts SET status='withdrawn',updated_at=? WHERE id=?")
        .bind(at, editionId)
        .run();
    if (mapping.catalog_product_id) {
      const storefront =
        p.availability === "available" || p.availability === "preorder" ? "active" : "inactive";
      await db
        .prepare("UPDATE products SET storefront_status=?,updated_at=? WHERE id=?")
        .bind(storefront, at, mapping.catalog_product_id)
        .run();
      if (p.availability === "withdrawn")
        await db
          .prepare(
            "UPDATE offers SET active=0,ends_at=COALESCE(ends_at,?),updated_at=? WHERE product_id=? AND active=1",
          )
          .bind(at, at, mapping.catalog_product_id)
          .run();
      else if (storefront === "active")
        await db
          .prepare(
            "UPDATE offers SET active=1,updated_at=? WHERE id=(SELECT id FROM offers WHERE product_id=? AND offer_type='purchase' ORDER BY created_at DESC LIMIT 1)",
          )
          .bind(at, mapping.catalog_product_id)
          .run();
    }
    await db
      .prepare(
        "UPDATE publisher_catalog_mappings SET status=?,updated_at=? WHERE account_id=? AND environment='production' AND partner_product_key=?",
      )
      .bind(
        p.availability === "withdrawn" ? "withdrawn" : "active",
        at,
        submission.account_id,
        p.productKey,
      )
      .run();
    return { type: "availability", id: editionId };
  }
  throw new ApiError(400, `Unsupported delta feed type ${submission.feed_type}.`);
}

async function reconcileFullPartnerSnapshot(db: CatalogDB, submission: any) {
  if (
    submission.environment !== "production" ||
    submission.feed_type !== "metadata" ||
    submission.mode !== "full" ||
    !Number(submission.replace_missing)
  )
    return 0;
  const missing = (
    await db
      .prepare(
        `SELECT m.partner_product_key,m.catalog_product_id FROM publisher_catalog_mappings m WHERE m.account_id=? AND m.environment='production' AND m.status='active' AND NOT EXISTS(SELECT 1 FROM publisher_feed_items i WHERE i.submission_id=? AND i.partner_product_key=m.partner_product_key AND i.status IN ('applied','warning','valid'))`,
      )
      .bind(submission.account_id, submission.id)
      .all<any>()
  ).results;
  const at = now();
  for (const row of missing) {
    const statements: any[] = [
      db
        .prepare(
          "UPDATE publisher_catalog_mappings SET status='withdrawn',updated_at=? WHERE account_id=? AND environment='production' AND partner_product_key=?",
        )
        .bind(at, submission.account_id, row.partner_product_key),
    ];
    if (row.catalog_product_id) {
      statements.push(
        db
          .prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?")
          .bind(at, row.catalog_product_id),
      );
      statements.push(
        db
          .prepare(
            "UPDATE offers SET active=0,ends_at=COALESCE(ends_at,?),updated_at=? WHERE product_id=? AND active=1",
          )
          .bind(at, at, row.catalog_product_id),
      );
    }
    await db.batch(statements);
  }
  return missing.length;
}

async function processPartnerFeedQueue(db: CatalogDB, limit = 25) {
  const rows = (
    await db
      .prepare(
        "SELECT * FROM publisher_feed_submissions WHERE status IN ('accepted','accepted_with_warnings') AND environment='sandbox' AND feed_type<>'assets_manifest' ORDER BY received_at LIMIT ?",
      )
      .bind(Math.max(1, Math.min(100, limit)))
      .all<any>()
  ).results;
  let applied = 0,
    failed = 0,
    sandbox = 0;
  for (const submission of rows) {
    if (submission.environment !== "sandbox" || submission.feed_type === "assets_manifest")
      throw new ApiError(503, "Partner publication requires a separately certified positive owner command.");
    await db
      .prepare(
        "UPDATE publisher_feed_submissions SET status='applying' WHERE id=? AND status IN ('accepted','accepted_with_warnings')",
      )
      .bind(submission.id)
      .run();
    const items = (
      await db
        .prepare(
          "SELECT * FROM publisher_feed_items WHERE submission_id=? AND status IN ('valid','warning') ORDER BY ordinal",
        )
        .bind(submission.id)
        .all<any>()
    ).results;
    let ok = 0,
      bad = 0;
    if (submission.environment === "sandbox" && submission.feed_type !== "assets_manifest") {
      for (const item of items)
        await db
          .prepare(
            "UPDATE publisher_feed_items SET status='applied',applied_entity_type='sandbox_preview',applied_entity_id=?,updated_at=? WHERE id=?",
          )
          .bind(item.partner_product_key, now(), item.id)
          .run();
      ok = items.length;
      sandbox++;
    } else {
      for (const item of items) {
        const p = parseJson<PartnerProduct>(item.normalized_json, {
          productKey: item.partner_product_key,
          notificationType: "update",
        });
        try {
          const result =
            submission.feed_type === "metadata"
              ? await applyMetadataItem(db, submission, item, p)
              : submission.feed_type === "assets_manifest"
                ? await applyAssetManifestItem(db, submission, p)
                : await applyDeltaItem(db, submission, p);
          await db
            .prepare(
              "UPDATE publisher_feed_items SET status=?,applied_entity_type=?,applied_entity_id=?,updated_at=? WHERE id=?",
            )
            .bind(
              "skipped" in result && result.skipped ? "skipped" : "applied",
              result.type,
              result.id || "",
              now(),
              item.id,
            )
            .run();
          ok++;
        } catch (e) {
          bad++;
          await db
            .prepare(
              "UPDATE publisher_feed_items SET status='rejected',validation_json=?,updated_at=? WHERE id=?",
            )
            .bind(
              JSON.stringify([
                {
                  severity: "error",
                  code: "APPLICATION_FAILED",
                  message: e instanceof Error ? e.message : "Application failed.",
                },
              ]),
              now(),
              item.id,
            )
            .run();
        }
      }
    }
    const withdrawnMissing = bad === 0 ? await reconcileFullPartnerSnapshot(db, submission) : 0;
    const finalStatus = bad === 0 ? "applied" : ok > 0 ? "partially_applied" : "failed",
      at = now();
    await db
      .prepare(
        "UPDATE publisher_feed_submissions SET status=?,applied_count=?,rejected_count=rejected_count+?,error_summary=?,applied_at=? WHERE id=?",
      )
      .bind(
        finalStatus,
        ok,
        bad,
        bad ? `${bad} item(s) failed during application.` : "",
        at,
        submission.id,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO publisher_validation_responses(id,submission_id,response_type,status,machine_code,message,payload_json,delivery_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id("pack"),
        submission.id,
        "application",
        finalStatus,
        finalStatus === "applied" ? "FEED_APPLIED" : "FEED_PARTIAL_OR_FAILED",
        finalStatus === "applied"
          ? "Feed applied successfully."
          : "Feed application completed with item failures.",
        JSON.stringify({
          appliedCount: ok,
          failedCount: bad,
          withdrawnMissing,
          environment: submission.environment,
        }),
        "pending",
        at,
      )
      .run();
    await partnerAudit(db, {
      accountId: submission.account_id,
      environment: submission.environment,
      actorType: "worker",
      actorId: "partner-ingest",
      eventType: "partner.feed.applied",
      subjectType: "feed",
      subjectId: submission.id,
      event: { status: finalStatus, appliedCount: ok, failedCount: bad, withdrawnMissing },
    });
    if (bad) failed++;
    else applied++;
  }
  return { leased: rows.length, applied, failed, sandbox };
}

  return processPartnerFeedQueue;
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

// These catalog mutations are not reachable by a public writer: their only
// entry is authenticated, QA-leased owner commands and an isolated D1 binding.
type DB=CatalogDB;
/* eslint-disable @typescript-eslint/no-explicit-any -- Preserved SQL template parity inside private, QA-only catalog owner. */
function commercialCatalogStatements(db: DB, externalId: string, at: string) {
  const { workId, editionId, productId } = catalogIds(externalId);
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO publishers(id,name,website,created_at,updated_at)
      SELECT gs.publisher_id,gs.name,gs.homepage_url,?,? FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?`,
      )
      .bind(at, at, externalId),
    // US rows created after migration receive the same append-only source evidence as migrated rows.
    db
      .prepare(
        `INSERT OR IGNORE INTO gutenberg_rights_evidence(id,source_id,cache_id,source_item_id,determination,territory_code,evidence_url,evidence_type,evidence_hash,parser_version,status,checked_at,created_at)
      SELECT 'gre_pgus_us_'||c.id,'pg_us',c.id,c.source_item_id,'public-domain','US',COALESCE(NULLIF(c.rights_evidence_url,''),c.source_url),'source-catalog','gutendex:'||c.id,'pgus-v1','approved',?,?
      FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.copyright=0`,
      )
      .bind(at, at, externalId),
    db
      .prepare(
        `UPDATE gutenberg_source_cache SET rights_evidence_id=COALESCE(rights_evidence_id,'gre_pgus_us_'||id),rights_checked_at=COALESCE(rights_checked_at,?)
      WHERE id=? AND source_id='pg_us' AND copyright=0`,
      )
      .bind(at, externalId),
    db
      .prepare(
        `INSERT INTO works(id,title,description,work_type,canonical_status,created_at,updated_at)
      SELECT ?,title,summary,'public_domain','canonical',first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,work_type='public_domain',canonical_status='canonical',updated_at=excluded.updated_at`,
      )
      .bind(workId, externalId),
    db
      .prepare(
        `INSERT INTO editions(id,work_id,publisher_id,title,description,language,drm_status,downloadable,release_status,edition_type,differentiation_status,differentiation_summary,canonical_public_domain,created_at,updated_at)
      SELECT ?,?,gs.publisher_id,c.title,c.summary,COALESCE(json_extract(c.languages_json,'$[0]'),'en'),'none',1,
        CASE WHEN c.rights_status='public-domain' AND c.commercial_use_status='approved' THEN 'available' ELSE 'unavailable' END,
        'canonical_public_domain','not_required','Canonical free Project Gutenberg edition',1,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,language=excluded.language,publisher_id=excluded.publisher_id,release_status=excluded.release_status,edition_type='canonical_public_domain',differentiation_status='not_required',differentiation_summary='Canonical free Project Gutenberg edition',canonical_public_domain=1,updated_at=excluded.updated_at`,
      )
      .bind(editionId, workId, externalId),
    db
      .prepare(
        `INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at)
      SELECT ?,?,'GUTENBERG-'||upper(replace(c.source_id,'pg_',''))||'-'||c.source_item_id,'ebook',
        CASE WHEN c.rights_status='public-domain' AND c.commercial_use_status='approved' THEN 'active' ELSE 'inactive' END,
        'gutenberg',c.id,c.first_ingested_at,c.updated_at FROM gutenberg_source_cache c WHERE c.id=?
      ON CONFLICT(id) DO UPDATE SET edition_id=excluded.edition_id,storefront_status=excluded.storefront_status,updated_at=excluded.updated_at`,
      )
      .bind(productId, editionId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'product',?,gs.identifier_scheme,c.source_item_id FROM gutenberg_source_cache c JOIN gutenberg_sources gs ON gs.id=c.source_id WHERE c.id=?
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(productId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'product',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(productId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'edition',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT INTO external_identifiers(entity_type,entity_id,scheme,value)
      SELECT 'work',?,'gutenberg',c.source_item_id FROM gutenberg_source_cache c WHERE c.id=? AND c.source_id='pg_us' AND c.source_item_id<>''
      ON CONFLICT(entity_type,entity_id,scheme) DO UPDATE SET value=excluded.value`,
      )
      .bind(workId, externalId),
    db
      .prepare(
        `INSERT INTO offers(id,product_id,offer_type,currency,amount_minor,active,created_at,updated_at)
      SELECT ?,?,'public-domain','USD',0,CASE WHEN rights_status='public-domain' AND commercial_use_status='approved' THEN 1 ELSE 0 END,?,?
      FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(id) DO UPDATE SET active=excluded.active,updated_at=excluded.updated_at`,
      )
      .bind(`off_gutenberg_${externalId}`, productId, at, at, externalId),
    // One exact country grant per approved evidence row. Europe therefore never receives an inferred EU/EEA blanket grant.
    db
      .prepare(
        `INSERT INTO rights_grants(
        id,edition_id,rightsholder_id,rightsholder_party_id,territory_code,format,sales_channel,license_type,drm_requirement,
        subscription_permitted,library_permitted,decision,status,promotion_restrictions_json,contract_reference,source,notes,created_at,updated_at,
        exclusivity,scope_summary,source_evidence_id
      )
      SELECT 'right_gutenberg_'||lower(ge.territory_code)||'_'||c.id,?,NULL,NULL,upper(ge.territory_code),'ebook','retail','public-domain','none',
        0,0,'allow','active','{}',ge.evidence_url,'gutenberg-'||c.source_id||'-public-domain',
        'Jurisdiction-scoped public-domain determination from '||c.source_project,?,?,'nonexclusive',upper(ge.territory_code)||' only',ge.id
      FROM gutenberg_source_cache c JOIN gutenberg_rights_evidence ge ON ge.cache_id=c.id AND ge.status='approved' AND ge.determination='public-domain'
      WHERE c.id=? AND c.rights_status='public-domain' AND c.commercial_use_status='approved'
        AND EXISTS(SELECT 1 FROM json_each(c.rights_territories_json) jt WHERE upper(jt.value)=upper(ge.territory_code))
      ON CONFLICT(id) DO NOTHING`,
      )
      .bind(editionId, at, at, externalId),
    db.prepare("DELETE FROM edition_contributors WHERE edition_id=?").bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO contributors(id,name,sort_name,created_at,updated_at)
      SELECT 'con_name_'||hex(lower(json_extract(j.value,'$.name'))),json_extract(j.value,'$.name'),json_extract(j.value,'$.name'),c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_contributors(edition_id,contributor_id,role,position)
      SELECT ?,'con_name_'||hex(lower(json_extract(j.value,'$.name'))),'author',CAST(j.key AS INTEGER)
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO work_contributors(work_id,contributor_id,role,position)
      SELECT ?,'con_name_'||hex(lower(json_extract(j.value,'$.name'))),'author',CAST(j.key AS INTEGER)
      FROM gutenberg_source_cache c,json_each(c.authors_json) j WHERE c.id=? AND json_extract(j.value,'$.name') IS NOT NULL`,
      )
      .bind(workId, externalId),
    db
      .prepare("DELETE FROM edition_subjects WHERE edition_id=? AND source='gutenberg'")
      .bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO subjects(id,scheme,name,normalized_name,created_at,updated_at)
      SELECT 'sub_gutenberg_'||hex(lower(j.value)),'gutenberg',j.value,lower(trim(j.value)),c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.subjects_json) j WHERE c.id=? AND trim(j.value)<>''`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_subjects(edition_id,subject_id,position,source)
      SELECT ?,'sub_gutenberg_'||hex(lower(j.value)),CAST(j.key AS INTEGER),'gutenberg'
      FROM gutenberg_source_cache c,json_each(c.subjects_json) j WHERE c.id=? AND trim(j.value)<>''`,
      )
      .bind(editionId, externalId),
    db.prepare("DELETE FROM edition_categories WHERE edition_id=?").bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO categories(id,scheme,name)
      SELECT 'cat_shelf_'||hex(lower(j.value)),'gutenberg-bookshelf',j.value FROM gutenberg_source_cache c,json_each(c.bookshelves_json) j WHERE c.id=?`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_categories(edition_id,category_id,position)
      SELECT ?,'cat_shelf_'||hex(lower(j.value)),1000+CAST(j.key AS INTEGER) FROM gutenberg_source_cache c,json_each(c.bookshelves_json) j WHERE c.id=?`,
      )
      .bind(editionId, externalId),
    db.prepare("DELETE FROM edition_languages WHERE edition_id=?").bind(editionId),
    db
      .prepare(
        `INSERT OR IGNORE INTO edition_languages(edition_id,language_code,kind)
      SELECT ?,j.value,'content' FROM gutenberg_source_cache c,json_each(c.languages_json) j WHERE c.id=?`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT OR IGNORE INTO languages(code,name,native_name,direction,active,created_at,updated_at)
      SELECT lower(j.value),'','',CASE WHEN lower(j.value) IN ('ar','fa','he','ur') THEN 'rtl' ELSE 'ltr' END,1,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c,json_each(c.languages_json) j WHERE c.id=? AND trim(j.value)<>''`,
      )
      .bind(externalId),
    db
      .prepare(
        `INSERT INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)
      SELECT ?,?,'epub','none',1,first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=? AND (
        COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')) IS NOT NULL
        OR (source_id IN ('pg_au','pg_ca','pg_eu') AND epub_status='completed'
          AND rights_status='public-domain' AND commercial_use_status='approved'
          AND NULLIF(content_hash,'') IS NOT NULL))
      ON CONFLICT(edition_id,kind) DO UPDATE SET updated_at=excluded.updated_at`,
      )
      .bind(`asset_epub_gutenberg_${externalId}`, editionId, externalId),
    db
      .prepare(
        `INSERT INTO asset_versions(id,asset_id,version_number,source_url,object_key,mime_type,sha256,created_at)
      SELECT ?,?,1,COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"'),json_extract(formats_json,'$."text/html"')),
        CASE WHEN epub_status='completed' THEN 'epubs/'||id||'.epub' ELSE NULL END,'application/epub+zip',NULLIF(content_hash,''),first_ingested_at
      FROM gutenberg_source_cache WHERE id=? AND (
        COALESCE(json_extract(formats_json,'$."application/epub+zip"'),json_extract(formats_json,'$."application/epub+zip;"')) IS NOT NULL
        OR (source_id IN ('pg_au','pg_ca','pg_eu') AND epub_status='completed'
          AND rights_status='public-domain' AND commercial_use_status='approved'
          AND NULLIF(content_hash,'') IS NOT NULL))
      ON CONFLICT(asset_id,version_number) DO UPDATE SET source_url=excluded.source_url,object_key=COALESCE(excluded.object_key,asset_versions.object_key),sha256=COALESCE(excluded.sha256,asset_versions.sha256)`,
      )
      .bind(
        `assetver_epub_gutenberg_${externalId}`,
        `asset_epub_gutenberg_${externalId}`,
        externalId,
      ),
    db
      .prepare("UPDATE digital_assets SET current_version_id=? WHERE id=?")
      .bind(`assetver_epub_gutenberg_${externalId}`, `asset_epub_gutenberg_${externalId}`),
    db
      .prepare(
        `INSERT INTO edition_distinctions(edition_id,edition_type,differentiation_summary,source_text_fingerprint,asset_sha256,verification_status,policy_version,created_at,updated_at)
      SELECT ?,'canonical_public_domain','Canonical free Project Gutenberg edition','',COALESCE(NULLIF(content_hash,''),''),'verified','fore-public-domain-editions-v1',first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=?
      ON CONFLICT(edition_id) DO UPDATE SET edition_type='canonical_public_domain',differentiation_summary=excluded.differentiation_summary,asset_sha256=excluded.asset_sha256,verification_status='verified',updated_at=excluded.updated_at`,
      )
      .bind(editionId, externalId),
    db
      .prepare(
        `INSERT INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)
      SELECT ?,?,'cover','none',1,first_ingested_at,updated_at FROM gutenberg_source_cache WHERE id=? AND source_id='pg_us' AND COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL
      ON CONFLICT(edition_id,kind) DO UPDATE SET updated_at=excluded.updated_at`,
      )
      .bind(`asset_cover_gutenberg_${externalId}`, editionId, externalId),
    db
      .prepare(
        `INSERT INTO asset_versions(id,asset_id,version_number,source_url,mime_type,created_at)
      SELECT ?,?,1,COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')),CASE WHEN json_extract(formats_json,'$."image/jpeg"') IS NOT NULL THEN 'image/jpeg' ELSE 'image/png' END,first_ingested_at
      FROM gutenberg_source_cache WHERE id=? AND source_id='pg_us' AND COALESCE(json_extract(formats_json,'$."image/jpeg"'),json_extract(formats_json,'$."image/png"')) IS NOT NULL
      ON CONFLICT(asset_id,version_number) DO UPDATE SET source_url=excluded.source_url,mime_type=excluded.mime_type`,
      )
      .bind(
        `assetver_cover_gutenberg_${externalId}`,
        `asset_cover_gutenberg_${externalId}`,
        externalId,
      ),
    db
      .prepare("UPDATE digital_assets SET current_version_id=? WHERE id=?")
      .bind(`assetver_cover_gutenberg_${externalId}`, `asset_cover_gutenberg_${externalId}`),
    db
      .prepare(
        `INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,bookshelves_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at)
      SELECT ?,c.id,c.title,
        COALESCE((SELECT group_concat(x.name,' ') FROM edition_contributors ec JOIN contributors x ON x.id=ec.contributor_id WHERE ec.edition_id=? ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(s.name,' | ') FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id=? ORDER BY es.position),''),
        COALESCE((SELECT group_concat(cat.name,' | ') FROM edition_categories ec JOIN categories cat ON cat.id=ec.category_id WHERE ec.edition_id=? AND cat.scheme='gutenberg-bookshelf' ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(cat.name,' | ') FROM edition_categories ec JOIN categories cat ON cat.id=ec.category_id WHERE ec.edition_id=? ORDER BY ec.position),''),
        COALESCE((SELECT group_concat(el.language_code,' ') FROM edition_languages el WHERE el.edition_id=? AND el.kind='content'),''),
        c.summary,c.download_count,c.first_ingested_at,c.updated_at
      FROM gutenberg_source_cache c WHERE c.id=?
      ON CONFLICT(product_id) DO UPDATE SET title=excluded.title,contributors_text=excluded.contributors_text,subjects_text=excluded.subjects_text,bookshelves_text=excluded.bookshelves_text,categories_text=excluded.categories_text,languages_text=excluded.languages_text,description=excluded.description,download_count=excluded.download_count,updated_at=excluded.updated_at`,
      )
      .bind(productId, editionId, editionId, editionId, editionId, editionId, externalId),
    db
      .prepare(
        `UPDATE catalog_search_documents SET
      publisher_text=COALESCE((SELECT pub.name FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN publishers pub ON pub.id=e.publisher_id WHERE p.id=?),''),
      imprint_text=COALESCE((SELECT imp.name FROM products p JOIN editions e ON e.id=p.edition_id LEFT JOIN imprints imp ON imp.id=e.imprint_id WHERE p.id=?),''),
      series_text=COALESCE((SELECT group_concat(s.name,' | ') FROM products p JOIN editions e ON e.id=p.edition_id JOIN series_memberships sm ON sm.edition_id=e.id JOIN series s ON s.id=sm.series_id WHERE p.id=?),''),
      isbn13=COALESCE((SELECT e.isbn13 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),''),
      format=COALESCE((SELECT p.format FROM products p WHERE p.id=?),'ebook'),
      currency=COALESCE((SELECT o.currency FROM offers o WHERE o.product_id=? AND o.active=1 ORDER BY o.created_at DESC LIMIT 1),'USD'),
      price_minor=COALESCE((SELECT o.amount_minor FROM offers o WHERE o.product_id=? AND o.active=1 ORDER BY o.created_at DESC LIMIT 1),0),
      subscription_eligible=COALESCE((SELECT e.subscription_eligible FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),0),
      library_eligible=COALESCE((SELECT e.library_eligible FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),0),
      release_date=(SELECT e.release_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),
      publication_date=(SELECT e.publication_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),
      preorder_date=(SELECT e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?),
      product_created_at=(SELECT p.created_at FROM products p WHERE p.id=?),product_updated_at=(SELECT p.updated_at FROM products p WHERE p.id=?),
      availability=CASE WHEN EXISTS(SELECT 1 FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=? AND p.storefront_status='active' AND e.release_status IN ('available','preorder')) THEN 'available' ELSE 'unavailable' END,
      suppressed=CASE WHEN EXISTS(SELECT 1 FROM products p WHERE p.id=? AND p.storefront_status='active') THEN 0 ELSE 1 END WHERE product_id=?`,
      )
      .bind(
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
        productId,
      ),
  ];
}

function personalImportStatements(
  db: DB,
  input: {
    id: string;
    userId: string;
    title: string;
    author: string;
    language: string;
    objectKey: string;
    createdAt: string;
  },
) {
  const { workId, editionId, productId } = catalogIds(input.id);
  const contributorId = `con_upload_${input.id}`;
  const assetId = `asset_epub_${input.id}`;
  const versionId = `assetver_epub_${input.id}`;
  return [
    db
      .prepare(
        "INSERT INTO works(id,title,description,created_at,updated_at) VALUES(?,?,'Personal import',?,?)",
      )
      .bind(workId, input.title, input.createdAt, input.createdAt),
    db
      .prepare(
        "INSERT INTO editions(id,work_id,title,description,language,drm_status,downloadable,release_status,created_at,updated_at) VALUES(?,?,?,'Personal import',?,'none',1,'private',?,?)",
      )
      .bind(editionId, workId, input.title, input.language, input.createdAt, input.createdAt),
    db
      .prepare(
        "INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,'ebook','private','upload',?,?,?)",
      )
      .bind(productId, editionId, `UPLOAD-${input.id}`, input.id, input.createdAt, input.createdAt),
    db
      .prepare(
        "INSERT INTO external_identifiers(entity_type,entity_id,scheme,value) VALUES('product',?,'upload',?)",
      )
      .bind(productId, input.id),
    db
      .prepare(
        "INSERT INTO contributors(id,name,sort_name,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .bind(contributorId, input.author, input.author, input.createdAt, input.createdAt),
    db
      .prepare(
        "INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?,'author',0)",
      )
      .bind(editionId, contributorId),
    db
      .prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,'content')")
      .bind(editionId, input.language),
    db
      .prepare(
        "INSERT INTO digital_assets(id,edition_id,kind,current_version_id,drm_status,downloadable,created_at,updated_at) VALUES(?,?,'epub',?,'none',1,?,?)",
      )
      .bind(assetId, editionId, versionId, input.createdAt, input.createdAt),
    db
      .prepare(
        "INSERT INTO asset_versions(id,asset_id,version_number,object_key,mime_type,created_at) VALUES(?,?,1,?,'application/epub+zip',?)",
      )
      .bind(versionId, assetId, input.objectKey, input.createdAt),
    db
      .prepare(
        "INSERT INTO personal_imports(id,user_id,product_id,object_key,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(input.id, input.userId, productId, input.objectKey, input.createdAt),
    db
      .prepare(
        "INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at) VALUES(?,?,?,?,'Personal import','Personal import',?,'Personal import',0,?,?)",
      )
      .bind(
        productId,
        input.id,
        input.title,
        input.author,
        input.language,
        input.createdAt,
        input.createdAt,
      ),
    db
      .prepare(
        "UPDATE catalog_search_documents SET format='ebook',availability='private',suppressed=1,product_created_at=?,product_updated_at=? WHERE product_id=?",
      )
      .bind(input.createdAt, input.createdAt, productId),
    db
      .prepare(
        "INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at) VALUES(?,?,?,'personal-import','active','upload',?,?)",
      )
      .bind(
        `ent_${crypto.randomUUID()}`,
        input.userId,
        productId,
        input.createdAt,
        input.createdAt,
      ),
    db
      .prepare(
        "INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,updated_at) VALUES(?,?,?,1,'want-to-read',?)",
      )
      .bind(input.userId, productId, input.id, input.createdAt),
  ];
}


/* eslint-enable @typescript-eslint/no-explicit-any */


/** QA-private, independently authorizing publisher audiovisual metadata. No public
 * route, caller-supplied SQL, or production lease can reach these mutations. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Historical D1 row shapes in the isolated, QA-leased audiobook owner clone. */
const privateAudioMetadata=(()=>{
  const now=()=>new Date().toISOString();
const id = (p: string) => `${p}_${crypto.randomUUID()}`;
const json = (s: any, f: any) => {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return f;
  }
};
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function validIsbn13(value: string) {
  if (!/^\d{13}$/.test(value)) return false;
  const sum = value
      .split("")
      .slice(0, 12)
      .reduce((a, n, i) => a + Number(n) * (i % 2 ? 3 : 1), 0),
    check = (10 - (sum % 10)) % 10;
  return check === Number(value[12]);
}
async function publishingEdition(
  db: CoveEnv["DB"],
  userId: string,
  editionId: string,
  write = false,
) {
  const row = await db
    .prepare(
      `SELECT e.*,t.account_id,t.title,t.subtitle,t.description FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
    )
    .bind(editionId)
    .first<any>();
  if (!row || row.format !== "audiobook")
    throw new ApiError(404, "Commercial audiobook edition not found.");
  const m = await db
    .prepare(
      "SELECT role FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'",
    )
    .bind(row.account_id, userId)
    .first<any>();
  if (!m || (write && !["owner", "admin", "editor"].includes(String(m.role))))
    throw new ApiError(403, "You do not have permission to manage this audiobook.");
  return row;
}
function requireAudioEditable(edition: any) {
  if (!["draft", "changes_requested"].includes(String(edition.status)))
    throw new ApiError(
      409,
      "Open a publishing update before changing commercial audiobook metadata, files, narrators, or agreements.",
    );
  return edition;
}
async function requireAudioProfile(db: CoveEnv["DB"], editionId: string) {
  const p = await db
    .prepare("SELECT 1 ok FROM commercial_audio_profiles WHERE edition_id=?")
    .bind(editionId)
    .first<any>();
  if (!p)
    throw new ApiError(
      409,
      "Save the commercial audiobook profile before adding narrators, agreements, or audio files.",
    );
}

async function saveCommercialAudioProfile(db: CoveEnv["DB"], userId: string, raw: unknown) {
  const x = z
      .object({
        editionId: z.string().min(1),
        audioPublisher: z.string().trim().min(1).max(240),
        copyrightNotice: z.string().trim().min(1).max(500),
        performanceRightsBasis: z.string().trim().min(10).max(4000),
        performanceRightsEvidenceId: z.string().min(1).nullable(),
        identifierType: z
          .enum(["isbn13", "asin", "ean", "upc", "publisher", "other"])
          .default("isbn13"),
        identifierValue: z.string().trim().min(1).max(120),
        credits: z
          .array(z.object({ role: z.string().min(1).max(80), name: z.string().min(1).max(240) }))
          .max(100)
          .default([]),
        territoryScope: z.record(z.any()).default({ mode: "worldwide" }),
        subscriptionEligible: z.boolean().default(false),
        offlineEligible: z.boolean().default(true),
        coverAssetVersionId: z.string().nullable().optional(),
      })
      .parse(raw),
    e = requireAudioEditable(await publishingEdition(db, userId, x.editionId, true)),
    policy = await db
      .prepare("SELECT id FROM commercial_audio_policy_versions WHERE status='active' LIMIT 1")
      .first<any>();
  if (!policy) throw new ApiError(503, "Commercial audiobook policy is unavailable.");
  if (x.performanceRightsEvidenceId) {
    const ev = await db
      .prepare(
        "SELECT 1 ok FROM publishing_rights_evidence pe JOIN publishing_rights_declarations pd ON pd.id=pe.declaration_id WHERE pe.id=? AND pd.edition_id=? AND pe.verification_status='verified'",
      )
      .bind(x.performanceRightsEvidenceId, x.editionId)
      .first<any>();
    if (!ev)
      throw new ApiError(
        409,
        "Performance-rights evidence must be staff-verified for this edition.",
      );
  }
  if (x.identifierType === "isbn13" && !validIsbn13(x.identifierValue))
    throw new ApiError(400, "Audiobook ISBN-13 is invalid.");
  if (x.subscriptionEligible && !e.subscription_permitted)
    throw new ApiError(
      409,
      "Enable subscription distribution on the edition before marking the audiobook subscription-eligible.",
    );
  const editionTerritory = json(e.territory_scope_json, {});
  if (stable(x.territoryScope) !== stable(editionTerritory))
    throw new ApiError(
      409,
      "Audiobook performance-rights territory must match this edition's distribution territory. Change the edition rights scope first.",
    );
  const at = now();
  await db
    .prepare(
      `INSERT INTO commercial_audio_profiles(edition_id,publishing_account_id,audio_publisher,copyright_notice,performance_rights_basis,performance_rights_evidence_id,identifier_type,identifier_value,credits_json,territory_scope_json,subscription_eligible,offline_eligible,cover_asset_version_id,active_policy_id,qc_status,rights_status,agreements_status,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,'pending',?,?) ON CONFLICT(edition_id) DO UPDATE SET audio_publisher=excluded.audio_publisher,copyright_notice=excluded.copyright_notice,performance_rights_basis=excluded.performance_rights_basis,performance_rights_evidence_id=excluded.performance_rights_evidence_id,identifier_type=excluded.identifier_type,identifier_value=excluded.identifier_value,credits_json=excluded.credits_json,territory_scope_json=excluded.territory_scope_json,subscription_eligible=excluded.subscription_eligible,offline_eligible=excluded.offline_eligible,cover_asset_version_id=excluded.cover_asset_version_id,active_policy_id=excluded.active_policy_id,rights_status=excluded.rights_status,updated_at=excluded.updated_at`,
    )
    .bind(
      x.editionId,
      e.account_id,
      x.audioPublisher,
      x.copyrightNotice,
      x.performanceRightsBasis,
      x.performanceRightsEvidenceId,
      x.identifierType,
      x.identifierValue,
      JSON.stringify(x.credits),
      JSON.stringify(x.territoryScope),
      x.subscriptionEligible ? 1 : 0,
      x.offlineEligible ? 1 : 0,
      x.coverAssetVersionId || null,
      policy.id,
      x.performanceRightsEvidenceId ? "verified" : "pending",
      at,
      at,
    )
    .run();
  return { saved: true };
}

async function replaceCommercialAudioNarrators(
  db: CoveEnv["DB"],
  userId: string,
  raw: unknown,
) {
  const x = z
    .object({
      editionId: z.string().min(1),
      narrators: z
        .array(
          z.object({
            displayName: z.string().trim().min(1).max(240),
            narrationType: z.enum(["human", "synthetic", "mixed"]).default("human"),
            syntheticVoiceLabel: z.string().max(240).default(""),
          }),
        )
        .min(1)
        .max(30),
    })
    .parse(raw);
  const e = requireAudioEditable(await publishingEdition(db, userId, x.editionId, true));
  await requireAudioProfile(db, e.id);
  const active = await db
    .prepare("SELECT count(*) n FROM narration_agreements WHERE edition_id=? AND status='active'")
    .bind(x.editionId)
    .first<any>();
  if (Number(active?.n || 0) > 0)
    throw new ApiError(
      409,
      "Narrators with active agreements cannot be replaced. Supersede agreements first.",
    );
  // Validate the complete replacement before any destructive operation.
  for(const n of x.narrators) if(n.narrationType!=="human"&&!n.syntheticVoiceLabel.trim())
    throw new ApiError(400,"Synthetic or mixed narration requires a customer-facing voice label.");
  const at=now(),statements=[
    db.prepare("DELETE FROM commercial_audio_narrators WHERE edition_id=?").bind(x.editionId)
  ];
  for(const [i,n] of x.narrators.entries())
    statements.push(db.prepare(
      "INSERT INTO commercial_audio_narrators(id,edition_id,display_name,narration_type,synthetic_voice_label,billing_order,created_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(id("narr"),x.editionId,n.displayName,n.narrationType,n.syntheticVoiceLabel,i,at));
  // D1 batch is atomic: a failed insertion cannot delete the existing list.
  await db.batch(statements);
  return { saved: true };
}

async function addNarrationAgreement(db: CoveEnv["DB"], userId: string, raw: unknown) {
  const x = z
    .object({
      editionId: z.string().min(1),
      narratorId: z.string().min(1),
      agreementType: z.enum([
        "employment",
        "work_for_hire",
        "license",
        "union",
        "synthetic_voice_license",
        "other",
      ]),
      evidenceId: z.string().min(1),
      territories: z.array(z.string().min(2).max(20)).min(1),
      permittedUses: z
        .array(z.enum(["retail", "subscription", "library", "preview", "offline"]))
        .min(1),
      signedAt: z.string().datetime(),
      expiresAt: z.string().datetime().nullable().optional(),
    })
    .parse(raw);
  const e = requireAudioEditable(await publishingEdition(db, userId, x.editionId, true));
  await requireAudioProfile(db, e.id);
  const n = await db
    .prepare("SELECT * FROM commercial_audio_narrators WHERE id=? AND edition_id=?")
    .bind(x.narratorId, x.editionId)
    .first<any>();
  if (!n) throw new ApiError(404, "Narrator not found.");
  if (n.narration_type !== "human" && x.agreementType !== "synthetic_voice_license")
    throw new ApiError(400, "Synthetic narration requires a synthetic voice license agreement.");
  const ev = await db
    .prepare(
      "SELECT pe.id FROM publishing_rights_evidence pe JOIN publishing_rights_declarations pd ON pd.id=pe.declaration_id WHERE pe.id=? AND pd.edition_id=? AND pe.verification_status='verified'",
    )
    .bind(x.evidenceId, x.editionId)
    .first<any>();
  if (!ev) throw new ApiError(409, "Narration agreement evidence must be staff-verified.");
  const agreementId = id("narragr"),
    at = now();
  await db
    .prepare(
      "INSERT INTO narration_agreements(id,edition_id,narrator_id,agreement_type,evidence_id,territories_json,permitted_uses_json,signed_at,expires_at,status,attested_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)",
    )
    .bind(
      agreementId,
      x.editionId,
      x.narratorId,
      x.agreementType,
      x.evidenceId,
      JSON.stringify(x.territories),
      JSON.stringify(x.permittedUses),
      x.signedAt,
      x.expiresAt || null,
      userId,
      at,
    )
    .run();
  await refreshAgreementStatus(db, x.editionId);
  return { id: agreementId };
}
async function endNarrationAgreement(db: CoveEnv["DB"], userId: string, raw: unknown) {
  const x = z
      .object({
        agreementId: z.string().min(1),
        disposition: z.enum(["terminated", "superseded"]),
        effectiveAt: z.string().datetime().optional(),
        replacementAgreementId: z.string().min(1).nullable().optional(),
        reason: z.string().trim().min(10).max(2000),
      })
      .parse(raw),
    agreement = await db
      .prepare("SELECT * FROM narration_agreements WHERE id=?")
      .bind(x.agreementId)
      .first<any>();
  if (!agreement) throw new ApiError(404, "Narration agreement not found.");
  await publishingEdition(db, userId, String(agreement.edition_id), true);
  const existing = await db
    .prepare("SELECT id FROM narration_agreement_terminations WHERE agreement_id=?")
    .bind(x.agreementId)
    .first<any>();
  if (existing)
    throw new ApiError(
      409,
      "This narration agreement already has an immutable termination/supersession record.",
    );
  if (x.disposition === "superseded") {
    if (!x.replacementAgreementId)
      throw new ApiError(400, "A replacement agreement is required when superseding an agreement.");
    const replacement = await db
      .prepare("SELECT id,narrator_id,edition_id FROM narration_agreements WHERE id=?")
      .bind(x.replacementAgreementId)
      .first<any>();
    if (
      !replacement ||
      replacement.edition_id !== agreement.edition_id ||
      replacement.narrator_id !== agreement.narrator_id
    )
      throw new ApiError(
        409,
        "Replacement agreement must belong to the same edition and narrator.",
      );
  }
  const at = now(),
    effectiveAt = x.effectiveAt || at,
    terminationId = id("narrterm");
  await db
    .prepare(
      "INSERT INTO narration_agreement_terminations(id,agreement_id,disposition,effective_at,replacement_agreement_id,reason,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      terminationId,
      x.agreementId,
      x.disposition,
      effectiveAt,
      x.replacementAgreementId || null,
      x.reason,
      userId,
      at,
    )
    .run();
  await refreshAgreementStatus(db, String(agreement.edition_id));
  return { id: terminationId, effectiveAt };
}
async function refreshAgreementStatus(db: CoveEnv["DB"], editionId: string) {
  const at = now(),
    narrators = await db
      .prepare("SELECT count(*) n FROM commercial_audio_narrators WHERE edition_id=?")
      .bind(editionId)
      .first<any>(),
    covered = await db
      .prepare(
        `SELECT count(DISTINCT na.narrator_id) n FROM narration_agreements na WHERE na.edition_id=? AND na.status='active' AND (na.expires_at IS NULL OR na.expires_at>?) AND NOT EXISTS(SELECT 1 FROM narration_agreement_terminations nt WHERE nt.agreement_id=na.id AND nt.effective_at<=?)`,
      )
      .bind(editionId, at, at)
      .first<any>();
  await db
    .prepare(
      "UPDATE commercial_audio_profiles SET agreements_status=?,updated_at=? WHERE edition_id=?",
    )
    .bind(
      Number(narrators?.n || 0) > 0 && Number(covered?.n || 0) >= Number(narrators?.n || 0)
        ? "verified"
        : "pending",
      at,
      editionId,
    )
    .run();
}


  async function requireAudioUploadEdition(db:CoveEnv["DB"],userId:string,editionId:string){
    const edition=requireAudioEditable(await publishingEdition(db,userId,editionId,true));
    await requireAudioProfile(db,edition.id);
    return edition;
  }
  return {saveCommercialAudioProfile,replaceCommercialAudioNarrators,addNarrationAgreement,
    endNarrationAgreement,requireAudioUploadEdition};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */


/* eslint-disable @typescript-eslint/no-explicit-any -- Typed QA-only staff action ownership, production locked. */
const supportOwnerId=(p:string)=>p+"_"+crypto.randomUUID();
async function executeSupportActionOwned(
  env: CoveEnv,
  staff: StaffContext,
  permission: (p: string) => boolean,
  raw: unknown,
  ownerSql:AuthoritySql,
  ownerTransaction:(fn:()=>ReturnType<typeof denyPaidEntitlement>)=>ReturnType<typeof denyPaidEntitlement>,
) {
  const x = z
      .object({
        caseId: z.string().min(1),
        actionType: z.enum([
          "resend_receipt",
          "refund",
          "restore_entitlement",
          "revoke_entitlement",
          "reset_publication",
          "requeue_download",
          "revoke_device",
          "security_recovery",
          "note_only",
        ]),
        targetId: z.string().min(1),
        reasonCode: z.string().min(2).max(120),
        rationale: z.string().trim().min(10).max(5000),
        idempotencyKey: z.string().min(16).max(200),
        amountMinor: z.number().int().positive().optional(),
      })
      .parse(raw),
    db = env.DB,
    c = await db.prepare("SELECT * FROM support_cases WHERE id=?").bind(x.caseId).first<any>();
  if (!c) throw new ApiError(404, "Support case not found.");
  if (x.actionType === "refund" && !permission("support.refund"))
    throw new ApiError(403, "Staff permission required: support.refund.");
  if (x.actionType === "reset_publication" && !permission("support.publication.manage"))
    throw new ApiError(403, "Staff permission required: support.publication.manage.");
  if (x.actionType === "security_recovery" && !permission("account.recovery.manage"))
    throw new ApiError(403, "Staff permission required: account.recovery.manage.");
  if (
    ["restore_entitlement", "revoke_entitlement"].includes(x.actionType) &&
    !permission("support.entitlement.manage")
  )
    throw new ApiError(403, "Staff permission required: support.entitlement.manage.");
  if (
    ["revoke_device", "requeue_download"].includes(x.actionType) &&
    !permission("support.device.manage")
  )
    throw new ApiError(403, "Staff permission required: support.device.manage.");
  if (x.actionType === "resend_receipt" && !permission("support.receipt.resend"))
    throw new ApiError(403, "Staff permission required: support.receipt.resend.");
  if (x.actionType === "refund") {
    throw new ApiError(503,"Provider-backed support refunds are not independently certified.");
  }
  if (x.actionType === "resend_receipt") {
    const order = await db
      .prepare(
        "SELECT id,user_id,invoice_number,receipt_url,status FROM commerce_orders WHERE id=?",
      )
      .bind(x.targetId)
      .first<any>();
    if (!order) throw new ApiError(404, "Order not found.");
    assertScope(c, order.id, "order");
    assertScope(c, order.user_id, "user");
    const at = now(),
      notificationId = supportOwnerId("notif");
    await db
      .prepare(
        "INSERT OR IGNORE INTO commerce_notifications(id,user_id,notification_type,dedupe_key,title,body,payload_json,created_at) VALUES(?,?,'receipt',?,?,?,?,?)",
      )
      .bind(
        notificationId,
        order.user_id,
        `support-receipt:${x.idempotencyKey}`,
        `Receipt ${order.invoice_number}`,
        `Your Cove receipt ${order.invoice_number} is ready.`,
        JSON.stringify({ orderId: order.id, receiptUrl: order.receipt_url || null }),
        at,
      )
      .run();
    await db
      .prepare(
        "INSERT OR IGNORE INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,available_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
      )
      .bind(
        "outbox_support_"+(await sha256(x.idempotencyKey)).slice(0,48),
        "support.receipt.resend",
        "order",
        order.id,
        JSON.stringify({
          userId: order.user_id,
          orderId: order.id,
          invoiceNumber: order.invoice_number,
        }),
        at,
        at,
      )
      .run();
    return recordAction(db, staff, { ...x, targetType: "order" }, order, {
      queued: true,
      notificationId,
    });
  }
  if (["restore_entitlement", "revoke_entitlement"].includes(x.actionType)) {
    // A support ticket cannot supply evidence for positive restoration.
    if (x.actionType === "restore_entitlement")
      throw new ApiError(503, "Fresh independent positive rights proof is required.");
    const before = await db.prepare("SELECT * FROM entitlements WHERE id=?")
      .bind(x.targetId).first<any>();
    if (!before) throw new ApiError(404,"Entitlement not found.");
    assertScope(c,before.user_id,"user");
    assertScope(c,before.product_id,"product");
    // Only commercial entitlements have a durable paid-authority epoch.
    // Public-domain/non-paid grants require a separately scoped owner command.
    if (!/^prd_(?!gutenberg_)[a-zA-Z0-9_-]{3,120}$/.test(String(before.product_id)))
      throw new ApiError(503,"No strong owner authority for this entitlement class.");
    const operationId = "support-entitlement:"+(await sha256(x.idempotencyKey));
    const outcome=ownerTransaction(()=>denyPaidEntitlement(ownerSql,{
      entitlementId:String(before.id),userId:String(before.user_id),
      productId:String(before.product_id),operationId
    }));
    if (!outcome.applied) throw new ApiError(409,"An owner revocation superseded this action.");
    await db.batch([
      db.prepare("UPDATE entitlements SET status='revoked',updated_at=? WHERE id=? AND status<>'revoked'")
        .bind(now(),x.targetId),
      db.prepare("UPDATE audio_offline_licenses SET status='revoked',revoked_at=?,revocation_reason='entitlement_revoked' WHERE entitlement_id=? AND status='active'")
        .bind(now(),x.targetId)
    ]);
    const after=await db.prepare("SELECT * FROM entitlements WHERE id=?")
      .bind(x.targetId).first<any>();
    if(!after||after.status!=="revoked")
      throw new ApiError(503,"Owner denial applied but canonical reconciliation is incomplete.");
    return recordAction(db,staff,{...x,targetType:"entitlement"},before,after);
  }
  if (x.actionType === "revoke_device") {
    const before = await db
      .prepare("SELECT * FROM devices WHERE id=?")
      .bind(x.targetId)
      .first<any>();
    if (!before) throw new ApiError(404, "Device not found.");
    assertScope(c, before.user_id, "user");
    await db
      .prepare("UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?")
      .bind(now(), x.targetId)
      .run();
    await db
      .prepare(
        "UPDATE audio_offline_licenses SET status='revoked',revoked_at=?,revocation_reason='support_device_revoke' WHERE device_id=? AND status='active'",
      )
      .bind(now(), x.targetId)
      .run();
    const after = await db
      .prepare("SELECT * FROM devices WHERE id=?")
      .bind(x.targetId)
      .first<any>();
    return recordAction(db, staff, { ...x, targetType: "device" }, before, after);
  }
  if (x.actionType === "reset_publication") {
    const before = await db
      .prepare(
        `SELECT l.*,t.account_id,p.product_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id LEFT JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id LEFT JOIN publishing_publications p ON p.id=pv.publication_id WHERE l.publishing_edition_id=?`,
      )
      .bind(x.targetId)
      .first<any>();
    if (!before) throw new ApiError(404, "Publishing lifecycle not found.");
    assertScope(c, before.account_id, "publisher");
    if (before.product_id) assertScope(c, before.product_id, "product");
    if (["suppressed", "takedown", "retired"].includes(String(before.state)))
      throw new ApiError(
        409,
        "Trust & Safety enforcement cannot be bypassed through customer support.",
      );
    if (["live", "updated"].includes(String(before.state)))
      throw new ApiError(
        409,
        "Live publications must be changed through Publishing Operations, not Customer Support.",
      );
    await db
      .prepare(
        "UPDATE publishing_release_lifecycles SET state='draft',state_reason='support_reset',updated_at=? WHERE publishing_edition_id=?",
      )
      .bind(now(), x.targetId)
      .run();
    await db
      .prepare("UPDATE publishing_edition_drafts SET status='draft',updated_at=? WHERE id=?")
      .bind(now(), x.targetId)
      .run();
    const after = await db
      .prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?")
      .bind(x.targetId)
      .first<any>();
    return recordAction(db, staff, { ...x, targetType: "publishing_edition" }, before, after);
  }
  if (x.actionType === "requeue_download") {
    const before = await db
      .prepare("SELECT * FROM audio_offline_licenses WHERE id=?")
      .bind(x.targetId)
      .first<any>();
    if (!before) throw new ApiError(404, "Offline license not found.");
    assertScope(c, before.user_id, "user");
    assertScope(c, before.product_id, "product");
    await db
      .prepare(
        "UPDATE audio_offline_licenses SET status='revoked',revoked_at=?,revocation_reason='support_reissue' WHERE id=? AND status='active'",
      )
      .bind(now(), x.targetId)
      .run();
    return recordAction(db, staff, { ...x, targetType: "offline_license" }, before, {
      reissueRequired: true,
    });
  }
  if (x.actionType === "security_recovery") {
    const account = await db
      .prepare("SELECT app_id,email FROM auth_accounts WHERE app_id=?")
      .bind(x.targetId)
      .first<any>();
    if (!account) throw new ApiError(404, "Account not found.");
    assertScope(c, account.app_id, "user");
    const emailHash = await sha256(
      String(account.email || "")
        .trim()
        .toLowerCase(),
    );
    await db
      .prepare(
        "INSERT INTO account_recovery_events(id,user_id,email_hash,event_type,actor_type,actor_user_id,metadata_json,created_at) VALUES(?,?,?,'staff_escalated','staff',?,?,?)",
      )
      .bind(
        supportOwnerId("recovery"),
        account.app_id,
        emailHash,
        staff.userId,
        JSON.stringify({ caseId: x.caseId, reasonCode: x.reasonCode }),
        now(),
      )
      .run();
    return recordAction(
      db,
      staff,
      { ...x, targetType: "user" },
      { id: account.app_id, emailHash },
      { recoveryEscalated: true },
    );
  }
  return recordAction(db, staff, { ...x, targetType: "case" }, {}, { noteOnly: true });
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- Private QA-only preorder source transplant; paid positive paths locked. */
const privatePreorder=(()=>{
const now = () => new Date().toISOString();
const uid = (p: string) => `${p}_${crypto.randomUUID()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Actor = { type: "customer" | "publisher" | "staff" | "automation"; id?: string | null };

async function event(
  db: CatalogDB,
  preorderId: string,
  eventType: string,
  actor: Actor,
  payload: Record<string, unknown> = {},
) {
  await db
    .prepare(
      "INSERT INTO preorder_events(id,preorder_id,event_type,actor_type,actor_id,event_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      uid("poevt"),
      preorderId,
      eventType,
      actor.type,
      actor.id || null,
      JSON.stringify(payload),
      now(),
    )
    .run();
}

async function member(db: CatalogDB, userId: string, accountId: string) {
  const row = await db
    .prepare(
      "SELECT role FROM publishing_account_members WHERE user_id=? AND account_id=? AND status='active'",
    )
    .bind(userId, accountId)
    .first<any>();
  if (!row) throw new ApiError(403, "You do not have access to this publishing account.");
  return row;
}

async function activePolicy(db: CatalogDB) {
  const row = await db
    .prepare(
      "SELECT * FROM preorder_policy_versions WHERE status='active' ORDER BY version DESC LIMIT 1",
    )
    .first<any>();
  if (!row) throw new ApiError(503, "No active preorder policy is configured.");
  return row;
}

/** Create or refresh the operational preorder plan from an approved Cove publication. */
async function ensurePreorderReleasePlan(
  db: CatalogDB,
  productId: string,
  actorUserId: string | null = null,
) {
  const current = await db
    .prepare(
      "SELECT * FROM preorder_release_plans WHERE product_id=? ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(productId)
    .first<any>();
  const source = await db
    .prepare(
      `SELECT p.id publication_id,p.publishing_account_id,s.edition_id publishing_edition_id,e.release_date,e.preorder_date,e.release_status
    FROM publishing_publications p
    JOIN publishing_submission_snapshots s ON s.id=p.submission_id
    JOIN editions e ON e.id=p.edition_id
    WHERE p.product_id=? ORDER BY p.published_at DESC LIMIT 1`,
    )
    .bind(productId)
    .first<any>();
  if (!source?.release_date) return current || null;
  const releaseAt = new Date(String(source.release_date));
  if (!Number.isFinite(releaseAt.getTime()) || releaseAt.getTime() <= Date.now())
    return current || null;
  const policy = await activePolicy(db);
  const openAt = source.preorder_date ? new Date(String(source.preorder_date)) : new Date();
  if (!Number.isFinite(openAt.getTime()))
    throw new ApiError(409, "The preorder opening date is invalid.");
  const horizon = releaseAt.getTime() - openAt.getTime();
  if (horizon > Number(policy.max_horizon_days) * DAY)
    throw new ApiError(
      409,
      `This preorder exceeds Cove's ${policy.max_horizon_days}-day maximum horizon.`,
    );
  const deadline = new Date(
    releaseAt.getTime() - Number(policy.manuscript_lead_hours) * HOUR,
  ).toISOString();
  const status = openAt.getTime() <= Date.now() ? "open" : "scheduled";
  const rules = (() => {
    try {
      return JSON.parse(String(policy.rules_json || "{}"));
    } catch {
      return {};
    }
  })();
  const paymentTiming =
    rules.paymentTiming === "charge_at_release" ? "charge_at_release" : "charge_now";
  // Deferred capture needs a separately tokenized payment-method vault; do not silently pretend it exists.
  if (paymentTiming === "charge_at_release")
    throw new ApiError(
      503,
      "The active preorder policy requires charge-at-release, but deferred payment vaulting is not enabled on this deployment.",
    );
  const id = current?.id || uid("poplan");
  if (current) {
    const changedRelease =
      String(current.release_at) !== releaseAt.toISOString() ||
      String(current.manuscript_deadline_at) !== deadline;
    if (changedRelease) {
      const affected = Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) n FROM preorders WHERE release_plan_id=? AND status IN ('paid_pending_release','cancellation_requested')",
            )
            .bind(current.id)
            .first<any>()
        )?.n || 0,
      );
      if (affected > 0) {
        const at = now();
        await db
          .prepare(
            "INSERT INTO preorder_release_changes(id,release_plan_id,previous_release_at,new_release_at,previous_manuscript_deadline_at,new_manuscript_deadline_at,reason,actor_type,actor_id,affected_preorders,created_at) VALUES(?,?,?,?,?,?,?,'automation',?,?,?)",
          )
          .bind(
            uid("poreleasechg"),
            current.id,
            current.release_at,
            releaseAt.toISOString(),
            current.manuscript_deadline_at,
            deadline,
            "Approved publication revision changed the release schedule.",
            actorUserId,
            affected,
            at,
          )
          .run();
        await db
          .prepare(
            "INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?, 'preorder.release_date_changed','preorder_release_plan',?,?,'pending',0,?,?)",
          )
          .bind(
            uid("out"),
            current.id,
            JSON.stringify({
              releasePlanId: current.id,
              previousReleaseAt: current.release_at,
              newReleaseAt: releaseAt.toISOString(),
              affectedPreorders: affected,
            }),
            at,
            at,
          )
          .run();
        if (new Date(String(current.release_at)).getTime() < releaseAt.getTime()) {
          const acct = await db
            .prepare(
              `SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
            )
            .bind(current.publishing_edition_id)
            .first<any>();
          if (acct)
            await db
              .prepare(
                "INSERT INTO publishing_preorder_incidents(id,publishing_account_id,release_plan_id,incident_type,severity,preorder_count,status,notes,created_at) VALUES(?,?,?,'release_delay',? ,?,'open','Approved release date moved later after customer preorders existed.',?)",
              )
              .bind(
                uid("poincident"),
                acct.account_id,
                current.id,
                affected >= 25 ? "restriction" : "warning",
                affected,
                at,
              )
              .run();
        }
      }
    }
    await db
      .prepare(
        `UPDATE preorder_release_plans SET publication_id=?,opens_at=?,release_at=?,manuscript_deadline_at=?,payment_timing=?,price_guarantee_policy=?,policy_version_id=?,status=CASE WHEN status IN ('released','canceled','failed') THEN status ELSE ? END,updated_at=? WHERE id=?`,
      )
      .bind(
        source.publication_id,
        openAt.toISOString(),
        releaseAt.toISOString(),
        deadline,
        paymentTiming,
        rules.priceGuarantee === "none" ? "none" : "lowest_price",
        policy.id,
        status,
        now(),
        id,
      )
      .run();
  } else {
    const at = now();
    await db
      .prepare(
        `INSERT INTO preorder_release_plans(id,publishing_edition_id,product_id,publication_id,opens_at,release_at,manuscript_deadline_at,payment_timing,price_guarantee_policy,cancellation_policy,failure_policy,status,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'customer_until_release','auto_refund_and_penalty',?,?,?,?)`,
      )
      .bind(
        id,
        source.publishing_edition_id,
        productId,
        source.publication_id,
        openAt.toISOString(),
        releaseAt.toISOString(),
        deadline,
        paymentTiming,
        rules.priceGuarantee === "none" ? "none" : "lowest_price",
        status,
        actorUserId,
        at,
        at,
      )
      .run();
    await db
      .prepare("UPDATE preorder_release_plans SET policy_version_id=? WHERE id=?")
      .bind(policy.id, id)
      .run();
  }
  return db.prepare("SELECT * FROM preorder_release_plans WHERE id=?").bind(id).first<any>();
}

async function preorderPurchaseState(
  db: CatalogDB,
  userId: string | null,
  productId: string,
) {
  const product = await db
    .prepare(
      "SELECT p.id,e.release_status,e.release_date,e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?",
    )
    .bind(productId)
    .first<any>();
  if (!product) throw new ApiError(404, "Product not found.");
  const releaseMs = product.release_date ? new Date(String(product.release_date)).getTime() : 0;
  const isPreorder =
    String(product.release_status) === "preorder" ||
    (Number.isFinite(releaseMs) && releaseMs > Date.now());
  if (!isPreorder)
    return { isPreorder: false, accepting: true, reason: null, plan: null, existing: null };
  const plan = await ensurePreorderReleasePlan(db, productId);
  const existing = userId
    ? await db
        .prepare(
          `SELECT po.*,rp.release_at,rp.opens_at,rp.price_guarantee_policy,rp.cancellation_policy
    FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id
    WHERE po.user_id=? AND po.product_id=? AND po.status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested')
    ORDER BY po.created_at DESC LIMIT 1`,
        )
        .bind(userId, productId)
        .first<any>()
    : null;
  if (!plan)
    return { isPreorder: true, accepting: false, reason: "not_configured", plan: null, existing };
  const opensMs = new Date(String(plan.opens_at)).getTime(),
    planReleaseMs = new Date(String(plan.release_at)).getTime();
  const status = String(plan.status);
  let reason: string | null = null;
  if (existing) reason = "already_preordered";
  else if (!Number.isFinite(opensMs) || opensMs > Date.now()) reason = "not_open";
  else if (!Number.isFinite(planReleaseMs) || planReleaseMs <= Date.now()) reason = "release_due";
  else if (!["open", "locked"].includes(status))
    reason = status === "scheduled" ? "not_open" : `plan_${status}`;
  return { isPreorder: true, accepting: reason === null, reason, plan, existing };
}

async function assertPreorderPurchaseAllowed(
  db: CatalogDB,
  userId: string,
  productId: string,
) {
  const state = await preorderPurchaseState(db, userId, productId);
  if (!state.isPreorder) return state;
  if (state.existing)
    throw new ApiError(409, "You already have an active preorder for this title.");
  if (!state.plan) throw new ApiError(409, "This preorder is not configured for sale yet.");
  if (state.reason === "not_open")
    throw new ApiError(
      409,
      `Preorders open ${new Date(String(state.plan.opens_at)).toLocaleDateString()}.`,
    );
  if (!state.accepting) throw new ApiError(409, "This title is not accepting preorders right now.");
  return state;
}

async function registerPaidPreorder(
  db: CatalogDB,
  input: {
    orderId: string;
    orderItemId: string;
    userId: string;
    productId: string;
    currency: string;
    chargedMinor: number;
  },
) {
  // A pending or caller-marked paid order is NOT independent provider settlement proof.
  throw new ApiError(503, "Preorder registration requires owner-verified Stripe settlement.");
  const existing = await db
    .prepare("SELECT * FROM preorders WHERE order_item_id=?")
    .bind(input.orderItemId)
    .first<any>();
  if (existing) return existing;
  const duplicate = await db
    .prepare(
      "SELECT * FROM preorders WHERE user_id=? AND product_id=? AND status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(input.userId, input.productId)
    .first<any>();
  if (duplicate)
    throw new ApiError(409, "This customer already has an active preorder for this title.");
  const product = await db
    .prepare(
      "SELECT p.*,e.release_status,e.release_date,e.preorder_date FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?",
    )
    .bind(input.productId)
    .first<any>();
  if (!product) throw new ApiError(404, "Product not found.");
  const future =
    product.release_date && new Date(String(product.release_date)).getTime() > Date.now();
  if (String(product.release_status) !== "preorder" && !future) return null;
  const plan = await ensurePreorderReleasePlan(db, input.productId);
  if (!plan || !["open", "scheduled", "locked"].includes(String(plan.status)))
    throw new ApiError(409, "This title is not accepting preorders.");
  if (new Date(String(plan.opens_at)).getTime() > Date.now())
    throw new ApiError(409, "This preorder has not opened yet.");
  if (String(plan.payment_timing) !== "charge_now")
    throw new ApiError(503, "This preorder uses a payment mode that is not enabled.");
  const at = now(),
    preorderId = uid("preorder"),
    charged = Math.max(0, Math.round(input.chargedMinor));
  await db
    .prepare(
      `INSERT INTO preorders(id,release_plan_id,order_item_id,order_id,user_id,product_id,currency,original_price_minor,guaranteed_price_minor,charged_minor,payment_timing,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'paid_pending_release',?,?)`,
    )
    .bind(
      preorderId,
      plan.id,
      input.orderItemId,
      input.orderId,
      input.userId,
      input.productId,
      input.currency.toUpperCase(),
      charged,
      charged,
      charged,
      plan.payment_timing,
      at,
      at,
    )
    .run();
  await db
    .prepare(
      "UPDATE commerce_order_items SET fulfillment_type='preorder',fulfillment_status='pending_release',preorder_id=?,entitlement_status='pending' WHERE id=?",
    )
    .bind(preorderId, input.orderItemId)
    .run();
  await event(
    db,
    preorderId,
    "paid_and_reserved",
    { type: "customer", id: input.userId },
    { releaseAt: plan.release_at, chargedMinor: charged, currency: input.currency.toUpperCase() },
  );
  await db
    .prepare(
      "INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?, 'preorder.confirmed','preorder',?,?,'pending',0,?,?)",
    )
    .bind(
      uid("out"),
      preorderId,
      JSON.stringify({
        preorderId,
        orderId: input.orderId,
        productId: input.productId,
        userId: input.userId,
        releaseAt: plan.release_at,
      }),
      at,
      at,
    )
    .run();
  return db.prepare("SELECT * FROM preorders WHERE id=?").bind(preorderId).first<any>();
}

async function grantReleaseEntitlement(db: CatalogDB, preorder: any) {
  // No positive paid access or fulfilled preorder without an independently
  // verified Stripe settlement and fresh legal grant, checked by strong owner.
  // This QA-only migration refuses to turn a D1 status into buyer authority.
  throw new ApiError(503, "Preorder release requires independently verified paid owner authorization.");
  const at = now();
  const entId = uid("ent");
  await db
    .prepare(
      `INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,order_item_id,granted_at,updated_at)
    VALUES(?,?,?,'purchase','active','preorder',?,?,?)
    ON CONFLICT(user_id,product_id,entitlement_type) WHERE status='active' DO UPDATE SET status='active',order_item_id=excluded.order_item_id,updated_at=excluded.updated_at`,
    )
    .bind(entId, preorder.user_id, preorder.product_id, preorder.order_item_id, at, at)
    .run();
  const entitlement = await db
    .prepare(
      "SELECT id FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='purchase' AND status='active' AND order_item_id=? ORDER BY granted_at DESC LIMIT 1",
    )
    .bind(preorder.user_id, preorder.product_id, preorder.order_item_id)
    .first<any>();
  const product = await db
    .prepare("SELECT source_external_id FROM products WHERE id=?")
    .bind(preorder.product_id)
    .first<any>();
  if (product)
    await db
      .prepare(
        `INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,progress,cfi,updated_at)
    VALUES(?,?,?,1,'want-to-read',0,COALESCE((SELECT cfi FROM preview_states WHERE user_id=? AND product_id=?),''),?)
    ON CONFLICT(user_id,product_id) DO UPDATE SET in_library=1,cfi=CASE WHEN reading_states.cfi='' THEN excluded.cfi ELSE reading_states.cfi END,updated_at=excluded.updated_at`,
      )
      .bind(
        preorder.user_id,
        preorder.product_id,
        product.source_external_id,
        preorder.user_id,
        preorder.product_id,
        at,
      )
      .run();
  const lifecycle = await db
    .prepare(
      `SELECT l.id,l.owner_update_policy,l.current_publication_version_id FROM publishing_release_lifecycles l
    JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id
    JOIN publishing_publications p ON p.id=pv.publication_id WHERE p.product_id=? LIMIT 1`,
    )
    .bind(preorder.product_id)
    .first<any>();
  if (
    entitlement?.id &&
    lifecycle?.current_publication_version_id &&
    lifecycle.owner_update_policy !== "auto_update"
  ) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO publishing_entitlement_version_pins(entitlement_id,lifecycle_id,publication_version_id,policy_at_grant,pinned_at,updated_at) VALUES(?,?,?,?,?,?)`,
      )
      .bind(
        entitlement.id,
        lifecycle.id,
        lifecycle.current_publication_version_id,
        lifecycle.owner_update_policy,
        at,
        at,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at)
      SELECT ?,?,?,?,?, 'grant_pin',?,? WHERE NOT EXISTS(SELECT 1 FROM publishing_owner_version_events WHERE entitlement_id=? AND action='grant_pin')`,
      )
      .bind(
        uid("ownevt"),
        entitlement.id,
        lifecycle.id,
        null,
        lifecycle.current_publication_version_id,
        preorder.user_id,
        at,
        entitlement.id,
      )
      .run();
  }
  await ensureOwnershipSnapshot(db, String(preorder.user_id), String(preorder.product_id));
  await db
    .prepare(
      "UPDATE commerce_order_items SET entitlement_status='granted',fulfillment_status='fulfilled' WHERE id=?",
    )
    .bind(preorder.order_item_id)
    .run();
  await db
    .prepare(
      "UPDATE preorders SET status='released',entitlement_id=?,released_at=?,updated_at=? WHERE id=? AND status='paid_pending_release'",
    )
    .bind(entitlement?.id || entId, at, at, preorder.id)
    .run();
  await event(
    db,
    preorder.id,
    "released",
    { type: "automation" },
    { entitlementId: entitlement?.id || entId },
  );
  await db
    .prepare(
      "INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?, 'preorder.released','preorder',?,?,'pending',0,?,?)",
    )
    .bind(
      uid("out"),
      preorder.id,
      JSON.stringify({
        preorderId: preorder.id,
        userId: preorder.user_id,
        productId: preorder.product_id,
      }),
      at,
      at,
    )
    .run();
  try {
    const product = await db
      .prepare(
        "SELECT e.title,p.source_external_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?",
      )
      .bind(preorder.product_id)
      .first<any>();
    await emitNotification(db, {
      userId: String(preorder.user_id),
      eventType: "preorder_released",
      dedupeKey: `preorder-released:${preorder.id}`,
      title: `Preorder released: ${product?.title || "Your book"}`,
      body: "Your preorder is now available in your Cove library.",
      productId: String(preorder.product_id),
      subjectType: "preorder",
      subjectId: String(preorder.id),
      actionUrl: product?.source_external_id
        ? `/book/${encodeURIComponent(product.source_external_id)}`
        : "/library",
      payload: { preorderId: preorder.id, productId: preorder.product_id },
    });
  } catch (e) {
    console.error("Preorder release notification enqueue failed", e);
  }
}

async function updatePreorderLowestPrice(
  db: CatalogDB,
  productId: string,
  reason = "lowest_price_guarantee",
) {
  const rows = (
    await db
      .prepare(
        `SELECT po.*,rp.price_guarantee_policy FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id
    WHERE po.product_id=? AND po.status='paid_pending_release' AND rp.price_guarantee_policy='lowest_price'`,
      )
      .bind(productId)
      .all<any>()
  ).results;
  let adjusted = 0;
  for (const po of rows) {
    const decision = await resolvePricingDecision(db, productId, "US", {
      userId: po.user_id,
      persist: false,
    });
    if (!decision || String(decision.currency).toUpperCase() !== String(po.currency).toUpperCase())
      continue;
    const next = Math.max(0, Number(decision.amountMinor));
    const previous = Number(po.guaranteed_price_minor);
    if (next >= previous) continue;
    const delta = previous - next,
      at = now(),
      jobId = uid("porefund");
    await db
      .prepare(
        "INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,?,?)",
      )
      .bind(jobId, po.id, po.order_id, delta, po.currency, "preorder_price_guarantee", at, at)
      .run();
    await db
      .prepare(
        "INSERT INTO preorder_price_adjustments(id,preorder_id,previous_guaranteed_minor,new_guaranteed_minor,adjustment_minor,reason,refund_job_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(uid("poadj"), po.id, previous, next, delta, reason, jobId, at)
      .run();
    await db
      .prepare("UPDATE preorders SET guaranteed_price_minor=?,updated_at=? WHERE id=?")
      .bind(next, at, po.id)
      .run();
    await event(
      db,
      po.id,
      "price_guarantee_lowered",
      { type: "automation" },
      { previousMinor: previous, newMinor: next, refundMinor: delta, refundJobId: jobId },
    );
    adjusted++;
  }
  return { productId, adjusted };
}

async function customerCancelPreorder(db: CatalogDB, userId: string, preorderId: string) {
  const po = await db
    .prepare(
      `SELECT po.*,rp.release_at,rp.cancellation_policy FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id WHERE po.id=? AND po.user_id=?`,
    )
    .bind(preorderId, userId)
    .first<any>();
  if (!po) throw new ApiError(404, "Preorder not found.");
  if (["customer_canceled", "refunded"].includes(po.status))
    return { preorderId, status: po.status };
  if (po.status !== "paid_pending_release")
    throw new ApiError(409, "This preorder can no longer be canceled.");
  if (
    String(po.cancellation_policy) !== "customer_until_release" ||
    new Date(String(po.release_at)).getTime() <= Date.now()
  )
    throw new ApiError(409, "The cancellation window has closed.");
  const at = now(),
    jobId = uid("porefund"),
    amount = Number(po.guaranteed_price_minor);
  await db
    .prepare(
      "UPDATE preorders SET status='cancellation_requested',canceled_at=?,updated_at=? WHERE id=?",
    )
    .bind(at, at, po.id)
    .run();
  await db
    .prepare(
      "INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,'customer_preorder_cancellation','queued',0,?,?)",
    )
    .bind(jobId, po.id, po.order_id, amount, po.currency, at, at)
    .run();
  await event(
    db,
    po.id,
    "cancellation_requested",
    { type: "customer", id: userId },
    { refundJobId: jobId, amountMinor: amount },
  );
  return { preorderId, status: "cancellation_requested", refundJobId: jobId };
}

async function publisherCancelReleasePlan(db: CatalogDB, userId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      releasePlanId: z.string().min(1),
      reason: z.string().trim().min(3).max(1000),
    })
    .parse(raw);
  await member(db, userId, x.accountId);
  const plan = await db
    .prepare(
      `SELECT rp.*,t.account_id FROM preorder_release_plans rp JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE rp.id=?`,
    )
    .bind(x.releasePlanId)
    .first<any>();
  if (!plan || plan.account_id !== x.accountId)
    throw new ApiError(404, "Preorder release plan not found.");
  if (["released", "canceled", "failed"].includes(plan.status))
    throw new ApiError(409, "This release plan is already closed.");
  const preorders = (
    await db
      .prepare(
        "SELECT * FROM preorders WHERE release_plan_id=? AND status IN ('paid_pending_release','cancellation_requested')",
      )
      .bind(plan.id)
      .all<any>()
  ).results;
  const at = now();
  await db
    .prepare("UPDATE preorder_release_plans SET status='canceled',updated_at=? WHERE id=?")
    .bind(at, plan.id)
    .run();
  for (const po of preorders) {
    const amount = Number(po.guaranteed_price_minor),
      jobId = uid("porefund");
    await db
      .prepare(
        "UPDATE preorders SET status='publisher_canceled',canceled_at=?,updated_at=? WHERE id=?",
      )
      .bind(at, at, po.id)
      .run();
    await db
      .prepare(
        "INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,'publisher_preorder_cancellation','queued',0,?,?)",
      )
      .bind(jobId, po.id, po.order_id, amount, po.currency, at, at)
      .run();
    await event(
      db,
      po.id,
      "publisher_canceled",
      { type: "publisher", id: userId },
      { reason: x.reason, refundJobId: jobId, amountMinor: amount },
    );
  }
  await db
    .prepare(
      "INSERT INTO publishing_preorder_incidents(id,publishing_account_id,release_plan_id,incident_type,severity,preorder_count,status,notes,created_at) VALUES(?,?,?,'publisher_cancellation',? ,?,'open',?,?)",
    )
    .bind(
      uid("poincident"),
      x.accountId,
      plan.id,
      preorders.length >= 25 ? "severe" : "warning",
      preorders.length,
      x.reason,
      at,
    )
    .run();
  return { releasePlanId: plan.id, canceled: preorders.length };
}

async function leasePreorderRefundJobs(db: CatalogDB, raw: unknown) {
  const x = z
    .object({
      workerId: z.string().min(3).max(120),
      limit: z.number().int().min(1).max(100).default(20),
      leaseSeconds: z.number().int().min(30).max(1800).default(300),
    })
    .parse(raw);
  const at = now(),
    expiry = new Date(Date.now() + x.leaseSeconds * 1000).toISOString(),
    jobs: any[] = [];
  const candidates = (
    await db
      .prepare(
        "SELECT * FROM preorder_refund_jobs WHERE status='queued' OR (status='leased' AND lease_expires_at<?) ORDER BY created_at LIMIT ?",
      )
      .bind(at, x.limit)
      .all<any>()
  ).results;
  for (const row of candidates) {
    const token = `${x.workerId}:${crypto.randomUUID()}`;
    const result: any = await db
      .prepare(
        "UPDATE preorder_refund_jobs SET status='leased',lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND (status='queued' OR (status='leased' AND lease_expires_at<?))",
      )
      .bind(token, expiry, at, row.id, at)
      .run();
    if (Number(result?.meta?.changes ?? result?.changes ?? 0) === 1)
      jobs.push({ ...row, status: "leased", lease_token: token, lease_expires_at: expiry });
  }
  return { jobs };
}

async function completePreorderRefundJob(db: CatalogDB, raw: unknown) {
  const x = z
    .object({
      jobId: z.string().min(1),
      leaseToken: z.string().min(1),
      success: z.boolean(),
      providerRefundId: z.string().nullable().optional(),
      error: z.string().max(2000).default(""),
    })
    .parse(raw);
  const row = await db
    .prepare("SELECT * FROM preorder_refund_jobs WHERE id=? AND status='leased' AND lease_token=?")
    .bind(x.jobId, x.leaseToken)
    .first<any>();
  if (!row) throw new ApiError(409, "Preorder refund lease is no longer valid.");
  if (x.success) throw new ApiError(503,"Preorder refund success requires owner-verified Stripe refund evidence.");
  const at = now();
  if (x.success) {
    await db
      .prepare(
        "UPDATE preorder_refund_jobs SET status='succeeded',provider_refund_id=?,lease_token=NULL,lease_expires_at=NULL,last_error='',updated_at=? WHERE id=?",
      )
      .bind(x.providerRefundId || null, at, row.id)
      .run();
    await db
      .prepare(
        "UPDATE preorders SET status='refunded',updated_at=? WHERE id=? AND status IN ('cancellation_requested','publisher_canceled','delivery_failed','paid_pending_release')",
      )
      .bind(at, row.preorder_id)
      .run();
    await event(
      db,
      row.preorder_id,
      "refund_completed",
      { type: "automation" },
      {
        refundJobId: row.id,
        providerRefundId: x.providerRefundId || null,
        amountMinor: row.amount_minor,
      },
    );
  } else {
    const terminal = Number(row.attempt_count) >= 8;
    await db
      .prepare(
        "UPDATE preorder_refund_jobs SET status=?,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?",
      )
      .bind(terminal ? "failed" : "queued", x.error || "refund failed", at, row.id)
      .run();
    await event(
      db,
      row.preorder_id,
      terminal ? "refund_failed_terminal" : "refund_retry_queued",
      { type: "automation" },
      { refundJobId: row.id, error: x.error },
    );
  }
  return {
    jobId: row.id,
    status: x.success ? "succeeded" : Number(row.attempt_count) >= 8 ? "failed" : "queued",
  };
}

async function advancePreorders(db: CatalogDB) {
  const at = now(),
    ts = Date.now();
  // All-or-nothing preflight: do not mark a plan released or partially
  // transition a paid preorder when independent access proof is unavailable.
  const due=await db.prepare("SELECT rp.id FROM preorder_release_plans rp JOIN preorders p ON p.release_plan_id=rp.id WHERE rp.release_at<=? AND rp.status IN ('scheduled','open','locked') AND p.status='paid_pending_release' LIMIT 1").bind(at).first<any>();
  if(due) throw new ApiError(503,"Paid preorder release requires independently verified owner settlement and legal authority.");

  let opened = 0,
    locked = 0,
    released = 0,
    failed = 0;
  const plans = (
    await db
      .prepare(
        "SELECT * FROM preorder_release_plans WHERE status IN ('scheduled','open','locked') ORDER BY release_at LIMIT 500",
      )
      .all<any>()
  ).results;
  for (const plan of plans) {
    const openMs = new Date(String(plan.opens_at)).getTime(),
      deadlineMs = new Date(String(plan.manuscript_deadline_at)).getTime(),
      releaseMs = new Date(String(plan.release_at)).getTime();
    if (plan.status === "scheduled" && openMs <= ts) {
      await db
        .prepare("UPDATE preorder_release_plans SET status='open',updated_at=? WHERE id=?")
        .bind(at, plan.id)
        .run();
      opened++;
    }
    if (["scheduled", "open"].includes(plan.status) && deadlineMs <= ts && releaseMs > ts) {
      await db
        .prepare("UPDATE preorder_release_plans SET status='locked',updated_at=? WHERE id=?")
        .bind(at, plan.id)
        .run();
      locked++;
    }
    if (releaseMs > ts) continue;
    const ready = await db
      .prepare(
        `SELECT 1 ok FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id
      WHERE p.id=? AND s.status='published' LIMIT 1`,
      )
      .bind(plan.publication_id)
      .first<any>();
    if (!ready) {
      const affected = (
        await db
          .prepare(
            "SELECT * FROM preorders WHERE release_plan_id=? AND status='paid_pending_release'",
          )
          .bind(plan.id)
          .all<any>()
      ).results;
      await db
        .prepare("UPDATE preorder_release_plans SET status='failed',updated_at=? WHERE id=?")
        .bind(at, plan.id)
        .run();
      const account = await db
        .prepare(
          `SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
        )
        .bind(plan.publishing_edition_id)
        .first<any>();
      if (account)
        await db
          .prepare(
            "INSERT INTO publishing_preorder_incidents(id,publishing_account_id,release_plan_id,incident_type,severity,preorder_count,status,notes,created_at) VALUES(?,?,?,'delivery_failure',? ,?,'open','Release artifact was not publication-ready at release time.',?)",
          )
          .bind(
            uid("poincident"),
            account.account_id,
            plan.id,
            affected.length >= 25 ? "severe" : "restriction",
            affected.length,
            at,
          )
          .run();
      for (const po of affected) {
        const jobId = uid("porefund"),
          amount = Number(po.guaranteed_price_minor);
        await db
          .prepare("UPDATE preorders SET status='delivery_failed',updated_at=? WHERE id=?")
          .bind(at, po.id)
          .run();
        await db
          .prepare(
            "INSERT INTO preorder_refund_jobs(id,preorder_id,order_id,amount_minor,currency,reason,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,'preorder_delivery_failure','queued',0,?,?)",
          )
          .bind(jobId, po.id, po.order_id, amount, po.currency, at, at)
          .run();
        await event(db, po.id, "delivery_failed", { type: "automation" }, { refundJobId: jobId });
      }
      failed++;
      continue;
    }
    const paid = (
      await db
        .prepare(
          "SELECT * FROM preorders WHERE release_plan_id=? AND status='paid_pending_release'",
        )
        .bind(plan.id)
        .all<any>()
    ).results;
    for (const po of paid) await grantReleaseEntitlement(db, po);
    await db
      .prepare("UPDATE preorder_release_plans SET status='released',updated_at=? WHERE id=?")
      .bind(at, plan.id)
      .run();
    released += paid.length;
  }
  return { opened, locked, released, failed };
}

async function publisherPreorderDashboard(db: CatalogDB, userId: string, accountId: string) {
  await member(db, userId, accountId);
  const [plans, statuses, incidents] = await Promise.all([
    db
      .prepare(
        `SELECT rp.*,e.title publishing_title,(SELECT COUNT(*) FROM preorders po WHERE po.release_plan_id=rp.id) preorder_count,(SELECT COALESCE(SUM(po.guaranteed_price_minor),0) FROM preorders po WHERE po.release_plan_id=rp.id AND po.status NOT IN ('refunded','customer_canceled')) booked_minor
      FROM preorder_release_plans rp JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY rp.release_at DESC`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT po.status,COUNT(*) units,COALESCE(SUM(po.guaranteed_price_minor),0) value_minor,po.currency FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id JOIN publishing_edition_drafts e ON e.id=rp.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? GROUP BY po.status,po.currency`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_preorder_incidents WHERE publishing_account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
  ]);
  return { plans: plans.results, statusSummary: statuses.results, incidents: incidents.results };
}

async function customerPreorders(db: CatalogDB, userId: string) {
  const rows = (
    await db
      .prepare(
        `SELECT po.*,rp.release_at,rp.opens_at,rp.price_guarantee_policy,rp.cancellation_policy,e.title,p.format FROM preorders po JOIN preorder_release_plans rp ON rp.id=po.release_plan_id JOIN products p ON p.id=po.product_id JOIN editions e ON e.id=p.edition_id WHERE po.user_id=? ORDER BY po.created_at DESC LIMIT 250`,
      )
      .bind(userId)
      .all<any>()
  ).results;
  return { preorders: rows };
}

return {ensurePreorderReleasePlan,registerPaidPreorder,updatePreorderLowestPrice,
 customerCancelPreorder,publisherCancelReleasePlan,leasePreorderRefundJobs,
 completePreorderRefundJob,advancePreorders};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- Historical trust rights SQL is private to the QA lease. */
const privateTrust=(()=>{
 const dispatchPublishingOwnerValidationJob=async (_db:unknown,_kind:unknown,_input:unknown):Promise<never>=>{throw new ApiError(503,"Private rights scan lease is not delegated from a private owner.");};

const now = () => new Date().toISOString();
const id = (p: string) => `${p}_${crypto.randomUUID()}`;
const clean = (v: unknown, max = 4000) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const origin = z.enum(["human", "ai_assisted", "ai_generated", "mixed"]);
const optionalOrigin = z.enum(["human", "ai_assisted", "ai_generated", "mixed", "not_applicable"]);
const FORE_RIGHTS_POLICY_VERSION = "fore-rights-v1";
const FORE_AI_POLICY_VERSION = "fore-ai-content-v1";
const addressSchema = z.object({
  line1: z.string().trim().min(2).max(240),
  line2: z.string().trim().max(240).default(""),
  city: z.string().trim().min(1).max(160),
  region: z.string().trim().max(160).default(""),
  postalCode: z.string().trim().min(2).max(32),
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),
});

async function member(
  db: PublishingDB,
  userId: string,
  accountId: string,
  min: "analyst" | "editor" | "admin" | "owner" = "analyst",
) {
  const rank: any = { analyst: 1, editor: 2, finance: 2, admin: 3, owner: 4 };
  const m = await db
    .prepare(
      "SELECT role FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'",
    )
    .bind(accountId, userId)
    .first<any>();
  if (!m || rank[String(m.role)] < rank[min])
    throw new ApiError(403, "You do not have permission to perform this publishing action.");
  return m;
}
async function edition(db: PublishingDB, editionId: string) {
  const r = await db
    .prepare(
      `SELECT e.*,t.account_id,t.title FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
    )
    .bind(editionId)
    .first<any>();
  if (!r) throw new ApiError(404, "Publishing edition not found.");
  return r;
}
async function audit(
  db: PublishingDB,
  accountId: string | null,
  userId: string | null,
  type: string,
  entityId: string,
  action: string,
  meta: unknown = {},
) {
  await db
    .prepare(
      "INSERT INTO publishing_audit_events(id,account_id,actor_user_id,entity_type,entity_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(id("pubaudit"), accountId, userId, type, entityId, action, JSON.stringify(meta), now())
    .run();
}

async function requireActivePolicy(db: PublishingDB, policyKey: string, version: string) {
  const row = await db
    .prepare(
      "SELECT policy_key,version,title,status,summary,rules_json,effective_at,published_at FROM publishing_policy_versions WHERE policy_key=? AND version=? AND status='active'",
    )
    .bind(policyKey, version)
    .first<any>();
  if (!row)
    throw new ApiError(
      503,
      `Cove policy ${policyKey} ${version} is not active; publishing signatures are temporarily unavailable until policy configuration is reconciled.`,
    );
  return row;
}

async function publicPublishingPolicies(db: PublishingDB) {
  const rows = (
    await db
      .prepare(
        "SELECT policy_key,version,title,summary,rules_json,effective_at,published_at FROM publishing_policy_versions WHERE status='active' ORDER BY policy_key",
      )
      .all<any>()
  ).results;
  return {
    policies: rows.map((r: any) => ({
      ...r,
      rules: (() => {
        try {
          return JSON.parse(String(r.rules_json || "{}"));
        } catch {
          return {};
        }
      })(),
    })),
  };
}

async function signPublishingRightsDeclaration(
  db: PublishingDB,
  userId: string,
  raw: unknown,
) {
  const x = z
    .object({
      editionId: z.string().min(1),
      rightsBasis: z.enum(["owned", "licensed", "public_domain"]),
      authorityType: z.enum([
        "copyright_owner",
        "exclusive_licensee",
        "nonexclusive_licensee",
        "authorized_agent",
        "public_domain_republisher",
      ]),
      rightsOwnerName: z.string().trim().min(2).max(240),
      sourceWorkTitle: z.string().max(500).default(""),
      sourceWorkAuthor: z.string().max(500).default(""),
      sourceWorkIdentifier: z.string().max(500).default(""),
      territoryScope: z.record(z.string(), z.unknown()).default({ mode: "worldwide", exclude: [] }),
      rightsStartAt: z.string().datetime().nullable().optional(),
      rightsEndAt: z.string().datetime().nullable().optional(),
      rightsSummary: z.string().max(5000).default(""),
      authorityAttestation: z.literal(true),
      noInfringementAttestation: z.literal(true),
      evidenceCompleteAttestation: z.literal(true),
      signatureName: z.string().trim().min(2).max(240),
    })
    .parse(raw);
  const e = await edition(db, x.editionId);
  await member(db, userId, String(e.account_id), "editor");
  await requireActivePolicy(db, "publisher_rights", FORE_RIGHTS_POLICY_VERSION);
  if (!["draft", "changes_requested"].includes(String(e.status)))
    throw new ApiError(409, "Open a new revision before changing the signed rights declaration.");
  if (x.rightsBasis !== String(e.rights_basis))
    throw new ApiError(400, "The declaration rights basis must match the edition rights basis.");
  if (x.rightsStartAt && x.rightsEndAt && x.rightsEndAt <= x.rightsStartAt)
    throw new ApiError(400, "Rights end date must follow the start date.");
  const prior = await db
    .prepare("SELECT id FROM publishing_rights_declarations WHERE edition_id=? AND revision=?")
    .bind(e.id, e.revision)
    .first<any>();
  if (prior)
    throw new ApiError(
      409,
      "This revision already has a signed immutable rights declaration. Open a new revision to replace it.",
    );
  const declarationId = id("rightsdecl"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_rights_declarations(id,edition_id,account_id,revision,policy_version,rights_basis,authority_type,rights_owner_name,source_work_title,source_work_author,source_work_identifier,territory_scope_json,rights_start_at,rights_end_at,rights_summary,authority_attestation,no_infringement_attestation,evidence_complete_attestation,signature_name,signed_by_user_id,signed_at,status,created_at) VALUES(?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,1,1,1,?,?,?,'signed',?)`,
    )
    .bind(
      declarationId,
      e.id,
      e.account_id,
      e.revision,
      FORE_RIGHTS_POLICY_VERSION,
      x.rightsBasis,
      x.authorityType,
      x.rightsOwnerName,
      x.sourceWorkTitle,
      x.sourceWorkAuthor,
      x.sourceWorkIdentifier,
      JSON.stringify(x.territoryScope),
      x.rightsStartAt || null,
      x.rightsEndAt || null,
      x.rightsSummary,
      x.signatureName,
      userId,
      at,
      at,
    )
    .run();
  await audit(db, String(e.account_id), userId, "rights_declaration", declarationId, "signed", {
    editionId: e.id,
    revision: e.revision,
    rightsBasis: x.rightsBasis,
    policyVersion: FORE_RIGHTS_POLICY_VERSION,
  });
  return {
    id: declarationId,
    editionId: e.id,
    revision: Number(e.revision),
    policyVersion: FORE_RIGHTS_POLICY_VERSION,
  };
}

async function signPublishingAiDisclosure(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      editionId: z.string().min(1),
      textOrigin: origin,
      coverOrigin: optionalOrigin,
      narrationOrigin: optionalOrigin,
      translationOrigin: optionalOrigin,
      syntheticVoiceLabel: z.string().max(240).default(""),
      modelNames: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
      generationNotes: z.string().max(5000).default(""),
      humanEditorialReviewAttestation: z.literal(true),
      rightsResponsibilityAttestation: z.literal(true),
      nonSpamAttestation: z.literal(true),
      signatureName: z.string().trim().min(2).max(240),
    })
    .parse(raw);
  const e = await edition(db, x.editionId);
  await member(db, userId, String(e.account_id), "editor");
  await requireActivePolicy(db, "ai_content", FORE_AI_POLICY_VERSION);
  if (!["draft", "changes_requested"].includes(String(e.status)))
    throw new ApiError(
      409,
      "Open a new revision before changing the signed AI-content disclosure.",
    );
  if (
    e.format === "audiobook" &&
    ["ai_generated", "mixed"].includes(x.narrationOrigin) &&
    !x.syntheticVoiceLabel.trim()
  )
    throw new ApiError(
      400,
      "AI-generated or mixed narration requires a customer-facing synthetic voice label.",
    );
  const prior = await db
    .prepare("SELECT id FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?")
    .bind(e.id, e.revision)
    .first<any>();
  if (prior)
    throw new ApiError(
      409,
      "This revision already has a signed immutable AI-content disclosure. Open a new revision to replace it.",
    );
  const disclosureId = id("aidisc"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_ai_disclosures(id,edition_id,account_id,revision,policy_version,text_origin,cover_origin,narration_origin,translation_origin,synthetic_voice_label,model_names_json,generation_notes,human_editorial_review_attestation,rights_responsibility_attestation,non_spam_attestation,signature_name,signed_by_user_id,signed_at,created_at) VALUES(?,?,?,?, ?,?,?,?,?,?,?,?,1,1,1,?,?,?,?)`,
    )
    .bind(
      disclosureId,
      e.id,
      e.account_id,
      e.revision,
      FORE_AI_POLICY_VERSION,
      x.textOrigin,
      x.coverOrigin,
      x.narrationOrigin,
      x.translationOrigin,
      x.syntheticVoiceLabel,
      JSON.stringify(x.modelNames),
      x.generationNotes,
      x.signatureName,
      userId,
      at,
      at,
    )
    .run();
  await audit(db, String(e.account_id), userId, "ai_disclosure", disclosureId, "signed", {
    editionId: e.id,
    revision: e.revision,
    policyVersion: FORE_AI_POLICY_VERSION,
    textOrigin: x.textOrigin,
    coverOrigin: x.coverOrigin,
    narrationOrigin: x.narrationOrigin,
  });
  return {
    id: disclosureId,
    editionId: e.id,
    revision: Number(e.revision),
    policyVersion: FORE_AI_POLICY_VERSION,
  };
}

async function uploadRightsEvidence(
  env: PublishingEnv,
  userId: string,
  input: {
    declarationId: string;
    evidenceType: string;
    description?: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    issuedBy?: string;
    issuedAt?: string | null;
    expiresAt?: string | null;
  },
) {
  if (!env.BUCKET) throw new ApiError(503, "Publishing evidence storage is not configured.");
  const x = z
    .object({
      declarationId: z.string().min(1),
      evidenceType: z.enum([
        "license",
        "assignment",
        "contract",
        "registration",
        "permission",
        "public_domain_source",
        "identity_authority",
        "other",
      ]),
      description: z.string().max(2000).default(""),
      filename: z.string().trim().min(1).max(240),
      mimeType: z.string().max(160),
      issuedBy: z.string().max(240).default(""),
      issuedAt: z.string().datetime().nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
    })
    .parse({ ...input, bytes: undefined });
  const allowedEvidenceMime = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]);
  const evidenceMime = (x.mimeType || "application/octet-stream").toLowerCase();
  if (!allowedEvidenceMime.has(evidenceMime))
    throw new ApiError(415, "Rights evidence must be PDF, JPEG, PNG, plain text, or DOCX.");
  const d = await env.DB.prepare("SELECT * FROM publishing_rights_declarations WHERE id=?")
    .bind(x.declarationId)
    .first<any>();
  if (!d) throw new ApiError(404, "Rights declaration not found.");
  await member(env.DB, userId, String(d.account_id), "editor");
  if (!input.bytes.byteLength) throw new ApiError(400, "The evidence file is empty.");
  if (input.bytes.byteLength > 25 * 1024 * 1024)
    throw new ApiError(413, "Rights evidence files are limited to 25 MB.");
  const digest = await sha256(input.bytes),
    evidenceId = id("rightsev"),
    jobId = id("rightsscan"),
    at = now(),
    safeName = x.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120),
    objectKey = `publishing/private-rights-evidence/${d.account_id}/${d.id}/${evidenceId}/${safeName}`;
  await env.BUCKET.put(objectKey, input.bytes, {
    httpMetadata: { contentType: x.mimeType || "application/octet-stream" },
    customMetadata: { sha256: digest, classification: "confidential-rights-evidence" },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO publishing_rights_evidence(id,declaration_id,account_id,evidence_type,description,original_filename,mime_type,size_bytes,object_key,sha256,scan_status,verification_status,issued_by,issued_at,expires_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued','unreviewed',?,?,?,?,?)`,
    ).bind(
      evidenceId,
      d.id,
      d.account_id,
      x.evidenceType,
      x.description,
      x.filename,
      x.mimeType,
      input.bytes.byteLength,
      objectKey,
      digest,
      x.issuedBy,
      x.issuedAt || null,
      x.expiresAt || null,
      userId,
      at,
    ),
    env.DB.prepare(
      "INSERT INTO publishing_rights_evidence_scan_jobs(id,evidence_id,status,attempts,max_attempts,available_at,created_at,updated_at) VALUES(?,?,'queued',0,5,?,?,?)",
    ).bind(jobId, evidenceId, at, at, at),
  ]);
  await audit(env.DB, String(d.account_id), userId, "rights_evidence", evidenceId, "uploaded", {
    declarationId: d.id,
    evidenceType: x.evidenceType,
    sha256: digest,
  });
  return { id: evidenceId, scanJobId: jobId, sha256: digest, scanStatus: "queued" };
}

async function sha256(bytes: Uint8Array | string) {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(raw)));
  return [...digest].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function normalizeText(s: string) {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[^\p{L}\p{N}'’-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500000);
}
function fnv64(token: string) {
  let h = 1469598103934665603n;
  for (const c of new TextEncoder().encode(token)) {
    h ^= BigInt(c);
    h = BigInt.asUintN(64, h * 1099511628211n);
  }
  return h;
}
function simhash64(tokens: string[]) {
  const v = new Array(64).fill(0);
  for (const t of tokens.slice(0, 100000)) {
    const h = fnv64(t);
    for (let i = 0; i < 64; i++) v[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (v[i] >= 0) out |= 1n << BigInt(i);
  return out.toString(16).padStart(16, "0");
}
function hamming(a: string, b: string) {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let x = BigInt("0x" + a) ^ BigInt("0x" + b),
    n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

async function recordAssetFingerprint(
  db: PublishingDB,
  input: {
    assetVersionId: string;
    accountId: string;
    editionId: string;
    assetKind: string;
    exactSha256: string;
    text?: string;
    metadata?: unknown;
  },
) {
  const existing = await db
    .prepare("SELECT id FROM publishing_asset_fingerprints WHERE asset_version_id=?")
    .bind(input.assetVersionId)
    .first<any>();
  if (existing) return existing;
  const normalized = normalizeText(input.text || ""),
    tokens = normalized ? normalized.split(" ").filter(Boolean) : [],
    normalizedHash = normalized ? await sha256(normalized) : "",
    sim = tokens.length >= 100 ? simhash64(tokens) : "",
    bands = simhashBands(sim),
    metaHash = await sha256(JSON.stringify(input.metadata || {})),
    fid = id("fingerprint"),
    at = now();
  await db
    .prepare(
      "INSERT INTO publishing_asset_fingerprints(id,asset_version_id,account_id,edition_id,asset_kind,exact_sha256,normalized_text_sha256,simhash64,simhash_band0,simhash_band1,simhash_band2,simhash_band3,token_count,metadata_fingerprint,detector_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'fore-fingerprint-v2',?)",
    )
    .bind(
      fid,
      input.assetVersionId,
      input.accountId,
      input.editionId,
      input.assetKind,
      input.exactSha256,
      normalizedHash,
      sim,
      ...bands,
      tokens.length,
      metaHash,
      at,
    )
    .run();
  const candidates = (
    await db
      .prepare(
        `SELECT * FROM publishing_asset_fingerprints
    WHERE asset_version_id<>? AND asset_kind=? AND (
      exact_sha256=? OR (?<>'' AND normalized_text_sha256=?) OR
      (?<>'' AND (simhash_band0=? OR simhash_band1=? OR simhash_band2=? OR simhash_band3=?))
    ) ORDER BY created_at DESC LIMIT 4000`,
      )
      .bind(
        input.assetVersionId,
        input.assetKind,
        input.exactSha256,
        normalizedHash,
        normalizedHash,
        sim,
        bands[0],
        bands[1],
        bands[2],
        bands[3],
      )
      .all<any>()
  ).results;
  for (const c of candidates) {
    let type: string | undefined,
      score = 0;
    if (c.exact_sha256 === input.exactSha256) {
      type = "exact";
      score = 1;
    } else if (normalizedHash && c.normalized_text_sha256 === normalizedHash) {
      type = "normalized_text";
      score = 0.995;
    } else if (sim) {
      const d = hamming(sim, String(c.simhash64 || ""));
      if (d <= 7) {
        type = "simhash";
        score = 1 - d / 64;
      }
    }
    if (!type) continue;
    const a = String(input.accountId),
      b = String(c.account_id),
      cross = a !== b,
      mid = id("simmatch");
    await db
      .prepare(
        `INSERT OR IGNORE INTO publishing_similarity_matches(id,asset_version_id,matched_asset_version_id,similarity_type,score,cross_account,disposition,detector_version,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'review','fore-fingerprint-v2',?,?,?)`,
      )
      .bind(
        mid,
        input.assetVersionId,
        c.asset_version_id,
        type,
        score,
        cross ? 1 : 0,
        JSON.stringify({
          tokenCount: tokens.length,
          matchedTokenCount: Number(c.token_count || 0),
          simhashDistance: sim ? hamming(sim, String(c.simhash64 || "")) : null,
        }),
        at,
        at,
      )
      .run();
    if (cross) {
      const linkType = type === "exact" ? "shared_exact_asset" : "high_content_similarity",
        linkScore = type === "exact" ? 100 : Math.round(score * 100);
      await upsertAccountRiskLink(db, a, b, linkType, linkScore, {
        assetVersionId: input.assetVersionId,
        matchedAssetVersionId: c.asset_version_id,
        similarityType: type,
      });
    }
  }
  return {
    id: fid,
    normalizedTextSha256: normalizedHash,
    simhash64: sim,
    tokenCount: tokens.length,
  };
}

function simhashBands(sim: string): [string, string, string, string] {
  if (!/^[0-9a-f]{16}$/i.test(sim)) return ["", "", "", ""];
  return [sim.slice(0, 4), sim.slice(4, 8), sim.slice(8, 12), sim.slice(12, 16)];
}

async function upsertAccountRiskLink(
  db: PublishingDB,
  a: string,
  b: string,
  linkType: string,
  score: number,
  evidence: unknown = {},
) {
  if (!a || !b || a === b) return;
  const lo = a < b ? a : b,
    hi = a < b ? b : a,
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_account_risk_links(id,account_a_id,account_b_id,link_type,score,evidence_json,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(account_a_id,account_b_id,link_type) DO UPDATE SET score=MAX(score,excluded.score),evidence_json=excluded.evidence_json,last_seen_at=excluded.last_seen_at`,
    )
    .bind(
      id("risklink"),
      lo,
      hi,
      linkType,
      Math.max(0, Math.min(100, score)),
      JSON.stringify(evidence),
      at,
      at,
    )
    .run();
  await ensureRiskCluster(db, lo, hi, linkType);
}

async function ensureRiskCluster(db: PublishingDB, a: string, b: string, reason: string) {
  const links = (
    await db
      .prepare(
        "SELECT link_type,score FROM publishing_account_risk_links WHERE account_a_id=? AND account_b_id=? ORDER BY score DESC",
      )
      .bind(a, b)
      .all<any>()
  ).results;
  if (!links.length) return;
  const max = Math.max(...links.map((r: any) => Number(r.score || 0))),
    aggregate = Math.min(100, max + Math.min(40, Math.max(0, links.length - 1) * 20));
  if (aggregate < 85) return;
  const memberships = (
    await db
      .prepare(
        `SELECT DISTINCT c.id,c.risk_score FROM publishing_risk_clusters c JOIN publishing_risk_cluster_members m ON m.cluster_id=c.id
    WHERE m.account_id IN (?,?) AND c.status IN ('open','monitoring') ORDER BY c.risk_score DESC,c.created_at`,
      )
      .bind(a, b)
      .all<any>()
  ).results;
  const at = now(),
    cid = String(memberships[0]?.id || id("riskcluster"));
  if (!memberships.length)
    await db
      .prepare(
        "INSERT INTO publishing_risk_clusters(id,status,risk_score,reason,created_at,updated_at) VALUES(?,'open',?,?,?,?)",
      )
      .bind(cid, aggregate, reason, at, at)
      .run();
  else
    await db
      .prepare(
        "UPDATE publishing_risk_clusters SET risk_score=MAX(risk_score,?),reason=?,updated_at=? WHERE id=?",
      )
      .bind(aggregate, reason, at, cid)
      .run();
  for (const extra of memberships.slice(1)) {
    const members = (
      await db
        .prepare("SELECT * FROM publishing_risk_cluster_members WHERE cluster_id=?")
        .bind(extra.id)
        .all<any>()
    ).results;
    for (const m of members)
      await db
        .prepare(
          `INSERT INTO publishing_risk_cluster_members(cluster_id,account_id,member_score,evidence_json,added_at) VALUES(?,?,?,?,?)
      ON CONFLICT(cluster_id,account_id) DO UPDATE SET member_score=MAX(member_score,excluded.member_score),evidence_json=excluded.evidence_json`,
        )
        .bind(cid, m.account_id, m.member_score, m.evidence_json || "{}", m.added_at || at)
        .run();
    await db.prepare("DELETE FROM publishing_risk_clusters WHERE id=?").bind(extra.id).run();
  }
  for (const accountId of [a, b])
    await db
      .prepare(
        `INSERT INTO publishing_risk_cluster_members(cluster_id,account_id,member_score,evidence_json,added_at) VALUES(?,?,?,'{}',?)
    ON CONFLICT(cluster_id,account_id) DO UPDATE SET member_score=MAX(member_score,excluded.member_score)`,
      )
      .bind(cid, accountId, aggregate, at)
      .run();
}

const publicMailDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "mail.com",
]);
async function scanAccountRiskLinks(db: PublishingDB, accountId: string) {
  const account = await db
    .prepare(
      "SELECT id,contact_email,finance_party_id,rights_party_id FROM publishing_accounts WHERE id=?",
    )
    .bind(accountId)
    .first<any>();
  if (!account) return { links: 0 };
  let linked = 0;
  const email = String(account.contact_email || "").toLowerCase(),
    domain = email.includes("@") ? email.split("@").pop() || "" : "";
  if (domain && !publicMailDomains.has(domain)) {
    const rows = (
      await db
        .prepare(
          "SELECT id FROM publishing_accounts WHERE id<>? AND lower(substr(contact_email,instr(contact_email,'@')+1))=?",
        )
        .bind(accountId, domain)
        .all<any>()
    ).results;
    for (const r of rows) {
      await upsertAccountRiskLink(db, accountId, String(r.id), "shared_contact_domain", 45, {
        domain,
      });
      linked++;
    }
  }
  const controllers = (
    await db
      .prepare(
        `SELECT DISTINCT m2.account_id FROM publishing_account_members m1 JOIN publishing_account_members m2 ON m2.user_id=m1.user_id
    WHERE m1.account_id=? AND m2.account_id<>? AND m1.status='active' AND m2.status='active' AND m1.role IN ('owner','admin') AND m2.role IN ('owner','admin')`,
      )
      .bind(accountId, accountId)
      .all<any>()
  ).results;
  for (const r of controllers) {
    await upsertAccountRiskLink(
      db,
      accountId,
      String(r.account_id),
      "shared_account_controller",
      65,
      { basis: "shared active owner/admin identity" },
    );
    linked++;
  }
  if (account.finance_party_id) {
    const rows = (
      await db
        .prepare(
          "SELECT id FROM publishing_accounts WHERE id<>? AND finance_party_id=? AND finance_party_id IS NOT NULL",
        )
        .bind(accountId, account.finance_party_id)
        .all<any>()
    ).results;
    for (const r of rows) {
      await upsertAccountRiskLink(db, accountId, String(r.id), "shared_payout_reference", 95, {
        financePartyId: String(account.finance_party_id),
      });
      linked++;
    }
  }
  if (account.rights_party_id) {
    const rows = (
      await db
        .prepare(
          "SELECT id FROM publishing_accounts WHERE id<>? AND rights_party_id=? AND rights_party_id IS NOT NULL",
        )
        .bind(accountId, account.rights_party_id)
        .all<any>()
    ).results;
    for (const r of rows) {
      await upsertAccountRiskLink(db, accountId, String(r.id), "shared_identity_reference", 90, {
        rightsPartyId: String(account.rights_party_id),
      });
      linked++;
    }
  }
  return { links: linked };
}

function normalizedName(v: string) {
  return v
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 240);
}
function editDistance(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = old;
    }
  }
  return prev[b.length];
}
async function scanIdentitySimilarity(
  db: PublishingDB,
  input: {
    accountId: string;
    subjectType: "publisher_name" | "pen_name" | "contributor";
    subjectId: string;
    name: string;
  },
) {
  const n = normalizedName(input.name);
  if (n.length < 4) return [];
  const rows = [
    ...(
      await db
        .prepare("SELECT id,name,'publisher' entity_type FROM publishers WHERE name<>'' LIMIT 4000")
        .all<any>()
    ).results,
    ...(
      await db
        .prepare(
          "SELECT id,name,'contributor' entity_type FROM contributors WHERE name<>'' LIMIT 4000",
        )
        .all<any>()
    ).results,
    ...(
      await db
        .prepare(
          "SELECT id,display_name name,'publishing_account' entity_type FROM publishing_accounts WHERE id<>? LIMIT 4000",
        )
        .bind(input.accountId)
        .all<any>()
    ).results,
    ...(
      await db
        .prepare(
          "SELECT id,display_name name,'pen_name' entity_type FROM publishing_pen_names WHERE account_id<>? LIMIT 4000",
        )
        .bind(input.accountId)
        .all<any>()
    ).results,
  ];
  const matches: any[] = [];
  for (const r of rows) {
    const m = normalizedName(String(r.name || ""));
    if (!m) continue;
    const dist = editDistance(n, m),
      score = Math.round((1 - dist / Math.max(n.length, m.length)) * 100);
    if (score < 90) continue;
    const duplicate = await db
      .prepare(
        `SELECT id FROM publishing_identity_similarity_matches WHERE account_id=? AND subject_type=? AND subject_id=? AND submitted_name=? AND matched_entity_type=? AND matched_entity_id=? AND status='review' LIMIT 1`,
      )
      .bind(input.accountId, input.subjectType, input.subjectId, input.name, r.entity_type, r.id)
      .first<any>();
    if (duplicate) {
      matches.push({
        id: String(duplicate.id),
        score,
        matchedName: r.name,
        matchedEntityType: r.entity_type,
        existing: true,
      });
      continue;
    }
    const matchId = id("idsim"),
      at = now();
    await db
      .prepare(
        "INSERT INTO publishing_identity_similarity_matches(id,account_id,subject_type,subject_id,submitted_name,matched_entity_type,matched_entity_id,matched_name,similarity_score,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)",
      )
      .bind(
        matchId,
        input.accountId,
        input.subjectType,
        input.subjectId,
        input.name,
        r.entity_type,
        r.id,
        r.name,
        score,
        at,
        at,
      )
      .run();
    matches.push({ id: matchId, score, matchedName: r.name, matchedEntityType: r.entity_type });
  }
  return matches;
}

async function assessSubmissionContentPolicy(db: PublishingDB, submissionId: string) {
  const existing = await db
    .prepare(
      "SELECT * FROM publishing_content_policy_assessments WHERE submission_id=? AND policy_version=?",
    )
    .bind(submissionId, FORE_AI_POLICY_VERSION)
    .first<any>();
  if (existing) return existing;
  const sub = await db
    .prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?")
    .bind(submissionId)
    .first<any>();
  if (!sub) throw new ApiError(404, "Publishing submission not found.");
  const ai = await db
    .prepare("SELECT * FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?")
    .bind(sub.edition_id, sub.revision)
    .first<any>();
  if (!ai)
    throw new ApiError(409, "A signed AI-content disclosure is required before automated review.");
  const [crossSimilarity, sameAccountSimilarity, recent] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) count,MAX(sm.score) max_score FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND sm.cross_account=1 AND sm.disposition IN ('review','fraud_hold','infringing')`,
      )
      .bind(sub.edition_id)
      .first<any>(),
    db
      .prepare(
        `SELECT COUNT(*) count,MAX(sm.score) max_score FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND sm.cross_account=0 AND sm.disposition IN ('review','fraud_hold','infringing')`,
      )
      .bind(sub.edition_id)
      .first<any>(),
    db
      .prepare(
        "SELECT COUNT(*) count FROM publishing_submission_snapshots WHERE account_id=? AND submitted_at>=datetime('now','-24 hours')",
      )
      .bind(sub.account_id)
      .first<any>(),
  ]);
  const signals: any[] = [],
    add = (type: string, points: number, evidence: any) => signals.push({ type, points, evidence });
  if (ai.text_origin === "ai_generated" || ai.text_origin === "mixed")
    add("generated_text_disclosed", 25, { origin: ai.text_origin });
  if (ai.translation_origin === "ai_generated" || ai.translation_origin === "mixed")
    add("generated_translation_disclosed", 25, { origin: ai.translation_origin });
  if (ai.cover_origin === "ai_generated" || ai.cover_origin === "mixed")
    add("generated_cover_disclosed", 10, { origin: ai.cover_origin });
  if (ai.narration_origin === "ai_generated" || ai.narration_origin === "mixed")
    add("synthetic_narration_disclosed", 10, {
      origin: ai.narration_origin,
      label: ai.synthetic_voice_label,
    });
  if (Number(crossSimilarity?.max_score || 0) >= 0.95)
    add("near_duplicate_cross_publisher_content", 70, {
      matches: Number(crossSimilarity?.count || 0),
      maxScore: Number(crossSimilarity.max_score),
    });
  else if (Number(crossSimilarity?.max_score || 0) >= 0.89)
    add("cross_publisher_content_similarity_review", 30, {
      matches: Number(crossSimilarity?.count || 0),
      maxScore: Number(crossSimilarity.max_score),
    });
  if (Number(sameAccountSimilarity?.max_score || 0) >= 0.97)
    add("low_value_derivative_variant_risk", 45, {
      matches: Number(sameAccountSimilarity?.count || 0),
      maxScore: Number(sameAccountSimilarity.max_score),
    });
  else if (Number(sameAccountSimilarity?.max_score || 0) >= 0.92)
    add("same_publisher_variant_similarity", 25, {
      matches: Number(sameAccountSimilarity?.count || 0),
      maxScore: Number(sameAccountSimilarity.max_score),
    });
  if (Number(recent?.count || 0) >= 25)
    add("mass_submission_velocity", 70, { submissions24h: Number(recent.count) });
  else if (Number(recent?.count || 0) >= 10)
    add("high_submission_velocity", 35, { submissions24h: Number(recent.count) });
  const score = Math.min(
      100,
      signals.reduce((n, s) => n + s.points, 0),
    ),
    outcome = score >= 80 ? "block" : score >= 25 ? "review" : "pass",
    assessmentId = id("policyassess"),
    at = now();
  await db
    .prepare(
      "INSERT INTO publishing_content_policy_assessments(id,submission_id,ai_disclosure_id,policy_version,outcome,risk_score,signals_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      assessmentId,
      submissionId,
      ai.id,
      FORE_AI_POLICY_VERSION,
      outcome,
      score,
      JSON.stringify(signals),
      at,
    )
    .run();
  return {
    id: assessmentId,
    submission_id: submissionId,
    outcome,
    risk_score: score,
    signals_json: JSON.stringify(signals),
  };
}

async function publishingAccountForSubject(
  db: PublishingDB,
  subjectType: string,
  subjectId: string,
) {
  let r: any = null;
  if (subjectType === "title")
    r = await db
      .prepare("SELECT account_id FROM publishing_titles WHERE id=?")
      .bind(subjectId)
      .first<any>();
  else if (subjectType === "edition")
    r = await db
      .prepare(
        "SELECT t.account_id FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?",
      )
      .bind(subjectId)
      .first<any>();
  else if (subjectType === "publication")
    r = await db
      .prepare("SELECT publishing_account_id account_id FROM publishing_publications WHERE id=?")
      .bind(subjectId)
      .first<any>();
  else if (subjectType === "publisher")
    r = await db
      .prepare("SELECT id account_id FROM publishing_accounts WHERE publisher_id=? OR id=? LIMIT 1")
      .bind(subjectId, subjectId)
      .first<any>();
  else if (subjectType === "author")
    r = await db
      .prepare("SELECT account_id FROM publishing_pen_names WHERE contributor_id=? OR id=? LIMIT 1")
      .bind(subjectId, subjectId)
      .first<any>();
  return r?.account_id ? String(r.account_id) : null;
}
async function lifecycleForSubject(db: PublishingDB, type: string, subjectId: string) {
  if (type === "edition")
    return db
      .prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?")
      .bind(subjectId)
      .first<any>();
  if (type === "publication")
    return db
      .prepare(
        `SELECT l.* FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id JOIN publishing_release_lifecycles l ON l.publishing_edition_id=s.edition_id WHERE p.id=?`,
      )
      .bind(subjectId)
      .first<any>();
  if (type === "title")
    return db
      .prepare(
        `SELECT l.* FROM publishing_edition_drafts e JOIN publishing_release_lifecycles l ON l.publishing_edition_id=e.id WHERE e.title_id=? ORDER BY l.updated_at DESC LIMIT 1`,
      )
      .bind(subjectId)
      .first<any>();
  return null;
}
function disputeEvent(
  db: PublishingDB,
  disputeId: string,
  eventType: string,
  actorType: "claimant" | "publisher" | "staff" | "system" | "worker",
  actorUserId: string | null,
  payload: any = {},
) {
  return db
    .prepare(
      "INSERT INTO rights_dispute_events(id,dispute_id,event_type,actor_type,actor_user_id,event_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      id("rightsevt"),
      disputeId,
      eventType,
      actorType,
      actorUserId,
      JSON.stringify(payload),
      now(),
    );
}
async function notify(
  db: PublishingDB,
  disputeId: string,
  type: string,
  recipientType: "claimant" | "publisher" | "staff",
  recipient: string,
  payload: any = {},
) {
  if (!recipient) return;
  await db
    .prepare(
      "INSERT INTO rights_notification_jobs(id,dispute_id,notification_type,recipient_type,recipient,payload_json,status,attempts,max_attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,8,?,?,?)",
    )
    .bind(
      id("rightsnotify"),
      disputeId,
      type,
      recipientType,
      recipient,
      JSON.stringify(payload),
      now(),
      now(),
      now(),
    )
    .run();
}

async function resolveCopyrightSubject(
  db: PublishingDB,
  input: { subjectType?: string; subjectId?: string; reportedUrl?: string },
) {
  if (input.subjectType && input.subjectId) {
    const accountId = await publishingAccountForSubject(db, input.subjectType, input.subjectId);
    if (!accountId)
      throw new ApiError(404, "The reported Cove publishing subject could not be found.");
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      accountId,
      reportedUrl: input.reportedUrl || "",
    };
  }
  if (!input.reportedUrl)
    throw new ApiError(400, "Provide a Cove content URL or a recognized publishing subject.");
  let u: URL;
  try {
    u = new URL(input.reportedUrl);
  } catch {
    throw new ApiError(400, "The reported content URL is invalid.");
  }
  const path = u.pathname.replace(/\/+$/g, "");
  let row: any = null,
    subjectType = "",
    subjectId = "";
  let m = path.match(/^\/book\/([^/]+)$/);
  if (m) {
    const productId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,publishing_account_id FROM publishing_publications WHERE product_id=? ORDER BY published_at DESC LIMIT 1",
      )
      .bind(productId)
      .first<any>();
    if (row) {
      subjectType = "publication";
      subjectId = String(row.id);
    }
  }
  m = path.match(/^\/edition\/([^/]+)$/);
  if (!row && m) {
    const editionId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,publishing_account_id FROM publishing_publications WHERE edition_id=? ORDER BY published_at DESC LIMIT 1",
      )
      .bind(editionId)
      .first<any>();
    if (row) {
      subjectType = "publication";
      subjectId = String(row.id);
    }
  }
  m = path.match(/^\/publisher\/([^/]+)$/);
  if (!row && m) {
    const publisherId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,publisher_id FROM publishing_accounts WHERE publisher_id=? OR id=? LIMIT 1",
      )
      .bind(publisherId, publisherId)
      .first<any>();
    if (row) {
      subjectType = "publisher";
      subjectId = String(row.publisher_id || row.id);
      row.publishing_account_id = row.id;
    }
  }
  m = path.match(/^\/author\/([^/]+)$/);
  if (!row && m) {
    const contributorId = decodeURIComponent(m[1]);
    row = await db
      .prepare(
        "SELECT id,account_id,contributor_id FROM publishing_pen_names WHERE contributor_id=? OR id=? LIMIT 1",
      )
      .bind(contributorId, contributorId)
      .first<any>();
    if (row) {
      subjectType = "author";
      subjectId = String(row.contributor_id || row.id);
      row.publishing_account_id = row.account_id;
    }
  }
  if (!row || !row.publishing_account_id)
    throw new ApiError(
      404,
      "That URL does not resolve to content published through Cove Publishing. Include a Cove book, edition, publisher, or author URL.",
    );
  return {
    subjectType,
    subjectId,
    accountId: String(row.publishing_account_id),
    reportedUrl: u.toString(),
  };
}

async function submitCopyrightNotice(db: PublishingDB, userId: string | null, raw: unknown) {
  const x = z
    .object({
      subjectType: z.enum(["title", "edition", "author", "publisher", "publication"]).optional(),
      subjectId: z.string().min(1).max(240).optional(),
      reportedUrl: z.string().url().max(2000).optional(),
      legalRegime: z.enum(["us_dmca", "contractual", "other"]).default("us_dmca"),
      claimantName: z.string().trim().min(2).max(240),
      claimantEmail: z.string().email(),
      claimantAddress: addressSchema,
      claimantPhone: z.string().trim().min(7).max(60),
      representedParty: z.string().max(240).default(""),
      copyrightedWorks: z
        .array(
          z.object({
            title: z.string().min(1).max(1000),
            author: z.string().max(500).default(""),
            registrationOrReference: z.string().max(500).default(""),
            description: z.string().max(4000).default(""),
          }),
        )
        .min(1)
        .max(200),
      infringingMaterial: z
        .array(
          z.object({
            url: z.string().url().or(z.literal("")),
            description: z.string().min(1).max(4000),
            location: z.string().max(1000).default(""),
          }),
        )
        .min(1)
        .max(200),
      rightsBasis: z.string().trim().min(3).max(2000),
      goodFaithAttestation: z.literal(true),
      accuracyPerjuryAttestation: z.literal(true),
      authorityAttestation: z.literal(true),
      signatureName: z.string().trim().min(2).max(240),
    })
    .superRefine((v, ctx) => {
      if (!v.reportedUrl && !(v.subjectType && v.subjectId))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A Cove content URL or publishing subject is required.",
        });
      if ((v.subjectType && !v.subjectId) || (!v.subjectType && v.subjectId))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subjectType and subjectId must be provided together.",
        });
    })
    .parse(raw);
  const subject = await resolveCopyrightSubject(db, x),
    lifecycle = await lifecycleForSubject(db, subject.subjectType, subject.subjectId);
  const sourceDigest = (
    await sha256(
      `${x.claimantEmail.toLowerCase()}|${subject.subjectType}|${subject.subjectId}|${JSON.stringify(x.copyrightedWorks)}|${JSON.stringify(x.infringingMaterial)}|${Date.now()}`,
    )
  ).slice(0, 24);
  const c = await createModerationCase(db, {
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    publishingAccountId: subject.accountId,
    category: "copyright",
    queue: "copyright",
    priority: "high",
    sourceType: "copyright_notice",
    sourceRef: `rights:${sourceDigest}`,
    riskScore: 60,
    summary: `Rightsholder notice regarding ${subject.subjectType} ${subject.subjectId}.`,
    reporterUserId: userId,
    reasonCode: "copyright_notice",
    details: x.rightsBasis,
    evidence: { reportedUrl: subject.reportedUrl },
  });
  const disputeId = id("rightsdispute"),
    noticeId = id("dmcanotice"),
    at = now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO rights_disputes(id,case_id,publishing_account_id,subject_type,subject_id,lifecycle_id,legal_regime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'notice_received',?,?)`,
      )
      .bind(
        disputeId,
        c.id,
        subject.accountId,
        subject.subjectType,
        subject.subjectId,
        lifecycle?.id || null,
        x.legalRegime,
        at,
        at,
      ),
    db
      .prepare(
        `INSERT INTO copyright_notices(id,dispute_id,complainant_user_id,claimant_name,claimant_email,claimant_address_json,claimant_phone,represented_party,copyrighted_works_json,infringing_material_json,rights_basis,good_faith_attestation,accuracy_perjury_attestation,authority_attestation,signature_name,status,received_at,updated_at,reported_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,1,1,?,'received',?,?,?)`,
      )
      .bind(
        noticeId,
        disputeId,
        userId,
        x.claimantName,
        x.claimantEmail.toLowerCase(),
        JSON.stringify(x.claimantAddress),
        x.claimantPhone,
        x.representedParty,
        JSON.stringify(x.copyrightedWorks),
        JSON.stringify(x.infringingMaterial),
        x.rightsBasis,
        x.signatureName,
        at,
        at,
        subject.reportedUrl,
      ),
    disputeEvent(db, disputeId, "notice_received", "claimant", userId, {
      noticeId,
      legalRegime: x.legalRegime,
      reportedUrl: subject.reportedUrl,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
    }),
  ]);
  await notify(db, disputeId, "notice_received", "claimant", x.claimantEmail, {
    noticeId,
    caseId: c.id,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
  });
  return {
    id: noticeId,
    disputeId,
    caseId: c.id,
    status: "received",
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
  };
}

async function takeDown(db: PublishingDB, dispute: any, staffUserId: string, reason: string) {
  const at = now();
  if (dispute.lifecycle_id) {
    const l = await db
      .prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?")
      .bind(dispute.lifecycle_id)
      .first<any>();
    if (l && l.state !== "takedown") {
      await db.batch([
        db
          .prepare(
            "UPDATE publishing_release_lifecycles SET enforcement_previous_state=state,state='takedown',state_reason=?,takedown_at=COALESCE(takedown_at,?),updated_at=? WHERE id=?",
          )
          .bind(reason, at, at, l.id),
        db
          .prepare(
            "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,'takedown','moderation',?,?,?,?)",
          )
          .bind(
            id("lifeevt"),
            l.id,
            l.state,
            staffUserId,
            "copyright_notice",
            JSON.stringify({ disputeId: dispute.id }),
            at,
          ),
      ]);
    }
  }
  const pubs = (
    await db
      .prepare(
        `SELECT p.*,s.edition_id source_edition_id FROM publishing_publications p JOIN publishing_submission_snapshots s ON s.id=p.submission_id WHERE p.publishing_account_id=? AND (?='publishing_account' OR ?='publisher' OR (?='publication' AND p.id=?) OR (?='edition' AND s.edition_id=?) OR (?='title' AND s.edition_id IN (SELECT id FROM publishing_edition_drafts WHERE title_id=?)) OR (?='author' AND s.edition_id IN (SELECT ec.edition_id FROM publishing_edition_contributors ec JOIN publishing_pen_names pn ON pn.id=ec.pen_name_id WHERE pn.contributor_id=? OR pn.id=?)))`,
      )
      .bind(
        dispute.publishing_account_id,
        dispute.subject_type,
        dispute.subject_type,
        dispute.subject_type,
        dispute.subject_id,
        dispute.subject_type,
        dispute.subject_id,
        dispute.subject_type,
        dispute.subject_id,
        dispute.subject_type,
        dispute.subject_id,
        dispute.subject_id,
      )
      .all<any>()
  ).results;
  for (const p of pubs) {
    await db
      .prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?")
      .bind(at, p.product_id)
      .run();
    await applyRoyaltyHold(db, dispute, p, staffUserId);
  }
}
async function applyRoyaltyHold(db: PublishingDB, dispute: any, pub: any, staffUserId: string) {
  if (!dispute.publishing_account_id) return;
  const acct = await db
      .prepare("SELECT finance_party_id FROM publishing_accounts WHERE id=?")
      .bind(dispute.publishing_account_id)
      .first<any>(),
    scopeType = "product",
    scopeId = String(pub.product_id),
    at = now();
  await db
    .prepare(
      "INSERT OR IGNORE INTO royalty_holds(id,dispute_id,publishing_account_id,finance_party_id,scope_type,scope_id,status,reason_code,started_by_user_id,started_at,created_at) VALUES(?,?,?,?,?,?,'active','copyright_dispute',?,?,?)",
    )
    .bind(
      id("royhold"),
      dispute.id,
      dispute.publishing_account_id,
      acct?.finance_party_id || null,
      scopeType,
      scopeId,
      staffUserId,
      at,
      at,
    )
    .run();
  await db
    .prepare(
      `UPDATE finance_royalty_events SET status='held' WHERE status IN ('accrued','payable') AND product_id=?`,
    )
    .bind(scopeId)
    .run();
  await db
    .prepare(
      `UPDATE finance_royalty_allocations SET status='held' WHERE status IN ('accrued','payable') AND calculation_id IN (SELECT id FROM finance_royalty_calculations WHERE product_id=?)`,
    )
    .bind(scopeId)
    .run();
  await db
    .prepare(
      `UPDATE payout_items SET status='held' WHERE status='pending' AND (id IN (SELECT pel.payout_item_id FROM payout_event_links pel JOIN finance_royalty_events re ON re.id=pel.royalty_event_id WHERE re.product_id=?) OR id IN (SELECT pal.payout_item_id FROM payout_allocation_links pal JOIN finance_royalty_allocations ra ON ra.id=pal.royalty_allocation_id JOIN finance_royalty_calculations rc ON rc.id=ra.calculation_id WHERE rc.product_id=?))`,
    )
    .bind(scopeId, scopeId)
    .run();
}
// Restoring takedown publications and releasing funds MUST be performed by
// an independently authorized canonical owner, not shared D1. No public
// replacement is deliberately exposed until rights/court evidence and
// finance hold release can be verified atomically under an owner epoch.

async function validateCopyrightNotice(db: PublishingDB, staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        disputeId: z.string().min(1),
        decision: z.enum(["needs_info", "noncompliant", "compliant_takedown"]),
        notes: z.string().max(10000).default(""),
      })
      .parse(raw),
    d = await db
      .prepare(
        `SELECT rd.*,cn.id notice_id,cn.claimant_email,pa.contact_email publisher_email FROM rights_disputes rd JOIN copyright_notices cn ON cn.dispute_id=rd.id LEFT JOIN publishing_accounts pa ON pa.id=rd.publishing_account_id WHERE rd.id=?`,
      )
      .bind(x.disputeId)
      .first<any>();
  if (!d) throw new ApiError(404, "Copyright dispute not found.");
  if (!["notice_received", "needs_info"].includes(String(d.status)))
    throw new ApiError(409, "This notice is no longer awaiting validation.");
  const at = now();
  if (x.decision === "needs_info") {
    await db.batch([
      db
        .prepare(
          "UPDATE copyright_notices SET status='needs_info',staff_validation_notes=?,validated_at=?,updated_at=? WHERE id=?",
        )
        .bind(x.notes, at, at, d.notice_id),
      db
        .prepare("UPDATE rights_disputes SET status='needs_info',updated_at=? WHERE id=?")
        .bind(at, d.id),
      disputeEvent(db, d.id, "notice_needs_info", "staff", staff.userId, { notes: x.notes }),
    ]);
    await notify(db, d.id, "needs_info", "claimant", d.claimant_email, { notes: x.notes });
    return { status: "needs_info" };
  }
  if (x.decision === "noncompliant") {
    await db.batch([
      db
        .prepare(
          "UPDATE copyright_notices SET status='noncompliant',staff_validation_notes=?,validated_at=?,updated_at=? WHERE id=?",
        )
        .bind(x.notes, at, at, d.notice_id),
      db
        .prepare(
          "UPDATE rights_disputes SET status='resolved',resolution_code='notice_noncompliant',resolution_notes=?,resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE id=?",
        )
        .bind(x.notes, staff.userId, at, at, d.id),
      db
        .prepare(
          "UPDATE moderation_cases SET status='resolved',resolved_at=?,updated_at=? WHERE id=?",
        )
        .bind(at, at, d.case_id),
      disputeEvent(db, d.id, "notice_rejected", "staff", staff.userId, { notes: x.notes }),
    ]);
    await notify(db, d.id, "notice_noncompliant", "claimant", d.claimant_email, {
      noticeId: d.notice_id,
      notes: x.notes,
    });
    return { status: "noncompliant" };
  }
  await db.batch([
    db
      .prepare(
        "UPDATE copyright_notices SET status='actioned',staff_validation_notes=?,validated_at=?,actioned_at=?,updated_at=? WHERE id=?",
      )
      .bind(x.notes, at, at, at, d.notice_id),
    db
      .prepare(
        "UPDATE rights_disputes SET status='taken_down',takedown_at=?,updated_at=? WHERE id=?",
      )
      .bind(at, at, d.id),
    db
      .prepare("UPDATE moderation_cases SET status='actioned',updated_at=? WHERE id=?")
      .bind(at, d.case_id),
    disputeEvent(db, d.id, "notice_validated_and_takedown_ordered", "staff", staff.userId, {
      notes: x.notes,
    }),
  ]);
  await takeDown(db, d, staff.userId, "copyright_notice");
  await notify(db, d.id, "notice_actioned", "claimant", d.claimant_email, {
    disputeId: d.id,
    noticeId: d.notice_id,
  });
  await notify(db, d.id, "takedown_to_publisher", "publisher", d.publisher_email || "", {
    disputeId: d.id,
    noticeId: d.notice_id,
    counterNoticeAvailable: d.legal_regime === "us_dmca",
  });
  return { status: "taken_down", disputeId: d.id };
}

async function submitCopyrightCounterNotice(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      disputeId: z.string().min(1),
      subscriberName: z.string().trim().min(2).max(240),
      subscriberAddress: addressSchema,
      subscriberPhone: z.string().trim().min(7).max(60),
      removedMaterial: z
        .array(
          z.object({
            description: z.string().min(1).max(4000),
            formerLocation: z.string().max(1000).default(""),
          }),
        )
        .min(1)
        .max(200),
      mistakePerjuryAttestation: z.literal(true),
      jurisdictionConsent: z.literal(true),
      serviceConsent: z.literal(true),
      signatureName: z.string().trim().min(2).max(240),
      statement: z.string().max(10000).default(""),
    })
    .parse(raw);
  const d = await db
    .prepare(
      `SELECT rd.*,cn.id notice_id FROM rights_disputes rd JOIN copyright_notices cn ON cn.dispute_id=rd.id WHERE rd.id=?`,
    )
    .bind(x.disputeId)
    .first<any>();
  if (!d) throw new ApiError(404, "Copyright dispute not found.");
  if (!d.publishing_account_id)
    throw new ApiError(409, "This dispute has no publisher account eligible to counter-notify.");
  await member(db, userId, String(d.publishing_account_id), "admin");
  if (d.legal_regime !== "us_dmca")
    throw new ApiError(409, "This dispute does not use the U.S. DMCA counter-notice workflow.");
  if (!["taken_down", "counter_received"].includes(String(d.status)))
    throw new ApiError(
      409,
      "A counter-notice may be submitted only after the material has been taken down.",
    );
  const prior = await db
    .prepare(
      "SELECT * FROM copyright_counter_notices WHERE dispute_id=? AND status IN ('received','needs_info','compliant','forwarded','waiting') ORDER BY received_at DESC LIMIT 1",
    )
    .bind(d.id)
    .first<any>();
  if (prior && prior.status !== "needs_info")
    throw new ApiError(409, "This dispute already has an active counter-notice.");
  const cid = id("counter"),
    at = now(),
    statements: any[] = [];
  if (prior) {
    statements.push(
      db
        .prepare(
          "UPDATE copyright_counter_notices SET status='closed',updated_at=? WHERE id=? AND status='needs_info'",
        )
        .bind(at, prior.id),
    );
    statements.push(
      disputeEvent(db, d.id, "counter_notice_superseded_after_needs_info", "publisher", userId, {
        priorCounterNoticeId: prior.id,
        newCounterNoticeId: cid,
      }),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO copyright_counter_notices(id,dispute_id,notice_id,publishing_account_id,submitter_user_id,subscriber_name,subscriber_address_json,subscriber_phone,removed_material_json,mistake_perjury_attestation,jurisdiction_consent,service_consent,signature_name,statement,status,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1,1,?,?,'received',?,?)`,
      )
      .bind(
        cid,
        d.id,
        d.notice_id,
        d.publishing_account_id,
        userId,
        x.subscriberName,
        JSON.stringify(x.subscriberAddress),
        x.subscriberPhone,
        JSON.stringify(x.removedMaterial),
        x.signatureName,
        x.statement,
        at,
        at,
      ),
  );
  statements.push(
    db
      .prepare(
        "UPDATE rights_disputes SET status='counter_received',restore_not_before_at=NULL,restore_deadline_at=NULL,updated_at=? WHERE id=?",
      )
      .bind(at, d.id),
  );
  statements.push(
    db
      .prepare("UPDATE copyright_notices SET status='countered',updated_at=? WHERE id=?")
      .bind(at, d.notice_id),
  );
  statements.push(
    disputeEvent(
      db,
      d.id,
      prior ? "counter_notice_resubmitted" : "counter_notice_received",
      "publisher",
      userId,
      { counterNoticeId: cid, priorCounterNoticeId: prior?.id || null },
    ),
  );
  await db.batch(statements);
  return { id: cid, status: "received", supersedes: prior?.id || null };
}

function utcDateKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function observedFixedHoliday(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  const d = new Date(Date.UTC(year, month, 1));
  const delta = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + delta + (n - 1) * 7);
  return d;
}
function lastWeekday(year: number, month: number, weekday: number) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  const delta = (d.getUTCDay() - weekday + 7) % 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d;
}
function isUsFederalBusinessHoliday(d: Date) {
  const y = d.getUTCFullYear(),
    key = utcDateKey(d),
    holidays = [
      observedFixedHoliday(y, 0, 1),
      observedFixedHoliday(y + 1, 0, 1),
      nthWeekday(y, 0, 1, 3),
      nthWeekday(y, 1, 1, 3),
      lastWeekday(y, 4, 1),
      observedFixedHoliday(y, 5, 19),
      observedFixedHoliday(y, 6, 4),
      nthWeekday(y, 8, 1, 1),
      nthWeekday(y, 9, 1, 2),
      observedFixedHoliday(y, 10, 11),
      nthWeekday(y, 10, 4, 4),
      observedFixedHoliday(y, 11, 25),
    ];
  return holidays.some((h) => utcDateKey(h) === key);
}
function addBusinessDays(input: Date, days: number) {
  const d = new Date(input);
  let n = 0;
  while (n < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6 && !isUsFederalBusinessHoliday(d)) n++;
  }
  return d.toISOString();
}

async function validateCopyrightCounterNotice(
  db: PublishingDB,
  staff: StaffContext,
  raw: unknown,
) {
  const x = z
      .object({
        counterNoticeId: z.string().min(1),
        decision: z.enum(["needs_info", "reject", "compliant_forward"]),
        notes: z.string().max(10000).default(""),
      })
      .parse(raw),
    c = await db
      .prepare(
        `SELECT cn.*,rd.case_id,rd.status dispute_status,n.claimant_email,pa.contact_email publisher_email FROM copyright_counter_notices cn JOIN rights_disputes rd ON rd.id=cn.dispute_id JOIN copyright_notices n ON n.id=cn.notice_id LEFT JOIN publishing_accounts pa ON pa.id=cn.publishing_account_id WHERE cn.id=?`,
      )
      .bind(x.counterNoticeId)
      .first<any>();
  if (!c) throw new ApiError(404, "Counter-notice not found.");
  if (!["received", "needs_info"].includes(String(c.status)))
    throw new ApiError(409, "This counter-notice is no longer awaiting validation.");
  const at = now();
  if (x.decision === "needs_info") {
    await db.batch([
      db
        .prepare(
          "UPDATE copyright_counter_notices SET status='needs_info',validated_at=?,updated_at=? WHERE id=?",
        )
        .bind(at, at, c.id),
      disputeEvent(db, c.dispute_id, "counter_notice_needs_info", "staff", staff.userId, {
        notes: x.notes,
      }),
    ]);
    await notify(db, c.dispute_id, "counter_needs_info", "publisher", c.publisher_email || "", {
      counterNoticeId: c.id,
      notes: x.notes,
    });
    return { status: "needs_info" };
  }
  if (x.decision === "reject") {
    await db.batch([
      db
        .prepare(
          "UPDATE copyright_counter_notices SET status='rejected',validated_at=?,updated_at=? WHERE id=?",
        )
        .bind(at, at, c.id),
      db
        .prepare(
          "UPDATE rights_disputes SET status='taken_down',restore_not_before_at=NULL,restore_deadline_at=NULL,updated_at=? WHERE id=?",
        )
        .bind(at, c.dispute_id),
      disputeEvent(db, c.dispute_id, "counter_notice_rejected", "staff", staff.userId, {
        notes: x.notes,
      }),
    ]);
    await notify(db, c.dispute_id, "counter_rejected", "publisher", c.publisher_email || "", {
      counterNoticeId: c.id,
      notes: x.notes,
    });
    return { status: "rejected" };
  }
  const receivedAt = new Date(String(c.received_at || at)),
    base = Number.isNaN(receivedAt.valueOf()) ? new Date() : receivedAt,
    notBefore = addBusinessDays(base, 10),
    deadline = addBusinessDays(base, 14);
  await db.batch([
    db
      .prepare(
        "UPDATE copyright_counter_notices SET status='forwarded',validated_at=?,forwarded_at=?,updated_at=? WHERE id=?",
      )
      .bind(at, at, at, c.id),
    db
      .prepare(
        "UPDATE rights_disputes SET status='waiting_restore_window',restore_not_before_at=?,restore_deadline_at=?,updated_at=? WHERE id=?",
      )
      .bind(notBefore, deadline, at, c.dispute_id),
    db
      .prepare("UPDATE moderation_cases SET status='waiting_external',updated_at=? WHERE id=?")
      .bind(at, c.case_id),
    disputeEvent(db, c.dispute_id, "counter_notice_forwarded", "staff", staff.userId, {
      counterNoticeId: c.id,
      receivedAt: c.received_at,
      restoreNotBeforeAt: notBefore,
      restoreDeadlineAt: deadline,
      notes: x.notes,
    }),
  ]);
  await notify(db, c.dispute_id, "counter_forwarded_to_claimant", "claimant", c.claimant_email, {
    counterNoticeId: c.id,
    receivedAt: c.received_at,
    restoreNotBeforeAt: notBefore,
    restoreDeadlineAt: deadline,
  });
  return { status: "forwarded", restoreNotBeforeAt: notBefore, restoreDeadlineAt: deadline };
}

async function recordCopyrightCourtAction(
  db: PublishingDB,
  staff: StaffContext,
  raw: unknown,
) {
  const x = z
      .object({
        disputeId: z.string().min(1),
        filedBy: z.enum(["claimant", "publisher", "other"]).default("claimant"),
        court: z.string().trim().min(2).max(500),
        caseNumber: z.string().trim().min(1).max(240),
        filingDate: z.string().datetime(),
        evidenceReference: z.string().max(1000).default(""),
      })
      .parse(raw),
    d = await db
      .prepare(
        `SELECT rd.*,n.claimant_email,pa.contact_email publisher_email FROM rights_disputes rd JOIN copyright_notices n ON n.dispute_id=rd.id LEFT JOIN publishing_accounts pa ON pa.id=rd.publishing_account_id WHERE rd.id=?`,
      )
      .bind(x.disputeId)
      .first<any>();
  if (!d) throw new ApiError(404, "Copyright dispute not found.");
  if (
    ![
      "counter_forwarded",
      "waiting_restore_window",
      "restoration_eligible",
      "counter_received",
    ].includes(String(d.status))
  )
    throw new ApiError(409, "This dispute is not in a counter-notice restoration window.");
  const at = now(),
    courtActionId = id("courtact");
  await db.batch([
    db
      .prepare(
        "INSERT INTO copyright_court_actions(id,dispute_id,filed_by,court,case_number,filing_date,evidence_reference,recorded_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        courtActionId,
        d.id,
        x.filedBy,
        x.court,
        x.caseNumber,
        x.filingDate,
        x.evidenceReference,
        staff.userId,
        at,
      ),
    db
      .prepare(
        "UPDATE rights_disputes SET status='litigation_hold',litigation_hold=1,updated_at=? WHERE id=?",
      )
      .bind(at, d.id),
    db
      .prepare(
        "UPDATE copyright_notices SET status='litigation_hold',updated_at=? WHERE dispute_id=?",
      )
      .bind(at, d.id),
    db
      .prepare(
        "UPDATE copyright_counter_notices SET status='court_action',updated_at=? WHERE dispute_id=? AND status IN ('forwarded','waiting','compliant')",
      )
      .bind(at, d.id),
    disputeEvent(db, d.id, "court_action_recorded", "staff", staff.userId, { ...x, courtActionId }),
  ]);
  await notify(db, d.id, "court_action_recorded", "claimant", d.claimant_email || "", {
    ...x,
    courtActionId,
  });
  await notify(db, d.id, "court_action_recorded", "publisher", d.publisher_email || "", {
    ...x,
    courtActionId,
  });
  return { status: "litigation_hold", courtActionId };
}

async function recalcRepeatPolicy(db: PublishingDB, accountId: string) {
  const r = await db
      .prepare(
        "SELECT COUNT(*) incidents,COALESCE(SUM(strike_points),0) points,MAX(decided_at) last_at FROM publisher_infringement_incidents WHERE publishing_account_id=? AND status='active' AND (expires_at IS NULL OR expires_at>datetime('now'))",
      )
      .bind(accountId)
      .first<any>(),
    points = Number(r?.points || 0),
    state =
      points >= 9
        ? "termination_review"
        : points >= 6
          ? "restricted"
          : points >= 3
            ? "warning"
            : "normal",
    at = now();
  await db
    .prepare(
      `INSERT INTO repeat_infringer_policy_state(publishing_account_id,active_incidents,active_strike_points,policy_state,last_incident_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(publishing_account_id) DO UPDATE SET active_incidents=excluded.active_incidents,active_strike_points=excluded.active_strike_points,policy_state=CASE WHEN repeat_infringer_policy_state.policy_state='terminated' THEN 'terminated' ELSE excluded.policy_state END,last_incident_at=excluded.last_incident_at,updated_at=excluded.updated_at`,
    )
    .bind(accountId, Number(r?.incidents || 0), points, state, r?.last_at || null, at)
    .run();
  if (state === "restricted")
    await db
      .prepare(
        "UPDATE publishing_accounts SET status='restricted',updated_at=? WHERE id=? AND status NOT IN ('suspended','closed')",
      )
      .bind(at, accountId)
      .run();
  if (state === "termination_review")
    await createModerationCase(db, {
      subjectType: "publishing_account",
      subjectId: accountId,
      publishingAccountId: accountId,
      category: "copyright",
      queue: "copyright",
      priority: "urgent",
      sourceType: "system",
      sourceRef: `repeat-infringer:${accountId}`,
      riskScore: 100,
      summary: `Repeat-infringer policy reached termination review with ${points} active strike points.`,
    });
  return { points, state };
}
async function resolveRightsDispute(db: PublishingDB, staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        disputeId: z.string().min(1),
        resolutionCode: z.enum([
          "no_infringement",
          "claimant_withdrawn",
          "infringement_confirmed",
          "court_order",
          "settlement",
          "other",
        ]),
        notes: z.string().trim().min(3).max(10000),
        restoreContent: z.boolean().default(false),
        royaltyDisposition: z.enum(["release", "continue_hold"]).optional(),
        // Backward-compatible input only. A rights decision no longer silently forfeits publisher money.
        forfeitRoyalties: z.boolean().optional(),
      })
      .parse(raw),
    d = await db.prepare("SELECT * FROM rights_disputes WHERE id=?").bind(x.disputeId).first<any>();
  if (!d) throw new ApiError(404, "Copyright dispute not found.");
  if (String(d.status) === "resolved")
    throw new ApiError(409, "This rights dispute is already resolved.");
  const at = now();
  if (x.forfeitRoyalties === true)
    throw new ApiError(
      400,
      "Royalty forfeiture is not a copyright-case shortcut. Keep disputed funds on hold until an authorized finance/legal disposition is recorded.",
    );
  const mustRelease = ["no_infringement", "claimant_withdrawn"].includes(x.resolutionCode);
  const royaltyDisposition = mustRelease ? "release" : x.royaltyDisposition || "continue_hold";
  // No staff/public D1 path may reactivate withdrawn rights or free held funds.
  // Deny before the infringement/finance/dispute side effects below.
  if (x.restoreContent || royaltyDisposition === "release")
    throw new ApiError(
      503,
      "Copyright restoration and royalty release require the independently authorized legal owner.",
    );
  if (
    d.publishing_account_id &&
    ["infringement_confirmed", "court_order"].includes(x.resolutionCode)
  ) {
    const incidentType =
        x.resolutionCode === "court_order" ? "court_order" : "confirmed_infringement",
      points = x.resolutionCode === "court_order" ? 5 : 3;
    await db
      .prepare(
        "INSERT OR IGNORE INTO publisher_infringement_incidents(id,publishing_account_id,dispute_id,incident_type,strike_points,status,decided_by_user_id,rationale,decided_at) VALUES(?,?,?,?,?,'active',?,?,?)",
      )
      .bind(
        id("infrincident"),
        d.publishing_account_id,
        d.id,
        incidentType,
        points,
        staff.userId,
        x.notes,
        at,
      )
      .run();
    await recalcRepeatPolicy(db, String(d.publishing_account_id));
  }
  await db.batch([
    db
      .prepare(
        "UPDATE rights_disputes SET status='resolved',resolution_code=?,resolution_notes=?,resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE id=?",
      )
      .bind(x.resolutionCode, x.notes, staff.userId, at, at, d.id),
    db
      .prepare(
        "UPDATE moderation_cases SET status='resolved',resolved_at=?,updated_at=? WHERE id=?",
      )
      .bind(at, at, d.case_id),
    disputeEvent(db, d.id, "dispute_resolved", "staff", staff.userId, {
      resolutionCode: x.resolutionCode,
      notes: x.notes,
      restoreContent: x.restoreContent,
      royaltyDisposition,
    }),
  ]);
  const notice = await db
      .prepare("SELECT claimant_email FROM copyright_notices WHERE dispute_id=?")
      .bind(d.id)
      .first<any>(),
    publisher = d.publishing_account_id
      ? await db
          .prepare("SELECT contact_email FROM publishing_accounts WHERE id=?")
          .bind(d.publishing_account_id)
          .first<any>()
      : null;
  const payload = {
    resolutionCode: x.resolutionCode,
    notes: x.notes,
    contentRestored: x.restoreContent,
    royaltyDisposition,
  };
  await notify(db, d.id, "dispute_resolved", "claimant", notice?.claimant_email || "", payload);
  await notify(db, d.id, "dispute_resolved", "publisher", publisher?.contact_email || "", payload);
  return { status: "resolved", resolutionCode: x.resolutionCode, royaltyDisposition };
}

async function manageRepeatInfringerPolicy(
  db: PublishingDB,
  staff: StaffContext,
  raw: unknown,
) {
  const x = z
      .object({
        accountId: z.string().min(1),
        action: z.enum(["terminate", "overturn_incident", "recalculate"]),
        incidentId: z.string().min(1).optional(),
        notes: z.string().trim().min(3).max(10000),
      })
      .parse(raw),
    account = await db
      .prepare("SELECT * FROM publishing_accounts WHERE id=?")
      .bind(x.accountId)
      .first<any>();
  if (!account) throw new ApiError(404, "Publishing account not found.");
  const at = now();
  if (x.action === "overturn_incident") {
    if (!x.incidentId)
      throw new ApiError(400, "incidentId is required when overturning an infringement incident.");
    const incident = await db
      .prepare(
        "SELECT * FROM publisher_infringement_incidents WHERE id=? AND publishing_account_id=?",
      )
      .bind(x.incidentId, x.accountId)
      .first<any>();
    if (!incident) throw new ApiError(404, "Infringement incident not found.");
    if (incident.status !== "active")
      throw new ApiError(409, "Only an active infringement incident can be overturned.");
    await db
      .prepare("UPDATE publisher_infringement_incidents SET status='overturned' WHERE id=?")
      .bind(incident.id)
      .run();
    const state = await recalcRepeatPolicy(db, x.accountId);
    await audit(
      db,
      x.accountId,
      staff.userId,
      "repeat_infringer_policy",
      x.accountId,
      "incident_overturned",
      {
        incidentId: incident.id,
        notes: x.notes,
        policyState: state.state,
        strikePoints: state.points,
      },
    );
    return { action: x.action, incidentId: incident.id, ...state };
  }
  const state = await recalcRepeatPolicy(db, x.accountId);
  if (x.action === "recalculate") {
    await audit(
      db,
      x.accountId,
      staff.userId,
      "repeat_infringer_policy",
      x.accountId,
      "recalculated",
      { notes: x.notes, policyState: state.state, strikePoints: state.points },
    );
    return { action: x.action, ...state };
  }
  if (state.points < 9 && state.state !== "termination_review")
    throw new ApiError(
      409,
      "Repeat-infringer termination requires the account to reach Cove's termination-review threshold.",
    );
  const lifecycles = (
    await db
      .prepare(
        `SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=?`,
      )
      .bind(x.accountId)
      .all<any>()
  ).results;
  const statements: any[] = [
    db
      .prepare(
        "UPDATE repeat_infringer_policy_state SET policy_state='terminated',updated_at=? WHERE publishing_account_id=?",
      )
      .bind(at, x.accountId),
    db
      .prepare("UPDATE publishing_accounts SET status='closed',updated_at=? WHERE id=?")
      .bind(at, x.accountId),
  ];
  for (const l of lifecycles) {
    if (!["takedown", "retired"].includes(String(l.state))) {
      statements.push(
        db
          .prepare(
            "UPDATE publishing_release_lifecycles SET enforcement_previous_state=state,state='takedown',state_reason='repeat_infringer_termination',takedown_at=COALESCE(takedown_at,?),updated_at=? WHERE id=?",
          )
          .bind(at, at, l.id),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,'takedown','moderation',?,'repeat_infringer_termination',?,?)",
          )
          .bind(
            id("lifeevt"),
            l.id,
            l.state,
            staff.userId,
            JSON.stringify({ notes: x.notes, accountId: x.accountId }),
            at,
          ),
      );
    }
    if (l.catalog_product_id)
      statements.push(
        db
          .prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE id=?")
          .bind(at, l.catalog_product_id),
      );
  }
  await db.batch(statements);
  await audit(db, x.accountId, staff.userId, "repeat_infringer_policy", x.accountId, "terminated", {
    notes: x.notes,
    strikePoints: state.points,
    releaseCount: lifecycles.length,
  });
  return {
    action: "terminate",
    state: "terminated",
    strikePoints: state.points,
    releasesDisabled: lifecycles.length,
  };
}

async function advanceRightsDisputeDeadlines(db: PublishingDB) {
  const due = (
    await db
      .prepare(
        "SELECT * FROM rights_disputes WHERE status='waiting_restore_window' AND litigation_hold=0 AND restore_not_before_at IS NOT NULL AND restore_not_before_at<=?",
      )
      .bind(now())
      .all<any>()
  ).results;
  // DO NOT acknowledge a restored work or notify a claimant of restoration
  // while the production owner is unavailable. Leave disputes pending and
  // explicitly fail the job so operators can resolve the legal deadline.
  if (due.length)
    throw new ApiError(
      503,
      "Copyright restoration deadline reached; independent legal-owner certification is required.",
    );
  return { checked: 0, restored: 0 };
}

async function leaseRightsNotificationJobs(db: PublishingDB, raw: unknown) {
  const x = z
      .object({
        workerId: z.string().min(1).max(160),
        limit: z.number().int().min(1).max(100).default(20),
        leaseSeconds: z.number().int().min(30).max(1800).default(300),
      })
      .parse(raw),
    at = now(),
    until = new Date(Date.now() + x.leaseSeconds * 1000).toISOString();
  await db
    .prepare(
      "UPDATE rights_notification_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=?,updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts<max_attempts",
    )
    .bind(at, at, at)
    .run();
  const rows = (
    await db
      .prepare(
        "SELECT * FROM rights_notification_jobs WHERE status='queued' AND available_at<=? AND attempts<max_attempts ORDER BY created_at LIMIT ?",
      )
      .bind(at, x.limit)
      .all<any>()
  ).results;
  const leased: any[] = [];
  for (const r of rows) {
    await db
      .prepare(
        "UPDATE rights_notification_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'",
      )
      .bind(x.workerId, until, at, r.id)
      .run();
    const got = await db
      .prepare(
        "SELECT * FROM rights_notification_jobs WHERE id=? AND status='leased' AND lease_owner=?",
      )
      .bind(r.id, x.workerId)
      .first<any>();
    if (got) leased.push(got);
  }
  return { jobs: leased };
}
async function completeRightsNotificationJob(db: PublishingDB, raw: unknown) {
  const x = z
      .object({
        jobId: z.string().min(1),
        workerId: z.string().min(1),
        status: z.enum(["sent", "failed"]),
        providerMessageId: z.string().max(500).default(""),
        error: z.string().max(2000).default(""),
      })
      .parse(raw),
    j = await db
      .prepare(
        "SELECT * FROM rights_notification_jobs WHERE id=? AND status='leased' AND lease_owner=?",
      )
      .bind(x.jobId, x.workerId)
      .first<any>();
  if (!j)
    throw new ApiError(409, "Notification job lease is missing or no longer owned by this worker.");
  const terminal = x.status === "sent" || Number(j.attempts) >= Number(j.max_attempts),
    status = x.status === "sent" ? "sent" : terminal ? "failed" : "queued",
    available =
      status === "queued"
        ? new Date(
            Date.now() +
              Math.min(3600, 60 * Math.pow(2, Math.max(0, Number(j.attempts) - 1))) * 1000,
          ).toISOString()
        : j.available_at;
  await db
    .prepare(
      "UPDATE rights_notification_jobs SET status=?,provider_message_id=?,last_error=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
    )
    .bind(status, x.providerMessageId, x.error, available, now(), j.id)
    .run();
  return { id: j.id, status };
}

async function leaseRightsEvidenceScanJobs(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "lease-rights-scan", raw);
}

async function completeRightsEvidenceScanJob(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "complete-rights-scan", raw);
}

async function reviewRightsEvidence(db: PublishingDB, staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        evidenceId: z.string().min(1),
        status: z.enum(["verified", "insufficient", "rejected"]),
      })
      .parse(raw),
    e = await db
      .prepare("SELECT * FROM publishing_rights_evidence WHERE id=?")
      .bind(x.evidenceId)
      .first<any>();
  if (!e) throw new ApiError(404, "Rights evidence not found.");
  if (e.scan_status !== "clean")
    throw new ApiError(
      409,
      "Rights evidence must pass malware/scanning checks before staff review.",
    );
  await db
    .prepare("UPDATE publishing_rights_evidence SET verification_status=? WHERE id=?")
    .bind(x.status, e.id)
    .run();
  await audit(db, String(e.account_id), staff.userId, "rights_evidence", e.id, "reviewed", {
    status: x.status,
  });
  return { saved: true, status: x.status };
}
async function resolveSimilarityMatch(db: PublishingDB, staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        id: z.string().min(1),
        disposition: z.enum(["cleared", "authorized_overlap", "infringing", "fraud_hold"]),
      })
      .parse(raw),
    r = await db
      .prepare("SELECT * FROM publishing_similarity_matches WHERE id=?")
      .bind(x.id)
      .first<any>();
  if (!r) throw new ApiError(404, "Similarity match not found.");
  await db
    .prepare("UPDATE publishing_similarity_matches SET disposition=?,updated_at=? WHERE id=?")
    .bind(x.disposition, now(), x.id)
    .run();
  return { saved: true, reviewedBy: staff.userId };
}
async function resolveIdentitySimilarity(
  db: PublishingDB,
  staff: StaffContext,
  raw: unknown,
) {
  const x = z
      .object({ id: z.string().min(1), status: z.enum(["cleared", "authorized", "impersonation"]) })
      .parse(raw),
    r = await db
      .prepare("SELECT * FROM publishing_identity_similarity_matches WHERE id=?")
      .bind(x.id)
      .first<any>();
  if (!r) throw new ApiError(404, "Identity similarity match not found.");
  await db
    .prepare("UPDATE publishing_identity_similarity_matches SET status=?,updated_at=? WHERE id=?")
    .bind(x.status, now(), x.id)
    .run();
  if (x.status === "impersonation") {
    await createModerationCase(db, {
      subjectType: r.subject_type === "pen_name" ? "author" : "publisher",
      subjectId: String(r.subject_id),
      publishingAccountId: String(r.account_id),
      category: "impersonation",
      queue: "impersonation",
      priority: "high",
      sourceType: "identity_similarity",
      sourceRef: `identity-match:${r.id}`,
      riskScore: Number(r.similarity_score),
      summary: `Potential impersonation match: ${r.submitted_name} vs ${r.matched_name}.`,
    });
    let targetAccountId: string | null = null;
    if (r.matched_entity_type === "publishing_account")
      targetAccountId = String(r.matched_entity_id);
    else if (r.matched_entity_type === "pen_name")
      targetAccountId =
        (
          await db
            .prepare("SELECT account_id FROM publishing_pen_names WHERE id=?")
            .bind(r.matched_entity_id)
            .first<any>()
        )?.account_id || null;
    else if (r.matched_entity_type === "publisher")
      targetAccountId =
        (
          await db
            .prepare(
              "SELECT id FROM publishing_accounts WHERE publisher_id=? ORDER BY created_at LIMIT 1",
            )
            .bind(r.matched_entity_id)
            .first<any>()
        )?.id || null;
    if (targetAccountId && targetAccountId !== String(r.account_id))
      await upsertAccountRiskLink(
        db,
        String(r.account_id),
        String(targetAccountId),
        "repeated_impersonation_target",
        Math.max(90, Number(r.similarity_score || 0)),
        {
          identitySimilarityMatchId: r.id,
          matchedEntityType: r.matched_entity_type,
          matchedEntityId: r.matched_entity_id,
        },
      );
  }
  return { saved: true, reviewedBy: staff.userId };
}
async function resolveRiskCluster(db: PublishingDB, staff: StaffContext, raw: unknown) {
  const x = z
      .object({
        id: z.string().min(1),
        status: z.enum(["cleared", "confirmed_fraud", "monitoring"]),
        reason: z.string().max(5000).default(""),
      })
      .parse(raw),
    r = await db
      .prepare("SELECT * FROM publishing_risk_clusters WHERE id=?")
      .bind(x.id)
      .first<any>();
  if (!r) throw new ApiError(404, "Risk cluster not found.");
  await db
    .prepare("UPDATE publishing_risk_clusters SET status=?,reason=?,updated_at=? WHERE id=?")
    .bind(x.status, x.reason, now(), x.id)
    .run();
  return { saved: true, reviewedBy: staff.userId };
}

async function rightsOperationsDashboard(db: PublishingDB) {
  const [
    disputes,
    notices,
    counters,
    holds,
    incidents,
    repeatStates,
    similarity,
    identityMatches,
    clusters,
    notifications,
    evidence,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT d.*,c.priority,c.status case_status,a.display_name publisher_name FROM rights_disputes d JOIN moderation_cases c ON c.id=d.case_id LEFT JOIN publishing_accounts a ON a.id=d.publishing_account_id ORDER BY d.created_at DESC LIMIT 500`,
      )
      .all<any>(),
    db.prepare("SELECT * FROM copyright_notices ORDER BY received_at DESC LIMIT 500").all<any>(),
    db
      .prepare("SELECT * FROM copyright_counter_notices ORDER BY received_at DESC LIMIT 500")
      .all<any>(),
    db.prepare("SELECT * FROM royalty_holds ORDER BY started_at DESC LIMIT 500").all<any>(),
    db
      .prepare("SELECT * FROM publisher_infringement_incidents ORDER BY decided_at DESC LIMIT 500")
      .all<any>(),
    db
      .prepare(
        "SELECT r.*,a.display_name publisher_name FROM repeat_infringer_policy_state r JOIN publishing_accounts a ON a.id=r.publishing_account_id ORDER BY active_strike_points DESC",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_similarity_matches WHERE disposition IN ('review','fraud_hold','infringing') ORDER BY score DESC,created_at DESC LIMIT 500",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_identity_similarity_matches WHERE status='review' ORDER BY similarity_score DESC,created_at DESC LIMIT 500",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT c.*,COUNT(m.account_id) member_count FROM publishing_risk_clusters c LEFT JOIN publishing_risk_cluster_members m ON m.cluster_id=c.id GROUP BY c.id ORDER BY c.risk_score DESC,c.updated_at DESC LIMIT 300",
      )
      .all<any>(),
    db
      .prepare(
        "SELECT notification_type,status,COUNT(*) count FROM rights_notification_jobs GROUP BY notification_type,status ORDER BY notification_type,status",
      )
      .all<any>(),
    db
      .prepare(
        `SELECT e.id,e.declaration_id,e.account_id,e.evidence_type,e.description,e.original_filename,e.mime_type,e.size_bytes,e.sha256,e.scan_status,e.verification_status,e.issued_by,e.issued_at,e.expires_at,e.created_at,d.rights_basis,d.edition_id,d.revision,a.display_name publisher_name FROM publishing_rights_evidence e JOIN publishing_rights_declarations d ON d.id=e.declaration_id JOIN publishing_accounts a ON a.id=e.account_id ORDER BY e.created_at DESC LIMIT 500`,
      )
      .all<any>(),
  ]);
  return {
    disputes: disputes.results,
    notices: notices.results,
    counters: counters.results,
    royaltyHolds: holds.results,
    infringementIncidents: incidents.results,
    repeatInfringerStates: repeatStates.results,
    similarityMatches: similarity.results,
    identityMatches: identityMatches.results,
    riskClusters: clusters.results,
    notificationQueue: notifications.results,
    rightsEvidence: evidence.results,
  };
}

async function publisherRightsSnapshot(db: PublishingDB, userId: string, accountId: string) {
  await member(db, userId, accountId, "analyst");
  const [declarations, evidence, ai, accessibility, disputes, counters, holds] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM publishing_rights_declarations WHERE account_id=? ORDER BY signed_at DESC",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT e.id,e.declaration_id,e.evidence_type,e.description,e.original_filename,e.mime_type,e.size_bytes,e.sha256,e.scan_status,e.verification_status,e.issued_by,e.issued_at,e.expires_at,e.created_at FROM publishing_rights_evidence e WHERE e.account_id=? ORDER BY e.created_at DESC`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_ai_disclosures WHERE account_id=? ORDER BY signed_at DESC")
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT d.* FROM publishing_accessibility_declarations d JOIN publishing_edition_drafts e ON e.id=d.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY d.created_at DESC`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM rights_disputes WHERE publishing_account_id=? ORDER BY created_at DESC",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM copyright_counter_notices WHERE publishing_account_id=? ORDER BY received_at DESC",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare("SELECT * FROM royalty_holds WHERE publishing_account_id=? ORDER BY started_at DESC")
      .bind(accountId)
      .all<any>(),
  ]);
  return {
    rightsDeclarations: declarations.results,
    rightsEvidence: evidence.results,
    aiDisclosures: ai.results,
    accessibilityDeclarations: accessibility.results,
    rightsDisputes: disputes.results,
    counterNotices: counters.results,
    royaltyHolds: holds.results,
  };
}

 return {signPublishingRightsDeclaration,uploadRightsEvidence,assessSubmissionContentPolicy,
  submitCopyrightNotice,validateCopyrightNotice,submitCopyrightCounterNotice,
  validateCopyrightCounterNotice,recordCopyrightCourtAction,resolveRightsDispute,
  manageRepeatInfringerPolicy,reviewRightsEvidence};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- Original QA publishing source is private to leased owner. */
const privatePublishingEditor=(()=>{
type PublishingDB = {
  prepare(sql: string): {
    bind(...values: unknown[]): ReturnType<PublishingDB["prepare"]>;
    first<T = any>(): Promise<T | null>;
    all<T = any>(): Promise<{ results: T[] }>;
    run(): Promise<any>;
  };
  batch(statements: any[]): Promise<unknown>;
};
type PublishingEnv = {
  DB: PublishingDB;
  BUCKET?: {
    get(key: string, options?: any): Promise<any>;
    put(key: string, value: any, options?: any): Promise<any>;
    delete(key: string): Promise<void>;
  };
  FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK?: string;
};

async function recordPublicationActivation(
  db: PublishingDB,
  event: {
    lifecycleId: string;
    publicationVersionId: string;
    fromPublicationVersionId: string | null;
    activationType: "initial" | "update" | "schedule" | "rollback" | "staff";
    actorUserId?: string | null;
    reasonCode: string;
    metadata: unknown;
    at: string;
  },
) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO publishing_publication_activations(id,lifecycle_id,publication_version_id,from_publication_version_id,activation_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      `pva_${await sha256Hex(stableJson({...event,actorUserId:event.actorUserId||null,metadata:event.metadata??null}))}`,
      event.lifecycleId,
      event.publicationVersionId,
      event.fromPublicationVersionId,
      event.activationType,
      event.actorUserId || null,
      event.reasonCode,
      JSON.stringify(event.metadata),
      event.at,
    )
    .run();
}
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const isoOrNull = z.string().datetime().nullable().optional();
const roles = ["owner", "admin", "editor", "finance", "analyst"] as const;
type Role = (typeof roles)[number];
const roleRank: Record<Role, number> = { analyst: 1, editor: 2, finance: 2, admin: 3, owner: 4 };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
async function sha256Hex(bytes: Uint8Array | string) {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input)));
  return [...digest].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function safeJson<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text || "")) as T;
  } catch {
    return fallback;
  }
}
function cleanText(value: unknown, max = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

async function membership(db: PublishingDB, userId: string, accountId: string) {
  return db
    .prepare(
      "SELECT * FROM publishing_account_members WHERE account_id=? AND user_id=? AND status='active'",
    )
    .bind(accountId, userId)
    .first<any>();
}
async function requireRole(db: PublishingDB, userId: string, accountId: string, minimum: Role) {
  const row = await membership(db, userId, accountId);
  if (!row || roleRank[row.role as Role] < roleRank[minimum])
    throw new ApiError(403, "You do not have permission to perform this publishing action.");
  return row;
}
async function editionAccess(
  db: PublishingDB,
  userId: string,
  editionId: string,
  minimum: Role = "analyst",
) {
  const row = await db
    .prepare(
      `SELECT e.*,t.account_id,t.title,t.subtitle,t.description,t.language title_language,t.audience,t.publisher_name,t.imprint_name,t.series_name,t.series_relationship,t.series_position,t.categories_json,t.keywords_json
    FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
    )
    .bind(editionId)
    .first<any>();
  if (!row) throw new ApiError(404, "Publishing edition not found.");
  await requireRole(db, userId, String(row.account_id), minimum);
  return row;
}
async function audit(
  db: PublishingDB,
  accountId: string | null,
  actorUserId: string | null,
  entityType: string,
  entityId: string,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await db
    .prepare(
      "INSERT INTO publishing_audit_events(id,account_id,actor_user_id,entity_type,entity_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      id("pubaudit"),
      accountId,
      actorUserId,
      entityType,
      entityId,
      action,
      JSON.stringify(metadata),
      now(),
    )
    .run();
}

async function ensurePublishingLifecycle(db:PublishingDB,publishingEditionId:string){
 const read=()=>db.prepare("SELECT * FROM publishing_release_lifecycles WHERE publishing_edition_id=?").bind(publishingEditionId).first<any>();
 const prior=await read();if(prior)return prior;
 const edition=await db.prepare("SELECT id,status,created_at FROM publishing_edition_drafts WHERE id=?").bind(publishingEditionId).first<any>();
 if(!edition)throw new ApiError(404,"Publishing edition not found.");
 const state=edition.status==="published"?"live":edition.status==="approved"?"approved":edition.status==="submitted"?"human_review":edition.status==="validating"?"validation":"draft";
 const digest=await sha256Hex(publishingEditionId),lifecycleId="lifecycle_"+digest,at=now();
 try{await db.batch([
   db.prepare("INSERT INTO publishing_release_lifecycles(id,publishing_edition_id,state,owner_update_policy,live_at,created_at,updated_at) SELECT ?,?,?,'auto_update',?,?,? WHERE EXISTS(SELECT 1 FROM publishing_edition_drafts WHERE id=? AND status=?)")
    .bind(lifecycleId,publishingEditionId,state,state==="live"?at:null,edition.created_at||at,at,publishingEditionId,edition.status),
   db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,reason_code,metadata_json,created_at) SELECT ?,?,?,?, 'migration','lifecycle_created','{}',? WHERE EXISTS(SELECT 1 FROM publishing_release_lifecycles WHERE id=?)")
    .bind("lifeevt_"+digest,lifecycleId,null,state,at,lifecycleId)
 ]);}catch(error){const committed=await read();if(committed)return committed;throw error;}
 const committed=await read();if(!committed)throw new ApiError(409,"Publishing edition changed before lifecycle creation.");return committed;
}

const normalLifecycleTransitions: Record<string, Set<string>> = {
  draft: new Set(["draft", "validation", "submitted", "suppressed", "takedown", "retired"]),
  validation: new Set(["validation", "draft", "submitted", "suppressed", "takedown", "retired"]),
  submitted: new Set([
    "automated_review",
    "human_review",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  automated_review: new Set([
    "human_review",
    "approved",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  human_review: new Set([
    "human_review",
    "approved",
    "draft",
    "live",
    "updated",
    "retired",
    "suppressed",
    "takedown",
  ]),
  approved: new Set([
    "approved",
    "scheduled",
    "preorder",
    "live",
    "updated",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  scheduled: new Set([
    "scheduled",
    "preorder",
    "live",
    "updated",
    "draft",
    "suppressed",
    "takedown",
    "retired",
  ]),
  preorder: new Set(["preorder", "live", "updated", "draft", "suppressed", "takedown", "retired"]),
  live: new Set(["live", "updated", "draft", "suppressed", "takedown", "retired"]),
  updated: new Set(["updated", "draft", "suppressed", "takedown", "retired"]),
  suppressed: new Set(["suppressed"]),
  takedown: new Set(["takedown"]),
  retired: new Set(["retired"]),
};

async function transitionPublishingLifecycle(db:PublishingDB,publishingEditionId:string,toState:string,
 triggerType:"publisher"|"automation"|"staff"|"schedule"|"moderation"|"rollback"|"migration",
 actorUserId:string|null,reasonCode="",metadata:Record<string,unknown>={}){
 const lifecycle=await ensurePublishingLifecycle(db,publishingEditionId);
 if(lifecycle.state===toState&&lifecycle.state_reason===reasonCode)return lifecycle;
 if(["suppressed","takedown","retired"].includes(String(lifecycle.state))&&lifecycle.state!==toState)
  throw new ApiError(409,"Terminal publication state requires fresh independently verified reinstatement.");
 const allowed=normalLifecycleTransitions[String(lifecycle.state)];
 if(triggerType!=="moderation"&&triggerType!=="migration"&&(!allowed||!allowed.has(toState)))
  throw new ApiError(409,`Invalid publishing lifecycle transition: ${lifecycle.state} → ${toState}.`);
 const at=now(),column=toState==="scheduled"?"scheduled_at":toState==="preorder"?"preorder_at":
   ["live","updated"].includes(toState)?"live_at":toState==="suppressed"?"suppressed_at":toState==="takedown"?"takedown_at":toState==="retired"?"retired_at":null;
 const eventId="lifeevt_"+await sha256Hex(stableJson([lifecycle.id,lifecycle.state,lifecycle.updated_at,toState,triggerType,actorUserId,reasonCode,metadata]));
 const event=()=>db.prepare("SELECT id FROM publishing_lifecycle_events WHERE id=?").bind(eventId).first<any>();
 const statement=db.prepare(`UPDATE publishing_release_lifecycles SET state=?,state_reason=?,${column?`${column}=COALESCE(${column},?),`:""}updated_at=? WHERE id=? AND state=? AND updated_at=?`)
  .bind(...(column?[toState,reasonCode,at,at,lifecycle.id,lifecycle.state,lifecycle.updated_at]:[toState,reasonCode,at,lifecycle.id,lifecycle.state,lifecycle.updated_at]));
 try{await db.batch([
  db.prepare("INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM publishing_release_lifecycles WHERE id=? AND state=? AND updated_at=?)")
   .bind(eventId,lifecycle.id,lifecycle.state,toState,triggerType,actorUserId,reasonCode,JSON.stringify(metadata),at,lifecycle.id,lifecycle.state,lifecycle.updated_at),
  statement
 ]);}catch(error){if(!await event())throw error;}
 if(!await event())throw new ApiError(409,"Publishing lifecycle changed before this transition committed.");
 return db.prepare("SELECT * FROM publishing_release_lifecycles WHERE id=?").bind(lifecycle.id).first<any>();
}

const accountSchema = z.object({
  id: z.string().max(180).optional(),
  accountType: z.enum(["person", "company"]).default("person"),
  legalName: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),
  contactEmail: z.string().email().or(z.literal("")).default(""),
  website: z.string().url().or(z.literal("")).default(""),
  termsVersion: z.string().max(80).default("fore-publishing-v1"),
  acceptTerms: z.boolean().default(false),
});

async function upsertPublishingAccount(db: PublishingDB, userId: string, raw: unknown) {
  const x = accountSchema.parse(raw),
    at = now();
  if (x.id) {
    await requireRole(db, userId, x.id, "admin");
    await db
      .prepare(
        `UPDATE publishing_accounts SET account_type=?,legal_name=?,display_name=?,country_code=?,contact_email=?,website=?,terms_version=?,terms_accepted_at=CASE WHEN ?=1 THEN COALESCE(terms_accepted_at,?) ELSE terms_accepted_at END,updated_at=? WHERE id=?`,
      )
      .bind(
        x.accountType,
        x.legalName,
        x.displayName,
        x.countryCode,
        x.contactEmail,
        x.website,
        x.termsVersion,
        x.acceptTerms ? 1 : 0,
        at,
        at,
        x.id,
      )
      .run();
    const identityMatches = await scanIdentitySimilarity(db, {
      accountId: x.id,
      subjectType: "publisher_name",
      subjectId: x.id,
      name: x.displayName,
    });
    const riskLinks = await scanAccountRiskLinks(db, x.id);
    await audit(db, x.id, userId, "publishing_account", x.id, "updated", {
      identitySimilarityMatches: identityMatches.length,
      riskLinks: riskLinks.links,
    });
    return {
      id: x.id,
      identitySimilarityMatches: identityMatches.length,
      riskLinks: riskLinks.links,
    };
  }
  const accountId = id("pubacct");
  await db.batch([
    db
      .prepare(
        `INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,contact_email,website,status,terms_version,terms_accepted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?)`,
      )
      .bind(
        accountId,
        x.accountType,
        x.legalName,
        x.displayName,
        x.countryCode,
        x.contactEmail,
        x.website,
        x.termsVersion,
        x.acceptTerms ? at : null,
        at,
        at,
      ),
    db
      .prepare(
        `INSERT INTO publishing_account_members(account_id,user_id,role,status,accepted_at,created_at,updated_at) VALUES(?,?,'owner','active',?,?,?)`,
      )
      .bind(accountId, userId, at, at, at),
  ]);
  const identityMatches = await scanIdentitySimilarity(db, {
    accountId,
    subjectType: "publisher_name",
    subjectId: accountId,
    name: x.displayName,
  });
  const riskLinks = await scanAccountRiskLinks(db, accountId);
  await audit(db, accountId, userId, "publishing_account", accountId, "created", {
    identitySimilarityMatches: identityMatches.length,
    riskLinks: riskLinks.links,
  });
  return {
    id: accountId,
    identitySimilarityMatches: identityMatches.length,
    riskLinks: riskLinks.links,
  };
}

async function savePublishingAddress(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      addressType: z.enum(["legal", "mailing", "tax"]),
      line1: z.string().trim().min(1).max(200),
      line2: z.string().max(200).default(""),
      city: z.string().trim().min(1).max(160),
      region: z.string().max(160).default(""),
      postalCode: z.string().max(40).default(""),
      countryCode: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((v) => v.toUpperCase()),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "admin");
  const at = now();
  const existing = await db
    .prepare("SELECT id FROM publishing_addresses WHERE account_id=? AND address_type=?")
    .bind(x.accountId, x.addressType)
    .first<any>();
  const addressId = existing?.id || id("pubaddr");
  await db
    .prepare(
      `INSERT INTO publishing_addresses(id,account_id,address_type,line1,line2,city,region,postal_code,country_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,address_type) DO UPDATE SET line1=excluded.line1,line2=excluded.line2,city=excluded.city,region=excluded.region,postal_code=excluded.postal_code,country_code=excluded.country_code,updated_at=excluded.updated_at`,
    )
    .bind(
      addressId,
      x.accountId,
      x.addressType,
      x.line1,
      x.line2,
      x.city,
      x.region,
      x.postalCode,
      x.countryCode,
      at,
      at,
    )
    .run();
  await audit(db, x.accountId, userId, "address", addressId, "saved", {
    addressType: x.addressType,
  });
  return { id: addressId };
}

async function savePenName(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      id: z.string().max(180).optional(),
      accountId: z.string().min(1),
      displayName: z.string().trim().min(1).max(220),
      sortName: z.string().max(220).default(""),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "editor");
  const penId = x.id || id("pen"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_pen_names(id,account_id,display_name,sort_name,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,sort_name=excluded.sort_name,updated_at=excluded.updated_at`,
    )
    .bind(penId, x.accountId, x.displayName, x.sortName, at, at)
    .run();
  const identityMatches = await scanIdentitySimilarity(db, {
    accountId: x.accountId,
    subjectType: "pen_name",
    subjectId: penId,
    name: x.displayName,
  });
  await audit(db, x.accountId, userId, "pen_name", penId, x.id ? "updated" : "created", {
    identitySimilarityMatches: identityMatches.length,
  });
  return { id: penId, identitySimilarityMatches: identityMatches.length };
}

async function invitePublishingMember(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      email: z.string().email(),
      role: z.enum(["admin", "editor", "finance", "analyst"]),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "admin");
  const invitationUserId = `invite:${crypto.randomUUID()}`,
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_account_members(account_id,user_id,role,status,invited_email,invited_by_user_id,created_at,updated_at) VALUES(?,?,?,'invited',?,?,?,?)`,
    )
    .bind(x.accountId, invitationUserId, x.role, x.email.toLowerCase(), userId, at, at)
    .run();
  await audit(db, x.accountId, userId, "team_invitation", invitationUserId, "created", {
    role: x.role,
    email: x.email.toLowerCase(),
  });
  return { invitationId: invitationUserId, status: "invited" };
}

async function startIdentityVerification(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      provider: z.string().trim().min(1).max(80).default("external_kyc"),
      providerReference: z.string().max(240).default(""),
      verificationType: z.string().max(80).default("government_id"),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "admin");
  const acct = await db
    .prepare("SELECT legal_name,country_code FROM publishing_accounts WHERE id=?")
    .bind(x.accountId)
    .first<any>();
  if (!acct) throw new ApiError(404, "Publishing account not found.");
  const verificationId = id("kyc"),
    at = now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO publishing_identity_verifications(id,account_id,provider,provider_reference,verification_type,status,country_code,legal_name_snapshot,initiated_at) VALUES(?,?,?,?,?,'pending',?,?,?)`,
      )
      .bind(
        verificationId,
        x.accountId,
        x.provider,
        x.providerReference || verificationId,
        x.verificationType,
        acct.country_code,
        acct.legal_name,
        at,
      ),
    db
      .prepare("UPDATE publishing_accounts SET identity_status='pending',updated_at=? WHERE id=?")
      .bind(at, x.accountId),
  ]);
  await audit(db, x.accountId, userId, "identity_verification", verificationId, "started", {
    provider: x.provider,
  });
  return { id: verificationId, status: "pending", rawIdentityDocumentsStoredByCove: false };
}

async function submitTaxProfile(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      countryCode: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((v) => v.toUpperCase()),
      taxResidencyCountry: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((v) => v.toUpperCase())
        .optional(),
      entityType: z
        .enum([
          "individual",
          "sole_proprietor",
          "partnership",
          "corporation",
          "llc",
          "nonprofit",
          "trust",
          "other",
          "unknown",
        ])
        .default("unknown"),
      taxClassification: z.string().max(120).default(""),
      formType: z.string().max(80).default(""),
      provider: z.string().trim().min(1).max(80).default("external_tax"),
      providerReference: z.string().max(240).default(""),
      treatyCountryCode: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((v) => v.toUpperCase())
        .nullable()
        .optional(),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "finance");
  const profileId = id("tax"),
    at = now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO publishing_tax_profiles(id,account_id,country_code,tax_classification,form_type,provider,provider_reference,status,treaty_country_code,created_at,updated_at,entity_type,tax_residency_country,provider_verification_status,form_status) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,'pending','pending')`,
      )
      .bind(
        profileId,
        x.accountId,
        x.countryCode,
        x.taxClassification,
        x.formType,
        x.provider,
        x.providerReference || profileId,
        x.treatyCountryCode || null,
        at,
        at,
        x.entityType,
        x.taxResidencyCountry || x.countryCode,
      ),
    db
      .prepare("UPDATE publishing_accounts SET tax_status='pending',updated_at=? WHERE id=?")
      .bind(at, x.accountId),
  ]);
  await audit(db, x.accountId, userId, "tax_profile", profileId, "submitted", {
    provider: x.provider,
    country: x.countryCode,
    taxResidencyCountry: x.taxResidencyCountry || x.countryCode,
    entityType: x.entityType,
  });
  await assessPublisherRisk(db, x.accountId, "tax_profile_submitted");
  return { id: profileId, status: "pending", rawTaxIdentifiersStoredByCove: false };
}

async function submitPayoutAccount(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      provider: z.string().trim().min(1).max(80).default("external_payout"),
      providerAccountId: z.string().max(240).default(""),
      method: z.enum(["eft", "ach", "sepa", "wire", "other"]).default("eft"),
      bankCountryCode: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .transform((v) => v.toUpperCase()),
      payoutCurrency: z
        .string()
        .regex(/^[A-Za-z]{3}$/)
        .transform((v) => v.toUpperCase()),
      accountLast4: z
        .string()
        .regex(/^\d{0,4}$/)
        .default(""),
      accountHolderType: z.enum(["individual", "company", "unknown"]).default("unknown"),
      payoutThresholdMinor: z.number().int().min(0).max(10000000).default(5000),
    })
    .parse(raw);
  await requireRole(db, userId, x.accountId, "finance");
  const payoutId = id("payoutacct"),
    at = now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO publishing_payout_accounts(id,account_id,provider,provider_account_id,method,bank_country_code,payout_currency,account_last4,account_holder_type,status,payout_threshold_minor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      )
      .bind(
        payoutId,
        x.accountId,
        x.provider,
        x.providerAccountId || payoutId,
        x.method,
        x.bankCountryCode,
        x.payoutCurrency,
        x.accountLast4,
        x.accountHolderType,
        x.payoutThresholdMinor,
        at,
        at,
      ),
    db
      .prepare("UPDATE publishing_accounts SET payout_status='pending',updated_at=? WHERE id=?")
      .bind(at, x.accountId),
  ]);
  const riskLinks = await scanAccountRiskLinks(db, x.accountId);
  await audit(db, x.accountId, userId, "payout_account", payoutId, "submitted", {
    provider: x.provider,
    currency: x.payoutCurrency,
    bankCountry: x.bankCountryCode,
    riskLinks: riskLinks.links,
  });
  const risk = await assessPublisherRisk(db, x.accountId, "payout_account_submitted");
  return {
    id: payoutId,
    status: "pending",
    rawBankCredentialsStoredByCove: false,
    riskLinks: riskLinks.links,
    risk: { score: risk.score, level: risk.level, action: risk.action },
  };
}

const titleSchema = z.object({
  id: z.string().max(180).optional(),
  accountId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().max(300).default(""),
  description: z.string().max(20000).default(""),
  language: z.string().trim().min(2).max(35).default("en"),
  audience: z
    .enum(["children", "young_adult", "general", "academic", "professional"])
    .default("general"),
  publisherName: z.string().max(240).default(""),
  imprintName: z.string().max(240).default(""),
  seriesName: z.string().max(300).default(""),
  seriesRelationship: z
    .enum(["main", "prequel", "novella", "companion", "boxset", "related"])
    .default("main"),
  seriesPosition: z.number().nullable().optional(),
  categories: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
async function savePublishingTitle(db: PublishingDB, userId: string, raw: unknown) {
  const x = titleSchema.parse(raw);
  await requireRole(db, userId, x.accountId, "editor");
  const titleId = x.id || id("pubtitle"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publishing_titles(id,account_id,title,subtitle,description,language,audience,publisher_name,imprint_name,series_name,series_relationship,series_position,categories_json,keywords_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,subtitle=excluded.subtitle,description=excluded.description,language=excluded.language,audience=excluded.audience,publisher_name=excluded.publisher_name,imprint_name=excluded.imprint_name,series_name=excluded.series_name,series_relationship=excluded.series_relationship,series_position=excluded.series_position,categories_json=excluded.categories_json,keywords_json=excluded.keywords_json,updated_at=excluded.updated_at`,
    )
    .bind(
      titleId,
      x.accountId,
      x.title,
      x.subtitle,
      x.description,
      x.language.toLowerCase(),
      x.audience,
      x.publisherName,
      x.imprintName,
      x.seriesName,
      x.seriesRelationship,
      x.seriesPosition ?? null,
      JSON.stringify(x.categories),
      JSON.stringify(x.keywords),
      at,
      at,
    )
    .run();
  await audit(db, x.accountId, userId, "publishing_title", titleId, x.id ? "updated" : "created");
  return { id: titleId };
}

const territoryScopeSchema = z.object({
  mode: z.enum(["single", "set", "worldwide", "expression"]).default("worldwide"),
  territory: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
  territorySetId: z.string().max(180).optional(),
  include: z
    .array(z.string().regex(/^[A-Za-z]{2}$/))
    .max(300)
    .default([]),
  exclude: z
    .array(z.string().regex(/^[A-Za-z]{2}$/))
    .max(300)
    .default([]),
  includeSetIds: z.array(z.string().max(180)).max(100).default([]),
  excludeSetIds: z.array(z.string().max(180)).max(100).default([]),
});
const editionSchema = z.object({
  id: z.string().max(180).optional(),
  titleId: z.string().min(1),
  format: z.enum(["ebook", "audiobook"]).default("ebook"),
  editionLabel: z.string().max(120).default(""),
  language: z.string().min(2).max(35).default("en"),
  isbn13: z
    .string()
    .regex(/^\d{13}$/)
    .nullable()
    .optional(),
  publisherIdentifier: z.string().max(120).default(""),
  rightsBasis: z.enum(["owned", "licensed", "public_domain"]).default("owned"),
  editionType: z
    .enum([
      "canonical_public_domain",
      "annotated",
      "new_translation",
      "illustrated",
      "scholarly",
      "commercial_audiobook",
      "original",
    ])
    .default("original"),
  differentiationSummary: z.string().max(4000).default(""),
  contractId: z.string().max(180).nullable().optional(),
  contractVersionId: z.string().max(180).nullable().optional(),
  territoryScope: territoryScopeSchema.default({
    mode: "worldwide",
    include: [],
    exclude: [],
    includeSetIds: [],
    excludeSetIds: [],
  }),
  rightsStartAt: isoOrNull,
  rightsEndAt: isoOrNull,
  releaseDate: isoOrNull,
  preorderDate: isoOrNull,
  listCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((v) => v.toUpperCase())
    .default("USD"),
  listPriceMinor: z.number().int().min(0).max(100000000).default(0),
  drmRequirement: z.enum(["none", "watermark", "lcp", "adobe_acs"]).default("none"),
  downloadable: z.boolean().default(true),
  subscriptionPermitted: z.boolean().default(false),
  libraryPermitted: z.boolean().default(false),
  salesChannels: z
    .array(z.enum(["retail", "subscription", "library"]))
    .min(1)
    .max(3)
    .default(["retail"]),
  contributors: z
    .array(
      z.object({
        penNameId: z.string().max(180).nullable().optional(),
        displayName: z.string().trim().min(1).max(220),
        role: z.enum(["author", "editor", "translator", "illustrator", "narrator", "other"]),
        position: z.number().int().min(0).max(1000).default(0),
      }),
    )
    .max(50)
    .default([]),
});
async function savePublishingEdition(db: PublishingDB, userId: string, raw: unknown) {
  const x = editionSchema.parse(raw);
  const title = await db
    .prepare("SELECT * FROM publishing_titles WHERE id=?")
    .bind(x.titleId)
    .first<any>();
  if (!title) throw new ApiError(404, "Publishing title not found.");
  await requireRole(db, userId, String(title.account_id), "editor");
  if (x.rightsStartAt && x.rightsEndAt && x.rightsEndAt <= x.rightsStartAt)
    throw new ApiError(400, "Rights end date must follow the start date.");
  if (x.preorderDate && x.releaseDate && x.preorderDate > x.releaseDate)
    throw new ApiError(400, "Preorder date cannot be after release date.");
  if (x.contractVersionId && !x.contractId)
    throw new ApiError(400, "A contract version requires a distribution contract.");
  if (x.contractId) {
    const assignment = await db
      .prepare(
        "SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)",
      )
      .bind(title.account_id, x.contractId, now(), now())
      .first<any>();
    if (!assignment)
      throw new ApiError(
        403,
        "That distribution contract is not actively assigned to this publishing organization.",
      );
    if (x.contractVersionId) {
      const v = await db
        .prepare(
          "SELECT 1 ok FROM rights_contract_versions WHERE id=? AND contract_id=? AND status='active'",
        )
        .bind(x.contractVersionId, x.contractId)
        .first<any>();
      if (!v)
        throw new ApiError(400, "The selected contract version is not active for that contract.");
    }
  }
  const editionId = x.id || id("pubed"),
    at = now();
  const existing = x.id
    ? await db
        .prepare(
          "SELECT id,status,revision FROM publishing_edition_drafts WHERE id=? AND title_id=?",
        )
        .bind(x.id, x.titleId)
        .first<any>()
    : null;
  if (x.id && !existing) throw new ApiError(404, "Publishing edition not found.");
  if (existing && ["submitted", "approved", "published"].includes(String(existing.status)))
    throw new ApiError(
      409,
      "Create a new revision before changing a submitted or published edition.",
    );
  const nextRevision =
    existing?.status === "changes_requested"
      ? Number(existing.revision || 1) + 1
      : Number(existing?.revision || 1);
  const nextStatus =
    existing?.status === "changes_requested" ? "draft" : existing?.status || "draft";
  const statements: any[] = [
    db
      .prepare(
        `INSERT INTO publishing_edition_drafts(id,title_id,format,edition_label,language,isbn13,publisher_identifier,rights_basis,edition_type,differentiation_summary,contract_id,contract_version_id,territory_scope_json,rights_start_at,rights_end_at,release_date,preorder_date,list_currency,list_price_minor,drm_requirement,downloadable,subscription_permitted,library_permitted,sales_channels_json,status,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET format=excluded.format,edition_label=excluded.edition_label,language=excluded.language,isbn13=excluded.isbn13,publisher_identifier=excluded.publisher_identifier,rights_basis=excluded.rights_basis,edition_type=excluded.edition_type,differentiation_summary=excluded.differentiation_summary,contract_id=excluded.contract_id,contract_version_id=excluded.contract_version_id,territory_scope_json=excluded.territory_scope_json,rights_start_at=excluded.rights_start_at,rights_end_at=excluded.rights_end_at,release_date=excluded.release_date,preorder_date=excluded.preorder_date,list_currency=excluded.list_currency,list_price_minor=excluded.list_price_minor,drm_requirement=excluded.drm_requirement,downloadable=excluded.downloadable,subscription_permitted=excluded.subscription_permitted,library_permitted=excluded.library_permitted,sales_channels_json=excluded.sales_channels_json,status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at`,
      )
      .bind(
        editionId,
        x.titleId,
        x.format,
        x.editionLabel,
        x.language.toLowerCase(),
        x.isbn13 || null,
        x.publisherIdentifier,
        x.rightsBasis,
        x.editionType,
        x.differentiationSummary,
        x.contractId || null,
        x.contractVersionId || null,
        JSON.stringify({
          ...x.territoryScope,
          include: x.territoryScope.include.map((v) => v.toUpperCase()),
          exclude: x.territoryScope.exclude.map((v) => v.toUpperCase()),
          territory: x.territoryScope.territory?.toUpperCase(),
        }),
        x.rightsStartAt || null,
        x.rightsEndAt || null,
        x.releaseDate || null,
        x.preorderDate || null,
        x.listCurrency,
        x.listPriceMinor,
        x.drmRequirement,
        x.downloadable ? 1 : 0,
        x.subscriptionPermitted ? 1 : 0,
        x.libraryPermitted ? 1 : 0,
        JSON.stringify(x.salesChannels),
        nextStatus,
        nextRevision,
        at,
        at,
      ),
    db.prepare("DELETE FROM publishing_edition_contributors WHERE edition_id=?").bind(editionId),
  ];
  x.contributors.forEach((c) =>
    statements.push(
      db
        .prepare(
          "INSERT INTO publishing_edition_contributors(edition_id,pen_name_id,display_name,role,position) VALUES(?,?,?,?,?)",
        )
        .bind(editionId, c.penNameId || null, c.displayName, c.role, c.position),
    ),
  );
  await db.batch(statements);
  await ensurePublishingLifecycle(db, editionId);
  await transitionPublishingLifecycle(
    db,
    editionId,
    "draft",
    "publisher",
    userId,
    x.id ? "draft_updated" : "draft_created",
  );
  await audit(
    db,
    String(title.account_id),
    userId,
    "publishing_edition",
    editionId,
    x.id ? "updated" : "created",
  );
  return { id: editionId };
}

function publishingChecks(kind: string, format: string) {
  if (kind === "cover")
    return [
      ["malware", true, "external"],
      ["cover", true, "inline"],
      ["images", true, "inline"],
      ["render", true, "external"],
      ["duplicate", false, "inline"],
    ] as const;
  if (kind === "manuscript" && format === "ebook")
    return [
      ["malware", true, "external"],
      ["archive_safety", true, "inline"],
      ["epubcheck", true, "external"],
      ["metadata", true, "inline"],
      ["images", false, "inline"],
      ["navigation", true, "inline"],
      ["links", true, "inline"],
      ["fonts", false, "inline"],
      ["fixed_layout", false, "inline"],
      ["accessibility", false, "inline"],
      ["render", true, "external"],
      ["device_compatibility", true, "external"],
      ["duplicate", true, "inline"],
    ] as const;
  if (kind === "audio")
    return [
      ["malware", true, "external"],
      ["audio_integrity", true, "external"],
      ["duplicate", true, "inline"],
    ] as const;
  return [
    ["malware", true, "external"],
    ["duplicate", false, "inline"],
  ] as const;
}

function imageDimensions(bytes: Uint8Array, mime: string) {
  if (
    mime === "image/png" &&
    bytes.length >= 24 &&
    String.fromCharCode(...bytes.slice(1, 4)) === "PNG"
  ) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if ((mime === "image/jpeg" || mime === "image/jpg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = bytes[p + 1],
        len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      )
        return {
          height: (bytes[p + 5] << 8) | bytes[p + 6],
          width: (bytes[p + 7] << 8) | bytes[p + 8],
        };
      if (len < 2) break;
      p += 2 + len;
    }
  }
  return null;
}

async function inspectEpub(bytes: Uint8Array) {
  const issues: { code: string; severity: "warning" | "error"; message: string }[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ApiError(400, "The manuscript is not a readable EPUB archive.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > 10000)
    throw new ApiError(413, "The EPUB contains too many archive entries.");
  let expanded = 0;
  for (const f of entries) expanded += Number((f as any)._data?.uncompressedSize || 0);
  if (expanded > 500 * 1024 * 1024 || (bytes.byteLength && expanded / bytes.byteLength > 120))
    throw new ApiError(413, "The EPUB expands beyond Cove's archive-safety limits.");
  const mimetype = await zip.file("mimetype")?.async("string");
  if (mimetype?.trim() !== "application/epub+zip")
    issues.push({
      code: "MIMETYPE",
      severity: "error",
      message: "EPUB mimetype entry is missing or invalid.",
    });
  if (zip.file("META-INF/encryption.xml"))
    issues.push({
      code: "ENCRYPTED",
      severity: "error",
      message: "Encrypted/DRM EPUB uploads are not accepted as source manuscripts.",
    });
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const rootfile = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!rootfile)
    issues.push({ code: "CONTAINER", severity: "error", message: "EPUB package path is missing." });
  const opf = (rootfile ? await zip.file(rootfile)?.async("string") : "") || "";
  if (!opf)
    issues.push({ code: "OPF", severity: "error", message: "EPUB package document is missing." });
  const cleanText = (v: string) =>
    v
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  const metaValues = (property: string) =>
    Array.from(
      opf.matchAll(
        new RegExp(
          `<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, "\\// QA-leased worker queues. All job ownership and retry transitions")}["'][^>]*>([\\s\\S]*?)<\\/meta>|<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, "\\// QA-leased worker queues. All job ownership and retry transitions")}["'][^>]+content=["']([^"']*)["'][^>]*\\/?\\s*>`,
          "gi",
        ),
      ),
    )
      .map((m) => cleanText(m[1] || m[2] || ""))
      .filter(Boolean);
  const title = cleanText(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || "");
  const language = cleanText(opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1] || "");
  const packageVersion = opf.match(/<package\b[^>]*\bversion=["']([^"']+)["']/i)?.[1] || "";
  if (!title)
    issues.push({
      code: "METADATA_TITLE",
      severity: "error",
      message: "EPUB metadata has no title.",
    });
  if (!language)
    issues.push({
      code: "METADATA_LANGUAGE",
      severity: "warning",
      message: "EPUB metadata has no primary language.",
    });
  const hasNav = /properties\s*=\s*["'][^"']*\bnav\b/i.test(opf),
    hasNcx = /media-type\s*=\s*["']application\/x-dtbncx\+xml/i.test(opf);
  if (!hasNav && !hasNcx)
    issues.push({
      code: "NAV",
      severity: "error",
      message: "EPUB has no navigation document or NCX.",
    });
  const renditionLayout =
      metaValues("rendition:layout")[0] ||
      (/name=["']fixed-layout["'][^>]+content=["']true["']/i.test(opf)
        ? "pre-paginated"
        : "reflowable"),
    fixed = renditionLayout === "pre-paginated";
  const pageProgression = (
    opf.match(/page-progression-direction=["'](ltr|rtl|default)["']/i)?.[1] ||
    metaValues("page-progression-direction")[0] ||
    "default"
  ).toLowerCase();
  const primaryWritingMode = (
    metaValues("primary-writing-mode")[0] ||
    metaValues("rendition:orientation")[0] ||
    "horizontal-tb"
  ).toLowerCase();
  const accessModes = [
    ...new Set(metaValues("schema:accessMode").concat(metaValues("accessMode"))),
  ];
  const accessibilityFeatures = [
    ...new Set(
      metaValues("schema:accessibilityFeature").concat(metaValues("accessibilityFeature")),
    ),
  ];
  const accessibilityHazards = [
    ...new Set(metaValues("schema:accessibilityHazard").concat(metaValues("accessibilityHazard"))),
  ];
  const accessModeSufficient = [
    ...new Set(
      metaValues("schema:accessModeSufficient").concat(metaValues("accessModeSufficient")),
    ),
  ];
  const accessibilitySummary =
    metaValues("schema:accessibilitySummary")[0] || metaValues("accessibilitySummary")[0] || "";
  const conformsTo = [
    ...new Set(metaValues("dcterms:conformsTo").concat(metaValues("schema:conformsTo"))),
  ];
  const certifier = metaValues("a11y:certifiedBy")[0] || metaValues("schema:certifiedBy")[0] || "";
  const certifierCredential = metaValues("a11y:certifierCredential")[0] || "",
    certifierReport = metaValues("a11y:certifierReport")[0] || "",
    certificationDate = metaValues("dcterms:modified")[0] || "";
  const fonts = entries.filter((f) => /\.(woff2?|ttf|otf)$/i.test(f.name)).map((f) => f.name);
  const cssFiles = entries.filter((f) => /\.css$/i.test(f.name) && !f.dir).slice(0, 250);
  let cssText = "";
  for (const f of cssFiles) {
    if (cssText.length > 750000) break;
    cssText += (await f.async("string")).slice(0, 100000);
  }
  const htmlFiles = entries
    .filter((f) => /\.(xhtml|html|htm)$/i.test(f.name) && !f.dir)
    .slice(0, 1200);
  let broken = 0,
    images = 0,
    missingAlt = 0,
    emptyAlt = 0,
    headings = 0,
    headingJumps = 0,
    tables = 0,
    tablesWithoutHeaders = 0,
    mathml = 0,
    svg = 0,
    svgMissingTextAlternative = 0,
    footnotes = 0,
    endnotes = 0,
    pagebreaks = 0,
    langNodes = 0,
    remoteResources = 0,
    scriptedContent = 0,
    fingerprintTextSize = 0;
  const fingerprintTextParts: string[] = [];
  let previousHeading = 0,
    oversizedImages = false;
  const normalize = (base: string, ref: string) => {
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(ref)) return null;
    const clean = ref.split("#")[0].split("?")[0];
    if (!clean) return null;
    const stack = base.split("/").slice(0, -1);
    for (const part of clean.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(decodeURIComponent(part));
    }
    return stack.join("/");
  };
  for (const file of htmlFiles) {
    const text = await file.async("string");
    if (fingerprintTextSize < 500000) {
      const chunk = text.slice(0, Math.min(50000, 500000 - fingerprintTextSize));
      fingerprintTextParts.push(chunk);
      fingerprintTextSize += chunk.length;
    }
    for (const m of text.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const p = normalize(file.name, m[1]);
      if (p && !zip.file(p)) broken++;
    }
    for (const m of text.matchAll(
      /<(img|audio|video|source|link|iframe|object|embed|image)\b[^>]*(?:src|href|xlink:href)\s*=\s*["']([^"']+)["'][^>]*>/gi,
    ))
      if (/^(?:https?:)?\/\//i.test(m[2])) remoteResources++;
    scriptedContent += (text.match(/<script\b/gi) || []).length;
    for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
      images++;
      const tag = m[0],
        alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
      if (!alt) missingAlt++;
      else if (!alt[1].trim()) emptyAlt++;
      const w = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || 0),
        h = Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || 0);
      if (w > 5000 || h > 5000) oversizedImages = true;
    }
    for (const m of text.matchAll(/<h([1-6])\b/gi)) {
      const level = Number(m[1]);
      headings++;
      if (previousHeading && level > previousHeading + 1) headingJumps++;
      previousHeading = level;
    }
    for (const m of text.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
      tables++;
      if (!/<th\b/i.test(m[0])) tablesWithoutHeaders++;
    }
    mathml += (text.match(/<math\b/gi) || []).length;
    svg += (text.match(/<svg\b/gi) || []).length;
    for (const m of text.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
      const node = m[0];
      if (
        !/aria-hidden\s*=\s*["']true["']/i.test(node) &&
        !/(?:aria-label|aria-labelledby)\s*=/i.test(node) &&
        !/<(?:title|desc)\b/i.test(node)
      )
        svgMissingTextAlternative++;
    }
    footnotes += (text.match(/epub:type=["'][^"']*\bfootnote\b/gi) || []).length;
    endnotes += (text.match(/epub:type=["'][^"']*\bendnote\b/gi) || []).length;
    pagebreaks += (text.match(/epub:type=["'][^"']*\bpagebreak\b/gi) || []).length;
    langNodes += (text.match(/(?:xml:lang|\blang)=["'][^"']+["']/gi) || []).length;
  }
  remoteResources +=
    (cssText.match(/url\(\s*["']?(?:https?:)?\/\//gi) || []).length +
    (cssText.match(/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//gi) || []).length;
  const mediaOverlays = /media-overlay\s*=/i.test(opf),
    dictionaryContent =
      /<dc:type[^>]*>\s*dictionary\s*<\/dc:type>/i.test(opf) ||
      /epub:type=["'][^"']*\bdictionary\b/i.test(fingerprintTextParts.join("\n"));
  const verticalWriting =
      /writing-mode\s*:\s*(vertical|tb-|sideways)/i.test(cssText) ||
      /^vertical/.test(primaryWritingMode),
    rtl = pageProgression === "rtl" || /direction\s*:\s*rtl/i.test(cssText);
  const complexCss =
    /(position\s*:\s*(absolute|fixed)|transform\s*:|columns?\s*:|float\s*:|writing-mode\s*:|shape-outside\s*:)/i.test(
      cssText,
    );
  if (broken)
    issues.push({
      code: "BROKEN_LINKS",
      severity: "error",
      message: `${broken} internal EPUB references could not be resolved.`,
    });
  if (remoteResources)
    issues.push({
      code: "REMOTE_RESOURCES",
      severity: "error",
      message: `${remoteResources} remote resource reference${remoteResources === 1 ? "" : "s"} would require network access while reading. Package required assets inside the EPUB.`,
    });
  if (scriptedContent)
    issues.push({
      code: "SCRIPTED_CONTENT",
      severity: "error",
      message: `${scriptedContent} scripted content reference${scriptedContent === 1 ? "" : "s"} detected. Cove strips executable EPUB scripting for reader security; publish a non-scripted fallback edition.`,
    });
  if (missingAlt)
    issues.push({
      code: "MISSING_ALT",
      severity: "warning",
      message: `${missingAlt} images do not declare alt text.`,
    });
  if (svgMissingTextAlternative)
    issues.push({
      code: "SVG_TEXT_ALTERNATIVE",
      severity: "warning",
      message: `${svgMissingTextAlternative} inline SVG graphic${svgMissingTextAlternative === 1 ? "" : "s"} lack a title, description, ARIA label, or explicit decorative marker.`,
    });
  if (!headings && htmlFiles.length > 1)
    issues.push({
      code: "HEADING_STRUCTURE",
      severity: "warning",
      message: "No semantic heading elements were detected across the EPUB content documents.",
    });
  if (headingJumps)
    issues.push({
      code: "HEADING_STRUCTURE",
      severity: "warning",
      message: `${headingJumps} heading transitions skip a semantic level.`,
    });
  if (tablesWithoutHeaders)
    issues.push({
      code: "TABLE_SEMANTICS",
      severity: "warning",
      message: `${tablesWithoutHeaders} tables do not contain header cells.`,
    });
  const claimedConformance = conformsTo.some((v) => /EPUB Accessibility|wcag/i.test(v));
  const requiredAccessibilityMetadata =
    accessModes.length > 0 && accessibilityFeatures.length > 0 && accessibilityHazards.length > 0;
  if (!requiredAccessibilityMetadata)
    issues.push({
      code: "ACCESSIBILITY_METADATA",
      severity: claimedConformance ? "error" : "warning",
      message:
        "EPUB accessibility discoverability metadata is incomplete (accessMode, accessibilityFeature, accessibilityHazard).",
    });
  if (claimedConformance && (missingAlt || headingJumps || tablesWithoutHeaders || !language))
    issues.push({
      code: "ACCESSIBILITY_CONFORMANCE_MISMATCH",
      severity: "error",
      message:
        "The EPUB claims accessibility conformance but Cove detected unresolved structural/accessibility issues.",
    });
  const altTextComplete = missingAlt === 0 && svgMissingTextAlternative === 0,
    semanticStructure = headings > 0 && headingJumps === 0,
    tableSemantics = tablesWithoutHeaders === 0;
  const mathmlDeclaredAccessible =
    mathml > 0 && accessibilityFeatures.some((v) => /^mathml$/i.test(v.trim()));
  if (mathml > 0 && !mathmlDeclaredAccessible)
    issues.push({
      code: "MATHML_DISCLOSURE",
      severity: "warning",
      message:
        "MathML is present, but the EPUB accessibility metadata does not declare the MathML accessibility feature.",
    });
  const nonvisualReading =
    fixed && images > 0 && !altTextComplete
      ? "not_supported"
      : altTextComplete && semanticStructure && !!language
        ? "supported"
        : "partial";
  const visualAdjustments = fixed ? "not_supported" : "supported";
  const validationStatus = issues.some((i) => i.severity === "error")
    ? "failed"
    : issues.length
      ? "warning"
      : "passed";
  const accessibility = {
    visualAdjustments,
    nonvisualReading,
    primaryLanguageDeclared: !!language,
    readingOrderVerified: (hasNav || hasNcx) && broken === 0,
    altTextComplete,
    semanticStructure,
    tableSemanticsComplete: tableSemantics,
    mathmlPresent: mathml > 0,
    mathmlAccessible: mathmlDeclaredAccessible,
    accessibilityNavigation: hasNav,
    pageNavigation: pagebreaks > 0,
    accessModes,
    accessModeSufficient,
    features: accessibilityFeatures,
    hazards: accessibilityHazards,
    conformsTo,
    summary: accessibilitySummary,
    certification: {
      certifier,
      credential: certifierCredential,
      report: certifierReport,
      date: certificationDate,
    },
    validationPolicyVersion: "fore-epub-accessibility-v1",
    validationStatus,
  };
  const compatibilityClass:
    | "reflowable_standard"
    | "reflowable_complex"
    | "fixed_layout"
    | "comic_manga"
    | "picture_book"
    | "dictionary"
    | "unknown" = dictionaryContent
    ? "dictionary"
    : fixed
      ? images > Math.max(8, htmlFiles.length / 2)
        ? "comic_manga"
        : "fixed_layout"
      : complexCss || verticalWriting
        ? "reflowable_complex"
        : "reflowable_standard";
  const warnings: string[] = [];
  if (fixed)
    warnings.push(
      "Fixed-layout content does not support Cove text-size or line-spacing overrides.",
    );
  if (verticalWriting)
    warnings.push("Vertical writing relies on publisher CSS and may vary by browser engine.");
  if (mediaOverlays)
    warnings.push(
      "Embedded EPUB media overlays are detected but Cove uses its separate audiobook/Biosync system for synchronized audio.",
    );
  if (oversizedImages) warnings.push("Oversized images are scaled in reflowable reading mode.");
  if (dictionaryContent)
    warnings.push(
      "Dictionary semantics are preserved, but Cove does not yet provide a dedicated dictionary lookup/navigation mode.",
    );
  if (complexCss)
    warnings.push(
      "Complex publisher CSS is preserved where safe and may render differently across browser engines.",
    );
  if (remoteResources)
    warnings.push(
      "Remote resource dependencies are not supported for commercial publication or offline reading.",
    );
  if (scriptedContent)
    warnings.push("Executable EPUB scripting is not supported and is stripped by the Cove reader.");
  const readerSupport =
    remoteResources || scriptedContent
      ? "unsupported"
      : mediaOverlays || fixed || verticalWriting || dictionaryContent || complexCss
        ? "supported_with_limits"
        : "full";
  const formatProfile = {
    epubVersion: packageVersion.startsWith("2")
      ? "EPUB 2"
      : packageVersion.startsWith("3")
        ? "EPUB 3"
        : "EPUB",
    packageVersion,
    navigationType: hasNav && hasNcx ? "both" : hasNav ? "epub3_nav" : hasNcx ? "ncx" : "unknown",
    renditionLayout,
    pageProgressionDirection: pageProgression,
    writingMode: verticalWriting
      ? primaryWritingMode.startsWith("vertical")
        ? primaryWritingMode
        : "vertical-rl"
      : "horizontal-tb",
    rtl,
    verticalWriting,
    complexCss,
    embeddedFonts: fonts.length > 0,
    svg: svg > 0,
    mathml: mathml > 0,
    complexTables: tables > 0,
    footnotes: footnotes > 0,
    endnotes: endnotes > 0,
    dictionaryContent,
    mediaOverlays,
    oversizedImages,
    accessibilityNavigation: hasNav,
    compatibilityClass,
    readerSupport,
    features: {
      fontCount: fonts.length,
      imageCount: images,
      htmlFileCount: htmlFiles.length,
      tableCount: tables,
      mathmlCount: mathml,
      svgCount: svg,
      svgMissingTextAlternativeCount: svgMissingTextAlternative,
      footnoteCount: footnotes,
      endnoteCount: endnotes,
      pagebreakCount: pagebreaks,
      langNodeCount: langNodes,
      remoteResourceCount: remoteResources,
      scriptedContentCount: scriptedContent,
    },
    warnings,
  };
  return {
    zip,
    expandedBytes: expanded,
    metadata: {
      title,
      language,
      packageVersion,
      fixedLayout: fixed,
      accessibilityMetadata: requiredAccessibilityMetadata,
      fontCount: fonts.length,
      imageCount: images,
      brokenInternalReferences: broken,
      missingAlt,
      emptyAlt,
      accessibility,
      formatProfile,
    },
    fingerprintText: fingerprintTextParts.join("\n").slice(0, 500000),
    issues,
  };
}

async function readBoundedPublishingUpload(request: Request, limit: number) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > limit) throw new ApiError(413, "This publishing asset exceeds the upload limit.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) throw new ApiError(413, "This publishing asset exceeds the upload limit.");
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}
function publishingUploadLimit(kind: string) {
  return kind === "audio"
    ? 750 * 1024 * 1024
    : kind === "manuscript"
      ? 150 * 1024 * 1024
      : kind === "cover"
        ? 25 * 1024 * 1024
        : 100 * 1024 * 1024;
}

async function recordInlineResult(
  db: PublishingDB,
  jobId: string,
  versionId: string,
  check: string,
  status: "passed" | "warning" | "failed" | "blocked",
  issues: any[] = [],
  validator = "fore-inline",
  version = "1",
) {
  const at = now();
  await db.batch([
    db
      .prepare(
        "UPDATE publishing_validation_jobs SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE id=?",
      )
      .bind(
        status,
        status === "failed" || status === "blocked"
          ? cleanText(issues[0]?.message || "Validation failed", 1000)
          : "",
        at,
        jobId,
      ),
    db
      .prepare(
        "INSERT INTO publishing_validation_results(id,job_id,asset_version_id,check_type,validator_name,validator_version,status,issue_count,issues_json,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id("pubval"),
        jobId,
        versionId,
        check,
        validator,
        version,
        status,
        issues.length,
        JSON.stringify(issues),
        at,
      ),
  ]);
}

async function refreshAssetValidationSummary(db: PublishingDB, assetVersionId: string) {
  const jobs = (
    await db
      .prepare("SELECT status,required FROM publishing_validation_jobs WHERE asset_version_id=?")
      .bind(assetVersionId)
      .all<any>()
  ).results;
  const required = jobs.filter((j) => Number(j.required) === 1);
  let summary = "pending",
    quarantine = "quarantined";
  if (required.some((j) => ["failed", "blocked"].includes(String(j.status)))) {
    summary = "blocked";
    quarantine = "rejected";
  } else if (required.some((j) => ["queued", "leased"].includes(String(j.status)))) {
    summary = required.some((j) => String(j.status) === "leased") ? "running" : "pending";
    quarantine = "scanning";
  }
  else if (required.every((j) => String(j.status) === "passed")) {
    summary = jobs.some((j) => String(j.status) === "warning") ? "warning" : "passed";
    quarantine = "clean";
  } else summary = "blocked";
  await db
    .prepare(
      "UPDATE publishing_asset_versions SET validation_summary=?,quarantine_status=? WHERE id=?",
    )
    .bind(summary, quarantine, assetVersionId)
    .run();
  return { summary, quarantine };
}

async function uploadPublishingAsset(
  env: PublishingEnv,
  userId: string,
  input: { editionId: string; kind: string; filename: string; mimeType: string; bytes: Uint8Array },
) {
  if (!env.BUCKET) throw new ApiError(503, "Publishing asset storage is not configured.");
  const edition = await editionAccess(env.DB, userId, input.editionId, "editor");
  const kind = z.enum(["manuscript", "cover", "supplement", "audio"]).parse(input.kind);
  if (!["draft", "changes_requested"].includes(String(edition.status)))
    throw new ApiError(409, "Open a new publishing revision before replacing production assets.");
  if (!input.bytes.byteLength) throw new ApiError(400, "The uploaded file is empty.");
  if (input.bytes.byteLength > publishingUploadLimit(kind))
    throw new ApiError(413, "This publishing asset exceeds the upload limit.");
  const mime = cleanText(input.mimeType || "application/octet-stream", 120).toLowerCase();
  if (
    kind === "manuscript" &&
    edition.format === "ebook" &&
    !(mime === "application/epub+zip" || input.filename.toLowerCase().endsWith(".epub"))
  )
    throw new ApiError(
      415,
      "Cove Publishing currently accepts EPUB source manuscripts for eBooks.",
    );
  if (kind === "cover" && !["image/jpeg", "image/png"].includes(mime))
    throw new ApiError(415, "Cover artwork must be JPEG or PNG.");
  const digest = await sha256Hex(input.bytes),
    at = now();
  const asset = await env.DB.prepare(
    "SELECT * FROM publishing_assets WHERE edition_id=? AND kind=?",
  )
    .bind(input.editionId, kind)
    .first<any>();
  const assetId = asset?.id || id("pubasset"),
    previousCount = Number(
      (
        await env.DB.prepare(
          "SELECT max(version_number) n FROM publishing_asset_versions WHERE asset_id=?",
        )
          .bind(assetId)
          .first<any>()
      )?.n || 0,
    ),
    versionNumber = previousCount + 1,
    versionId = id("pubassetv");
  const ext =
    kind === "cover"
      ? mime === "image/png"
        ? "png"
        : "jpg"
      : kind === "manuscript"
        ? "epub"
        : input.filename
            .split(".")
            .pop()
            ?.replace(/[^a-zA-Z0-9]/g, "")
            .slice(0, 8) || "bin";
  const objectKey = `publishing/quarantine/${edition.account_id}/${input.editionId}/${assetId}/${versionId}/source.${ext}`;
  let metadata: Record<string, unknown> = {};
  let fingerprintText = "";
  if (kind === "manuscript" && edition.format === "ebook") {
    const result = await inspectEpub(input.bytes);
    metadata = result.metadata;
    fingerprintText = result.fingerprintText;
  }
  if (kind === "cover") {
    const dims = imageDimensions(input.bytes, mime);
    if (!dims) throw new ApiError(400, "Cove could not read the cover image dimensions.");
    metadata = dims;
    if (dims.width < 1000 || dims.height < 1400)
      metadata.coverWarning = "Cover is below Cove's recommended production dimensions.";
    if (dims.height <= dims.width)
      throw new ApiError(400, "Book cover artwork must be portrait-oriented.");
  }
  await env.BUCKET.put(objectKey, input.bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { sha256: digest, source: "fore-publishing-quarantine" },
  });
  const checks = publishingChecks(kind, String(edition.format));
  const jobs = checks.map(([check, required, execution]) => ({
    jobId: id("pubjob"),
    check,
    required,
    execution,
  }));
  try {
    const statements: any[] = [];
    if (!asset)
      statements.push(
        env.DB.prepare(
          "INSERT INTO publishing_assets(id,edition_id,kind,required,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ).bind(
          assetId,
          input.editionId,
          kind,
          ["manuscript", "cover"].includes(kind) ? 1 : 0,
          at,
          at,
        ),
      );
    statements.push(
      env.DB.prepare(
        "INSERT INTO publishing_asset_versions(id,asset_id,version_number,object_key,original_filename,mime_type,size_bytes,sha256,quarantine_status,extracted_metadata_json,validation_summary,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?, 'quarantined',?,'pending',?,?)",
      ).bind(
        versionId,
        assetId,
        versionNumber,
        objectKey,
        cleanText(input.filename, 240),
        mime,
        input.bytes.byteLength,
        digest,
        JSON.stringify(metadata),
        userId,
        at,
      ),
    );
    statements.push(
      env.DB.prepare(
        "UPDATE publishing_assets SET current_version_id=?,updated_at=? WHERE id=?",
      ).bind(versionId, at, assetId),
    );
    for (const j of jobs)
      statements.push(
        env.DB.prepare(
          "INSERT INTO publishing_validation_jobs(id,asset_version_id,check_type,required,execution_class,status,priority,available_at,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,'queued',100,?,?,?,?)",
        ).bind(
          j.jobId,
          versionId,
          j.check,
          j.required ? 1 : 0,
          j.execution,
          at,
          `${versionId}:${j.check}:v1`,
          at,
          at,
        ),
      );
    await env.DB.batch(statements);
  } catch (e) {
    await env.BUCKET.delete(objectKey);
    throw e;
  }
  // Run cheap deterministic checks immediately. Production-only services remain queued and fail closed.
  let epubInspection: Awaited<ReturnType<typeof inspectEpub>> | null = null;
  if (kind === "manuscript" && edition.format === "ebook") {
    epubInspection = await inspectEpub(input.bytes);
    await env.DB.prepare(
      "INSERT INTO publishing_epub_inspections(asset_version_id,inspection_version,metadata_json,accessibility_json,format_profile_json,issue_summary_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        versionId,
        "fore-epub-inspection-v1",
        JSON.stringify(epubInspection.metadata),
        JSON.stringify(epubInspection.metadata.accessibility),
        JSON.stringify(epubInspection.metadata.formatProfile),
        JSON.stringify(epubInspection.issues),
        at,
      )
      .run();
  }
  for (const j of jobs.filter((j) => j.execution === "inline")) {
    let status: "passed" | "warning" | "failed" = "passed",
      issues: any[] = [];
    if (j.check === "archive_safety") {
      issues = epubInspection?.issues.filter((i) => i.code === "SCRIPTED_CONTENT") || [];
      status = issues.some((i) => i.severity === "error") ? "failed" : "passed";
    } else if (j.check === "metadata") {
      issues =
        epubInspection?.issues.filter(
          (i) =>
            i.code.startsWith("METADATA") ||
            ["MIMETYPE", "CONTAINER", "OPF", "ENCRYPTED"].includes(i.code),
        ) || [];
      status = issues.some((i) => i.severity === "error")
        ? "failed"
        : issues.length
          ? "warning"
          : "passed";
    } else if (j.check === "navigation") {
      issues = epubInspection?.issues.filter((i) => i.code === "NAV") || [];
      status = issues.length ? "failed" : "passed";
    } else if (j.check === "links") {
      issues =
        epubInspection?.issues.filter((i) =>
          ["BROKEN_LINKS", "REMOTE_RESOURCES"].includes(i.code),
        ) || [];
      status = issues.some((i) => i.severity === "error")
        ? "failed"
        : issues.length
          ? "warning"
          : "passed";
    } else if (j.check === "accessibility") {
      issues =
        epubInspection?.issues.filter((i) =>
          [
            "MISSING_ALT",
            "SVG_TEXT_ALTERNATIVE",
            "HEADING_STRUCTURE",
            "TABLE_SEMANTICS",
            "ACCESSIBILITY_METADATA",
            "ACCESSIBILITY_CONFORMANCE_MISMATCH",
            "METADATA_LANGUAGE",
            "MATHML_DISCLOSURE",
          ].includes(i.code),
        ) || [];
      status = issues.some((i) => i.severity === "error")
        ? "failed"
        : issues.length
          ? "warning"
          : "passed";
    } else if (j.check === "cover") {
      const dims = metadata as any;
      issues = dims.coverWarning
        ? [{ code: "COVER_DIMENSIONS", severity: "warning", message: dims.coverWarning }]
        : [];
      status = issues.length ? "warning" : "passed";
    } else if (j.check === "duplicate") {
      const matches = (
        await env.DB.prepare(
          `SELECT v.id,v.asset_id FROM publishing_asset_versions v WHERE v.sha256=? AND v.id<>? LIMIT 10`,
        )
          .bind(digest, versionId)
          .all<any>()
      ).results;
      const catalog = (
        await env.DB.prepare("SELECT id,asset_id FROM asset_versions WHERE sha256=? LIMIT 10")
          .bind(digest)
          .all<any>()
      ).results;
      if (matches.length || catalog.length) {
        status = "warning";
        issues = [
          {
            code: "EXACT_DUPLICATE",
            severity: "warning",
            message:
              "Identical content already exists in Cove. Review is required before publication.",
          },
        ];
        const dups: any[] = [];
        for (const m of matches)
          dups.push(
            env.DB.prepare(
              "INSERT INTO publishing_duplicate_matches(id,asset_version_id,matched_asset_version_id,match_type,confidence,disposition,created_at,updated_at) VALUES(?,?,?,'exact_hash',1,'review',?,?)",
            ).bind(id("pubdup"), versionId, m.id, at, at),
          );
        for (const m of catalog)
          dups.push(
            env.DB.prepare(
              "INSERT INTO publishing_duplicate_matches(id,asset_version_id,match_type,confidence,disposition,created_at,updated_at) VALUES(?,?,'exact_hash',1,'review',?,?)",
            ).bind(id("pubdup"), versionId, at, at),
          );
        if (dups.length) await env.DB.batch(dups);
      }
    }
    await recordInlineResult(env.DB, j.jobId, versionId, j.check, status, issues);
  }
  await recordAssetFingerprint(env.DB, {
    assetVersionId: versionId,
    accountId: String(edition.account_id),
    editionId: input.editionId,
    assetKind: kind,
    exactSha256: digest,
    text: fingerprintText,
    metadata,
  });
  const validation = await refreshAssetValidationSummary(env.DB, versionId);
  await transitionPublishingLifecycle(
    env.DB,
    input.editionId,
    "validation",
    "publisher",
    userId,
    "asset_uploaded",
    { assetVersionId: versionId, kind },
  );
  await audit(
    env.DB,
    String(edition.account_id),
    userId,
    "publishing_asset_version",
    versionId,
    "uploaded",
    { kind, sizeBytes: input.bytes.byteLength, sha256: digest, validation: validation.summary },
  );
  return {
    assetId,
    versionId,
    versionNumber,
    sha256: digest,
    quarantineStatus: validation.quarantine,
    validationSummary: validation.summary,
    queuedChecks: jobs.filter((j) => j.execution !== "inline").map((j) => j.check),
    metadata,
  };
}

async function signPublishingAccessibilityDeclaration(
  db: PublishingDB,
  userId: string,
  raw: unknown,
) {
  const x = z
    .object({
      editionId: z.string().min(1),
      accessibilitySummary: z.string().trim().max(3000).default(""),
      certifier: z.string().trim().max(300).default(""),
      credential: z.string().trim().max(500).default(""),
      claimsConformance: z.boolean().default(false),
      knownLimitations: z.string().trim().max(3000).default(""),
      metadataAccurateAttestation: z.literal(true),
      signatureName: z.string().trim().min(2).max(200),
    })
    .parse(raw);
  const edition = await editionAccess(db, userId, x.editionId, "editor");
  if (String(edition.format) !== "ebook")
    throw new ApiError(409, "Accessibility declarations currently apply to EPUB editions.");
  const asset = await db
    .prepare(
      `SELECT v.id version_id,i.accessibility_json,i.format_profile_json,i.issue_summary_json FROM publishing_assets a JOIN publishing_asset_versions v ON v.id=a.current_version_id LEFT JOIN publishing_epub_inspections i ON i.asset_version_id=v.id WHERE a.edition_id=? AND a.kind='manuscript' LIMIT 1`,
    )
    .bind(x.editionId)
    .first<any>();
  if (!asset?.version_id || !asset.accessibility_json)
    throw new ApiError(
      409,
      "Upload and inspect the current EPUB before signing its accessibility declaration.",
    );
  const detected = safeJson<any>(asset.accessibility_json, {});
  if (x.claimsConformance && detected.validationStatus === "failed")
    throw new ApiError(
      409,
      "This EPUB cannot be declared conformant while Cove's current accessibility validation is failing.",
    );
  const revision = Number(edition.revision || 1),
    existing = await db
      .prepare(
        "SELECT 1 ok FROM publishing_accessibility_declarations WHERE edition_id=? AND revision=?",
      )
      .bind(x.editionId, revision)
      .first<any>();
  if (existing)
    throw new ApiError(
      409,
      "An immutable accessibility declaration already exists for this revision. Open a new revision to change it.",
    );
  const declaration = {
    policyVersion: "fore-epub-accessibility-v1",
    sourceAssetVersionId: String(asset.version_id),
    publisher: {
      summary: x.accessibilitySummary,
      certifier: x.certifier,
      credential: x.credential,
      claimsConformance: x.claimsConformance,
      knownLimitations: x.knownLimitations,
      metadataAccurateAttestation: true,
      signatureName: x.signatureName,
    },
    detectedAccessibility: detected,
    detectedFormat: safeJson<any>(asset.format_profile_json, {}),
    issues: safeJson<any[]>(asset.issue_summary_json, []),
  };
  const at = now();
  await db
    .prepare(
      "INSERT INTO publishing_accessibility_declarations(edition_id,revision,policy_version,declaration_json,attested_by_user_id,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(x.editionId, revision, "fore-epub-accessibility-v1", stableJson(declaration), userId, at)
    .run();
  await audit(
    db,
    String(edition.account_id),
    userId,
    "publishing_accessibility_declaration",
    `${x.editionId}:${revision}`,
    "signed",
    { sourceAssetVersionId: asset.version_id, claimsConformance: x.claimsConformance },
  );
  return {
    editionId: x.editionId,
    revision,
    policyVersion: "fore-epub-accessibility-v1",
    createdAt: at,
  };
}

async function leasePublishingValidationJobs(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "lease-validation", raw);
}

async function completePublishingValidationJob(db: PublishingDB, raw: unknown) {
  return dispatchPublishingOwnerValidationJob(db, "complete-validation", raw);
}

async function assetStatus(db: PublishingDB, editionId: string) {
  const rows = (
    await db
      .prepare(
        `SELECT a.id,a.kind,a.required,a.current_version_id,v.quarantine_status,v.validation_summary,v.sha256,v.object_key,v.mime_type,v.size_bytes,v.original_filename
    FROM publishing_assets a LEFT JOIN publishing_asset_versions v ON v.id=a.current_version_id WHERE a.edition_id=? ORDER BY a.kind`,
      )
      .bind(editionId)
      .all<any>()
  ).results;
  return rows;
}

async function publishingReadiness(db: PublishingDB, userId: string, editionId: string) {
  const edition = await editionAccess(db, userId, editionId, "analyst"),
    account = await db
      .prepare("SELECT * FROM publishing_accounts WHERE id=?")
      .bind(edition.account_id)
      .first<any>();
  const contributors = (
      await db
        .prepare(
          "SELECT * FROM publishing_edition_contributors WHERE edition_id=? ORDER BY position",
        )
        .bind(editionId)
        .all<any>()
    ).results,
    assets = await assetStatus(db, editionId);
  const blockers: string[] = [];
  if (!account?.terms_accepted_at) blockers.push("Accept the current Cove Publishing agreement.");
  const legalAddress = await db
    .prepare(
      "SELECT id FROM publishing_addresses WHERE account_id=? AND address_type='legal' LIMIT 1",
    )
    .bind(edition.account_id)
    .first<any>();
  if (!legalAddress) blockers.push("Add a legal business/residential address.");
  if (account?.identity_status !== "verified")
    blockers.push("Identity verification must be complete.");
  if (account?.tax_status !== "verified") blockers.push("Tax information must be validated.");
  if (account?.payout_status !== "verified") blockers.push("A verified payout method is required.");
  if (!contributors.some((c) => c.role === "author"))
    blockers.push("Add at least one author/contributor.");
  if (!edition.description?.trim()) blockers.push("Add a book description.");
  if (Number(edition.list_price_minor) < 0) blockers.push("Set a valid list price.");
  if (edition.format === "ebook" && !assets.some((a) => a.kind === "manuscript"))
    blockers.push("Upload an EPUB manuscript.");
  if (!assets.some((a) => a.kind === "cover")) blockers.push("Upload cover artwork.");
  for (const a of assets.filter((a) => Number(a.required) === 1))
    if (a.validation_summary !== "passed" && a.validation_summary !== "warning")
      blockers.push(`${a.kind} validation is not complete.`);
  const openRequired =
    (
      await db
        .prepare(
          `SELECT count(*) n FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND j.required=1 AND j.status<>'passed'`,
        )
        .bind(editionId)
        .first<any>()
    )?.n || 0;
  if (Number(openRequired) > 0)
    blockers.push(
      `${openRequired} required validation check${Number(openRequired) === 1 ? " is" : "s are"} still unresolved.`,
    );
  const duplicateReview =
    (
      await db
        .prepare(
          `SELECT count(*) n FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND d.disposition IN ('review','fraud_hold')`,
        )
        .bind(editionId)
        .first<any>()
    )?.n || 0;
  if (Number(duplicateReview) > 0) blockers.push("Potential duplicate content requires review.");
  const declaration = await db
    .prepare("SELECT * FROM publishing_rights_declarations WHERE edition_id=? AND revision=?")
    .bind(editionId, edition.revision)
    .first<any>();
  if (!declaration) blockers.push("Sign the Cove publisher rights declaration for this revision.");
  else {
    if (String(declaration.policy_version) !== FORE_RIGHTS_POLICY_VERSION)
      blockers.push(
        `Re-sign the publisher rights declaration under the current ${FORE_RIGHTS_POLICY_VERSION} policy.`,
      );
    if (
      !Number(declaration.authority_attestation) ||
      !Number(declaration.no_infringement_attestation) ||
      !Number(declaration.evidence_complete_attestation)
    )
      blockers.push("The rights declaration attestations are incomplete.");
    const evidence = (
      await db
        .prepare("SELECT * FROM publishing_rights_evidence WHERE declaration_id=?")
        .bind(declaration.id)
        .all<any>()
    ).results;
    if (
      ["licensed", "public_domain"].includes(String(declaration.rights_basis)) &&
      !evidence.length
    )
      blockers.push("Upload rights evidence for licensed or public-domain material.");
    if (evidence.some((r: any) => !["clean"].includes(String(r.scan_status))))
      blockers.push("Rights evidence scanning must complete before submission.");
    if (evidence.some((r: any) => r.verification_status === "rejected"))
      blockers.push("Rejected rights evidence must be resolved before submission.");
    if (
      ["licensed", "public_domain"].includes(String(declaration.rights_basis)) &&
      !evidence.some((r: any) => r.verification_status === "verified")
    )
      blockers.push(
        "Licensed or public-domain material requires at least one staff-verified rights evidence record before submission.",
      );
  }
  const aiDisclosure = await db
    .prepare("SELECT * FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?")
    .bind(editionId, edition.revision)
    .first<any>();
  if (!aiDisclosure)
    blockers.push(
      "Sign the Cove AI-content disclosure for this revision, including fully human-created works.",
    );
  else {
    if (String(aiDisclosure.policy_version) !== FORE_AI_POLICY_VERSION)
      blockers.push(
        `Re-sign the AI-content disclosure under the current ${FORE_AI_POLICY_VERSION} policy.`,
      );
    if (
      edition.format === "audiobook" &&
      ["ai_generated", "mixed"].includes(String(aiDisclosure.narration_origin)) &&
      !String(aiDisclosure.synthetic_voice_label || "").trim()
    )
      blockers.push(
        "Synthetic or mixed AI narration requires a customer-facing synthetic voice label.",
      );
  }
  let accessibilityDeclaration: any = null;
  if (String(edition.format) === "ebook") {
    const manuscript = assets.find((a: any) => a.kind === "manuscript");
    accessibilityDeclaration = await db
      .prepare(
        "SELECT * FROM publishing_accessibility_declarations WHERE edition_id=? AND revision=?",
      )
      .bind(editionId, edition.revision)
      .first<any>();
    if (!accessibilityDeclaration)
      blockers.push(
        "Sign the Cove EPUB accessibility declaration for this revision, including editions with no formal conformance claim.",
      );
    else {
      if (String(accessibilityDeclaration.policy_version) !== "fore-epub-accessibility-v1")
        blockers.push(
          "Re-sign the EPUB accessibility declaration under the current Cove accessibility policy.",
        );
      const declaration = safeJson<any>(accessibilityDeclaration.declaration_json, {});
      if (
        !manuscript?.current_version_id ||
        String(declaration.sourceAssetVersionId || "") !==
          String(manuscript.current_version_id || "")
      )
        blockers.push(
          "The accessibility declaration is bound to an older manuscript. Open a new revision and sign against the current EPUB.",
        );
      const inspection = manuscript?.current_version_id
        ? await db
            .prepare(
              "SELECT accessibility_json FROM publishing_epub_inspections WHERE asset_version_id=?",
            )
            .bind(manuscript.current_version_id)
            .first<any>()
        : null;
      const detected = safeJson<any>(inspection?.accessibility_json, {});
      if (declaration?.publisher?.claimsConformance && detected.validationStatus === "failed")
        blockers.push(
          "The current EPUB fails Cove accessibility validation and cannot retain a formal conformance claim.",
        );
    }
  }
  if (String(edition.rights_basis) === "public_domain") {
    const et = String(edition.edition_type || "original"),
      summary = String(edition.differentiation_summary || "").trim();
    if (["original", "canonical_public_domain"].includes(et))
      blockers.push(
        "Public-domain submissions must be a differentiated annotated, translated, illustrated, scholarly, or commercial-audiobook edition. Cove reserves the canonical free edition for its canonical public-domain source.",
      );
    if (!summary)
      blockers.push("Describe the substantive differentiation in this public-domain edition.");
    if (et === "new_translation" && !contributors.some((c) => c.role === "translator"))
      blockers.push("A new translation edition must identify at least one translator.");
    const manuscript = assets.find((a: any) => a.kind === "manuscript");
    if (manuscript?.sha256) {
      const duplicate = await db
        .prepare(
          `SELECT e.id FROM editions e JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' JOIN asset_versions av ON av.id=da.current_version_id WHERE av.sha256=? AND (? IS NULL OR e.id<>?) LIMIT 1`,
        )
        .bind(
          manuscript.sha256,
          edition.catalog_edition_id || null,
          edition.catalog_edition_id || null,
        )
        .first<any>();
      if (duplicate)
        blockers.push(
          "This public-domain EPUB is byte-identical to an existing edition. Commercial public-domain editions must add substantive differentiation rather than duplicate the canonical free copy.",
        );
    }
  }
  const partner = await db
    .prepare(
      "SELECT production_status,default_contract_id FROM publisher_partner_profiles WHERE account_id=?",
    )
    .bind(edition.account_id)
    .first<any>();
  if (partner && String(partner.production_status) === "active") {
    if (!edition.contract_id)
      blockers.push(
        "Production partner titles must be governed by an assigned distribution contract; per-book flags cannot substitute for contract policy.",
      );
    if (edition.contract_id) {
      const assigned = await db
        .prepare(
          "SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active'",
        )
        .bind(edition.account_id, edition.contract_id)
        .first<any>();
      if (!assigned)
        blockers.push(
          "The selected distribution contract is not actively assigned to this publisher.",
        );
    }
    if (edition.contract_version_id) {
      const active = await db
        .prepare(
          "SELECT 1 ok FROM rights_contract_versions WHERE id=? AND contract_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)",
        )
        .bind(edition.contract_version_id, edition.contract_id, now(), now())
        .first<any>();
      if (!active)
        blockers.push("The selected distribution contract version is not currently effective.");
    }
  }
  const similarityReview =
    (
      await db
        .prepare(
          `SELECT count(*) n FROM publishing_similarity_matches sm JOIN publishing_asset_versions v ON v.id=sm.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE a.edition_id=? AND a.current_version_id=v.id AND sm.cross_account=1 AND sm.disposition IN ('review','fraud_hold') AND sm.score>=.95`,
        )
        .bind(editionId)
        .first<any>()
    )?.n || 0;
  if (Number(similarityReview) > 0)
    blockers.push("High-confidence cross-publisher content similarity requires review.");
  let commercialAudio: any = null;
  if (String(edition.format) === "audiobook") {
    commercialAudio = await commercialAudioReadiness(db as any, editionId);
    blockers.push(...commercialAudio.blockers);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    account: {
      identityStatus: account?.identity_status,
      taxStatus: account?.tax_status,
      payoutStatus: account?.payout_status,
      termsAccepted: !!account?.terms_accepted_at,
    },
    assets,
    contributors,
    rightsDeclaration: declaration
      ? { id: declaration.id, status: declaration.status, rightsBasis: declaration.rights_basis }
      : null,
    aiDisclosure: aiDisclosure
      ? {
          id: aiDisclosure.id,
          policyVersion: aiDisclosure.policy_version,
          textOrigin: aiDisclosure.text_origin,
          coverOrigin: aiDisclosure.cover_origin,
          narrationOrigin: aiDisclosure.narration_origin,
        }
      : null,
    accessibilityDeclaration: accessibilityDeclaration
      ? {
          policyVersion: accessibilityDeclaration.policy_version,
          revision: Number(accessibilityDeclaration.revision || 0),
          createdAt: accessibilityDeclaration.created_at,
        }
      : null,
    commercialAudio,
  };
}

async function submitPublishingEdition(
  env: PublishingEnv,
  userId: string,
  editionId: string,
) {
  const db = env.DB,
    edition = await editionAccess(db, userId, editionId, "editor"),
    lifecycle = await ensurePublishingLifecycle(db, editionId);
  if (["suppressed", "takedown", "retired"].includes(String(lifecycle.state)))
    throw new ApiError(
      409,
      "This release is under staff enforcement and cannot be submitted until Cove restores it.",
    );
  const readiness = await publishingReadiness(db, userId, editionId);
  if (!readiness.ready) throw new ApiError(409, readiness.blockers.join(" "));
  const title = await db
      .prepare("SELECT * FROM publishing_titles WHERE id=?")
      .bind(edition.title_id)
      .first<any>(),
    account = await db
      .prepare(
        "SELECT id,legal_name,display_name,country_code,contact_email,website,identity_status,tax_status,payout_status,terms_version,terms_accepted_at FROM publishing_accounts WHERE id=?",
      )
      .bind(edition.account_id)
      .first<any>();
  const addresses = (
    await db
      .prepare(
        "SELECT address_type,line1,line2,city,region,postal_code,country_code FROM publishing_addresses WHERE account_id=? ORDER BY address_type",
      )
      .bind(edition.account_id)
      .all<any>()
  ).results;
  const tax = await db
    .prepare(
      "SELECT id,country_code,tax_classification,form_type,provider,provider_reference,status,withholding_bps,treaty_country_code,validated_at,expires_at FROM publishing_tax_profiles WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(edition.account_id)
    .first<any>();
  const payout = await db
    .prepare(
      "SELECT id,provider,provider_account_id,method,bank_country_code,payout_currency,account_last4,status,payout_threshold_minor,verified_at FROM publishing_payout_accounts WHERE account_id=? AND status='verified' ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(edition.account_id)
    .first<any>();
  const contributors = (
      await db
        .prepare(
          "SELECT pen_name_id,display_name,role,position FROM publishing_edition_contributors WHERE edition_id=? ORDER BY position",
        )
        .bind(editionId)
        .all<any>()
    ).results,
    assets = readiness.assets;
  const rightsDeclaration = await db
    .prepare("SELECT * FROM publishing_rights_declarations WHERE edition_id=? AND revision=?")
    .bind(editionId, edition.revision)
    .first<any>();
  const rightsEvidence = rightsDeclaration
    ? (
        await db
          .prepare(
            "SELECT id,evidence_type,description,original_filename,mime_type,size_bytes,sha256,scan_status,verification_status,issued_by,issued_at,expires_at,created_at FROM publishing_rights_evidence WHERE declaration_id=? ORDER BY created_at",
          )
          .bind(rightsDeclaration.id)
          .all<any>()
      ).results
    : [];
  const aiDisclosure = await db
    .prepare("SELECT * FROM publishing_ai_disclosures WHERE edition_id=? AND revision=?")
    .bind(editionId, edition.revision)
    .first<any>();
  const accessibilityDeclaration = await db
    .prepare(
      "SELECT * FROM publishing_accessibility_declarations WHERE edition_id=? AND revision=?",
    )
    .bind(editionId, edition.revision)
    .first<any>();
  const commercialAudio =
    String(edition.format) === "audiobook"
      ? await commercialAudioSubmissionEvidence(db as any, editionId)
      : null;
  const snapshot = {
      schemaVersion: 5,
      account,
      addresses,
      tax,
      payout,
      title,
      edition,
      contributors,
      assets,
      rightsDeclaration,
      rightsEvidence,
      aiDisclosure,
      accessibilityDeclaration,
      commercialAudio: commercialAudio?.manifest || null,
      commercialAudioManifestSha256: commercialAudio?.manifestSha256 || null,
      submittedAt: now(),
    },
    serialized = stableJson(snapshot),
    digest = await sha256Hex(serialized),
    submissionId = id("pubsub"),
    revision = Number(edition.revision || 1),
    at = now();
  const submissionStatements: any[] = [
    db
      .prepare(
        "INSERT INTO publishing_submission_snapshots(id,edition_id,account_id,revision,snapshot_json,snapshot_sha256,status,submitted_by_user_id,submitted_at) VALUES(?,?,?,?,?,?,'submitted',?,?)",
      )
      .bind(submissionId, editionId, edition.account_id, revision, serialized, digest, userId, at),
    db
      .prepare("UPDATE publishing_edition_drafts SET status='submitted',updated_at=? WHERE id=?")
      .bind(at, editionId),
    db
      .prepare("UPDATE publishing_titles SET status='in_review',updated_at=? WHERE id=?")
      .bind(at, edition.title_id),
    db
      .prepare(
        "INSERT INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,available_at,created_at) VALUES(?,'publishing.submitted','submission',?,?,?,?)",
      )
      .bind(
        id("pubout"),
        submissionId,
        JSON.stringify({
          submissionId,
          editionId,
          accountId: edition.account_id,
          snapshotSha256: digest,
        }),
        at,
        at,
      ),
  ];
  if (commercialAudio)
    submissionStatements.push(
      db
        .prepare(
          "INSERT INTO commercial_audio_submission_snapshots(submission_id,edition_id,policy_id,manifest_json,manifest_sha256,created_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          submissionId,
          editionId,
          commercialAudio.policyId,
          commercialAudio.manifestJson,
          commercialAudio.manifestSha256,
          at,
        ),
    );
  await db.batch(submissionStatements);
  await transitionPublishingLifecycle(
    db,
    editionId,
    "submitted",
    "publisher",
    userId,
    "submitted",
    { submissionId, revision, snapshotSha256: digest },
  );
  await transitionPublishingLifecycle(
    db,
    editionId,
    "automated_review",
    "automation",
    null,
    "automated_review_started",
    { submissionId },
  );
  await assessSubmissionContentPolicy(db, submissionId);
  const automated = await runAutomatedPublishingReview(db, submissionId),
    publisherRisk = await assessPublisherRisk(
      db,
      String(edition.account_id),
      "publishing_submission",
    ),
    autoApprove =
      automated.outcome === "pass" &&
      !["hold", "block"].includes(publisherRisk.action) &&
      String(env.FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK || "false").toLowerCase() === "true";
  if (autoApprove) {
    const decided = now();
    await db.batch([
      db
        .prepare(
          "UPDATE publishing_submission_snapshots SET status='approved',decided_at=? WHERE id=?",
        )
        .bind(decided, submissionId),
      db
        .prepare("UPDATE publishing_edition_drafts SET status='approved',updated_at=? WHERE id=?")
        .bind(decided, editionId),
    ]);
    await transitionPublishingLifecycle(
      db,
      editionId,
      "approved",
      "automation",
      null,
      "automated_low_risk_approval",
      { submissionId, riskScore: Number(automated.risk_score || 0) },
    );
    const publication = await materializePublishingSubmission(
      env,
      submissionId,
      "system:automated-review",
    );
    await audit(
      db,
      String(edition.account_id),
      userId,
      "publishing_submission",
      submissionId,
      "auto_approved",
      {
        editionId,
        revision,
        snapshotSha256: digest,
        automatedOutcome: automated.outcome,
        automatedRiskScore: automated.risk_score,
        publicationVersionId: publication.publicationVersionId,
      },
    );
    try {
      const members = (
        await db
          .prepare(
            "SELECT user_id FROM publishing_account_members WHERE account_id=? AND status='active' AND role IN ('owner','admin','editor')",
          )
          .bind(edition.account_id)
          .all<any>()
      ).results;
      for (const m of members)
        await emitNotification(db, {
          userId: String(m.user_id),
          eventType: "publisher_book_approved",
          dedupeKey: `publishing-auto-review:${submissionId}:${m.user_id}`,
          title: `${title?.title || "Your book"} approved`,
          body: "Cove's automated publishing review approved this low-risk submission and published it.",
          subjectType: "publishing_submission",
          subjectId: submissionId,
          actionUrl: "/publishing",
          payload: {
            submissionId,
            editionId,
            decision: "approve",
            automated: true,
            publicationVersionId: publication.publicationVersionId,
          },
        });
    } catch (e) {
      console.error("Automated publishing approval notification enqueue failed", e);
    }
    return {
      submissionId,
      snapshotSha256: digest,
      status: "published",
      lifecycleState: publication.releaseState,
      automatedReview: { outcome: automated.outcome, riskScore: automated.risk_score },
      publisherRisk: {
        score: publisherRisk.score,
        level: publisherRisk.level,
        action: publisherRisk.action,
      },
      publication,
    };
  }
  await db
    .prepare("UPDATE publishing_submission_snapshots SET status='in_review' WHERE id=?")
    .bind(submissionId)
    .run();
  await transitionPublishingLifecycle(
    db,
    editionId,
    "human_review",
    "automation",
    null,
    automated.outcome === "pass" ? "human_review_policy" : `automated_${automated.outcome}`,
    {
      submissionId,
      riskScore: Number(automated.risk_score || 0),
      caseId: (automated as any).caseId || null,
    },
  );
  await audit(
    db,
    String(edition.account_id),
    userId,
    "publishing_submission",
    submissionId,
    "submitted",
    {
      editionId,
      revision,
      snapshotSha256: digest,
      automatedOutcome: automated.outcome,
      automatedRiskScore: automated.risk_score,
    },
  );
  return {
    submissionId,
    snapshotSha256: digest,
    status: "in_review",
    lifecycleState: "human_review",
    automatedReview: { outcome: automated.outcome, riskScore: automated.risk_score },
    publisherRisk: {
      score: publisherRisk.score,
      level: publisherRisk.level,
      action: publisherRisk.action,
    },
  };
}

async function openPublishingRevision(db: PublishingDB, userId: string, editionId: string) {
  const edition = await editionAccess(db, userId, editionId, "editor");
  if (
    !["published", "approved", "submitted", "changes_requested", "withdrawn"].includes(
      String(edition.status),
    )
  )
    throw new ApiError(409, "This edition is already editable.");
  const lifecycle = await ensurePublishingLifecycle(db, editionId);
  if (["suppressed", "takedown", "retired"].includes(String(lifecycle.state)))
    throw new ApiError(
      409,
      "This release must be restored by Cove staff before a publisher update can be opened.",
    );
  const at = now(),
    nextRevision = Number(edition.revision || 1) + 1;
  await db.batch([
    db
      .prepare(
        "UPDATE publishing_submission_snapshots SET status='withdrawn',decided_at=COALESCE(decided_at,?) WHERE edition_id=? AND revision=? AND status IN ('submitted','in_review','approved')",
      )
      .bind(at, editionId, Number(edition.revision || 1)),
    db
      .prepare(
        "UPDATE publishing_edition_drafts SET status='draft',revision=?,updated_at=? WHERE id=?",
      )
      .bind(nextRevision, at, editionId),
  ]);
  await transitionPublishingLifecycle(
    db,
    editionId,
    "draft",
    "publisher",
    userId,
    "publisher_update_opened",
    { revision: nextRevision, currentlyLive: !!edition.catalog_product_id },
  );
  await audit(
    db,
    String(edition.account_id),
    userId,
    "publishing_edition",
    editionId,
    "revision_opened",
    { revision: nextRevision },
  );
  return { editionId, revision: nextRevision, status: "draft" };
}

async function setPublishingUpdatePolicy(db: PublishingDB, userId: string, raw: unknown) {
  const x = z
      .object({
        editionId: z.string().min(1),
        policy: z.enum(["auto_update", "manual_opt_in", "preserve_purchased_version"]),
      })
      .parse(raw),
    edition = await editionAccess(db, userId, x.editionId, "admin"),
    lifecycle = await ensurePublishingLifecycle(db, x.editionId),
    at = now();
  await db
    .prepare(
      "UPDATE publishing_release_lifecycles SET owner_update_policy=?,updated_at=? WHERE id=?",
    )
    .bind(x.policy, at, lifecycle.id)
    .run();
  let pinnedExistingOwners = 0;
  if (x.policy !== "auto_update" && lifecycle.current_publication_version_id) {
    const product = await db
      .prepare(
        `SELECT p.product_id FROM publishing_publication_versions pv JOIN publishing_publications p ON p.id=pv.publication_id WHERE pv.id=?`,
      )
      .bind(lifecycle.current_publication_version_id)
      .first<any>();
    if (product?.product_id) {
      const entitlements = (
        await db
          .prepare(
            "SELECT id,user_id FROM entitlements WHERE product_id=? AND entitlement_type='purchase' AND status='active'",
          )
          .bind(product.product_id)
          .all<any>()
      ).results;
      for (const ent of entitlements) {
        const exists = await db
          .prepare(
            "SELECT entitlement_id FROM publishing_entitlement_version_pins WHERE entitlement_id=?",
          )
          .bind(ent.id)
          .first<any>();
        if (exists) continue;
        await db
          .prepare(
            "INSERT INTO publishing_entitlement_version_pins(entitlement_id,lifecycle_id,publication_version_id,policy_at_grant,pinned_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .bind(ent.id, lifecycle.id, lifecycle.current_publication_version_id, x.policy, at, at)
          .run();
        await db
          .prepare(
            "INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at) VALUES(?,?,?,?,?,'policy_pin',?,?)",
          )
          .bind(
            id("ownevt"),
            ent.id,
            lifecycle.id,
            null,
            lifecycle.current_publication_version_id,
            userId,
            at,
          )
          .run();
        pinnedExistingOwners++;
      }
    }
  }
  await audit(
    db,
    String(edition.account_id),
    userId,
    "publishing_release",
    lifecycle.id,
    "owner_update_policy_changed",
    { policy: x.policy, pinnedExistingOwners },
  );
  return { saved: true, policy: x.policy, pinnedExistingOwners };
}

async function optInOwnedPublicationUpdate(db: PublishingDB, userId: string, raw: unknown) {
  const x = z.object({ productId: z.string().min(1) }).parse(raw),
    ent = await db
      .prepare(
        "SELECT * FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='purchase' AND status='active' ORDER BY granted_at DESC LIMIT 1",
      )
      .bind(userId, x.productId)
      .first<any>();
  if (!ent) throw new ApiError(403, "An active purchase entitlement is required.");
  const lifecycle = await db
    .prepare(
      `SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_publication_versions pv ON pv.id=l.current_publication_version_id JOIN publishing_publications p ON p.id=pv.publication_id WHERE p.product_id=? LIMIT 1`,
    )
    .bind(x.productId)
    .first<any>();
  if (!lifecycle || !lifecycle.current_publication_version_id)
    throw new ApiError(404, "This product does not have a versioned Cove Publishing release.");
  if (lifecycle.owner_update_policy !== "manual_opt_in")
    throw new ApiError(409, "This title does not use manual owner updates.");
  const prior = await db
      .prepare(
        "SELECT publication_version_id FROM publishing_entitlement_version_pins WHERE entitlement_id=?",
      )
      .bind(ent.id)
      .first<any>(),
    at = now();
  if (prior?.publication_version_id === lifecycle.current_publication_version_id)
    return { updated: false, publicationVersionId: lifecycle.current_publication_version_id };
  await db
    .prepare(
      `INSERT INTO publishing_entitlement_version_pins(entitlement_id,lifecycle_id,publication_version_id,policy_at_grant,pinned_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entitlement_id) DO UPDATE SET lifecycle_id=excluded.lifecycle_id,publication_version_id=excluded.publication_version_id,policy_at_grant=excluded.policy_at_grant,updated_at=excluded.updated_at`,
    )
    .bind(ent.id, lifecycle.id, lifecycle.current_publication_version_id, "manual_opt_in", at, at)
    .run();
  await db
    .prepare(
      "INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at) VALUES(?,?,?,?,?,'owner_opt_in',?,?)",
    )
    .bind(
      id("ownevt"),
      ent.id,
      lifecycle.id,
      prior?.publication_version_id || null,
      lifecycle.current_publication_version_id,
      userId,
      at,
    )
    .run();
  return { updated: true, publicationVersionId: lifecycle.current_publication_version_id };
}

function scopeToGrant(scope: any) {
  const mode = scope?.mode || "worldwide";
  if (mode === "single")
    return {
      scopeMode: "single" as const,
      territory: String(scope.territory || "US").toUpperCase(),
    };
  if (mode === "set")
    return { scopeMode: "set" as const, territorySetId: String(scope.territorySetId || "WORLD") };
  if (mode === "expression")
    return {
      scopeMode: "expression" as const,
      includeTerritories: (scope.include || []).map((x: string) => x.toUpperCase()),
      excludeTerritories: (scope.exclude || []).map((x: string) => x.toUpperCase()),
      includeSetIds: scope.includeSetIds || [],
      excludeSetIds: scope.excludeSetIds || [],
    };
  return {
    scopeMode: "worldwide" as const,
    excludeTerritories: (scope.exclude || []).map((x: string) => x.toUpperCase()),
  };
}
async function bucketBytes(env: PublishingEnv, key: string) {
  const obj = await env.BUCKET?.get(key);
  if (!obj) throw new ApiError(503, "A publication asset is missing from storage.");
  return new Uint8Array(await new Response(obj.body).arrayBuffer());
}

async function ensureCatalogParties(db:PublishingDB,account:any,tax:any,payout:any){
 const current=await db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(account.id).first<any>();
 if(!current||current.status!=="active"||![current.identity_status,current.tax_status,current.payout_status].every(s=>s==="verified"))
  throw new ApiError(409,"Canonical publisher compliance must be verified before party materialization.");
 account=current;
 const digest=await sha256Hex(account.id),at=now();
 const publisherId=account.publisher_id||"publisher_"+digest,financePartyId=account.finance_party_id||"finparty_"+digest,rightsPartyId=account.rights_party_id||"rparty_"+digest;
 const guard="EXISTS(SELECT 1 FROM publishing_accounts WHERE id=? AND status='active' AND identity_status='verified' AND tax_status='verified' AND payout_status='verified' AND COALESCE(publisher_id,'')=? AND COALESCE(finance_party_id,'')=? AND COALESCE(rights_party_id,'')=?)";
 const guardArgs=[account.id,account.publisher_id||"",account.finance_party_id||"",account.rights_party_id||""];
 const statements:Parameters<PublishingDB["batch"]>[0]=[];
 if(!account.publisher_id)statements.push(db.prepare("INSERT OR IGNORE INTO publishers(id,name,website,created_at,updated_at) SELECT ?,?,?,?,? WHERE "+guard).bind(publisherId,account.display_name,account.website||"",at,at,...guardArgs));
 if(!account.rights_party_id)statements.push(db.prepare("INSERT OR IGNORE INTO rights_parties(id,display_name,party_type,publisher_id,contributor_id,contact_email,reference_code,status,created_at,updated_at) SELECT ?,?,'publisher',?,NULL,?,?,'active',?,? WHERE "+guard)
  .bind(rightsPartyId,account.display_name,publisherId,account.contact_email||"","FORE-PUB-"+account.id,at,at,...guardArgs));
 if(!account.finance_party_id)statements.push(db.prepare("INSERT OR IGNORE INTO finance_parties(id,party_type,display_name,publisher_id,tax_country,withholding_bps,payout_currency,status,created_at,updated_at) SELECT ?,'publisher',?,?,?,?,?,'active',?,? WHERE "+guard)
  .bind(financePartyId,account.display_name,publisherId,tax?.country_code||account.country_code,Number(tax?.withholding_bps||0),payout?.payout_currency||"USD",at,at,...guardArgs));
 statements.push(db.prepare("UPDATE publishing_accounts SET publisher_id=?,finance_party_id=?,rights_party_id=?,status='active',updated_at=? WHERE id=? AND "+guard).bind(publisherId,financePartyId,rightsPartyId,at,account.id,...guardArgs));
 try{await db.batch(statements);}catch(error){
  const committed=await db.prepare("SELECT publisher_id,finance_party_id,rights_party_id FROM publishing_accounts WHERE id=?").bind(account.id).first<any>();
  if(committed?.publisher_id!==publisherId||committed?.finance_party_id!==financePartyId||committed?.rights_party_id!==rightsPartyId)throw error;
 }
 const confirmed=await db.prepare("SELECT publisher_id,finance_party_id,rights_party_id,status,identity_status,tax_status,payout_status FROM publishing_accounts WHERE id=?").bind(account.id).first<any>();
 if(!confirmed||confirmed.publisher_id!==publisherId||confirmed.finance_party_id!==financePartyId||confirmed.rights_party_id!==rightsPartyId||confirmed.status!=="active"||![confirmed.identity_status,confirmed.tax_status,confirmed.payout_status].every(s=>s==="verified"))
  throw new ApiError(409,"Publisher compliance changed before parties committed.");
 return {publisherId,financePartyId,rightsPartyId};
}

async function publicationVersionManifest(
  db: PublishingDB,
  publicationVersionId: string | null | undefined,
) {
  if (!publicationVersionId) return null;
  const row = await db
    .prepare("SELECT id,manifest_json FROM publishing_publication_versions WHERE id=?")
    .bind(publicationVersionId)
    .first<any>();
  return row ? { id: String(row.id), manifest: safeJson<any>(row.manifest_json, {}) } : null;
}

/** Retired: never activate commercial rights directly through the shared application DB. */
async function privateEditorLegacyactivatePublicationCommercialTerms(
  _db: PublishingDB,
  _currentManifest: any,
  _previousManifest: any | null,
  _at: string,
): Promise<never> {
  throw new ApiError(503, "Commercial activation requires the canonical private owner.");
}

async function materializePublishingSubmission(
  env: PublishingEnv,
  submissionId: string,
  reviewerUserId: string,
) {
  if (hasPublicationOwner(env.DB))
    return dispatchPublicationMaterialization(env.DB, { submissionId, reviewerUserId });
  throw new ApiError(503, "Publishing materialization requires its canonical private owner.");
}

/** The owner reserves canonical identities and holds the product before this
 * complete implementation can write. Unenrolled legacy callers retain their
 * existing path until production writer closure is certified. */

async function activatePublicationVersion(
  db: PublishingDB,
  publicationVersionId: string,
  actorUserId: string | null,
  triggerType: "schedule" | "rollback" | "staff",
) {
  if (hasPublicationOwner(db))
    return dispatchPublicationActivation(db, { publicationVersionId, actorUserId, triggerType });
  return activatePublicationVersionOwned(db, publicationVersionId, actorUserId, triggerType);
}

/** The private legal owner executes this implementation against its own
 * PRIMARY_DB after durably acquiring the product's publication hold. */
/** Retired: the owner verifies the frozen version and executes the physical activation. */
async function privateEditorLegacyactivatePublicationVersionOwned(
  _db: PublishingDB,
  _publicationVersionId: string,
  _actorUserId: string | null,
  _triggerType: "schedule" | "rollback" | "staff",
): Promise<never> {
  throw new ApiError(503, "Publication version activation requires its private owner.");
}

/** Only the owner invokes this implementation on enrolled databases; the
 * scheduler always dispatches the typed command through its bound facade. */
/** Retired: scheduled preorder activation cannot bypass canonical owner denial. */
async function privateEditorLegacyopenPublicationPreorderOwned(
  _db: PublishingDB,
  _publicationVersionId: string,
): Promise<never> {
  throw new ApiError(503, "Preorder activation requires its canonical private owner.");
}

async function advancePublishingReleaseSchedules(db: PublishingDB) {
  // A complete primary activation can already be live/preorder when its
  // final owner commit fails. Recover recorded holds before the lifecycle
  // query, which intentionally selects only still-due releases.
  const recovery = hasPublicationOwner(db) ? await dispatchPublicationRecovery(db) : null;
  const atMs = Date.now(),
    atSeconds = Math.floor(atMs / 1000),
    rows = (
      await db
        .prepare(
          `SELECT l.*,pv.id version_id,pv.manifest_json,pv.version_number FROM publishing_release_lifecycles l LEFT JOIN publishing_publication_versions pv ON pv.id=COALESCE(l.pending_publication_version_id,l.current_publication_version_id) WHERE l.state IN ('scheduled','preorder') AND CASE WHEN json_valid(pv.manifest_json) THEN (CAST(strftime('%s',json_extract(pv.manifest_json,'$.metadata.releaseDate')) AS INTEGER)<=? OR (l.state='scheduled' AND l.pending_publication_version_id IS NULL AND CAST(strftime('%s',json_extract(pv.manifest_json,'$.metadata.preorderDate')) AS INTEGER)<=?)) ELSE 0 END ORDER BY l.updated_at,l.id LIMIT 500`,
        )
        .bind(atSeconds, atSeconds)
        .all<any>()
    ).results;
  const advanced: any[] = [];
  for (const row of rows) {
    if (!row.version_id) continue;
    const m = safeJson<any>(row.manifest_json, {}),
      meta = m.metadata || {},
      releaseMs = meta.releaseDate ? new Date(meta.releaseDate).getTime() : NaN,
      preorderMs = meta.preorderDate ? new Date(meta.preorderDate).getTime() : NaN;
    if (Number.isFinite(releaseMs) && releaseMs <= atMs) {
      advanced.push(await activatePublicationVersion(db, row.version_id, null, "schedule"));
      continue;
    }
    if (
      row.state === "scheduled" &&
      !row.pending_publication_version_id &&
      Number.isFinite(preorderMs) &&
      preorderMs <= atMs
    ) {
      advanced.push(
        hasPublicationOwner(db)
          ? await dispatchPublicationPreorder(db, { publicationVersionId: row.version_id })
          : await openPublicationPreorderOwned(db, row.version_id),
      );
    }
  }
  return { checked: rows.length, advanced, ...(recovery ? { recovery } : {}) };
}

async function rollbackPublishingVersion(
  db: PublishingDB,
  reviewerUserId: string,
  raw: unknown,
) {
  const x = z
      .object({
        editionId: z.string().min(1),
        versionNumber: z.number().int().min(1),
        reasonCode: z.string().trim().min(3).max(120),
        notes: z.string().max(4000).default(""),
      })
      .parse(raw),
    lifecycle = await ensurePublishingLifecycle(db, x.editionId),
    target = await db
      .prepare(
        "SELECT * FROM publishing_publication_versions WHERE lifecycle_id=? AND version_number=?",
      )
      .bind(lifecycle.id, x.versionNumber)
      .first<any>();
  if (!target) throw new ApiError(404, "Publication version not found.");
  if (["suppressed", "takedown", "retired"].includes(String(lifecycle.state)))
    throw new ApiError(
      409,
      "Rollback is blocked while the release is suppressed, taken down, or retired. Restore the release through moderation first.",
    );
  if (target.id === lifecycle.current_publication_version_id)
    return {
      publicationVersionId: target.id,
      state: lifecycle.state,
      versionNumber: x.versionNumber,
      alreadyCurrent: true,
    };
  const result = await activatePublicationVersion(db, target.id, reviewerUserId, "rollback");
  await audit(db, null, reviewerUserId, "publishing_release", lifecycle.id, "rollback", {
    toVersion: x.versionNumber,
    fromVersionId: lifecycle.current_publication_version_id,
    reasonCode: x.reasonCode,
    notes: x.notes,
  });
  return result;
}

async function reviewPublishingSubmission(
  env: PublishingEnv,
  reviewerUserId: string,
  raw: unknown,
) {
  const x = z
      .object({
        submissionId: z.string().min(1),
        decision: z.enum(["approve", "request_changes", "reject", "hold"]),
        reasonCode: z.string().max(120).default(""),
        notes: z.string().max(4000).default(""),
        publishNow: z.boolean().default(true),
      })
      .parse(raw),
    db = env.DB,
    sub = await db
      .prepare("SELECT * FROM publishing_submission_snapshots WHERE id=?")
      .bind(x.submissionId)
      .first<any>();
  if (!sub) throw new ApiError(404, "Publishing submission not found.");
  if (!["submitted", "in_review"].includes(String(sub.status)))
    throw new ApiError(
      409,
      "This submission is not in an actionable review state. Requested changes require a new revision and submission.",
    );
  const lifecycleBefore = await ensurePublishingLifecycle(db, String(sub.edition_id));
  if (
    x.decision === "approve" &&
    ["suppressed", "takedown", "retired"].includes(String(lifecycleBefore.state))
  )
    throw new ApiError(
      409,
      "This release is under staff enforcement. Restore the release before approving a publisher update.",
    );
  const at = now(),
    next =
      x.decision === "approve"
        ? "approved"
        : x.decision === "request_changes"
          ? "changes_requested"
          : x.decision === "reject"
            ? "rejected"
            : "in_review";
  await db.batch([
    db
      .prepare(
        "INSERT INTO publishing_submission_reviews(id,submission_id,reviewer_user_id,decision,reason_code,notes,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(id("pubreview"), x.submissionId, reviewerUserId, x.decision, x.reasonCode, x.notes, at),
    db
      .prepare("UPDATE publishing_submission_snapshots SET status=?,decided_at=? WHERE id=?")
      .bind(next, at, x.submissionId),
    db
      .prepare("UPDATE publishing_edition_drafts SET status=?,updated_at=? WHERE id=?")
      .bind(
        x.decision === "request_changes"
          ? "changes_requested"
          : x.decision === "approve"
            ? "approved"
            : x.decision === "reject"
              ? "withdrawn"
              : "submitted",
        at,
        sub.edition_id,
      ),
  ]);
  const hasLiveVersion = !!lifecycleBefore.current_publication_version_id;
  const lifecycleDecision =
    x.decision === "approve"
      ? "approved"
      : x.decision === "request_changes"
        ? hasLiveVersion
          ? "live"
          : "draft"
        : x.decision === "reject"
          ? hasLiveVersion
            ? "live"
            : "retired"
          : "human_review";
  await transitionPublishingLifecycle(
    db,
    String(sub.edition_id),
    lifecycleDecision,
    "staff",
    reviewerUserId,
    x.reasonCode || x.decision,
    {
      submissionId: x.submissionId,
      notes: x.notes,
      keptPriorLiveVersion: hasLiveVersion && x.decision !== "approve",
    },
  );
  await audit(
    db,
    String(sub.account_id),
    reviewerUserId,
    "publishing_submission",
    x.submissionId,
    x.decision,
    { reasonCode: x.reasonCode },
  );
  if (x.decision === "approve" || x.decision === "reject" || x.decision === "request_changes")
    try {
      const edition = await db
          .prepare(
            `SELECT e.id,t.title FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?`,
          )
          .bind(sub.edition_id)
          .first<any>(),
        members = (
          await db
            .prepare(
              "SELECT user_id FROM publishing_account_members WHERE account_id=? AND status='active' AND role IN ('owner','admin','editor')",
            )
            .bind(sub.account_id)
            .all<any>()
        ).results,
        eventType =
          x.decision === "approve" ? "publisher_book_approved" : "publisher_book_rejected",
        label =
          x.decision === "approve"
            ? "approved"
            : x.decision === "request_changes"
              ? "needs changes"
              : "rejected";
      for (const m of members)
        await emitNotification(db, {
          userId: String(m.user_id),
          eventType,
          dedupeKey: `publishing-review:${x.submissionId}:${x.decision}:${m.user_id}`,
          title: `${edition?.title || "Your book"} ${label}`,
          body:
            x.notes ||
            (x.decision === "approve"
              ? "Cove approved this submission."
              : x.decision === "request_changes"
                ? "Cove requested changes before this submission can be published."
                : "Cove rejected this submission."),
          urgency: x.decision === "approve" ? "normal" : "high",
          subjectType: "publishing_submission",
          subjectId: x.submissionId,
          actionUrl: "/publishing",
          payload: {
            submissionId: x.submissionId,
            editionId: sub.edition_id,
            decision: x.decision,
            reasonCode: x.reasonCode,
          },
        });
    } catch (e) {
      console.error("Publishing decision notification enqueue failed", e);
    }
  if (x.decision === "approve" && x.publishNow)
    return {
      decision: x.decision,
      publication: await materializePublishingSubmission(env, x.submissionId, reviewerUserId),
    };
  return { decision: x.decision, status: next };
}

/** A review is no longer a shared-D1 authority write. Only the isolated
 * privately authenticated owner can record a negative onboarding decision.
 * Positive KYC/tax/payout verification requires external proof and remains closed. */
async function reviewPublishingOnboarding(
  db: PublishingDB,
  reviewerUserId: string,
  raw: unknown,
) {
  const x = z
    .object({
      accountId: z.string().min(1).max(180),
      kind: z.enum(["identity", "tax", "payout"]),
      recordId: z.string().min(1).max(180),
      status: z.enum(["verified", "failed", "expired", "manual_review", "restricted"]),
      reasonCode: z.string().max(120).default(""),
      withholdingBps: z.number().int().min(0).max(10000).optional(),
      requirementsDue: z.array(z.string().max(240)).max(100).optional(),
    })
    .parse(raw);
  if (!hasPublicationOwner(db))
    throw new ApiError(503, "Publishing verification review requires its private legal owner.");
  return dispatchPublishingOnboardingReview(db, { ...x, reviewerUserId });
}

async function publishingSnapshot(
  db: PublishingDB,
  userId: string,
  accountId?: string | null,
) {
  const memberships = (
    await db
      .prepare(
        `SELECT m.*,a.display_name,a.legal_name,a.country_code,a.status account_status,a.identity_status,a.tax_status,a.payout_status,a.terms_accepted_at FROM publishing_account_members m JOIN publishing_accounts a ON a.id=m.account_id WHERE m.user_id=? AND m.status='active' ORDER BY a.created_at`,
      )
      .bind(userId)
      .all<any>()
  ).results;
  const selected = accountId ? memberships.find((m) => m.account_id === accountId) : memberships[0];
  if (!selected)
    return {
      accounts: memberships,
      account: null,
      titles: [],
      penNames: [],
      members: [],
      onboarding: null,
    };
  const aid = String(selected.account_id);
  await requireRole(db, userId, aid, "analyst");
  const [
    account,
    addresses,
    penNames,
    members,
    titles,
    editions,
    assets,
    validations,
    submissions,
    publications,
  ] = await Promise.all([
    db.prepare("SELECT * FROM publishing_accounts WHERE id=?").bind(aid).first<any>(),
    db
      .prepare("SELECT * FROM publishing_addresses WHERE account_id=? ORDER BY address_type")
      .bind(aid)
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_pen_names WHERE account_id=? ORDER BY display_name")
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        "SELECT role,status,invited_email,accepted_at,created_at,user_id FROM publishing_account_members WHERE account_id=? ORDER BY created_at",
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_titles WHERE account_id=? ORDER BY updated_at DESC")
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        `SELECT e.* FROM publishing_edition_drafts e JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY e.updated_at DESC`,
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        `SELECT a.*,v.version_number,v.original_filename,v.mime_type,v.size_bytes,v.sha256,v.quarantine_status,v.validation_summary,v.extracted_metadata_json FROM publishing_assets a JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id LEFT JOIN publishing_asset_versions v ON v.id=a.current_version_id WHERE t.account_id=? ORDER BY a.updated_at DESC`,
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        `SELECT j.*,v.original_filename,a.kind,a.edition_id FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY j.created_at DESC LIMIT 500`,
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        "SELECT id,edition_id,revision,status,snapshot_sha256,submitted_at,decided_at,published_at FROM publishing_submission_snapshots WHERE account_id=? ORDER BY submitted_at DESC",
      )
      .bind(aid)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_publications WHERE publishing_account_id=? ORDER BY published_at DESC",
      )
      .bind(aid)
      .all<any>(),
  ]);
  const latestIdentity = await db
      .prepare(
        "SELECT id,provider,status,reason_code,initiated_at,decided_at,expires_at FROM publishing_identity_verifications WHERE account_id=? ORDER BY initiated_at DESC LIMIT 1",
      )
      .bind(aid)
      .first<any>(),
    latestTax = await db
      .prepare(
        "SELECT id,country_code,tax_classification,form_type,provider,status,withholding_bps,treaty_country_code,validated_at,expires_at FROM publishing_tax_profiles WHERE account_id=? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(aid)
      .first<any>(),
    latestPayout = await db
      .prepare(
        "SELECT id,provider,method,bank_country_code,payout_currency,account_last4,status,payout_threshold_minor,requirements_due_json,verified_at FROM publishing_payout_accounts WHERE account_id=? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(aid)
      .first<any>();
  const [lifecycles, publicationVersions, activations, moderationCases, appeals] =
    await Promise.all([
      db
        .prepare(
          `SELECT l.* FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY l.updated_at DESC`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          `SELECT pv.id,pv.lifecycle_id,pv.submission_id,pv.version_number,pv.previous_version_id,pv.rollback_of_version_id,pv.snapshot_sha256,pv.owner_delivery_policy,pv.release_state,pv.activated_at,pv.created_at,l.publishing_edition_id FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY pv.created_at DESC`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          `SELECT pa.* FROM publishing_publication_activations pa JOIN publishing_release_lifecycles l ON l.id=pa.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.account_id=? ORDER BY pa.created_at DESC LIMIT 500`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          `SELECT c.*,(SELECT ma.id FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_id,(SELECT ma.action_type FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_type,(SELECT ma.rationale FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_rationale,(SELECT ma.reversible FROM moderation_actions ma WHERE ma.case_id=c.id ORDER BY ma.created_at DESC LIMIT 1) latest_action_reversible FROM moderation_cases c WHERE c.publishing_account_id=? ORDER BY c.updated_at DESC LIMIT 200`,
        )
        .bind(aid)
        .all<any>(),
      db
        .prepare(
          "SELECT a.*,c.category,c.summary FROM moderation_appeals a JOIN moderation_cases c ON c.id=a.case_id WHERE a.publishing_account_id=? ORDER BY a.submitted_at DESC",
        )
        .bind(aid)
        .all<any>(),
    ]);
  let finance = { statements: [] as any[], payouts: [] as any[], royaltyBalances: [] as any[] };
  if (account?.finance_party_id) {
    const [statementRows, payoutRows, balanceRows] = await Promise.all([
      db
        .prepare(
          "SELECT id,period_start,period_end,currency,sales_minor,refunds_minor,royalties_minor,withholding_minor,reserve_minor,payable_minor,generated_at FROM finance_statements WHERE party_id=? ORDER BY period_end DESC,generated_at DESC LIMIT 24",
        )
        .bind(account.finance_party_id)
        .all<any>(),
      db
        .prepare(
          `SELECT pi.id,pi.currency,pi.gross_minor,pi.withholding_minor,pi.net_minor,pi.status,pi.external_payout_id,pi.created_at,pb.period_start,pb.period_end,pb.paid_at FROM payout_items pi JOIN payout_batches pb ON pb.id=pi.batch_id WHERE pi.party_id=? ORDER BY pi.created_at DESC LIMIT 50`,
        )
        .bind(account.finance_party_id)
        .all<any>(),
      db
        .prepare(
          "SELECT currency,status,SUM(royalty_minor) royalty_minor,SUM(withholding_minor) withholding_minor,SUM(payable_minor) payable_minor,COUNT(*) event_count FROM finance_royalty_allocations WHERE party_id=? GROUP BY currency,status ORDER BY currency,status",
        )
        .bind(account.finance_party_id)
        .all<any>(),
    ]);
    finance = {
      statements: statementRows.results,
      payouts: payoutRows.results,
      royaltyBalances: balanceRows.results,
    };
  }
  const trust = await publisherRightsSnapshot(db, userId, aid);
  return {
    accounts: memberships,
    account,
    addresses: addresses.results,
    penNames: penNames.results,
    members: members.results,
    titles: titles.results,
    editions: editions.results,
    assets: assets.results,
    validations: validations.results,
    submissions: submissions.results,
    publications: publications.results,
    lifecycles: lifecycles.results,
    publicationVersions: publicationVersions.results,
    publicationActivations: activations.results,
    moderationCases: moderationCases.results,
    appeals: appeals.results,
    finance,
    ...trust,
    onboarding: {
      identity: latestIdentity,
      tax: latestTax,
      payout: latestPayout,
      ready:
        account?.identity_status === "verified" &&
        account?.tax_status === "verified" &&
        account?.payout_status === "verified" &&
        !!account?.terms_accepted_at,
    },
  };
}

async function adminPublishingSnapshot(db: PublishingDB) {
  const [
    accounts,
    submissions,
    jobs,
    duplicates,
    auditRows,
    lifecycles,
    versions,
    activations,
    automated,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT a.*,(SELECT count(*) FROM publishing_titles t WHERE t.account_id=a.id) title_count,(SELECT COALESCE(SUM(s.strike_points),0) FROM moderation_sanctions s WHERE s.publishing_account_id=a.id AND s.status='active') active_strikes FROM publishing_accounts a ORDER BY a.updated_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare(
        `SELECT s.id,s.edition_id,s.account_id,s.revision,s.status,s.snapshot_sha256,s.submitted_at,s.decided_at,s.published_at,t.title,e.format,a.display_name publisher_name,ar.outcome automated_outcome,ar.risk_score automated_risk_score,l.state lifecycle_state FROM publishing_submission_snapshots s JOIN publishing_edition_drafts e ON e.id=s.edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_accounts a ON a.id=s.account_id LEFT JOIN publishing_automated_reviews ar ON ar.submission_id=s.id LEFT JOIN publishing_release_lifecycles l ON l.publishing_edition_id=e.id ORDER BY s.submitted_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare(
        "SELECT status,check_type,count(*) count FROM publishing_validation_jobs GROUP BY status,check_type ORDER BY status,check_type",
      )
      .all<any>(),
    db
      .prepare(
        `SELECT d.*,v.original_filename,a.kind,t.title FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE d.disposition IN ('review','fraud_hold') ORDER BY d.created_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_audit_events ORDER BY created_at DESC LIMIT 300")
      .all<any>(),
    db
      .prepare(
        `SELECT l.*,t.title,a.display_name publisher_name,e.format,e.catalog_product_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_accounts a ON a.id=t.account_id ORDER BY l.updated_at DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare(
        `SELECT pv.id,pv.lifecycle_id,pv.version_number,pv.previous_version_id,pv.snapshot_sha256,pv.owner_delivery_policy,pv.release_state,pv.activated_at,pv.created_at,l.publishing_edition_id,t.title FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id ORDER BY pv.created_at DESC LIMIT 1000`,
      )
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publishing_publication_activations ORDER BY created_at DESC LIMIT 1000",
      )
      .all<any>(),
    db
      .prepare("SELECT * FROM publishing_automated_reviews ORDER BY created_at DESC LIMIT 500")
      .all<any>(),
  ]);
  return {
    accounts: accounts.results,
    submissions: submissions.results,
    jobs: jobs.results,
    duplicates: duplicates.results,
    audit: auditRows.results,
    lifecycles: lifecycles.results,
    versions: versions.results,
    activations: activations.results,
    automatedReviews: automated.results,
  };
}

async function resolveDuplicateMatch(
  db: PublishingDB,
  reviewerUserId: string,
  raw: unknown,
) {
  const x = z
      .object({
        id: z.string().min(1),
        disposition: z.enum(["cleared", "duplicate", "fraud_hold"]),
      })
      .parse(raw),
    row = await db
      .prepare(
        `SELECT d.*,t.account_id FROM publishing_duplicate_matches d JOIN publishing_asset_versions v ON v.id=d.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id JOIN publishing_edition_drafts e ON e.id=a.edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE d.id=?`,
      )
      .bind(x.id)
      .first<any>();
  if (!row) throw new ApiError(404, "Duplicate review item not found.");
  await db
    .prepare("UPDATE publishing_duplicate_matches SET disposition=?,updated_at=? WHERE id=?")
    .bind(x.disposition, now(), x.id)
    .run();
  await audit(db, row.account_id, reviewerUserId, "duplicate_match", x.id, "resolved", {
    disposition: x.disposition,
  });
  return { saved: true };
}

async function catalogPublishingAsset(env: PublishingEnv, assetVersionId: string) {
  const row = await env.DB.prepare(
    `SELECT av.object_key,av.mime_type,av.size_bytes,da.kind,p.storefront_status FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id JOIN editions e ON e.id=da.edition_id JOIN products p ON p.edition_id=e.id WHERE av.id=? AND da.kind='cover' AND p.storefront_status='active' LIMIT 1`,
  )
    .bind(assetVersionId)
    .first<any>();
  if (!row || !env.BUCKET) throw new ApiError(404, "Catalog asset not found.");
  const object = await env.BUCKET.get(row.object_key);
  if (!object) throw new ApiError(404, "Catalog asset not found.");
  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type || "application/octet-stream",
      "Content-Length": String(object.size || row.size_bytes || 0),
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

return {recordPublicationActivation,ensurePublishingLifecycle,ensureCatalogParties,transitionPublishingLifecycle,recordInlineResult,refreshAssetValidationSummary,upsertPublishingAccount,invitePublishingMember,startIdentityVerification,submitTaxProfile,submitPayoutAccount,savePublishingTitle,savePublishingEdition,uploadPublishingAsset,signPublishingAccessibilityDeclaration,submitPublishingEdition,openPublishingRevision,setPublishingUpdatePolicy,optInOwnedPublicationUpdate,reviewPublishingSubmission};
})();
const {recordPublicationActivation,ensurePublishingLifecycle,ensureCatalogParties}=privatePublishingEditor;
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- Historical partner SQL private to isolated QA-only owner. */
const privateTraditionalPartner=(()=>{
 const dispatchPartnerFeedProcessing=async (_db:unknown,_limit:unknown):Promise<never>=>{
  throw new ApiError(503,"Private partner feed processing requires independent intake verification.");
 };

type PartnerEnvironment = "sandbox" | "production";
type PartnerPrincipal = {
  credentialId: string;
  accountId: string;
  environment: PartnerEnvironment;
  actorUserId: string;
  keyPrefix: string;
  scopes: Set<string>;
};

type PartnerProduct = {
  productKey: string;
  recordReference?: string;
  workReference?: string;
  originalWorkTitle?: string;
  notificationType: "create" | "update" | "delete";
  title?: string;
  subtitle?: string;
  description?: string;
  language?: string;
  format?: "ebook" | "audiobook";
  editionLabel?: string;
  isbn13?: string | null;
  publisherIdentifier?: string;
  publisherName?: string;
  imprintName?: string;
  contributors?: {
    name: string;
    role: "author" | "editor" | "translator" | "illustrator" | "narrator" | "other";
    position: number;
  }[];
  rightsBasis?: "owned" | "licensed" | "public_domain";
  territories?: { mode: "worldwide" | "expression"; include: string[]; exclude: string[] };
  releaseDate?: string | null;
  preorderDate?: string | null;
  currency?: string;
  priceMinor?: number;
  availability?: "available" | "preorder" | "temporarily_unavailable" | "withdrawn";
  subscriptionPermitted?: boolean;
  libraryPermitted?: boolean;
  downloadable?: boolean;
  drmRequirement?: "none" | "watermark" | "lcp" | "adobe_acs";
  editionType?:
    | "canonical_public_domain"
    | "annotated"
    | "new_translation"
    | "illustrated"
    | "scholarly"
    | "commercial_audiobook"
    | "original";
  differentiationSummary?: string;
  contractReference?: string;
  sourceRevision?: string;
  assetKind?: "epub" | "cover" | "audio" | "sample" | "supplement";
  filename?: string;
  sha256?: string;
  sizeBytes?: number;
  mimeType?: string;
};

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const encoder = new TextEncoder();
const clean = (v: unknown, max = 1000) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

async function sha256(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function hmacSha256(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function derivedPartnerWebhookSecret(masterSecret: string, accountId: string) {
  if (!masterSecret || masterSecret.length < 32)
    throw new ApiError(503, "Partner webhook signing is not configured.");
  return `fwhsec_${bytesToBase64Url(await hmacSha256(masterSecret, `fore-partner-webhook-v1:${accountId}`))}`;
}

function randomToken(bytes = 32) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    const x = typeof value === "string" ? JSON.parse(value) : value;
    return (x ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function roleAllows(role: string, required: "analyst" | "editor" | "admin" | "owner") {
  const rank: Record<string, number> = { analyst: 1, finance: 1, editor: 2, admin: 3, owner: 4 };
  return (rank[role] || 0) >= (rank[required] || 99);
}

async function requirePartnerRole(
  db: CatalogDB,
  userId: string,
  accountId: string,
  required: "analyst" | "editor" | "admin" | "owner",
) {
  const member = await db
    .prepare("SELECT role,status FROM publishing_account_members WHERE account_id=? AND user_id=?")
    .bind(accountId, userId)
    .first<any>();
  if (!member || member.status !== "active" || !roleAllows(String(member.role), required))
    throw new ApiError(403, "You do not have permission to manage this publisher integration.");
  const account = await db
    .prepare("SELECT * FROM publishing_accounts WHERE id=?")
    .bind(accountId)
    .first<any>();
  if (!account || ["suspended", "closed"].includes(String(account.status)))
    throw new ApiError(403, "This publishing organization is not active.");
  return account;
}

async function partnerAudit(
  db: CatalogDB,
  input: {
    accountId: string;
    environment?: string;
    actorType: string;
    actorId?: string;
    eventType: string;
    subjectType?: string;
    subjectId?: string;
    event?: unknown;
  },
) {
  await db
    .prepare(
      "INSERT INTO publisher_partner_audit_events(id,account_id,environment,actor_type,actor_id,event_type,subject_type,subject_id,event_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id("paudit"),
      input.accountId,
      input.environment || "production",
      input.actorType,
      input.actorId || "",
      input.eventType,
      input.subjectType || "",
      input.subjectId || "",
      JSON.stringify(input.event || {}),
      now(),
    )
    .run();
}

function normalizedCountryList(value: unknown) {
  const values = Array.isArray(value) ? value : clean(value).split(/[\s,;]+/g);
  return [
    ...new Set(
      values
        .map((x) => clean(x, 2).toUpperCase())
        .filter((x) => /^[A-Z]{2}$/.test(x) && !["XX", "ZZ"].includes(x)),
    ),
  ].sort();
}

function safePartnerCallbackUrl(value: string) {
  if (!value) return "";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ApiError(400, "Partner callback URL is invalid.");
  }
  if (u.protocol !== "https:") throw new ApiError(400, "Partner callback URLs must use HTTPS.");
  if (u.username || u.password)
    throw new ApiError(400, "Partner callback URLs may not include embedded credentials.");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv6 = h.includes(":");
  const blocked =
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "0.0.0.0" ||
    h === "::" ||
    h === "::1" ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    h.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    (ipv6 && (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")));
  if (blocked)
    throw new ApiError(
      400,
      "Partner callback URLs may not target localhost or private network addresses.",
    );
  u.hash = "";
  return u.toString();
}

const profileSchema = z.object({
  accountId: z.string().min(1),
  partnerCode: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((v) => v.toUpperCase()),
  partnerType: z.enum(["publisher", "distributor", "aggregator", "agent"]).default("publisher"),
  integrationTier: z.enum(["managed", "api", "sftp", "hybrid"]).default("managed"),
  productionStatus: z
    .enum(["not_started", "testing", "certification", "active", "paused", "terminated"])
    .default("testing"),
  sandboxEnabled: z.boolean().default(true),
  metadataStandard: z.enum(["onix_3", "onix_2_1", "fore_json"]).default("onix_3"),
  defaultContractId: z.string().max(180).nullable().optional(),
  operationsEmail: z.string().email().or(z.literal("")).default(""),
  technicalEmail: z.string().email().or(z.literal("")).default(""),
  acknowledgementsUrl: z.string().url().or(z.literal("")).default(""),
  webhookUrl: z.string().url().or(z.literal("")).default(""),
  notes: z.string().max(5000).default(""),
});

async function savePartnerProfile(db: CatalogDB, userId: string, raw: unknown) {
  const x = profileSchema.parse(raw);
  await requirePartnerRole(db, userId, x.accountId, "admin");
  x.acknowledgementsUrl = safePartnerCallbackUrl(x.acknowledgementsUrl);
  x.webhookUrl = safePartnerCallbackUrl(x.webhookUrl);
  // Certification is a retailer-side control. Publisher admins may edit integration
  // settings, but cannot promote themselves to production or clear a staff pause.
  const existingProfile = await db
    .prepare("SELECT production_status FROM publisher_partner_profiles WHERE account_id=?")
    .bind(x.accountId)
    .first<any>();
  const productionStatus = existingProfile ? String(existingProfile.production_status) : "testing";
  if (x.defaultContractId) {
    const assigned = await db
      .prepare(
        "SELECT 1 ok FROM publisher_contract_assignments WHERE account_id=? AND contract_id=? AND status='active'",
      )
      .bind(x.accountId, x.defaultContractId)
      .first<any>();
    if (!assigned)
      throw new ApiError(
        400,
        "The default contract must be actively assigned to this publishing organization.",
      );
  }
  const at = now();
  await db
    .prepare(
      `INSERT INTO publisher_partner_profiles(account_id,partner_code,partner_type,integration_tier,production_status,sandbox_enabled,metadata_standard,default_contract_id,operations_email,technical_email,acknowledgements_url,webhook_url,notes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET partner_code=excluded.partner_code,partner_type=excluded.partner_type,integration_tier=excluded.integration_tier,sandbox_enabled=excluded.sandbox_enabled,metadata_standard=excluded.metadata_standard,default_contract_id=excluded.default_contract_id,operations_email=excluded.operations_email,technical_email=excluded.technical_email,acknowledgements_url=excluded.acknowledgements_url,webhook_url=excluded.webhook_url,notes=excluded.notes,updated_at=excluded.updated_at`,
    )
    .bind(
      x.accountId,
      x.partnerCode,
      x.partnerType,
      x.integrationTier,
      productionStatus,
      x.sandboxEnabled ? 1 : 0,
      x.metadataStandard,
      x.defaultContractId || null,
      x.operationsEmail,
      x.technicalEmail,
      x.acknowledgementsUrl,
      x.webhookUrl,
      x.notes,
      at,
      at,
    )
    .run();
  if (x.acknowledgementsUrl || x.webhookUrl) {
    await db
      .prepare(
        `UPDATE publisher_validation_responses SET delivery_status='pending',next_attempt_at=?,last_error='' WHERE delivery_status='not_configured' AND submission_id IN (SELECT id FROM publisher_feed_submissions WHERE account_id=?)`,
      )
      .bind(at, x.accountId)
      .run();
  }
  await partnerAudit(db, {
    accountId: x.accountId,
    actorType: "user",
    actorId: userId,
    eventType: "partner.profile.saved",
    subjectType: "partner",
    subjectId: x.accountId,
    event: { partnerCode: x.partnerCode, productionStatus },
  });
  return { accountId: x.accountId, updatedAt: at };
}

async function certifyPartnerProfile(db: CatalogDB, actorUserId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      productionStatus: z.enum([
        "not_started",
        "testing",
        "certification",
        "active",
        "paused",
        "terminated",
      ]),
      reason: z.string().trim().min(3).max(2000),
    })
    .parse(raw);
  const profile = await db
    .prepare(
      "SELECT account_id,production_status,partner_code FROM publisher_partner_profiles WHERE account_id=?",
    )
    .bind(x.accountId)
    .first<any>();
  if (!profile) throw new ApiError(404, "Partner integration profile not found.");
  const previous = String(profile.production_status);
  if (previous === "terminated" && x.productionStatus !== "terminated")
    throw new ApiError(
      409,
      "A terminated partner must be re-onboarded under a new staff-approved process rather than reactivated in place.",
    );
  if (x.productionStatus === "active") {
    const [assignment, activeVersion] = await Promise.all([
      db
        .prepare(
          "SELECT contract_id FROM publisher_contract_assignments WHERE account_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1",
        )
        .bind(x.accountId, now(), now())
        .first<any>(),
      db
        .prepare(
          `SELECT rcv.id FROM publisher_contract_assignments a JOIN rights_contract_versions rcv ON rcv.contract_id=a.contract_id WHERE a.account_id=? AND a.status='active' AND rcv.status='active' AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?) LIMIT 1`,
        )
        .bind(x.accountId, now(), now())
        .first<any>(),
    ]);
    if (!assignment || !activeVersion)
      throw new ApiError(
        409,
        "Production activation requires an active assigned distribution contract with an effective approved contract version.",
      );
  }
  const at = now();
  await db
    .prepare(
      "UPDATE publisher_partner_profiles SET production_status=?,updated_at=? WHERE account_id=?",
    )
    .bind(x.productionStatus, at, x.accountId)
    .run();
  if (["paused", "terminated"].includes(x.productionStatus))
    await db
      .prepare(
        "UPDATE publisher_partner_credentials SET status='revoked',revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND environment='production' AND status='active'",
      )
      .bind(at, x.accountId)
      .run();
  await partnerAudit(db, {
    accountId: x.accountId,
    environment: "production",
    actorType: "user",
    actorId: actorUserId,
    eventType: "partner.certification.changed",
    subjectType: "partner",
    subjectId: x.accountId,
    event: { from: previous, to: x.productionStatus, reason: x.reason },
  });
  return { accountId: x.accountId, from: previous, to: x.productionStatus, updatedAt: at };
}

const channelSchema = z.object({
  id: z.string().max(180).optional(),
  accountId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  channelType: z.enum(["api", "sftp", "object_drop"]),
  label: z.string().trim().min(1).max(120),
  status: z.enum(["active", "paused", "disabled"]).default("active"),
  metadataFormat: z.enum(["onix_3", "onix_2_1", "fore_json"]).default("onix_3"),
  config: z.record(z.string(), z.unknown()).default({}),
  secretReference: z.string().max(500).default(""),
});
async function savePartnerChannel(db: CatalogDB, userId: string, raw: unknown) {
  const x = channelSchema.parse(raw);
  await requirePartnerRole(db, userId, x.accountId, "admin");
  if (x.channelType === "sftp" && !x.secretReference)
    throw new ApiError(
      400,
      "SFTP channels must point to a secret-manager credential reference. Raw passwords/private keys are not stored in Cove.",
    );
  const disallowed = ["password", "privateKey", "secret", "token"].filter((k) =>
    Object.keys(x.config).some((v) => v.toLowerCase().includes(k.toLowerCase())),
  );
  if (disallowed.length)
    throw new ApiError(
      400,
      "Channel config may contain only non-secret transport settings. Store credentials in your secret manager and provide secretReference.",
    );
  const channelId = x.id || id("pchannel"),
    at = now();
  await db
    .prepare(
      `INSERT INTO publisher_ingestion_channels(id,account_id,environment,channel_type,label,status,metadata_format,config_json,secret_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET environment=excluded.environment,channel_type=excluded.channel_type,label=excluded.label,status=excluded.status,metadata_format=excluded.metadata_format,config_json=excluded.config_json,secret_reference=excluded.secret_reference,updated_at=excluded.updated_at`,
    )
    .bind(
      channelId,
      x.accountId,
      x.environment,
      x.channelType,
      x.label,
      x.status,
      x.metadataFormat,
      JSON.stringify(x.config),
      x.secretReference,
      at,
      at,
    )
    .run();
  await partnerAudit(db, {
    accountId: x.accountId,
    environment: x.environment,
    actorType: "user",
    actorId: userId,
    eventType: "partner.channel.saved",
    subjectType: "channel",
    subjectId: channelId,
    event: { channelType: x.channelType, label: x.label },
  });
  return { id: channelId };
}

const credentialSchema = z.object({
  accountId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  label: z.string().trim().min(1).max(120),
  scopes: z
    .array(z.enum(["feeds:write", "feeds:read", "assets:write", "catalog:read"]))
    .min(1)
    .max(4)
    .default(["feeds:write", "feeds:read"]),
  ipAllowlist: z.array(z.string().trim().min(3).max(80)).max(100).default([]),
  expiresAt: z.string().datetime().nullable().optional(),
});
async function issuePartnerCredential(db: CatalogDB, userId: string, raw: unknown) {
  const x = credentialSchema.parse(raw);
  await requirePartnerRole(db, userId, x.accountId, "admin");
  const profile = await db
    .prepare("SELECT * FROM publisher_partner_profiles WHERE account_id=?")
    .bind(x.accountId)
    .first<any>();
  if (!profile)
    throw new ApiError(
      409,
      "Configure the traditional-publisher partner profile before issuing credentials.",
    );
  if (x.environment === "production" && String(profile.production_status) !== "active")
    throw new ApiError(
      409,
      "Production credentials are issued only after partner certification is active.",
    );
  if (x.environment === "sandbox" && !Number(profile.sandbox_enabled))
    throw new ApiError(409, "Sandbox access is disabled for this partner.");
  const prefix = `fore_${x.environment === "production" ? "live" : "test"}_${randomToken(8)}`,
    secret = randomToken(32),
    presented = `${prefix}.${secret}`,
    hash = await sha256(presented),
    credentialId = id("pcred"),
    at = now();
  await db
    .prepare(
      "INSERT INTO publisher_partner_credentials(id,account_id,environment,label,key_prefix,secret_hash,scopes_json,ip_allowlist_json,actor_user_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)",
    )
    .bind(
      credentialId,
      x.accountId,
      x.environment,
      x.label,
      prefix,
      hash,
      JSON.stringify(x.scopes),
      JSON.stringify(x.ipAllowlist),
      userId,
      x.expiresAt || null,
      at,
    )
    .run();
  await partnerAudit(db, {
    accountId: x.accountId,
    environment: x.environment,
    actorType: "user",
    actorId: userId,
    eventType: "partner.credential.issued",
    subjectType: "credential",
    subjectId: credentialId,
    event: { label: x.label, scopes: x.scopes, keyPrefix: prefix },
  });
  return {
    id: credentialId,
    environment: x.environment,
    keyPrefix: prefix,
    secret: presented,
    scopes: x.scopes,
    expiresAt: x.expiresAt || null,
    warning:
      "Copy this credential now. Cove stores only its cryptographic digest and cannot show the secret again.",
  };
}

async function revokePartnerCredential(db: CatalogDB, userId: string, raw: unknown) {
  const x = z.object({ accountId: z.string().min(1), credentialId: z.string().min(1) }).parse(raw);
  await requirePartnerRole(db, userId, x.accountId, "admin");
  const row = await db
    .prepare("SELECT id,environment FROM publisher_partner_credentials WHERE id=? AND account_id=?")
    .bind(x.credentialId, x.accountId)
    .first<any>();
  if (!row) throw new ApiError(404, "Partner credential not found.");
  const at = now();
  await db
    .prepare("UPDATE publisher_partner_credentials SET status='revoked',revoked_at=? WHERE id=?")
    .bind(at, x.credentialId)
    .run();
  await partnerAudit(db, {
    accountId: x.accountId,
    environment: row.environment,
    actorType: "user",
    actorId: userId,
    eventType: "partner.credential.revoked",
    subjectType: "credential",
    subjectId: x.credentialId,
  });
  return { revoked: true, revokedAt: at };
}

function ipMatchesRule(ip: string, rule: string) {
  if (!rule) return false;
  if (ip === rule) return true;
  // Conservative CIDR support for IPv4. IPv6 allowlists should use exact addresses until a dedicated parser is deployed.
  const m = rule.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d{1,2})$/);
  const p = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m || !p) return false;
  const bits = Number(m[5]);
  if (bits < 0 || bits > 32) return false;
  const toN = (a: RegExpMatchArray) =>
    (((Number(a[1]) << 24) >>> 0) + (Number(a[2]) << 16) + (Number(a[3]) << 8) + Number(a[4])) >>>
    0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toN(m) & mask) === (toN(p) & mask);
}

async function authenticatePartnerRequest(
  db: CatalogDB,
  request: Request,
  requiredScope: string,
): Promise<PartnerPrincipal> {
  const supplied = clean(
    request.headers.get("x-fore-partner-key") ||
      request.headers.get("authorization")?.replace(/^CovePartner\s+/i, ""),
    500,
  );
  const dot = supplied.indexOf(".");
  if (dot < 10) throw new ApiError(401, "A valid Cove partner credential is required.");
  const prefix = supplied.slice(0, dot);
  const row = await db
    .prepare("SELECT * FROM publisher_partner_credentials WHERE key_prefix=?")
    .bind(prefix)
    .first<any>();
  if (!row || row.status !== "active" || (row.expires_at && String(row.expires_at) <= now()))
    throw new ApiError(401, "This Cove partner credential is invalid or expired.");
  const hash = await sha256(supplied);
  let diff = hash.length ^ String(row.secret_hash).length;
  for (let i = 0; i < Math.max(hash.length, String(row.secret_hash).length); i++)
    diff |= (hash.charCodeAt(i) || 0) ^ (String(row.secret_hash).charCodeAt(i) || 0);
  if (diff !== 0) throw new ApiError(401, "This Cove partner credential is invalid or expired.");
  const scopes = new Set(parseJson<string[]>(row.scopes_json, []));
  if (!scopes.has(requiredScope))
    throw new ApiError(403, `Partner credential lacks ${requiredScope}.`);
  const allowlist = parseJson<string[]>(row.ip_allowlist_json, []);
  const ip = clean(
    request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0],
    100,
  );
  if (allowlist.length && !allowlist.some((r) => ipMatchesRule(ip, r)))
    throw new ApiError(403, "This client address is not allowed for the partner credential.");
  const profile = await db
    .prepare(
      "SELECT production_status,sandbox_enabled FROM publisher_partner_profiles WHERE account_id=?",
    )
    .bind(row.account_id)
    .first<any>();
  if (!profile) throw new ApiError(403, "Partner integration is not configured.");
  if (row.environment === "production" && String(profile.production_status) !== "active")
    throw new ApiError(403, "Production partner ingestion is not active.");
  if (row.environment === "sandbox" && !Number(profile.sandbox_enabled))
    throw new ApiError(403, "Partner sandbox access is disabled.");
  await db
    .prepare("UPDATE publisher_partner_credentials SET last_used_at=? WHERE id=?")
    .bind(now(), row.id)
    .run();
  return {
    credentialId: String(row.id),
    accountId: String(row.account_id),
    environment: row.environment,
    actorUserId: String(row.actor_user_id),
    keyPrefix: prefix,
    scopes,
  };
}

function xmlDecode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tagText(xml: string, tags: string[]) {
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\// QA-leased worker queues. All job ownership and retry transitions");
    const m = xml.match(
      new RegExp(
        `<(?:(?:[A-Za-z0-9_-]+):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${escaped}>`,
        "i",
      ),
    );
    if (m) return xmlDecode(m[1]);
  }
  return "";
}
function tagBlocks(xml: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\// QA-leased worker queues. All job ownership and retry transitions");
  return [
    ...xml.matchAll(
      new RegExp(
        `<(?:(?:[A-Za-z0-9_-]+):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${escaped}>`,
        "gi",
      ),
    ),
  ].map((m) => m[1]);
}
function onixDate(value: string) {
  const v = value.replace(/\D/g, "");
  if (v.length >= 8) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00.000Z`;
  if (v.length >= 6) return `${v.slice(0, 4)}-${v.slice(4, 6)}-01T00:00:00.000Z`;
  if (v.length >= 4) return `${v.slice(0, 4)}-01-01T00:00:00.000Z`;
  return null;
}
function onixRole(
  code: string,
): "author" | "editor" | "translator" | "illustrator" | "narrator" | "other" {
  const c = code.toUpperCase();
  if (["B06", "B10"].includes(c)) return "translator";
  if (["A12", "A13"].includes(c)) return "illustrator";
  if (c === "E07") return "narrator";
  if (["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09", "A10", "A11"].includes(c))
    return "author";
  if (/^B\d{2}$/.test(c)) return "editor";
  return "other";
}
function onixAvailability(code: string): PartnerProduct["availability"] {
  if (["20", "21", "22", "23", "30", "31", "32", "33", "40"].includes(code)) return "available";
  if (["10", "11", "12", "13", "14", "15", "16", "17"].includes(code)) return "preorder";
  if (["41", "42", "43", "44", "45", "46", "47", "48"].includes(code))
    return "temporarily_unavailable";
  if (
    [
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "50",
      "51",
      "52",
      "53",
      "54",
      "55",
      "56",
      "57",
      "58",
      "59",
      "60",
      "61",
      "62",
      "63",
      "64",
      "65",
      "66",
      "67",
      "68",
      "69",
      "70",
      "71",
      "72",
      "73",
      "74",
      "75",
      "76",
      "77",
      "78",
      "79",
      "80",
      "81",
      "82",
      "83",
      "84",
      "85",
      "86",
      "87",
      "88",
      "89",
      "90",
      "91",
      "92",
      "93",
      "94",
      "95",
      "96",
      "97",
      "98",
      "99",
    ].includes(code)
  )
    return "withdrawn";
  return "available";
}

function parseOnix(xml: string): {
  products: PartnerProduct[];
  warnings: string[];
  version: string;
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new ApiError(
      400,
      "ONIX feeds containing DTD/entity declarations are rejected. Submit self-contained ONIX XML without external entities.",
    );
  if (
    /<(?:a001|b221|b244|j151|j152)\b/i.test(xml) &&
    !/<(?:Product|RecordReference|ProductIdentifier)\b/i.test(xml)
  )
    throw new ApiError(
      400,
      "ONIX short-tag-only feeds are not accepted by Cove's in-process parser. Configure the partner channel to send ONIX reference tags; the ingestion acknowledgement fails closed rather than guessing short-tag semantics.",
    );
  const version = /release\s*=\s*["']3/i.test(xml) ? "onix_3" : "onix_2_1",
    blocks = tagBlocks(xml, "Product");
  if (!blocks.length) throw new ApiError(400, "No ONIX Product records were found.");
  const warnings: string[] = [],
    products: PartnerProduct[] = [];
  blocks.forEach((block, ordinal) => {
    const recordReference = tagText(block, ["RecordReference"]);
    const notificationCode = tagText(block, ["NotificationType"]);
    const notificationType: PartnerProduct["notificationType"] =
      notificationCode === "05"
        ? "delete"
        : ["01", "02", "03"].includes(notificationCode)
          ? "create"
          : "update";
    const identifiers = tagBlocks(block, "ProductIdentifier").map((b) => ({
      type: tagText(b, ["ProductIDType"]),
      value: tagText(b, ["IDValue"]),
    }));
    const isbn =
      identifiers.find((x) => x.type === "15" && /^\d{13}$/.test(x.value))?.value || null;
    const proprietary = identifiers.find((x) => x.type === "01")?.value || "";
    const productKey = recordReference || isbn || proprietary;
    if (!productKey) {
      warnings.push(`Product ${ordinal + 1} has no RecordReference/ISBN/proprietary identifier.`);
      return;
    }
    const titleDetail = tagBlocks(block, "TitleDetail")[0] || tagBlocks(block, "Title")[0] || block;
    const title = tagText(titleDetail, ["TitleText", "TitleWithoutPrefix"]);
    const subtitle = tagText(titleDetail, ["Subtitle"]);
    const description =
      tagBlocks(block, "TextContent")
        .map((t) => tagText(t, ["Text"]))
        .find(Boolean) || tagText(block, ["Annotation", "OtherText"]);
    const contributors = tagBlocks(block, "Contributor")
      .map((c, i) => ({
        name: tagText(c, ["PersonName", "PersonNameInverted", "CorporateName"]),
        role: onixRole(tagText(c, ["ContributorRole"])),
        position: Number(tagText(c, ["SequenceNumber"]) || i),
      }))
      .filter((c) => c.name)
      .slice(0, 50);
    const languageBlock =
      tagBlocks(block, "Language").find((l) => ["01", ""].includes(tagText(l, ["LanguageRole"]))) ||
      tagBlocks(block, "Language")[0] ||
      "";
    const language = (tagText(languageBlock, ["LanguageCode"]) || "en").toLowerCase();
    const publisherBlock = tagBlocks(block, "Publisher")[0] || "";
    const publisherName = tagText(publisherBlock, ["PublisherName"]);
    const imprintName = tagText(tagBlocks(block, "Imprint")[0] || "", ["ImprintName"]);
    const pubDates = tagBlocks(block, "PublishingDate");
    const releaseDate = onixDate(
      tagText(
        pubDates.find((d) => ["01", "11"].includes(tagText(d, ["PublishingDateRole"]))) ||
          pubDates[0] ||
          "",
        ["Date"],
      ),
    );
    const supply = tagBlocks(block, "SupplyDetail")[0] || block;
    const availability = onixAvailability(
      tagText(supply, ["ProductAvailability", "ProductAvailabilityCode"]),
    );
    const prices = tagBlocks(supply, "Price");
    const retailPrice =
      prices.find((p) =>
        ["01", "02", "04", "41", "42"].includes(tagText(p, ["PriceType", "PriceTypeCode"])),
      ) ||
      prices[0] ||
      "";
    const amountRaw = tagText(retailPrice, ["PriceAmount"]);
    const currency = (tagText(retailPrice, ["CurrencyCode"]) || "USD").toUpperCase();
    const priceMinor =
      amountRaw && !Number.isNaN(Number(amountRaw))
        ? Math.round(Number(amountRaw) * 100)
        : undefined;
    const territoryBlocks = [
      ...tagBlocks(block, "Territory"),
      ...tagBlocks(retailPrice, "Territory"),
    ];
    const included = normalizedCountryList(
      territoryBlocks.flatMap((t) => tagText(t, ["CountriesIncluded"]).split(/\s+/g)),
    );
    const excluded = normalizedCountryList(
      territoryBlocks.flatMap((t) => tagText(t, ["CountriesExcluded"]).split(/\s+/g)),
    );
    const form = tagText(block, ["ProductForm", "ProductFormDetail"]);
    const format: "ebook" | "audiobook" = /audio|spoken|EC|ED|EA/i.test(form)
      ? "audiobook"
      : "ebook";
    const relatedWork = tagBlocks(block, "RelatedWork")[0] || "",
      workIdentifier = tagBlocks(relatedWork, "WorkIdentifier")[0] || "",
      workIdType = tagText(workIdentifier, ["WorkIDType"]),
      workIdValue = tagText(workIdentifier, ["IDValue"]),
      workReference = workIdValue ? `${workIdType || "01"}:${workIdValue}` : "";
    products.push({
      productKey,
      recordReference,
      workReference: workReference || undefined,
      notificationType,
      title: title || undefined,
      subtitle,
      description,
      language,
      format,
      editionLabel: tagText(block, ["EditionStatement"]),
      isbn13: isbn,
      publisherIdentifier: proprietary || recordReference,
      publisherName,
      imprintName,
      contributors,
      rightsBasis: "licensed",
      territories: {
        mode: included.length ? "expression" : "worldwide",
        include: included,
        exclude: excluded,
      },
      releaseDate,
      currency,
      priceMinor,
      availability,
      editionType: format === "audiobook" ? "commercial_audiobook" : "original",
    });
  });
  return { products, warnings, version };
}

const partnerProductSchema = z.object({
  productKey: z.string().trim().min(1).max(300),
  recordReference: z.string().max(300).optional(),
  workReference: z.string().max(500).optional(),
  originalWorkTitle: z.string().max(500).optional(),
  notificationType: z.enum(["create", "update", "delete"]).default("update"),
  title: z.string().trim().max(500).optional(),
  subtitle: z.string().max(500).default(""),
  description: z.string().max(30000).default(""),
  language: z.string().min(2).max(35).default("en"),
  format: z.enum(["ebook", "audiobook"]).default("ebook"),
  editionLabel: z.string().max(180).default(""),
  isbn13: z
    .string()
    .regex(/^\d{13}$/)
    .nullable()
    .optional(),
  publisherIdentifier: z.string().max(300).default(""),
  publisherName: z.string().max(300).default(""),
  imprintName: z.string().max(300).default(""),
  contributors: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(300),
        role: z.enum(["author", "editor", "translator", "illustrator", "narrator", "other"]),
        position: z.number().int().min(0).max(1000).default(0),
      }),
    )
    .max(100)
    .default([]),
  rightsBasis: z.enum(["owned", "licensed", "public_domain"]).default("licensed"),
  territories: z
    .object({
      mode: z.enum(["worldwide", "expression"]).default("worldwide"),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .optional(),
  releaseDate: z.string().datetime().nullable().optional(),
  preorderDate: z.string().datetime().nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((v) => v.toUpperCase())
    .default("USD"),
  priceMinor: z.number().int().min(0).max(100000000).optional(),
  availability: z
    .enum(["available", "preorder", "temporarily_unavailable", "withdrawn"])
    .optional(),
  subscriptionPermitted: z.boolean().default(false),
  libraryPermitted: z.boolean().default(false),
  downloadable: z.boolean().default(true),
  drmRequirement: z.enum(["none", "watermark", "lcp", "adobe_acs"]).default("none"),
  editionType: z
    .enum([
      "canonical_public_domain",
      "annotated",
      "new_translation",
      "illustrated",
      "scholarly",
      "commercial_audiobook",
      "original",
    ])
    .default("original"),
  differentiationSummary: z.string().max(5000).default(""),
  contractReference: z.string().max(300).default(""),
  sourceRevision: z.string().max(300).default(""),
  assetKind: z.enum(["epub", "cover", "audio", "sample", "supplement"]).optional(),
  filename: z.string().trim().min(1).max(240).optional(),
  sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .transform((v) => v.toLowerCase())
    .optional(),
  sizeBytes: z.number().int().min(0).max(2_000_000_000).optional(),
  mimeType: z.string().max(120).optional(),
});

function validatePartnerProduct(product: PartnerProduct, feedType: string) {
  const issues: { severity: "warning" | "error"; code: string; message: string }[] = [];
  if (feedType === "metadata" && product.notificationType !== "delete") {
    if (!product.title?.trim())
      issues.push({
        severity: "error",
        code: "TITLE_REQUIRED",
        message: "Metadata records require a title.",
      });
    if (product.priceMinor == null)
      issues.push({
        severity: "error",
        code: "INITIAL_PRICE_REQUIRED",
        message:
          "Metadata records require an explicit initial priceMinor, including an intentional zero price. Subsequent changes may use the dedicated price feed.",
      });
    if (!product.territories)
      issues.push({
        severity: "error",
        code: "INITIAL_TERRITORY_REQUIRED",
        message:
          "Metadata records require an explicit initial territory scope. Subsequent changes may use the dedicated territory feed.",
      });
    if (!product.contributors?.some((c) => c.role === "author") && product.format !== "audiobook")
      issues.push({
        severity: "warning",
        code: "AUTHOR_MISSING",
        message: "No author contributor was supplied.",
      });
    if (product.rightsBasis === "public_domain") {
      if (["original", "canonical_public_domain"].includes(String(product.editionType)))
        issues.push({
          severity: "error",
          code: "PUBLIC_DOMAIN_DIFFERENTIATION_REQUIRED",
          message:
            "Commercial public-domain submissions must declare a differentiated edition (annotated, new translation, illustrated, scholarly, or commercial audiobook). Cove reserves canonical_public_domain for canonical free-source ingestion.",
        });
      if (!product.differentiationSummary?.trim())
        issues.push({
          severity: "error",
          code: "DIFFERENTIATION_SUMMARY_REQUIRED",
          message: "Explain the substantive differentiation from the canonical public-domain text.",
        });
      if (
        product.editionType === "new_translation" &&
        !product.contributors?.some((c) => c.role === "translator")
      )
        issues.push({
          severity: "error",
          code: "TRANSLATOR_REQUIRED",
          message: "A new translation must identify at least one translator.",
        });
    }
    if (product.editionType === "commercial_audiobook" && product.format !== "audiobook")
      issues.push({
        severity: "error",
        code: "EDITION_FORMAT_MISMATCH",
        message: "commercial_audiobook classification requires audiobook format.",
      });
  }
  if (["price", "availability", "territory"].includes(feedType) && !product.productKey)
    issues.push({
      severity: "error",
      code: "PRODUCT_KEY_REQUIRED",
      message: "Delta records require partnerProductKey.",
    });
  if (feedType === "price" && product.priceMinor == null)
    issues.push({
      severity: "error",
      code: "PRICE_REQUIRED",
      message: "Price feed records require priceMinor.",
    });
  if (feedType === "availability" && !product.availability)
    issues.push({
      severity: "error",
      code: "AVAILABILITY_REQUIRED",
      message: "Availability feed records require availability.",
    });
  if (feedType === "territory" && !product.territories)
    issues.push({
      severity: "error",
      code: "TERRITORY_SCOPE_REQUIRED",
      message: "Territory feed records require an explicit territory scope.",
    });
  if (feedType === "assets_manifest") {
    if (!product.assetKind)
      issues.push({
        severity: "error",
        code: "ASSET_KIND_REQUIRED",
        message: "Asset manifest records require assetKind.",
      });
    if (!product.filename)
      issues.push({
        severity: "error",
        code: "ASSET_FILENAME_REQUIRED",
        message: "Asset manifest records require filename.",
      });
    if (!product.sha256)
      issues.push({
        severity: "error",
        code: "ASSET_SHA256_REQUIRED",
        message: "Asset manifest records require sha256.",
      });
    if (product.sizeBytes == null)
      issues.push({
        severity: "error",
        code: "ASSET_SIZE_REQUIRED",
        message: "Asset manifest records require sizeBytes.",
      });
  }
  if (product.territories) {
    product.territories.include = normalizedCountryList(product.territories.include);
    product.territories.exclude = normalizedCountryList(product.territories.exclude);
  }
  return issues;
}

async function readBounded(request: Request, limit: number) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > limit) throw new ApiError(413, "Partner feed exceeds the configured upload limit.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit)
    throw new ApiError(413, "Partner feed exceeds the configured upload limit.");
  return bytes;
}

async function submitPartnerFeed(
  env: CoveEnv,
  request: Request,
  principal: PartnerPrincipal,
) {
  const bytes = await readBounded(request, 25 * 1024 * 1024),
    text = new TextDecoder().decode(bytes),
    contentType = (request.headers.get("content-type") || "").toLowerCase();
  const declaredFormat =
    clean(request.headers.get("x-fore-feed-format"), 30) ||
    (contentType.includes("xml") ? "onix_3" : "fore_json");
  const feedType = z
    .enum(["metadata", "price", "availability", "territory", "assets_manifest"])
    .parse(clean(request.headers.get("x-fore-feed-type"), 40) || "metadata");
  const mode = z
    .enum(["full", "delta"])
    .parse(clean(request.headers.get("x-fore-feed-mode"), 20) || "delta");
  const replaceMissing =
    mode === "full" &&
    feedType === "metadata" &&
    ["1", "true", "yes"].includes(
      clean(request.headers.get("x-fore-full-feed-delete-missing"), 10).toLowerCase(),
    );
  const externalFeedId =
    clean(request.headers.get("x-fore-feed-id"), 200) || `auto_${await sha256(bytes)}`;
  const sequenceRaw = clean(request.headers.get("x-fore-feed-sequence"), 30);
  const sequenceNumber = sequenceRaw ? z.coerce.number().int().min(0).parse(sequenceRaw) : null;
  const filename = clean(request.headers.get("x-fore-filename"), 240);
  const channelId = clean(request.headers.get("x-fore-channel-id"), 180) || null;
  const format = z.enum(["onix_3", "onix_2_1", "fore_json"]).parse(declaredFormat);
  const digest = await sha256(bytes),
    db = env.DB;
  if (channelId) {
    const channel = await db
      .prepare(
        "SELECT id,channel_type,metadata_format FROM publisher_ingestion_channels WHERE id=? AND account_id=? AND environment=? AND status='active'",
      )
      .bind(channelId, principal.accountId, principal.environment)
      .first<any>();
    if (!channel)
      throw new ApiError(
        409,
        "The declared ingestion channel is not active for this partner/environment.",
      );
    if (feedType !== "assets_manifest" && String(channel.metadata_format) !== format)
      throw new ApiError(
        409,
        `Feed format ${format} does not match ingestion channel ${channelId} (${channel.metadata_format}).`,
      );
  }
  const existing = await db
    .prepare(
      "SELECT id,status,item_count,accepted_count,warning_count,rejected_count,applied_count FROM publisher_feed_submissions WHERE account_id=? AND environment=? AND feed_type=? AND (external_feed_id=? OR source_sha256=?) ORDER BY received_at DESC LIMIT 1",
    )
    .bind(principal.accountId, principal.environment, feedType, externalFeedId, digest)
    .first<any>();
  if (existing) return { ...existing, idempotentReplay: true };
  const cursor = await db
    .prepare(
      "SELECT last_sequence_number FROM publisher_feed_cursors WHERE account_id=? AND environment=? AND feed_type=?",
    )
    .bind(principal.accountId, principal.environment, feedType)
    .first<any>();
  if (
    sequenceNumber != null &&
    cursor?.last_sequence_number != null &&
    Number(sequenceNumber) <= Number(cursor.last_sequence_number)
  )
    throw new ApiError(
      409,
      `Feed sequence ${sequenceNumber} is not newer than the last accepted sequence ${cursor.last_sequence_number}.`,
    );
  let rawProducts: unknown[] = [],
    parserWarnings: string[] = [],
    detectedFormat = format;
  if (format === "fore_json") {
    let doc: any;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new ApiError(400, "Partner JSON feed is not valid JSON.");
    }
    rawProducts = Array.isArray(doc)
      ? doc
      : feedType === "assets_manifest" && Array.isArray(doc.assets)
        ? doc.assets
        : Array.isArray(doc.products)
          ? doc.products
          : [];
    if (!rawProducts.length)
      throw new ApiError(
        400,
        feedType === "assets_manifest"
          ? "Asset manifest feeds must contain a non-empty assets array."
          : "Partner JSON feed must contain a non-empty products array.",
      );
  } else {
    if (feedType === "assets_manifest")
      throw new ApiError(
        400,
        "Asset manifests use Cove JSON; ONIX is reserved for bibliographic metadata.",
      );
    const parsed = parseOnix(text);
    rawProducts = parsed.products;
    parserWarnings = parsed.warnings;
    detectedFormat = parsed.version as typeof format;
  }
  const parsedProducts: PartnerProduct[] = [];
  const staged: { product: PartnerProduct; issues: any[]; fragmentSha: string }[] = [];
  for (const raw of rawProducts.slice(0, 100000)) {
    let product: PartnerProduct;
    try {
      product = partnerProductSchema.parse(raw) as PartnerProduct;
    } catch (e) {
      const issue = {
        severity: "error",
        code: "SCHEMA_INVALID",
        message: e instanceof Error ? e.message.slice(0, 1500) : "Invalid product record.",
      };
      staged.push({
        product: {
          productKey: clean(
            (raw as any)?.productKey ||
              (raw as any)?.recordReference ||
              `invalid_${staged.length + 1}`,
          ),
          notificationType: "update",
        },
        issues: [issue],
        fragmentSha: await sha256(JSON.stringify(raw)),
      });
      continue;
    }
    const issues = validatePartnerProduct(product, feedType);
    parsedProducts.push(product);
    staged.push({ product, issues, fragmentSha: await sha256(JSON.stringify(product)) });
  }
  if (rawProducts.length > 100000)
    throw new ApiError(
      413,
      "A single feed may contain at most 100,000 product records. Split larger catalogs into sequenced feed parts.",
    );
  const rejected = staged.filter((s) => s.issues.some((i) => i.severity === "error")).length,
    warningItems = staged.filter(
      (s) =>
        !s.issues.some((i) => i.severity === "error") &&
        s.issues.some((i) => i.severity === "warning"),
    ).length,
    accepted = staged.length - rejected;
  const submissionId = id("pfeed"),
    at = now(),
    status =
      rejected === staged.length
        ? "rejected"
        : rejected > 0 || warningItems > 0 || parserWarnings.length
          ? "accepted_with_warnings"
          : "accepted";
  let rawObjectKey: string | null = null;
  if (env.BUCKET) {
    rawObjectKey = `partner-ingest/${principal.environment}/${principal.accountId}/${submissionId}/source.${format === "fore_json" ? "json" : "xml"}`;
    await env.BUCKET.put(rawObjectKey, bytes, {
      httpMetadata: {
        contentType:
          contentType || (format === "fore_json" ? "application/json" : "application/xml"),
      },
      customMetadata: {
        sha256: digest,
        accountId: principal.accountId,
        feedType,
        environment: principal.environment,
      },
    });
  }
  const statements: any[] = [
    db
      .prepare(
        `INSERT INTO publisher_feed_submissions(id,account_id,credential_id,channel_id,environment,feed_type,feed_format,mode,replace_missing,external_feed_id,sequence_number,source_filename,source_sha256,raw_object_key,status,item_count,accepted_count,warning_count,rejected_count,error_summary,received_at,validated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        submissionId,
        principal.accountId,
        principal.credentialId,
        channelId,
        principal.environment,
        feedType,
        detectedFormat,
        mode,
        replaceMissing ? 1 : 0,
        externalFeedId,
        sequenceNumber,
        filename,
        digest,
        rawObjectKey,
        status,
        staged.length,
        accepted,
        warningItems + parserWarnings.length,
        rejected,
        rejected ? `${rejected} item(s) rejected.` : "",
        at,
        at,
      ),
  ];
  staged.forEach((s, ordinal) =>
    statements.push(
      db
        .prepare(
          "INSERT INTO publisher_feed_items(id,submission_id,ordinal,partner_product_key,notification_type,normalized_json,source_fragment_sha256,status,validation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id("pfitem"),
          submissionId,
          ordinal + 1,
          s.product.productKey,
          s.product.notificationType,
          JSON.stringify(s.product),
          s.fragmentSha,
          s.issues.some((i) => i.severity === "error")
            ? "rejected"
            : s.issues.length
              ? "warning"
              : "valid",
          JSON.stringify(s.issues),
          at,
          at,
        ),
    ),
  );
  statements.push(
    db
      .prepare(
        "INSERT INTO publisher_validation_responses(id,submission_id,response_type,status,machine_code,message,payload_json,delivery_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id("pack"),
        submissionId,
        "receipt",
        "received",
        "FEED_RECEIVED",
        "Feed received and validated by Cove.",
        JSON.stringify({
          submissionId,
          itemCount: staged.length,
          acceptedCount: accepted,
          rejectedCount: rejected,
          warningCount: warningItems + parserWarnings.length,
          parserWarnings,
        }),
        "pending",
        at,
      ),
  );
  statements.push(
    db
      .prepare(
        "INSERT INTO publisher_validation_responses(id,submission_id,response_type,status,machine_code,message,payload_json,delivery_status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id("pack"),
        submissionId,
        "validation",
        status,
        status === "rejected"
          ? "FEED_REJECTED"
          : status === "accepted_with_warnings"
            ? "FEED_VALID_WITH_WARNINGS"
            : "FEED_VALID",
        status === "rejected"
          ? "Feed validation rejected all records."
          : status === "accepted_with_warnings"
            ? "Feed validation completed with warnings or rejected records."
            : "Feed validation passed.",
        JSON.stringify({
          submissionId,
          status,
          itemCount: staged.length,
          acceptedCount: accepted,
          rejectedCount: rejected,
          warningCount: warningItems + parserWarnings.length,
        }),
        "pending",
        at,
      ),
  );
  if (accepted > 0)
    statements.push(
      db
        .prepare(
          "INSERT INTO publisher_feed_cursors(account_id,environment,feed_type,last_sequence_number,last_external_feed_id,last_source_sha256,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,environment,feed_type) DO UPDATE SET last_sequence_number=COALESCE(excluded.last_sequence_number,publisher_feed_cursors.last_sequence_number),last_external_feed_id=excluded.last_external_feed_id,last_source_sha256=excluded.last_source_sha256,updated_at=excluded.updated_at",
        )
        .bind(
          principal.accountId,
          principal.environment,
          feedType,
          sequenceNumber,
          externalFeedId,
          digest,
          at,
        ),
    );
  await db.batch(statements);
  await partnerAudit(db, {
    accountId: principal.accountId,
    environment: principal.environment,
    actorType: "credential",
    actorId: principal.credentialId,
    eventType: "partner.feed.received",
    subjectType: "feed",
    subjectId: submissionId,
    event: {
      feedType,
      format: detectedFormat,
      mode,
      channelId,
      itemCount: staged.length,
      accepted,
      rejected,
      warnings: warningItems + parserWarnings.length,
    },
  });
  return {
    id: submissionId,
    status,
    environment: principal.environment,
    feedType,
    feedFormat: detectedFormat,
    mode,
    itemCount: staged.length,
    acceptedCount: accepted,
    warningCount: warningItems + parserWarnings.length,
    rejectedCount: rejected,
    parserWarnings,
    acknowledgementPath: `/api/fore/partner/v1/feeds/${submissionId}/ack`,
  };
}

async function candidateWorkIdentityKeys(p: PartnerProduct) {
  const norm = (v: string) =>
      clean(v)
        .toLocaleLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    author = norm(p.contributors?.find((c) => c.role === "author")?.name || "");
  const keys: { key: string; scheme: string }[] = [];
  if (p.workReference)
    keys.push({
      key: `wref_${await sha256(clean(p.workReference, 500).toLowerCase())}`,
      scheme: "external_work_reference",
    });
  const sourceTitle = norm(p.originalWorkTitle || p.title || "");
  if (sourceTitle && author)
    keys.push({
      key: `wkeyta_${await sha256(`${sourceTitle}|${author}`)}`,
      scheme: "title_author",
    });
  if (sourceTitle)
    keys.push({
      key: `wkey_${await sha256(`${sourceTitle}|${author}|${clean(p.language || "en").toLowerCase()}`)}`,
      scheme: "title_author_language",
    });
  return keys;
}

async function matchAssetExpectations(
  db: CatalogDB,
  input: {
    accountId: string;
    environment: string;
    productKey: string;
    assetKind: string;
    filename: string;
    sha256: string;
    sizeBytes: number;
    mimeType: string;
    assetId: string;
  },
) {
  const rows = (
    await db
      .prepare(
        "SELECT * FROM publisher_asset_expectations WHERE account_id=? AND environment=? AND partner_product_key=? AND asset_kind=? AND status IN ('waiting','mismatch') ORDER BY created_at",
      )
      .bind(input.accountId, input.environment, input.productKey, input.assetKind)
      .all<any>()
  ).results;
  let matched = 0,
    mismatched = 0;
  const at = now();
  for (const row of rows) {
    const checksum = String(row.expected_sha256).toLowerCase() === input.sha256.toLowerCase(),
      size = row.expected_size_bytes == null || Number(row.expected_size_bytes) === input.sizeBytes,
      mime =
        !row.expected_mime_type ||
        String(row.expected_mime_type).toLowerCase() === input.mimeType.toLowerCase();
    if (checksum && size && mime) {
      await db
        .prepare(
          "UPDATE publisher_asset_expectations SET status='matched',matched_asset_id=?,validation_json='[]',matched_at=? WHERE id=?",
        )
        .bind(input.assetId, at, row.id)
        .run();
      matched++;
    } else if (String(row.source_filename) === input.filename || checksum) {
      await db
        .prepare(
          "UPDATE publisher_asset_expectations SET status='mismatch',matched_asset_id=?,validation_json=? WHERE id=?",
        )
        .bind(
          input.assetId,
          JSON.stringify([
            {
              severity: "error",
              code: "ASSET_BINARY_MISMATCH",
              message: !checksum
                ? "Uploaded asset checksum does not match the manifest."
                : !size
                  ? "Uploaded asset size does not match the manifest."
                  : "Uploaded asset MIME type does not match the manifest.",
            },
          ]),
          row.id,
        )
        .run();
      mismatched++;
    }
  }
  if (matched)
    await db
      .prepare("UPDATE publisher_feed_assets SET status='accepted',updated_at=? WHERE id=?")
      .bind(at, input.assetId)
      .run();
  return { matched, mismatched };
}

/** Canonical partner application is now exclusively owned. This caller cannot write D1. */
async function processPartnerFeedQueue(db: CatalogDB, limit = 25) {
  return dispatchPartnerFeedProcessing(db, limit);
}

async function revealPartnerWebhookSecret(env: CoveEnv, userId: string, accountId: string) {
  await requirePartnerRole(env.DB as CatalogDB, userId, accountId, "admin");
  const profile = await env.DB.prepare(
    "SELECT partner_code FROM publisher_partner_profiles WHERE account_id=?",
  )
    .bind(accountId)
    .first<any>();
  if (!profile) throw new ApiError(404, "Partner integration profile not found.");
  const secret = await derivedPartnerWebhookSecret(
    env.FORE_PARTNER_WEBHOOK_MASTER_SECRET || "",
    accountId,
  );
  await partnerAudit(env.DB as CatalogDB, {
    accountId,
    actorType: "user",
    actorId: userId,
    eventType: "partner.webhook_secret.revealed",
    subjectType: "partner",
    subjectId: accountId,
    event: { partnerCode: profile.partner_code || "" },
  });
  return {
    accountId,
    partnerCode: profile.partner_code || "",
    algorithm: "HMAC-SHA256",
    secret,
    signatureHeader: "X-Cove-Signature",
    timestampHeader: "X-Cove-Timestamp",
  };
}

function callbackRetryAt(attempts: number) {
  const minutes = Math.min(360, Math.max(1, 2 ** Math.min(8, attempts)) * 2);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function postPartnerAcknowledgement(
  url: string,
  payload: string,
  input: { secret: string; responseId: string },
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = bytesToBase64Url(await hmacSha256(input.secret, `${timestamp}.${payload}`));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Cove-Partner-Acknowledgements/1.0",
        "X-Cove-Signature": `v1=${signature}`,
        "X-Cove-Timestamp": timestamp,
        "X-Cove-Event-Id": input.responseId,
        "Idempotency-Key": input.responseId,
      },
      body: payload,
    });
    if (!response.ok) throw new Error(`Partner callback returned HTTP ${response.status}.`);
    return { status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverPartnerValidationResponses(env: CoveEnv, limit = 50) {
  const db = env.DB as CatalogDB;
  const at = now();
  const rows = (
    await db
      .prepare(
        `SELECT r.*,s.account_id,s.environment,s.external_feed_id,s.feed_type,s.mode,s.status submission_status,s.source_sha256,
      p.partner_code,p.acknowledgements_url,p.webhook_url
    FROM publisher_validation_responses r
    JOIN publisher_feed_submissions s ON s.id=r.submission_id
    LEFT JOIN publisher_partner_profiles p ON p.account_id=s.account_id
    WHERE r.delivery_status IN ('pending','failed') AND r.attempts<8 AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=?)
    ORDER BY r.created_at,r.id LIMIT ?`,
      )
      .bind(at, Math.max(1, Math.min(200, limit)))
      .all<any>()
  ).results;
  let delivered = 0,
    failed = 0,
    notConfigured = 0;
  for (const row of rows) {
    let destination = clean(
      row.destination_url || row.acknowledgements_url || row.webhook_url,
      2000,
    );
    const attempts = Number(row.attempts || 0) + 1;
    if (!destination) {
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET delivery_status='not_configured',attempts=?,last_attempt_at=?,last_error='No acknowledgement callback URL is configured.',next_attempt_at=NULL WHERE id=?",
        )
        .bind(attempts, at, row.id)
        .run();
      notConfigured++;
      continue;
    }
    try {
      destination = safePartnerCallbackUrl(destination);
      const secret = await derivedPartnerWebhookSecret(
        env.FORE_PARTNER_WEBHOOK_MASTER_SECRET || "",
        String(row.account_id),
      );
      const payloadObject = {
        schemaVersion: "fore.partner.ack.v1",
        eventId: String(row.id),
        eventType: `partner.feed.${String(row.response_type)}`,
        createdAt: String(row.created_at),
        partner: {
          accountId: String(row.account_id),
          partnerCode: String(row.partner_code || ""),
          environment: String(row.environment),
        },
        submission: {
          id: String(row.submission_id),
          externalFeedId: String(row.external_feed_id || ""),
          feedType: String(row.feed_type),
          mode: String(row.mode),
          status: String(row.submission_status),
          sourceSha256: String(row.source_sha256 || ""),
        },
        response: {
          type: String(row.response_type),
          status: String(row.status),
          code: String(row.machine_code),
          message: String(row.message),
          payload: parseJson(row.payload_json, {}),
        },
      };
      const payload = JSON.stringify(payloadObject);
      const payloadSha = await sha256(payload);
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET destination_url=?,payload_sha256=?,attempts=?,last_attempt_at=?,last_error='',next_attempt_at=NULL WHERE id=?",
        )
        .bind(destination, payloadSha, attempts, at, row.id)
        .run();
      const result = await postPartnerAcknowledgement(destination, payload, {
        secret,
        responseId: String(row.id),
      });
      const deliveredAt = now();
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET delivery_status='delivered',delivered_at=?,last_error='',next_attempt_at=NULL WHERE id=?",
        )
        .bind(deliveredAt, row.id)
        .run();
      await partnerAudit(db, {
        accountId: String(row.account_id),
        environment: String(row.environment),
        actorType: "worker",
        actorId: "partner-ack",
        eventType: "partner.ack.delivered",
        subjectType: "validation_response",
        subjectId: String(row.id),
        event: { destination, httpStatus: result.status, attempts, payloadSha256: payloadSha },
      });
      delivered++;
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : "Partner acknowledgement delivery failed."
      ).slice(0, 2000);
      const terminal = attempts >= 8;
      await db
        .prepare(
          "UPDATE publisher_validation_responses SET delivery_status='failed',attempts=?,last_attempt_at=?,last_error=?,next_attempt_at=? WHERE id=?",
        )
        .bind(attempts, at, message, terminal ? null : callbackRetryAt(attempts), row.id)
        .run();
      await partnerAudit(db, {
        accountId: String(row.account_id),
        environment: String(row.environment),
        actorType: "worker",
        actorId: "partner-ack",
        eventType: "partner.ack.failed",
        subjectType: "validation_response",
        subjectId: String(row.id),
        event: { destination, attempts, terminal, error: message },
      });
      failed++;
    }
  }
  return { leased: rows.length, delivered, failed, notConfigured };
}

async function partnerFeedAcknowledgement(
  db: CatalogDB,
  principal: PartnerPrincipal,
  submissionId: string,
) {
  const submission = await db
    .prepare(
      "SELECT * FROM publisher_feed_submissions WHERE id=? AND account_id=? AND environment=?",
    )
    .bind(submissionId, principal.accountId, principal.environment)
    .first<any>();
  if (!submission) throw new ApiError(404, "Feed submission not found.");
  const items = (
    await db
      .prepare(
        "SELECT ordinal,partner_product_key,notification_type,status,validation_json,applied_entity_type,applied_entity_id FROM publisher_feed_items WHERE submission_id=? ORDER BY ordinal LIMIT 10000",
      )
      .bind(submissionId)
      .all<any>()
  ).results;
  const responses = (
    await db
      .prepare(
        "SELECT id,response_type,status,machine_code,message,payload_json,delivery_status,attempts,destination_url,payload_sha256,last_attempt_at,next_attempt_at,last_error,created_at,delivered_at FROM publisher_validation_responses WHERE submission_id=? ORDER BY created_at",
      )
      .bind(submissionId)
      .all<any>()
  ).results;
  return {
    submission,
    items: items.map((i) => ({ ...i, validation: parseJson(i.validation_json, []) })),
    responses: responses.map((r) => ({ ...r, payload: parseJson(r.payload_json, {}) })),
  };
}

async function uploadPartnerAsset(
  env: CoveEnv,
  request: Request,
  principal: PartnerPrincipal,
) {
  const productKey = clean(request.headers.get("x-fore-product-key"), 300);
  const assetKind = z
    .enum(["epub", "cover", "audio", "sample", "supplement"])
    .parse(clean(request.headers.get("x-fore-asset-kind"), 30));
  const filename =
    clean(request.headers.get("x-fore-filename"), 240) ||
    `asset.${assetKind === "epub" ? "epub" : assetKind === "cover" ? "jpg" : "bin"}`;
  const mime = clean(request.headers.get("content-type"), 120) || "application/octet-stream";
  if (!productKey) throw new ApiError(400, "X-Cove-Product-Key is required.");
  const uploadLimit =
    assetKind === "audio"
      ? 750 * 1024 * 1024
      : assetKind === "epub"
        ? 150 * 1024 * 1024
        : 25 * 1024 * 1024;
  const bytes = await readBounded(request, uploadLimit),
    digest = await sha256(bytes),
    assetId = id("pfasset"),
    at = now();

  if (principal.environment === "sandbox") {
    const known = await env.DB.prepare(
      `SELECT 1 ok FROM publisher_feed_items i JOIN publisher_feed_submissions s ON s.id=i.submission_id WHERE s.account_id=? AND s.environment='sandbox' AND s.feed_type='metadata' AND i.partner_product_key=? AND i.status IN ('valid','warning','applied') LIMIT 1`,
    )
      .bind(principal.accountId, productKey)
      .first<any>();
    if (!known)
      throw new ApiError(
        409,
        "Submit sandbox metadata before uploading assets for this product key.",
      );
    if (!env.BUCKET) throw new ApiError(503, "Partner sandbox asset storage is not configured.");
    const objectKey = `partner-ingest/sandbox/${principal.accountId}/assets/${assetId}/${filename.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    await env.BUCKET.put(objectKey, bytes, {
      httpMetadata: { contentType: mime },
      customMetadata: { sha256: digest, environment: "sandbox", productKey },
    });
    await env.DB.prepare(
      "INSERT INTO publisher_feed_assets(id,account_id,environment,partner_product_key,asset_kind,source_filename,mime_type,object_key,size_bytes,sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'quarantined',?,?)",
    )
      .bind(
        assetId,
        principal.accountId,
        principal.environment,
        productKey,
        assetKind,
        filename,
        mime,
        objectKey,
        bytes.byteLength,
        digest,
        at,
        at,
      )
      .run();
    const expectationMatch = await matchAssetExpectations(env.DB, {
      accountId: principal.accountId,
      environment: principal.environment,
      productKey,
      assetKind,
      filename,
      sha256: digest,
      sizeBytes: bytes.byteLength,
      mimeType: mime,
      assetId,
    });
    await partnerAudit(env.DB, {
      accountId: principal.accountId,
      environment: principal.environment,
      actorType: "credential",
      actorId: principal.credentialId,
      eventType: "partner.asset.uploaded",
      subjectType: "asset",
      subjectId: assetId,
      event: {
        productKey,
        assetKind,
        sha256: digest,
        sizeBytes: bytes.byteLength,
        expectationMatch,
      },
    });
    return {
      id: assetId,
      environment: "sandbox",
      sha256: digest,
      sizeBytes: bytes.byteLength,
      status: expectationMatch.matched ? "accepted" : "quarantined",
      expectationMatch,
    };
  }

  const mapping = await env.DB.prepare(
    "SELECT * FROM publisher_catalog_mappings WHERE account_id=? AND environment='production' AND partner_product_key=?",
  )
    .bind(principal.accountId, productKey)
    .first<any>();
  if (!mapping?.publishing_edition_id)
    throw new ApiError(
      409,
      "Submit and apply partner metadata before uploading assets for this product key.",
    );
  const kind = assetKind === "epub" ? "manuscript" : assetKind,
    limit = publishingUploadLimit(kind);
  if (bytes.byteLength > limit)
    throw new ApiError(413, `${assetKind} exceeds the publishing upload limit.`);
  const result = await uploadPublishingAsset(env, principal.actorUserId, {
    editionId: String(mapping.publishing_edition_id),
    kind,
    filename,
    mimeType: mime,
    bytes,
  });
  const row = await env.DB.prepare(
    "SELECT object_key,size_bytes FROM publishing_asset_versions WHERE id=?",
  )
    .bind(result.versionId)
    .first<any>();
  await env.DB.prepare(
    "INSERT INTO publisher_feed_assets(id,account_id,environment,partner_product_key,asset_kind,source_filename,mime_type,object_key,size_bytes,sha256,status,linked_publishing_asset_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'linked',?,?,?)",
  )
    .bind(
      assetId,
      principal.accountId,
      principal.environment,
      productKey,
      assetKind,
      filename,
      mime,
      row?.object_key || "",
      Number(row?.size_bytes || bytes.byteLength),
      result.sha256,
      result.versionId,
      at,
      at,
    )
    .run();
  const expectationMatch = await matchAssetExpectations(env.DB, {
    accountId: principal.accountId,
    environment: principal.environment,
    productKey,
    assetKind,
    filename,
    sha256: result.sha256,
    sizeBytes: Number(row?.size_bytes || bytes.byteLength),
    mimeType: mime,
    assetId,
  });
  await partnerAudit(env.DB, {
    accountId: principal.accountId,
    environment: principal.environment,
    actorType: "credential",
    actorId: principal.credentialId,
    eventType: "partner.asset.uploaded",
    subjectType: "asset",
    subjectId: assetId,
    event: {
      productKey,
      assetKind,
      sha256: result.sha256,
      versionId: result.versionId,
      expectationMatch,
    },
  });
  return { id: assetId, environment: "production", ...result, expectationMatch };
}

async function uploadPartnerAssetBatch(
  env: CoveEnv,
  request: Request,
  principal: PartnerPrincipal,
) {
  const bytes = await readBounded(request, 250 * 1024 * 1024),
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry)
    throw new ApiError(400, "Bulk asset archives require manifest.json at the archive root.");
  let manifest: any;
  try {
    manifest = JSON.parse(await manifestEntry.async("text"));
  } catch {
    throw new ApiError(400, "Bulk asset manifest.json is not valid JSON.");
  }
  const entries = z
    .array(
      z.object({
        productKey: z.string().trim().min(1).max(300),
        kind: z.enum(["epub", "cover"]),
        path: z.string().min(1).max(500),
        filename: z.string().max(240).optional(),
        mimeType: z.string().max(120).optional(),
        sha256: z
          .string()
          .regex(/^[a-fA-F0-9]{64}$/)
          .optional(),
      }),
    )
    .min(1)
    .max(500)
    .parse(manifest?.assets);
  if (Object.keys(zip.files).length > 1001)
    throw new ApiError(413, "Bulk asset archive contains too many files.");
  const duplicateKeys = new Set<string>(),
    duplicatePaths = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.productKey}\0${entry.kind}`;
    if (duplicateKeys.has(key))
      throw new ApiError(
        400,
        `Bulk manifest contains duplicate ${entry.kind} entries for ${entry.productKey}.`,
      );
    duplicateKeys.add(key);
    if (duplicatePaths.has(entry.path))
      throw new ApiError(400, `Bulk manifest reuses archive path ${entry.path}.`);
    duplicatePaths.add(entry.path);
  }
  const results: any[] = [];
  let accepted = 0,
    rejected = 0,
    totalExtracted = 0;
  for (const entry of entries) {
    try {
      if (
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path.split("/").includes("..")
      )
        throw new ApiError(400, "Asset paths may not escape the archive root.");
      const file = zip.file(entry.path);
      if (!file || file.dir) throw new ApiError(400, `Archive asset ${entry.path} was not found.`);
      const assetBytes = await file.async("uint8array");
      totalExtracted += assetBytes.byteLength;
      if (totalExtracted > 300 * 1024 * 1024)
        throw new ApiError(413, "Bulk asset archive expands beyond Cove's 300 MiB safety limit.");
      const max = publishingUploadLimit(entry.kind === "epub" ? "manuscript" : "cover");
      if (assetBytes.byteLength > max)
        throw new ApiError(413, `${entry.path} exceeds the ${entry.kind} upload limit.`);
      if (entry.sha256 && (await sha256(assetBytes)) !== entry.sha256.toLowerCase())
        throw new ApiError(409, `${entry.path} checksum does not match manifest.json.`);
      const mime =
          entry.mimeType ||
          (entry.kind === "epub"
            ? "application/epub+zip"
            : /\.png$/i.test(entry.path)
              ? "image/png"
              : "image/jpeg"),
        filename =
          entry.filename ||
          entry.path.split("/").pop() ||
          `asset.${entry.kind === "epub" ? "epub" : "jpg"}`;
      const internal = new Request("https://fore.internal/partner-asset", {
        method: "POST",
        headers: {
          "x-fore-product-key": entry.productKey,
          "x-fore-asset-kind": entry.kind,
          "x-fore-filename": filename,
          "content-type": mime,
        },
        body: new Uint8Array(assetBytes),
      });
      const out = await uploadPartnerAsset(env, internal, principal);
      results.push({
        productKey: entry.productKey,
        path: entry.path,
        status: "accepted",
        asset: out,
      });
      accepted++;
    } catch (e) {
      results.push({
        productKey: entry.productKey,
        path: entry.path,
        status: "rejected",
        error: e instanceof Error ? e.message : "Asset ingestion failed.",
      });
      rejected++;
    }
  }
  await partnerAudit(env.DB, {
    accountId: principal.accountId,
    environment: principal.environment,
    actorType: "credential",
    actorId: principal.credentialId,
    eventType: "partner.assets.batch",
    subjectType: "asset_batch",
    subjectId: id("assetbatch"),
    event: { accepted, rejected, itemCount: entries.length, totalExtracted },
  });
  return {
    environment: principal.environment,
    itemCount: entries.length,
    acceptedCount: accepted,
    rejectedCount: rejected,
    results,
  };
}

async function partnerDashboard(db: CatalogDB, userId: string, accountId: string) {
  await requirePartnerRole(db, userId, accountId, "analyst");
  const [
    profile,
    credentials,
    channels,
    feeds,
    mappings,
    assets,
    expectations,
    responses,
    contracts,
    audit,
  ] = await Promise.all([
    db
      .prepare("SELECT * FROM publisher_partner_profiles WHERE account_id=?")
      .bind(accountId)
      .first<any>(),
    db
      .prepare(
        "SELECT id,account_id,environment,label,key_prefix,scopes_json,ip_allowlist_json,status,last_used_at,expires_at,created_at,revoked_at FROM publisher_partner_credentials WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_ingestion_channels WHERE account_id=? ORDER BY environment,label",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_feed_submissions WHERE account_id=? ORDER BY received_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_catalog_mappings WHERE account_id=? ORDER BY updated_at DESC LIMIT 200",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,environment,partner_product_key,asset_kind,source_filename,mime_type,size_bytes,sha256,status,linked_publishing_asset_version_id,created_at,updated_at FROM publisher_feed_assets WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT id,submission_id,environment,partner_product_key,asset_kind,source_filename,expected_mime_type,expected_size_bytes,expected_sha256,status,matched_asset_id,validation_json,created_at,matched_at FROM publisher_asset_expectations WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT r.id,r.submission_id,r.response_type,r.status,r.machine_code,r.message,r.delivery_status,r.attempts,r.destination_url,r.payload_sha256,r.last_attempt_at,r.next_attempt_at,r.last_error,r.created_at,r.delivered_at FROM publisher_validation_responses r JOIN publisher_feed_submissions s ON s.id=r.submission_id WHERE s.account_id=? ORDER BY r.created_at DESC LIMIT 200`,
      )
      .bind(accountId)
      .all<any>(),
    db
      .prepare(
        `SELECT a.*,rc.reference_code,rc.name,rc.status contract_status,rcv.id active_version_id,rcv.version_number,rcv.effective_from,rcv.effective_to,rcv.retailer_commission_bps,rcv.post_termination_access_policy FROM publisher_contract_assignments a JOIN rights_contracts rc ON rc.id=a.contract_id LEFT JOIN rights_contract_versions rcv ON rcv.contract_id=rc.id AND rcv.status='active' AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?) WHERE a.account_id=? ORDER BY rc.reference_code`,
      )
      .bind(now(), now(), accountId)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM publisher_partner_audit_events WHERE account_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(accountId)
      .all<any>(),
  ]);
  return {
    profile: profile || null,
    credentials: credentials.results.map((r: any) => ({
      ...r,
      scopes: parseJson(r.scopes_json, []),
      ipAllowlist: parseJson(r.ip_allowlist_json, []),
    })),
    channels: channels.results.map((r: any) => ({ ...r, config: parseJson(r.config_json, {}) })),
    feeds: feeds.results,
    mappings: mappings.results,
    assets: assets.results,
    expectations: expectations.results.map((r: any) => ({
      ...r,
      validation: parseJson(r.validation_json, []),
    })),
    responses: responses.results,
    contracts: contracts.results,
    audit: audit.results,
  };
}

/** Direct contract-version D1 writes were retired. Even if an old caller reaches
 * this symbol, it cannot bypass the private serialized owner. All production
 * staff writes remain unavailable until the writer-only cutover is certified.
 */
async function saveContractVersion(
  _db: CatalogDB,
  _actorUserId: string,
  _raw: unknown,
): Promise<never> {
  throw new ApiError(503, "Distribution contract changes require their canonical owner.");
}

async function assignPublisherContract(db: CatalogDB, actorUserId: string, raw: unknown) {
  const x = z
    .object({
      accountId: z.string().min(1),
      contractId: z.string().min(1),
      relationship: z.enum(["direct", "distributor", "aggregator", "agent"]).default("direct"),
      startsAt: z.string().datetime().nullable().optional(),
      endsAt: z.string().datetime().nullable().optional(),
      status: z.enum(["active", "suspended", "terminated"]).default("active"),
    })
    .parse(raw);
  const [account, contract] = await Promise.all([
    db.prepare("SELECT id FROM publishing_accounts WHERE id=?").bind(x.accountId).first<any>(),
    db.prepare("SELECT id FROM rights_contracts WHERE id=?").bind(x.contractId).first<any>(),
  ]);
  if (!account || !contract) throw new ApiError(404, "Publisher account or contract not found.");
  if (x.startsAt && x.endsAt && x.endsAt <= x.startsAt)
    throw new ApiError(400, "Contract assignment end must follow its start.");
  const at = now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO publisher_contract_assignments(account_id,contract_id,relationship,starts_at,ends_at,status,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,contract_id) DO UPDATE SET relationship=excluded.relationship,starts_at=excluded.starts_at,ends_at=excluded.ends_at,status=excluded.status",
      )
      .bind(
        x.accountId,
        x.contractId,
        x.relationship,
        x.startsAt || null,
        x.endsAt || null,
        x.status,
        at,
      ),
    db
      .prepare(
        "INSERT INTO rights_contract_audit(id,contract_id,action,actor_user_id,snapshot_json,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        id("rcaudit"),
        x.contractId,
        "publisher_assignment",
        actorUserId,
        JSON.stringify(x),
        at,
      ),
  ]);
  return { assigned: true };
}

function normalizeIdentityText(v: string) {
  return v
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
async function rebuildWorkIdentityKeys(db: CatalogDB, limit = 1000) {
  const rows = (
    await db
      .prepare(
        `SELECT w.id,w.title,COALESCE((SELECT c.name FROM editions e JOIN edition_contributors ec ON ec.edition_id=e.id JOIN contributors c ON c.id=ec.contributor_id WHERE e.work_id=w.id AND ec.role='author' ORDER BY ec.position LIMIT 1),'') author,COALESCE(w.original_language,(SELECT e.language FROM editions e WHERE e.work_id=w.id ORDER BY e.created_at LIMIT 1),'en') language FROM works w WHERE NOT EXISTS(SELECT 1 FROM work_identity_keys k WHERE k.work_id=w.id AND k.scheme='title_author_language') OR NOT EXISTS(SELECT 1 FROM work_identity_keys k WHERE k.work_id=w.id AND k.scheme='title_author') ORDER BY w.created_at LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(5000, limit)))
      .all<any>()
  ).results;
  let created = 0,
    collisions = 0;
  const at = now();
  for (const r of rows) {
    const title = normalizeIdentityText(String(r.title || "")),
      author = normalizeIdentityText(String(r.author || "")),
      language = String(r.language || "en").toLowerCase(),
      keys = [
        {
          key: `wkey_${await sha256(`${title}|${author}|${language}`)}`,
          scheme: "title_author_language",
          confidence: 1,
        },
        {
          key: `wkeyta_${await sha256(`${title}|${author}`)}`,
          scheme: "title_author",
          confidence: 0.82,
        },
      ];
    for (const candidate of keys) {
      const existing = await db
        .prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?")
        .bind(candidate.key)
        .first<any>();
      if (existing && String(existing.work_id) !== String(r.id)) {
        collisions++;
        continue;
      }
      await db
        .prepare(
          "INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          candidate.key,
          r.id,
          candidate.scheme,
          candidate.confidence,
          "catalog-rebuild",
          at,
          at,
        )
        .run();
      created++;
    }
  }
  const mappings = (
    await db
      .prepare(
        "SELECT account_id,catalog_work_id,work_reference,original_work_title,publishing_edition_id FROM publisher_catalog_mappings WHERE catalog_work_id IS NOT NULL AND (work_reference<>'' OR original_work_title<>'') ORDER BY updated_at DESC LIMIT ?",
      )
      .bind(Math.max(1, Math.min(5000, limit)))
      .all<any>()
  ).results;
  for (const m of mappings) {
    const edition = await db
        .prepare(
          `SELECT d.language,(SELECT display_name FROM publishing_edition_contributors c WHERE c.edition_id=d.id AND c.role='author' ORDER BY position LIMIT 1) author FROM publishing_edition_drafts d WHERE d.id=?`,
        )
        .bind(m.publishing_edition_id)
        .first<any>(),
      p: PartnerProduct = {
        productKey: "mapping",
        notificationType: "update",
        workReference: m.work_reference || undefined,
        originalWorkTitle: m.original_work_title || undefined,
        title: m.original_work_title || undefined,
        language: edition?.language || "en",
        contributors: edition?.author
          ? [{ name: String(edition.author), role: "author", position: 0 }]
          : [],
      };
    for (const candidate of await candidateWorkIdentityKeys(p)) {
      const existing = await db
        .prepare("SELECT work_id FROM work_identity_keys WHERE identity_key=?")
        .bind(candidate.key)
        .first<any>();
      if (existing && String(existing.work_id) !== String(m.catalog_work_id)) {
        collisions++;
        continue;
      }
      await db
        .prepare(
          "INSERT OR IGNORE INTO work_identity_keys(identity_key,work_id,scheme,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          candidate.key,
          m.catalog_work_id,
          candidate.scheme,
          candidate.scheme === "external_work_reference" ? 1 : 0.82,
          `partner:${m.account_id}`,
          at,
          at,
        )
        .run();
      created++;
    }
  }
  return { scanned: rows.length, partnerMappings: mappings.length, created, collisions };
}

async function reconcilePublicDomainWorks(db: CatalogDB, limit = 250) {
  await rebuildWorkIdentityKeys(db, Math.max(limit * 3, 500));
  const groups = (
    await db
      .prepare(
        `SELECT lower(trim(w.title)) title_key,lower(COALESCE((SELECT c.name FROM editions e JOIN edition_contributors ec ON ec.edition_id=e.id JOIN contributors c ON c.id=ec.contributor_id WHERE e.work_id=w.id AND ec.role='author' ORDER BY ec.position LIMIT 1),'')) author_key,COALESCE(w.original_language,(SELECT e.language FROM editions e WHERE e.work_id=w.id ORDER BY e.created_at LIMIT 1),'en') language,count(DISTINCT w.id) n,group_concat(DISTINCT w.id) ids FROM works w JOIN editions e0 ON e0.work_id=w.id LEFT JOIN products p0 ON p0.edition_id=e0.id WHERE (e0.canonical_public_domain=1 OR p0.source_name='gutenberg' OR e0.edition_type IN ('canonical_public_domain','annotated','new_translation','illustrated','scholarly')) GROUP BY title_key,author_key,language HAVING count(DISTINCT w.id)>1 LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(1000, limit)))
      .all<any>()
  ).results;
  let merged = 0;
  for (const g of groups) {
    const ids = String(g.ids || "")
      .split(",")
      .filter(Boolean);
    if (ids.length < 2) continue;
    const candidates = (
      await db
        .prepare(
          `SELECT w.id,MIN(CASE WHEN p.source_name='gutenberg' THEN 0 ELSE 1 END) source_rank,MIN(w.created_at) created_at FROM works w JOIN editions e ON e.work_id=w.id LEFT JOIN products p ON p.edition_id=e.id WHERE w.id IN (${ids.map(() => "?").join(",")}) GROUP BY w.id ORDER BY source_rank,created_at,w.id`,
        )
        .bind(...ids)
        .all<any>()
    ).results;
    const canonical = String(candidates[0].id);
    for (const old of ids.filter((x) => x !== canonical)) {
      await db.batch([
        db.prepare("UPDATE editions SET work_id=? WHERE work_id=?").bind(canonical, old),
        db
          .prepare("UPDATE publishing_titles SET catalog_work_id=? WHERE catalog_work_id=?")
          .bind(canonical, old),
        db
          .prepare(
            "UPDATE publisher_catalog_mappings SET catalog_work_id=? WHERE catalog_work_id=?",
          )
          .bind(canonical, old),
        db
          .prepare(
            "INSERT OR REPLACE INTO work_redirects(old_work_id,canonical_work_id,reason,created_at) VALUES(?,?,?,?)",
          )
          .bind(old, canonical, "canonical-public-domain-work-reconciliation", now()),
        db
          .prepare("UPDATE works SET canonical_status='redirected',updated_at=? WHERE id=?")
          .bind(now(), old),
      ]);
      merged++;
    }
    await db
      .prepare(
        "UPDATE works SET work_type='public_domain',canonical_status='canonical',updated_at=? WHERE id=?",
      )
      .bind(now(), canonical)
      .run();
  }
  const canonicalRows = (
    await db
      .prepare(
        `SELECT w.id work_id,e.id edition_id,p.source_name,av.sha256 FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id LEFT JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' LEFT JOIN asset_versions av ON av.id=da.current_version_id WHERE p.source_name='gutenberg' AND p.storefront_status='active' ORDER BY w.id,e.created_at`,
      )
      .all<any>()
  ).results;
  const seen = new Set<string>();
  for (const r of canonicalRows) {
    if (seen.has(String(r.work_id))) continue;
    seen.add(String(r.work_id));
    await db.batch([
      db
        .prepare(
          "UPDATE editions SET edition_type='canonical_public_domain',canonical_public_domain=1,differentiation_status='not_required' WHERE id=?",
        )
        .bind(r.edition_id),
      db
        .prepare(
          "INSERT INTO edition_distinctions(edition_id,edition_type,differentiation_summary,source_text_fingerprint,asset_sha256,verification_status,policy_version,created_at,updated_at) VALUES(?,'canonical_public_domain','Canonical free Gutenberg edition','',?,'verified','fore-public-domain-editions-v1',?,?) ON CONFLICT(edition_id) DO UPDATE SET edition_type='canonical_public_domain',asset_sha256=excluded.asset_sha256,verification_status='verified',updated_at=excluded.updated_at",
        )
        .bind(r.edition_id, r.sha256 || "", now(), now()),
    ]);
  }
  return { groups: groups.length, merged, canonicalized: seen.size };
}

async function editionDifferentiationDecision(
  db: CatalogDB,
  input: {
    editionId: string;
    editionType: string;
    rightsBasis: string;
    differentiationSummary: string;
    assetSha256?: string | null;
    translatorPresent?: boolean;
  },
) {
  const type = input.editionType || "original";
  if (input.rightsBasis !== "public_domain")
    return { allowed: true, reasonCode: "NOT_PUBLIC_DOMAIN", requiresReview: false };
  if (type === "canonical_public_domain")
    return { allowed: false, reasonCode: "CANONICAL_PUBLIC_DOMAIN_RESERVED", requiresReview: true };
  if (type === "original")
    return {
      allowed: false,
      reasonCode: "PUBLIC_DOMAIN_DIFFERENTIATION_REQUIRED",
      requiresReview: true,
    };
  if (!input.differentiationSummary.trim())
    return { allowed: false, reasonCode: "DIFFERENTIATION_SUMMARY_REQUIRED", requiresReview: true };
  if (type === "new_translation" && !input.translatorPresent)
    return { allowed: false, reasonCode: "TRANSLATOR_REQUIRED", requiresReview: true };
  if (input.assetSha256) {
    const identical = await db
      .prepare(
        `SELECT e.id,e.edition_type,e.canonical_public_domain FROM editions e JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub' JOIN asset_versions av ON av.id=da.current_version_id WHERE av.sha256=? AND e.id<>? LIMIT 1`,
      )
      .bind(input.assetSha256, input.editionId)
      .first<any>();
    if (identical)
      return {
        allowed: false,
        reasonCode: "IDENTICAL_PUBLIC_DOMAIN_ASSET",
        requiresReview: true,
        matchedEditionId: String(identical.id),
      };
  }
  return {
    allowed: true,
    reasonCode: "DIFFERENTIATED_PUBLIC_DOMAIN_EDITION",
    requiresReview: false,
  };
}

 return {certifyPartnerProfile,issuePartnerCredential,revokePartnerCredential,
  submitPartnerFeed,matchAssetExpectations,uploadPartnerAsset,
  assignPublisherContract,reconcilePublicDomainWorks};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

// QA-leased worker queues. All job ownership and retry transitions are
// validated at the independently bound primary DB, not on the storefront D1 facade.
/* eslint-disable @typescript-eslint/no-explicit-any -- QA lease-only D1 worker row shapes, release locked. */
const privatePublishingWorkQueues=(()=>{
  const now=()=>new Date().toISOString();
  const id=(prefix:string)=>prefix+"_"+crypto.randomUUID();
  const cleanText=(value:unknown,max=500)=>String(value??"").trim().slice(0,max);
  async function refreshAssetValidationSummary(db: PublishingDB, assetVersionId: string) {
  const jobs = (
    await db
      .prepare("SELECT status,required FROM publishing_validation_jobs WHERE asset_version_id=?")
      .bind(assetVersionId)
      .all<any>()
  ).results;
  const required = jobs.filter((j) => Number(j.required) === 1);
  let summary = "pending",
    quarantine = "quarantined";
  if (required.some((j) => ["failed", "blocked"].includes(String(j.status)))) {
    summary = "blocked";
    quarantine = "rejected";
  } else if (required.some((j) => ["queued", "leased"].includes(String(j.status)))) {
    summary = required.some((j) => String(j.status) === "leased") ? "running" : "pending";
    quarantine = "scanning";
  }
  else if (required.every((j) => String(j.status) === "passed")) {
    summary = jobs.some((j) => String(j.status) === "warning") ? "warning" : "passed";
    quarantine = "clean";
  } else summary = "blocked";
  await db
    .prepare(
      "UPDATE publishing_asset_versions SET validation_summary=?,quarantine_status=? WHERE id=?",
    )
    .bind(summary, quarantine, assetVersionId)
    .run();
  return { summary, quarantine };
}


  async function leasePublishingValidationJobs(db: PublishingDB, raw: unknown) {
  const x = z
      .object({
        workerId: z.string().trim().min(3).max(120),
        limit: z.number().int().min(1).max(50).default(10),
        leaseSeconds: z.number().int().min(30).max(900).default(300),
        executionClasses: z
          .array(z.enum(["worker", "external"]))
          .min(1)
          .max(2)
          .default(["worker", "external"]),
      })
      .parse(raw),
    at = now(),
    expires = new Date(Date.now() + x.leaseSeconds * 1000).toISOString();
  // Recover abandoned leases before taking new work. Jobs retry up to max_attempts and then
  // fail closed as blocked instead of circulating forever or silently passing.
  await db.batch([
    db
      .prepare(
        "UPDATE publishing_validation_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=?,last_error='Previous worker lease expired; retrying.',updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts<max_attempts",
      )
      .bind(at, at, at),
    db
      .prepare(
        "UPDATE publishing_validation_jobs SET status='blocked',lease_owner=NULL,lease_expires_at=NULL,last_error='Validation exhausted its retry budget.',updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts>=max_attempts",
      )
      .bind(at, at),
  ]);
  const candidates = (
    await db
      .prepare(
        `SELECT id FROM publishing_validation_jobs WHERE status='queued' AND attempts<max_attempts AND available_at<=? AND execution_class IN (${x.executionClasses.map(() => "?").join(",")}) ORDER BY priority ASC,created_at ASC LIMIT ?`,
      )
      .bind(at, ...x.executionClasses, x.limit)
      .all<any>()
  ).results;
  for (const row of candidates)
    await db
      .prepare(
        "UPDATE publishing_validation_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'",
      )
      .bind(x.workerId, expires, at, row.id)
      .run();
  const jobs = (
    await db
      .prepare(
        `SELECT j.*,v.object_key,v.mime_type,v.size_bytes,v.sha256,v.original_filename,a.kind,a.edition_id FROM publishing_validation_jobs j JOIN publishing_asset_versions v ON v.id=j.asset_version_id JOIN publishing_assets a ON a.id=v.asset_id WHERE j.status='leased' AND j.lease_owner=? AND j.lease_expires_at=? ORDER BY j.priority,j.created_at`,
      )
      .bind(x.workerId, expires)
      .all<any>()
  ).results;
  return { jobs, leaseExpiresAt: expires };
}


  async function completePublishingValidationJob(db: PublishingDB, raw: unknown) {
  const x = z
    .object({
      jobId: z.string().min(1),
      workerId: z.string().min(3).max(120),
      status: z.enum(["passed", "warning", "failed", "blocked"]),
      validatorName: z.string().min(1).max(120),
      validatorVersion: z.string().max(80).default(""),
      issues: z
        .array(
          z.object({
            code: z.string().max(120),
            severity: z.enum(["info", "warning", "error"]).default("error"),
            message: z.string().max(2000),
            location: z.string().max(500).optional(),
          }),
        )
        .max(2000)
        .default([]),
      reportObjectKey: z.string().max(500).nullable().optional(),
      reportSha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .nullable()
        .optional(),
    })
    .parse(raw);
  const job = await db
    .prepare("SELECT * FROM publishing_validation_jobs WHERE id=?")
    .bind(x.jobId)
    .first<any>();
  if (!job) throw new ApiError(404, "Validation job not found.");
  if (
    job.status !== "leased" ||
    job.lease_owner !== x.workerId ||
    (job.lease_expires_at && job.lease_expires_at < now())
  )
    throw new ApiError(409, "This validation lease is no longer active.");
  const at = now();
  await db.batch([
    db
      .prepare(
        "UPDATE publishing_validation_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?",
      )
      .bind(
        x.status,
        ["failed", "blocked"].includes(x.status)
          ? cleanText(x.issues[0]?.message || "Validation failed", 1000)
          : "",
        at,
        x.jobId,
      ),
    db
      .prepare(
        "INSERT INTO publishing_validation_results(id,job_id,asset_version_id,check_type,validator_name,validator_version,status,issue_count,issues_json,report_object_key,report_sha256,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id("pubval"),
        x.jobId,
        job.asset_version_id,
        job.check_type,
        x.validatorName,
        x.validatorVersion,
        x.status,
        x.issues.length,
        JSON.stringify(x.issues),
        x.reportObjectKey || null,
        x.reportSha256 || null,
        at,
      ),
  ]);
  if (String(job.check_type) === "malware")
    await mirrorPublishingMalwareResult(db, {
      assetVersionId: String(job.asset_version_id),
      status: x.status,
      validatorName: x.validatorName,
      validatorVersion: x.validatorVersion,
      issues: x.issues,
      reportObjectKey: x.reportObjectKey || null,
      reportSha256: x.reportSha256 || null,
    });
  const asset = await refreshAssetValidationSummary(db, String(job.asset_version_id));
  return { jobId: x.jobId, assetVersionId: job.asset_version_id, ...asset };
}


  async function leaseRightsEvidenceScanJobs(db: PublishingDB, raw: unknown) {
  const x = z
      .object({
        workerId: z.string().min(1).max(160),
        limit: z.number().int().min(1).max(50).default(10),
        leaseSeconds: z.number().int().min(30).max(1800).default(300),
      })
      .parse(raw),
    at = now(),
    until = new Date(Date.now() + x.leaseSeconds * 1000).toISOString();
  await db
    .prepare(
      "UPDATE publishing_rights_evidence_scan_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,available_at=?,updated_at=? WHERE status='leased' AND lease_expires_at<? AND attempts<max_attempts",
    )
    .bind(at, at, at)
    .run();
  const rows = (
    await db
      .prepare(
        "SELECT j.*,e.object_key,e.mime_type,e.sha256,e.size_bytes FROM publishing_rights_evidence_scan_jobs j JOIN publishing_rights_evidence e ON e.id=j.evidence_id WHERE j.status='queued' AND j.available_at<=? AND j.attempts<j.max_attempts ORDER BY j.created_at LIMIT ?",
      )
      .bind(at, x.limit)
      .all<any>()
  ).results;
  for (const r of rows)
    await db
      .prepare(
        "UPDATE publishing_rights_evidence_scan_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'",
      )
      .bind(x.workerId, until, at, r.id)
      .run();
  return { jobs: rows };
}

  async function completeRightsEvidenceScanJob(db: PublishingDB, raw: unknown) {
  const x = z
      .object({
        jobId: z.string().min(1),
        workerId: z.string().min(1),
        status: z.enum(["passed", "failed", "blocked"]),
        error: z.string().max(2000).default(""),
      })
      .parse(raw),
    j = await db
      .prepare(
        "SELECT * FROM publishing_rights_evidence_scan_jobs WHERE id=? AND status='leased' AND lease_owner=?",
      )
      .bind(x.jobId, x.workerId)
      .first<any>();
  if (!j || (j.lease_expires_at && j.lease_expires_at < now()))
    throw new ApiError(409, "Evidence scan lease is missing or no longer owned by this worker.");
  const at = now(),
    scanStatus = x.status === "passed" ? "clean" : x.status === "blocked" ? "rejected" : "failed";
  await db.batch([
    db
      .prepare(
        "UPDATE publishing_rights_evidence_scan_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?",
      )
      .bind(x.status, x.error, at, j.id),
    db
      .prepare("UPDATE publishing_rights_evidence SET scan_status=? WHERE id=?")
      .bind(scanStatus, j.evidence_id),
  ]);
  return { id: j.id, status: x.status };
}


  return {leasePublishingValidationJobs,completePublishingValidationJob,
    leaseRightsEvidenceScanJobs,completeRightsEvidenceScanJob};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- QA-only audiobook QC row shapes. */
const privateAudioQcQueues=(()=>{
  const now=()=>new Date().toISOString();
  const id=(prefix:string)=>prefix+"_"+crypto.randomUUID();
  const json=(value:unknown,fallback:Record<string,unknown>)=>{
    try{return JSON.parse(String(value||""));}catch{return fallback;}
  };
async function hash(bytes: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function leaseCommercialAudioQcJobs(db: CoveEnv["DB"], raw: unknown) {
  const x = z
      .object({
        workerId: z.string().min(1).max(160),
        limit: z.number().int().min(1).max(25).default(5),
        leaseSeconds: z.number().int().min(30).max(1800).default(300),
      })
      .parse(raw),
    at = now(),
    expires = new Date(Date.now() + x.leaseSeconds * 1000).toISOString();
  const candidates = (
    await db
      .prepare(
        `SELECT edition_id FROM commercial_audio_qc_jobs WHERE attempts<max_attempts AND available_at<=? AND (status='queued' OR (status='leased' AND lease_expires_at<=?)) ORDER BY available_at,updated_at LIMIT ?`,
      )
      .bind(at, at, x.limit)
      .all<any>()
  ).results;
  const jobs: any[] = [];
  for (const c of candidates) {
    const claimed = await db
      .prepare(
        `UPDATE commercial_audio_qc_jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE edition_id=? AND attempts<max_attempts AND available_at<=? AND (status='queued' OR (status='leased' AND lease_expires_at<=?)) RETURNING edition_id,attempts,lease_expires_at`,
      )
      .bind(x.workerId, expires, at, c.edition_id, at, at)
      .first<any>();
    if (!claimed) continue;
    const chapters = (
      await db
        .prepare(
          `SELECT c.id chapter_id,c.position,c.title,c.duration_ms,c.mime_type,c.sample_rate_hz,c.bitrate_kbps,c.bitrate_mode,c.channels,c.sha256,f.object_key,f.size_bytes FROM commercial_audio_chapters c JOIN commercial_audio_files f ON f.id=c.file_id WHERE c.edition_id=? ORDER BY c.position`,
        )
        .bind(c.edition_id)
        .all<any>()
    ).results;
    const profile = await db
        .prepare("SELECT preview_file_id FROM commercial_audio_profiles WHERE edition_id=?")
        .bind(c.edition_id)
        .first<any>(),
      preview = profile?.preview_file_id
        ? await db
            .prepare(
              "SELECT id file_id,object_key,size_bytes,mime_type,duration_ms,sample_rate_hz,bitrate_kbps,bitrate_mode,channels,sha256 FROM commercial_audio_files WHERE id=?",
            )
            .bind(profile.preview_file_id)
            .first<any>()
        : null;
    jobs.push({
      editionId: c.edition_id,
      attempt: claimed.attempts,
      leaseExpiresAt: claimed.lease_expires_at,
      chapters,
      preview,
    });
  }
  return { jobs };
}


async function completeCommercialAudioQc(db: CoveEnv["DB"], raw: unknown) {
  const measurement = z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    malwareClean: z.boolean(),
    durationMs: z.number().int().positive(),
    rmsDb: z.number(),
    peakDb: z.number(),
    noiseFloorDb: z.number(),
    sampleRateHz: z.number().int(),
    bitrateKbps: z.number().int().nullable(),
    bitrateMode: z.string(),
    channels: z.number().int(),
  });
  const x = z
      .object({
        editionId: z.string().min(1),
        workerId: z.string().min(1).max(160).optional(),
        chapters: z.array(measurement.extend({ chapterId: z.string().min(1) })).min(1),
        preview: measurement
          .extend({ fileId: z.string().min(1) })
          .nullable()
          .optional(),
      })
      .parse(raw),
    profile = await db
      .prepare("SELECT * FROM commercial_audio_profiles WHERE edition_id=?")
      .bind(x.editionId)
      .first<any>();
  if (!profile) throw new ApiError(404, "Commercial audio profile not found.");
  const policyRow = await db
      .prepare("SELECT * FROM commercial_audio_policy_versions WHERE id=?")
      .bind(profile.active_policy_id)
      .first<any>(),
    policy = json(policyRow?.policy_json, {}),
    stored = (
      await db
        .prepare("SELECT * FROM commercial_audio_chapters WHERE edition_id=? ORDER BY position")
        .bind(x.editionId)
        .all<any>()
    ).results;
  if (stored.length !== x.chapters.length)
    throw new ApiError(409, "QC results must cover every current chapter.");
  const job = await db
    .prepare("SELECT * FROM commercial_audio_qc_jobs WHERE edition_id=?")
    .bind(x.editionId)
    .first<any>();
  if (job && job.status === "leased" && x.workerId && job.lease_owner !== x.workerId)
    throw new ApiError(409, "This audio QC job is leased to another worker.");
  if (job && job.status === "leased" && job.lease_expires_at && job.lease_expires_at < now())
    throw new ApiError(409, "This audio QC lease expired; lease the job again.");
  const findings: any[] = [];
  let status: "passed" | "warning" | "failed" = "passed",
    channels: number | null = null;
  for (const s of stored) {
    const m = x.chapters.find((c) => c.chapterId === s.id);
    if (!m) throw new ApiError(409, "QC chapter set does not match the current manifest.");
    const errors: string[] = [];
    if (m.sha256 !== String(s.sha256))
      errors.push("content checksum does not match the uploaded chapter");
    if (!m.malwareClean) errors.push("malware scan failed");
    if (m.sampleRateHz !== Number(policy.sampleRateHz || 44100))
      errors.push(`sample rate ${m.sampleRateHz} Hz`);
    if (
      s.mime_type === "audio/mpeg" &&
      (Number(m.bitrateKbps || 0) < Number(policy.mp3MinBitrateKbps || 192) ||
        String(m.bitrateMode).toUpperCase() !== String(policy.mp3BitrateMode || "CBR"))
    )
      errors.push("MP3 encoding below policy");
    if (m.rmsDb < Number(policy.rmsDbMin || -23) || m.rmsDb > Number(policy.rmsDbMax || -18))
      errors.push(`RMS ${m.rmsDb} dB`);
    if (m.peakDb > Number(policy.peakDbMax || -3)) errors.push(`peak ${m.peakDb} dB`);
    if (m.noiseFloorDb > Number(policy.noiseFloorDbMax || -60))
      errors.push(`noise floor ${m.noiseFloorDb} dB`);
    if (channels !== null && channels !== m.channels)
      errors.push("inconsistent channel configuration");
    channels = m.channels;
    if (errors.length) {
      status = "failed";
      findings.push({ chapterId: s.id, severity: "error", errors });
    }
    await db
      .prepare(
        "UPDATE commercial_audio_chapters SET duration_ms=?,sample_rate_hz=?,bitrate_kbps=?,bitrate_mode=?,channels=?,loudness_rms_db=?,true_peak_db=?,noise_floor_db=?,qc_status=? WHERE id=?",
      )
      .bind(
        m.durationMs,
        m.sampleRateHz,
        m.bitrateKbps,
        m.bitrateMode,
        m.channels,
        m.rmsDb,
        m.peakDb,
        m.noiseFloorDb,
        errors.length ? "failed" : "passed",
        s.id,
      )
      .run();
    await db
      .prepare(
        "UPDATE commercial_audio_files SET duration_ms=?,sample_rate_hz=?,bitrate_kbps=?,bitrate_mode=?,channels=?,loudness_rms_db=?,true_peak_db=?,noise_floor_db=?,qc_status=?,quarantine_status=? WHERE id=?",
      )
      .bind(
        m.durationMs,
        m.sampleRateHz,
        m.bitrateKbps,
        m.bitrateMode,
        m.channels,
        m.rmsDb,
        m.peakDb,
        m.noiseFloorDb,
        errors.length ? "failed" : "passed",
        errors.length ? "rejected" : "clean",
        s.file_id,
      )
      .run();
  }
  const previewFile = profile.preview_file_id
    ? await db
        .prepare(
          "SELECT * FROM commercial_audio_files WHERE id=? AND edition_id=? AND kind='preview'",
        )
        .bind(profile.preview_file_id, x.editionId)
        .first<any>()
    : null;
  if (previewFile) {
    if (!x.preview || x.preview.fileId !== previewFile.id)
      throw new ApiError(409, "QC results must cover the current preview clip.");
    const p = x.preview,
      errors: string[] = [];
    if (p.sha256 !== String(previewFile.sha256))
      errors.push("preview checksum does not match the uploaded file");
    if (!p.malwareClean) errors.push("preview malware scan failed");
    const seconds = p.durationMs / 1000;
    if (
      seconds < Number(policy.previewMinSeconds || 30) ||
      seconds > Number(policy.previewMaxSeconds || 300)
    )
      errors.push(`preview duration ${seconds.toFixed(1)} seconds`);
    if (p.sampleRateHz !== Number(policy.sampleRateHz || 44100))
      errors.push(`preview sample rate ${p.sampleRateHz} Hz`);
    if (
      previewFile.mime_type === "audio/mpeg" &&
      (Number(p.bitrateKbps || 0) < Number(policy.mp3MinBitrateKbps || 192) ||
        String(p.bitrateMode).toUpperCase() !== String(policy.mp3BitrateMode || "CBR"))
    )
      errors.push("preview MP3 encoding below policy");
    if (p.rmsDb < Number(policy.rmsDbMin || -23) || p.rmsDb > Number(policy.rmsDbMax || -18))
      errors.push(`preview RMS ${p.rmsDb} dB`);
    if (p.peakDb > Number(policy.peakDbMax || -3)) errors.push(`preview peak ${p.peakDb} dB`);
    if (p.noiseFloorDb > Number(policy.noiseFloorDbMax || -60))
      errors.push(`preview noise floor ${p.noiseFloorDb} dB`);
    if (errors.length) {
      status = "failed";
      findings.push({ fileId: previewFile.id, severity: "error", errors });
    }
    await db
      .prepare(
        "UPDATE commercial_audio_files SET duration_ms=?,sample_rate_hz=?,bitrate_kbps=?,bitrate_mode=?,channels=?,loudness_rms_db=?,true_peak_db=?,noise_floor_db=?,qc_status=?,quarantine_status=? WHERE id=?",
      )
      .bind(
        p.durationMs,
        p.sampleRateHz,
        p.bitrateKbps,
        p.bitrateMode,
        p.channels,
        p.rmsDb,
        p.peakDb,
        p.noiseFloorDb,
        errors.length ? "failed" : "passed",
        errors.length ? "rejected" : "clean",
        previewFile.id,
      )
      .run();
  }
  const manifestHash = await hash(
    new TextEncoder().encode(JSON.stringify(stored.map((s: any) => [s.id, s.sha256, s.position]))),
  );
  const runId = id("audioqc");
  await db
    .prepare(
      "INSERT INTO commercial_audio_qc_runs(id,edition_id,policy_id,source_manifest_hash,status,findings_json,measured_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      runId,
      x.editionId,
      profile.active_policy_id,
      manifestHash,
      status,
      JSON.stringify(findings),
      JSON.stringify({ chapters: x.chapters, preview: x.preview || null }),
      now(),
    )
    .run();
  await db
    .prepare("UPDATE commercial_audio_profiles SET qc_status=?,updated_at=? WHERE edition_id=?")
    .bind(status === "failed" ? "blocked" : status, now(), x.editionId)
    .run();
  if (job)
    await db
      .prepare(
        "UPDATE commercial_audio_qc_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_run_id=?,last_error=?,updated_at=? WHERE edition_id=?",
      )
      .bind(
        status === "failed" ? "failed" : "completed",
        runId,
        status === "failed" ? JSON.stringify(findings).slice(0, 4000) : "",
        now(),
        x.editionId,
      )
      .run();
  return { id: runId, status, findings };
}


  return {leaseCommercialAudioQcJobs,completeCommercialAudioQc};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- QA-only R2 upload receipt and D1 media row types. */
async function registerPrivateCommercialAudioUpload(env:LegalAuthorityEnv,input:any) {
  const db=env.PRIMARY_DB as unknown as CoveEnv["DB"];
  await privateAudioMetadata.requireAudioUploadEdition(db,input.userId,input.editionId);
  const expected="publishing/audio/"+String(input.editionId).replace(/[^A-Za-z0-9_-]/g,"_")+
    "/"+input.fileId+"-"+input.sha.slice(0,16)+"."+(input.mime==="audio/mpeg"?"mp3":"m4a");
  if(input.key!==expected)throw new ApiError(409,"Audio object identity is invalid.");
  const bucket=env.BUCKET as unknown as {head?:(key:string)=>Promise<{
    size:number;customMetadata?:Record<string,string>
  }|null>}|undefined;
  if(!bucket?.head)throw new ApiError(503,"Private audio object verification unavailable.");
  const object=await bucket.head(input.key);
  if(!object||Number(object.size)!==input.length||
     object.customMetadata?.editionId!==input.editionId||
     object.customMetadata?.sha256!==input.sha)
    throw new ApiError(409,"Audio upload receipt does not match the stored object.");
  const found=await db.prepare(
    "SELECT id,object_key,sha256,edition_id,kind,original_filename,mime_type,size_bytes,duration_ms,sample_rate_hz,bitrate_kbps,bitrate_mode,channels,loudness_rms_db,true_peak_db,noise_floor_db,created_by_user_id FROM commercial_audio_files WHERE id=?"
  ).bind(input.fileId).first<any>();
  if(found){
    const numeric=(value:unknown)=>value===null||value===undefined?null:Number(value);
    if(found.object_key!==input.key||found.sha256!==input.sha||
       found.edition_id!==input.editionId||found.kind!==input.kind||
       found.created_by_user_id!==input.userId||
       found.original_filename!==input.filename||found.mime_type!==input.mime||
       Number(found.size_bytes)!==input.length||Number(found.duration_ms)!==input.durationMs||
       Number(found.sample_rate_hz)!==input.sampleRateHz||
       numeric(found.bitrate_kbps)!==input.bitrateKbps||
       String(found.bitrate_mode)!==input.bitrateMode||
       Number(found.channels)!==input.channels||
       numeric(found.loudness_rms_db)!==input.rms||
       numeric(found.true_peak_db)!==input.peak||
       numeric(found.noise_floor_db)!==input.noise)
      throw new ApiError(409,"Audio upload identity was already used with different metadata.");
    if(input.kind==="preview"){
      const profile=await db.prepare("SELECT preview_file_id FROM commercial_audio_profiles WHERE edition_id=?")
        .bind(input.editionId).first<any>();
      if(profile?.preview_file_id!==input.fileId)
        throw new ApiError(503,"Interrupted preview registration requires owner recovery.");
      return {id:input.fileId,sha256:input.sha};
    }
    const chapter=await db.prepare(
      "SELECT id,position,title FROM commercial_audio_chapters WHERE edition_id=? AND file_id=?"
    ).bind(input.editionId,input.fileId).first<any>();
    if(!chapter)throw new ApiError(503,"Interrupted chapter registration requires owner recovery.");
    if(Number(chapter.position)!==input.position||chapter.title!==input.title)
      throw new ApiError(409,"Replayed chapter metadata does not match the original registration.");
    return {id:chapter.id,fileId:input.fileId,sha256:input.sha,replaced:true};
  }
  const at=new Date().toISOString();
  const statements:any[]=[
    db.prepare(
      "INSERT INTO commercial_audio_files(id,edition_id,kind,object_key,original_filename,mime_type,size_bytes,sha256,duration_ms,sample_rate_hz,bitrate_kbps,bitrate_mode,channels,loudness_rms_db,true_peak_db,noise_floor_db,qc_status,quarantine_status,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending','quarantined',?,?)"
    ).bind(input.fileId,input.editionId,input.kind,input.key,input.filename,input.mime,
      input.length,input.sha,input.durationMs,input.sampleRateHz,input.bitrateKbps,
      input.bitrateMode,input.channels,input.rms,input.peak,input.noise,input.userId,at)
  ];
  let chapterId:string|null=null,existingChapter=false;
  if(input.kind==="preview"){
    statements.push(db.prepare(
      "UPDATE commercial_audio_profiles SET preview_file_id=?,qc_status='pending',updated_at=? WHERE edition_id=?"
    ).bind(input.fileId,at,input.editionId));
  }else {
    const existing=await db.prepare(
      "SELECT id FROM commercial_audio_chapters WHERE edition_id=? AND position=?"
    ).bind(input.editionId,input.position).first<any>();
    chapterId=existing?.id||"chapter_"+crypto.randomUUID();
    existingChapter=!!existing;
    if(existing)
      statements.push(db.prepare(
        "UPDATE commercial_audio_chapters SET title=?,file_id=?,duration_ms=?,mime_type=?,sample_rate_hz=?,bitrate_kbps=?,bitrate_mode=?,channels=?,loudness_rms_db=?,true_peak_db=?,noise_floor_db=?,sha256=?,qc_status='pending' WHERE id=?"
      ).bind(input.title,input.fileId,input.durationMs,input.mime,input.sampleRateHz,
        input.bitrateKbps,input.bitrateMode,input.channels,input.rms,input.peak,input.noise,
        input.sha,chapterId));
    else
      statements.push(db.prepare(
        "INSERT INTO commercial_audio_chapters(id,edition_id,position,title,file_id,duration_ms,mime_type,sample_rate_hz,bitrate_kbps,bitrate_mode,channels,loudness_rms_db,true_peak_db,noise_floor_db,sha256,qc_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)"
      ).bind(chapterId,input.editionId,input.position,input.title,input.fileId,
        input.durationMs,input.mime,input.sampleRateHz,input.bitrateKbps,input.bitrateMode,
        input.channels,input.rms,input.peak,input.noise,input.sha,at));
    statements.push(db.prepare(
      "UPDATE commercial_audio_profiles SET qc_status='pending',updated_at=? WHERE edition_id=?"
    ).bind(at,input.editionId));
  }
  statements.push(db.prepare(
    "INSERT INTO commercial_audio_qc_jobs(edition_id,status,attempts,max_attempts,lease_owner,lease_expires_at,available_at,last_run_id,last_error,created_at,updated_at) VALUES(?,'queued',0,5,NULL,NULL,?,NULL,'',?,?) ON CONFLICT(edition_id) DO UPDATE SET status='queued',attempts=0,lease_owner=NULL,lease_expires_at=NULL,available_at=excluded.available_at,last_error='',updated_at=excluded.updated_at"
  ).bind(input.editionId,at,at,at));
  await db.batch(statements);
  return input.kind==="preview"?{id:input.fileId,sha256:input.sha}:
    {id:chapterId,fileId:input.fileId,sha256:input.sha,replaced:existingChapter};
}
/* eslint-enable @typescript-eslint/no-explicit-any */


/* eslint-disable @typescript-eslint/no-explicit-any -- Original financial algorithms execute only inside the private QA owner. */
const createPrivateRoyalty=(seed?:string)=>{
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const clampBps = (value: unknown, fallback = 0) =>
  Math.max(
    0,
    Math.min(10000, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback),
  );
const minor = (value: unknown) => Math.round(Number(value || 0));
function safeJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type RoyaltyContext = {
  sourceType:
    | "sale"
    | "refund"
    | "chargeback"
    | "subscription"
    | "library"
    | "wholesale"
    | "agency"
    | "promotion_adjustment"
    | "manual_adjustment";
  sourceId: string;
  orderId?: string | null;
  orderItemId?: string | null;
  usageEventId?: string | null;
  productId: string;
  publisherId?: string | null;
  territory: string;
  format: string;
  salesChannel: string;
  currency: string;
  quantity?: number;
  listPriceMinor?: number;
  customerPriceMinor?: number;
  taxMinor?: number;
  processorFeeMinor?: number;
  promotionDiscountMinor?: number;
  foreFundedDiscountMinor?: number;
  publisherFundedDiscountMinor?: number;
  distributorFeeMinor?: number;
  grossValueMinor?: number;
  rightsBasis?: string | null;
  promotionType?: string | null;
  promotionFundingSource?: string | null;
  distributorId?: string | null;
  subscriptionPlanId?: string | null;
  occurredAt: string;
  /** Optional contractual availability anchor (for example, a paid preorder release date). */
  availabilityAnchorAt?: string | null;
  metadata?: Record<string, unknown>;
};

type RoyaltyRuleAction = {
  basis?: "list_price" | "customer_price" | "net_receipts" | "gross_value";
  royaltyRateBps?: number;
  foreCommissionBps?: number;
  flatRoyaltyMinorPerUnit?: number;
  reserveBps?: number;
  paymentTermsDays?: number;
  processorFeeTreatment?: "deduct" | "ignore";
  distributorFeeTreatment?: "deduct" | "ignore";
  taxTreatment?: "deduct" | "ignore";
  foreFundedDiscountTreatment?: "add_back" | "ignore";
  publisherFundedDiscountTreatment?: "deduct" | "ignore";
};

type RoyaltyRuleConditions = {
  territories?: string[];
  excludeTerritories?: string[];
  publisherIds?: string[];
  productIds?: string[];
  formats?: string[];
  salesChannels?: string[];
  rightsBasis?: string[];
  promotionTypes?: string[];
  promotionFundingSources?: string[];
  distributorIds?: string[];
  subscriptionPlanIds?: string[];
  minCustomerPriceMinor?: number;
  maxCustomerPriceMinor?: number;
  minListPriceMinor?: number;
  maxListPriceMinor?: number;
};

function includesOrAny(values: string[] | undefined, actual: string | null | undefined) {
  if (!values?.length) return true;
  return values.map((v) => String(v).toUpperCase()).includes(String(actual || "").toUpperCase());
}
function ruleMatches(conditions: RoyaltyRuleConditions, ctx: RoyaltyContext) {
  if (!includesOrAny(conditions.territories, ctx.territory)) return false;
  if (
    conditions.excludeTerritories?.map((x) => x.toUpperCase()).includes(ctx.territory.toUpperCase())
  )
    return false;
  if (!includesOrAny(conditions.publisherIds, ctx.publisherId)) return false;
  if (!includesOrAny(conditions.productIds, ctx.productId)) return false;
  if (!includesOrAny(conditions.formats, ctx.format)) return false;
  if (!includesOrAny(conditions.salesChannels, ctx.salesChannel)) return false;
  if (!includesOrAny(conditions.rightsBasis, ctx.rightsBasis)) return false;
  if (!includesOrAny(conditions.promotionTypes, ctx.promotionType)) return false;
  if (!includesOrAny(conditions.promotionFundingSources, ctx.promotionFundingSource)) return false;
  if (!includesOrAny(conditions.distributorIds, ctx.distributorId)) return false;
  if (!includesOrAny(conditions.subscriptionPlanIds, ctx.subscriptionPlanId)) return false;
  const customer = minor(ctx.customerPriceMinor),
    list = minor(ctx.listPriceMinor);
  if (conditions.minCustomerPriceMinor != null && customer < conditions.minCustomerPriceMinor)
    return false;
  if (conditions.maxCustomerPriceMinor != null && customer > conditions.maxCustomerPriceMinor)
    return false;
  if (conditions.minListPriceMinor != null && list < conditions.minListPriceMinor) return false;
  if (conditions.maxListPriceMinor != null && list > conditions.maxListPriceMinor) return false;
  return true;
}

async function contractForContext(db: CatalogDB, ctx: RoyaltyContext) {
  const row = await db
    .prepare(
      `SELECT rc.*,rcv.id contract_version_id,rcv.version,rcv.calculation_basis,rcv.fore_commission_bps,rcv.default_royalty_rate_bps,rcv.payment_terms_days,rcv.reserve_bps,rcv.rules_version_hash,rcv.effective_from version_effective_from,rcv.effective_to version_effective_to
    FROM finance_royalty_contracts rc
    JOIN finance_royalty_contract_versions rcv ON rcv.contract_id=rc.id
    JOIN products p ON p.id=?
    JOIN editions e ON e.id=p.edition_id
    WHERE rc.status='active'
      AND (rc.product_id=? OR rc.product_id IS NULL)
      AND (rc.edition_id=e.id OR rc.edition_id IS NULL)
      AND (rc.publisher_id=e.publisher_id OR rc.publisher_id IS NULL)
      AND (rc.territory_code IS NULL OR upper(rc.territory_code)=upper(?))
      AND (rc.format IS NULL OR lower(rc.format)=lower(?))
      AND (rc.sales_channel IS NULL OR lower(rc.sales_channel)=lower(?))
      AND rc.effective_from<=? AND (rc.effective_to IS NULL OR rc.effective_to>?)
      AND rcv.effective_from<=? AND (rcv.effective_to IS NULL OR rcv.effective_to>?)
    ORDER BY
      CASE WHEN rc.product_id=? THEN 0 WHEN rc.edition_id=e.id THEN 1 WHEN rc.publisher_id=e.publisher_id THEN 2 ELSE 3 END,
      CASE WHEN rc.territory_code IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN rc.format IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN rc.sales_channel IS NOT NULL THEN 0 ELSE 1 END,
      rc.effective_from DESC,rcv.version DESC
    LIMIT 1`,
    )
    .bind(
      ctx.productId,
      ctx.productId,
      ctx.territory,
      ctx.format,
      ctx.salesChannel,
      ctx.occurredAt,
      ctx.occurredAt,
      ctx.occurredAt,
      ctx.occurredAt,
      ctx.productId,
    )
    .first<any>();
  if (!row) return null;
  const rules = (
    await db
      .prepare(
        "SELECT * FROM finance_royalty_rules WHERE contract_version_id=? ORDER BY priority,rule_key",
      )
      .bind(row.contract_version_id)
      .all<any>()
  ).results;
  return { ...row, rules };
}

function defaultAction(contract: any): RoyaltyRuleAction {
  return {
    basis:
      contract.calculation_basis === "list_price"
        ? "list_price"
        : contract.calculation_basis === "customer_price"
          ? "customer_price"
          : "net_receipts",
    foreCommissionBps: Number(contract.fore_commission_bps || 0),
    royaltyRateBps:
      contract.default_royalty_rate_bps == null
        ? undefined
        : Number(contract.default_royalty_rate_bps),
    reserveBps: Number(contract.reserve_bps || 0),
    paymentTermsDays: Number(contract.payment_terms_days || 60),
    processorFeeTreatment: "deduct",
    distributorFeeTreatment: "deduct",
    taxTreatment: "deduct",
    foreFundedDiscountTreatment: "add_back",
    publisherFundedDiscountTreatment: "deduct",
  };
}

function calculateEconomics(ctx: RoyaltyContext, action: RoyaltyRuleAction) {
  const list = Math.max(0, minor(ctx.listPriceMinor));
  const customer = Math.max(0, minor(ctx.customerPriceMinor));
  const tax = Math.max(0, minor(ctx.taxMinor));
  const processor = Math.max(0, minor(ctx.processorFeeMinor));
  const distributor = Math.max(0, minor(ctx.distributorFeeMinor));
  const foreFunded = Math.max(0, minor(ctx.foreFundedDiscountMinor));
  const publisherFunded = Math.max(0, minor(ctx.publisherFundedDiscountMinor));
  const grossValue = Math.max(0, minor(ctx.grossValueMinor ?? customer));
  let net = customer;
  if ((action.foreFundedDiscountTreatment || "add_back") === "add_back") net += foreFunded;
  if ((action.publisherFundedDiscountTreatment || "deduct") === "ignore") net += publisherFunded;
  if ((action.taxTreatment || "deduct") === "deduct") net -= tax;
  if ((action.processorFeeTreatment || "deduct") === "deduct") net -= processor;
  if ((action.distributorFeeTreatment || "deduct") === "deduct") net -= distributor;
  net = Math.max(0, net);
  const basisKind = action.basis || "net_receipts";
  const basis =
    basisKind === "list_price"
      ? list
      : basisKind === "customer_price"
        ? customer
        : basisKind === "gross_value"
          ? grossValue
          : net;
  const qty = Math.max(1, Math.round(Number(ctx.quantity || 1)));
  const flat = Math.max(0, minor(action.flatRoyaltyMinorPerUnit)) * qty;
  let commission = 0,
    pool = 0;
  if (action.royaltyRateBps != null) {
    pool = Math.max(0, Math.floor((basis * clampBps(action.royaltyRateBps)) / 10000) + flat);
    commission = Math.max(0, basis - pool);
  } else {
    commission = Math.floor((basis * clampBps(action.foreCommissionBps, 0)) / 10000);
    pool = Math.max(0, basis - commission + flat);
  }
  return {
    list,
    customer,
    tax,
    processor,
    distributor,
    foreFunded,
    publisherFunded,
    grossValue,
    netReceipts: net,
    basis,
    commission,
    pool,
  };
}

async function activeDisputeHold(db: CatalogDB, productId: string) {
  return !!(await db
    .prepare(
      `SELECT 1 ok FROM royalty_holds h WHERE h.status='active' AND ((h.scope_type='product' AND h.scope_id=?) OR (h.scope_type='edition' AND h.scope_id=(SELECT edition_id FROM products WHERE id=?)) OR (h.scope_type='publication' AND h.scope_id IN (SELECT id FROM publishing_publications WHERE product_id=?))) LIMIT 1`,
    )
    .bind(productId, productId, productId)
    .first<any>());
}

function ledger(
  statements: Parameters<CatalogDB["batch"]>[0],
  db: CatalogDB,
  orderId: string | null,
  userId: string | null,
  type: string,
  account: string,
  amount: number,
  currency: string,
  external: string,
  metadata: Record<string, unknown> = {},
) {
  statements.push(
    db
      .prepare(
        "INSERT INTO commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id("led"),
        orderId,
        userId,
        type,
        account,
        amount,
        currency,
        external,
        JSON.stringify(metadata),
        now(),
      ),
  );
}

type SaleRoyaltyPlan = {
  statements: Parameters<CatalogDB["batch"]>[0];
  at: string;
  processorFees?: Map<string, number>;
  preorderReleaseDates?: Map<string, string>;
};

async function calculateAndAccrueRoyalty(
  db: CatalogDB,
  ctx: RoyaltyContext,
  plan?: SaleRoyaltyPlan,
) {
  const existing = await db
    .prepare(
      "SELECT * FROM finance_royalty_calculations WHERE source_type=? AND source_id=? AND product_id=? ORDER BY calculated_at DESC LIMIT 1",
    )
    .bind(ctx.sourceType, ctx.sourceId, ctx.productId)
    .first<any>();
  if (existing) return existing;
  const contract = await contractForContext(db, ctx);
  if (!contract)
    throw new ApiError(
      409,
      `No active royalty contract covers ${ctx.productId} / ${ctx.territory} / ${ctx.salesChannel}.`,
    );
  let chosen: any = null;
  const trace: string[] = [`contract:${contract.id}:v${contract.version}`];
  for (const rule of contract.rules || []) {
    const conditions = safeJson<RoyaltyRuleConditions>(rule.conditions_json, {});
    if (ruleMatches(conditions, ctx)) {
      chosen = rule;
      trace.push(`rule:${rule.rule_key}`);
      break;
    }
    trace.push(`skip:${rule.rule_key}`);
  }
  const action = {
    ...defaultAction(contract),
    ...(chosen ? safeJson<RoyaltyRuleAction>(chosen.action_json, {}) : {}),
  };
  if (!chosen) trace.push("rule:contract-default");
  const economics = calculateEconomics(ctx, action);
  const rulesCanonical = JSON.stringify(
    (contract.rules || []).map((r: any) => ({
      key: r.rule_key,
      priority: r.priority,
      conditions: safeJson(r.conditions_json, {}),
      action: safeJson(r.action_json, {}),
    })),
  );
  const versionHash =
    contract.rules_version_hash ||
    (await sha256(
      JSON.stringify({
        contractId: contract.id,
        version: contract.version,
        defaults: defaultAction(contract),
        rules: rulesCanonical,
      }),
    ));
  const splits = (
    await db
      .prepare(
        "SELECT rs.*,fp.withholding_bps,fp.status party_status FROM finance_royalty_splits rs JOIN finance_parties fp ON fp.id=rs.party_id WHERE rs.contract_version_id=? ORDER BY rs.priority,rs.id",
      )
      .bind(contract.contract_version_id)
      .all<any>()
  ).results;
  if (!splits.length)
    throw new ApiError(
      409,
      `Royalty contract version ${contract.contract_version_id} has no payee splits.`,
    );
  const totalShare = splits.reduce((sum: number, s: any) => sum + Number(s.share_bps || 0), 0);
  if (totalShare !== 10000)
    throw new ApiError(
      500,
      `Royalty split must allocate exactly 100% for contract version ${contract.contract_version_id}; found ${totalShare / 100}%.`,
    );

  const statements: Parameters<CatalogDB["batch"]>[0] = plan?.statements || [];
  const calcId = id("roycalc"),
    calculatedAt = plan?.at || now();
  const snapshot = {
    context: ctx,
    economics,
    action,
    contract: {
      id: contract.id,
      versionId: contract.contract_version_id,
      version: contract.version,
    },
    rule: chosen ? { id: chosen.id, key: chosen.rule_key } : null,
  };
  statements.push(
    db
      .prepare(
        `INSERT INTO finance_royalty_calculations(id,source_type,source_id,order_id,order_item_id,usage_event_id,product_id,contract_id,contract_version_id,contract_version_hash,rule_id,territory_code,format,sales_channel,currency,quantity,list_price_minor,customer_price_minor,tax_minor,processor_fee_minor,promotion_discount_minor,fore_funded_discount_minor,publisher_funded_discount_minor,distributor_fee_minor,net_receipts_minor,basis_minor,fore_commission_minor,royalty_pool_minor,rule_trace_json,input_snapshot_json,calculated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        calcId,
        ctx.sourceType,
        ctx.sourceId,
        ctx.orderId || null,
        ctx.orderItemId || null,
        ctx.usageEventId || null,
        ctx.productId,
        contract.id,
        contract.contract_version_id,
        versionHash,
        chosen?.id || null,
        ctx.territory.toUpperCase(),
        ctx.format,
        ctx.salesChannel,
        ctx.currency.toUpperCase(),
        Math.max(1, Math.round(Number(ctx.quantity || 1))),
        economics.list,
        economics.customer,
        economics.tax,
        economics.processor,
        minor(ctx.promotionDiscountMinor),
        economics.foreFunded,
        economics.publisherFunded,
        economics.distributor,
        economics.netReceipts,
        economics.basis,
        economics.commission,
        economics.pool,
        JSON.stringify(trace),
        JSON.stringify(snapshot),
        calculatedAt,
      ),
  );
  const held = await activeDisputeHold(db, ctx.productId);
  const paymentTerms = Math.max(
    0,
    Math.min(730, Number(action.paymentTermsDays ?? contract.payment_terms_days ?? 60)),
  );
  const reserveBps = clampBps(action.reserveBps, Number(contract.reserve_bps || 0));
  const occurredMs = Date.parse(ctx.occurredAt);
  const anchorMs = ctx.availabilityAnchorAt ? Date.parse(ctx.availabilityAnchorAt) : occurredMs;
  const availabilityBaseMs = Number.isFinite(anchorMs)
    ? Math.max(occurredMs, anchorMs)
    : occurredMs;
  const availableAt = new Date(availabilityBaseMs + paymentTerms * 86400000).toISOString();
  const orderUser = ctx.orderId
    ? await db
        .prepare("SELECT user_id FROM commerce_orders WHERE id=?")
        .bind(ctx.orderId)
        .first<any>()
    : null;
  for (const split of splits) {
    const royalty = Math.floor((economics.pool * clampBps(split.share_bps)) / 10000);
    const tax = await effectivePublisherWithholding(db, String(split.party_id), calculatedAt);
    const withholdingBps = tax.taxProfileId ? tax.bps : clampBps(split.withholding_bps);
    const withholding = Math.floor((royalty * clampBps(withholdingBps)) / 10000);
    const reserve = Math.floor((royalty * reserveBps) / 10000);
    const payable = Math.max(0, royalty - withholding - reserve);
    const status = split.party_status === "hold" || held || !tax.verified ? "held" : "accrued";
    let legacyId: string | null = null;
    if (
      ctx.orderId &&
      ctx.orderItemId &&
      ["sale", "refund", "chargeback"].includes(ctx.sourceType)
    ) {
      legacyId = id("roy");
      statements.push(
        db
          .prepare(
            `INSERT INTO finance_royalty_events(id,order_id,order_item_id,contract_version_id,party_id,event_type,basis_minor,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,external_reference,created_at,royalty_calculation_id,sales_channel,territory_code,product_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            legacyId,
            ctx.orderId,
            ctx.orderItemId,
            contract.contract_version_id,
            split.party_id,
            ctx.sourceType,
            economics.basis,
            royalty,
            withholding,
            reserve,
            payable,
            ctx.currency,
            status,
            availableAt,
            ctx.sourceId,
            calculatedAt,
            calcId,
            ctx.salesChannel,
            ctx.territory,
            ctx.productId,
          ),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO finance_royalty_allocations(id,calculation_id,party_id,share_bps,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,legacy_royalty_event_id,created_at,tax_profile_id,withholding_rule_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id("royalloc"),
          calcId,
          split.party_id,
          Number(split.share_bps),
          royalty,
          withholding,
          reserve,
          payable,
          ctx.currency.toUpperCase(),
          status,
          availableAt,
          legacyId,
          calculatedAt,
          tax.taxProfileId || null,
          tax.ruleId || null,
        ),
    );
    const ref = `${calcId}:${split.party_id}`;
    ledger(
      statements,
      db,
      ctx.orderId || null,
      orderUser?.user_id || null,
      "royalty_accrual",
      "royalty_expense",
      royalty,
      ctx.currency,
      ref,
      {
        calculationId: calcId,
        contractVersionId: contract.contract_version_id,
        partyId: split.party_id,
        sourceType: ctx.sourceType,
      },
    );
    ledger(
      statements,
      db,
      ctx.orderId || null,
      orderUser?.user_id || null,
      "royalty_accrual",
      `royalty_payable:${split.party_id}`,
      -payable,
      ctx.currency,
      ref,
      { calculationId: calcId },
    );
    if (withholding)
      ledger(
        statements,
        db,
        ctx.orderId || null,
        orderUser?.user_id || null,
        "royalty_withholding",
        "withholding_payable",
        -withholding,
        ctx.currency,
        ref,
        { calculationId: calcId },
      );
    if (reserve)
      ledger(
        statements,
        db,
        ctx.orderId || null,
        orderUser?.user_id || null,
        "royalty_reserve",
        "royalty_reserve_liability",
        -reserve,
        ctx.currency,
        ref,
        { calculationId: calcId },
      );
  }
  // A calculation marker can never survive without ALL payee allocations
  // and its complete balanced journal. Unknown commit outcomes replay via
  // the existing unique source identity.
  if (plan)
    return {
      id: calcId,
      contract_version_id: contract.contract_version_id,
      fore_commission_minor: economics.commission,
    };
  await db.batch(statements);
  return db
    .prepare("SELECT * FROM finance_royalty_calculations WHERE id=?")
    .bind(calcId)
    .first<any>();
}

async function accrueSaleRoyaltiesForOrder(
  db: CatalogDB,
  orderId: string,
  plan?: SaleRoyaltyPlan,
) {
  const order = await db
    .prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(orderId)
    .first<any>();
  if (!order) throw new ApiError(404, "Order not found.");
  const items = (
    await db
      .prepare(
        `SELECT oi.*,p.format,e.publisher_id,e.release_status,pd.base_amount_minor,pd.scheduled_amount_minor,pd.promotion_amount_minor,pd.promotion_id,pr.promotion_type pricing_promotion_type,pr.funding_source pricing_funding_source,pr.publisher_funding_bps pricing_publisher_funding_bps,ped.rights_basis,pc.campaign_type checkout_promotion_type,pc.funding_source checkout_funding_source,pc.publisher_funding_bps checkout_publisher_funding_bps,rp.release_at preorder_release_at
    FROM commerce_order_items oi JOIN products p ON p.id=oi.product_id JOIN editions e ON e.id=p.edition_id
    LEFT JOIN pricing_decisions pd ON pd.id=oi.pricing_decision_id LEFT JOIN promotions pr ON pr.id=pd.promotion_id
    LEFT JOIN promotion_campaigns pc ON pc.id=oi.promotion_campaign_id
    LEFT JOIN preorders po ON po.id=oi.preorder_id LEFT JOIN preorder_release_plans rp ON rp.id=po.release_plan_id
    LEFT JOIN publishing_publications pub ON pub.id=(SELECT pub2.id FROM publishing_publications pub2 WHERE pub2.product_id=oi.product_id ORDER BY pub2.published_at DESC,pub2.id DESC LIMIT 1)
    LEFT JOIN publishing_submission_snapshots ss ON ss.id=pub.submission_id LEFT JOIN publishing_edition_drafts ped ON ped.id=ss.edition_id
    WHERE oi.order_id=?`,
      )
      .bind(orderId)
      .all<any>()
  ).results;
  const at = plan?.at || order.paid_at || now();
  for (const item of items) {
    const promoDiscount =
      Number(item.discount_minor || 0) + Number(item.promotion_amount_minor || 0);
    const pricingPromo = Number(item.promotion_amount_minor || 0);
    const pricingPublisherBps = clampBps(
      item.pricing_publisher_funding_bps,
      item.pricing_funding_source === "publisher"
        ? 10000
        : item.pricing_funding_source === "fore"
          ? 0
          : 5000,
    );
    const pricingPublisherFunding = Math.floor((pricingPromo * pricingPublisherBps) / 10000);
    const pricingCoveFunding = pricingPromo - pricingPublisherFunding;
    const checkoutPublisherFunding = Number(item.publisher_discount_funding_minor || 0);
    const checkoutCoveFunding = Number(item.fore_discount_funding_minor || 0);
    const calc = await calculateAndAccrueRoyalty(
      db,
      {
        sourceType: "sale",
        sourceId: item.id,
        orderId,
        orderItemId: item.id,
        productId: item.product_id,
        publisherId: item.publisher_id,
        territory: order.territory_code,
        format: item.format,
        salesChannel: item.sales_channel || "retail",
        currency: order.currency,
        quantity: 1,
        listPriceMinor: Number(
          item.scheduled_amount_minor ?? item.base_amount_minor ?? item.unit_amount_minor,
        ),
        customerPriceMinor: Math.max(
          0,
          Number(item.unit_amount_minor) - Number(item.discount_minor || 0),
        ),
        taxMinor: Number(item.tax_minor || 0),
        processorFeeMinor:
          plan?.processorFees?.get(item.id) ?? Number(item.processor_fee_minor || 0),
        promotionDiscountMinor: promoDiscount,
        foreFundedDiscountMinor: pricingCoveFunding + checkoutCoveFunding,
        publisherFundedDiscountMinor: pricingPublisherFunding + checkoutPublisherFunding,
        distributorFeeMinor: Number(item.distributor_fee_minor || 0),
        rightsBasis: item.rights_basis || null,
        promotionType: item.checkout_promotion_type || item.pricing_promotion_type || null,
        promotionFundingSource: item.checkout_funding_source || item.pricing_funding_source || null,
        occurredAt: at,
        availabilityAnchorAt:
          plan?.preorderReleaseDates?.get(item.id) ||
          (item.fulfillment_type === "preorder" ? item.preorder_release_at || null : null),
        metadata: {
          invoiceNumber: order.invoice_number,
          pricingDecisionId: item.pricing_decision_id || null,
          promotionCampaignId: item.promotion_campaign_id || null,
          preorderReleaseAt: item.preorder_release_at || null,
        },
      },
      plan,
    );
    if (calc) {
      const statement = db
        .prepare(
          "UPDATE commerce_order_items SET royalty_contract_version_id=?,recognized_revenue_minor=? WHERE id=?",
        )
        .bind(calc.contract_version_id, Number(calc.fore_commission_minor || 0), item.id);
      if (plan) plan.statements.push(statement);
      else await statement.run();
    }
  }
}

async function createRoyaltyContractVersion(db: CatalogDB, raw: unknown) {
  const ruleSchema = z.object({
    key: z.string().trim().min(1).max(120),
    priority: z.number().int().min(0).max(100000).default(100),
    conditions: z.record(z.string(), z.unknown()).default({}),
    action: z
      .object({
        basis: z.enum(["list_price", "customer_price", "net_receipts", "gross_value"]).optional(),
        royaltyRateBps: z.number().int().min(0).max(10000).optional(),
        foreCommissionBps: z.number().int().min(0).max(10000).optional(),
        flatRoyaltyMinorPerUnit: z.number().int().min(0).optional(),
        reserveBps: z.number().int().min(0).max(10000).optional(),
        paymentTermsDays: z.number().int().min(0).max(730).optional(),
        processorFeeTreatment: z.enum(["deduct", "ignore"]).optional(),
        distributorFeeTreatment: z.enum(["deduct", "ignore"]).optional(),
        taxTreatment: z.enum(["deduct", "ignore"]).optional(),
        foreFundedDiscountTreatment: z.enum(["add_back", "ignore"]).optional(),
        publisherFundedDiscountTreatment: z.enum(["deduct", "ignore"]).optional(),
      })
      .refine(
        (a) =>
          a.royaltyRateBps != null ||
          a.foreCommissionBps != null ||
          a.flatRoyaltyMinorPerUnit != null ||
          !!a.basis,
        "A rule action must change at least one royalty term.",
      ),
  });
  const x = z
    .object({
      contractId: z.string().min(1),
      effectiveFrom: z.string().datetime(),
      effectiveTo: z.string().datetime().nullable().optional(),
      basis: z.enum(["list_price", "customer_price", "net_revenue"]).default("net_revenue"),
      foreCommissionBps: z.number().int().min(0).max(10000).default(3000),
      defaultRoyaltyRateBps: z.number().int().min(0).max(10000).nullable().optional(),
      paymentTermsDays: z.number().int().min(0).max(730).default(60),
      reserveBps: z.number().int().min(0).max(10000).default(0),
      notes: z.string().max(2000).default(""),
      changeReason: z.string().trim().min(1).max(2000).default("Contract terms versioned."),
      createdByUserId: z.string().max(180).nullable().optional(),
      supersedesVersionId: z.string().nullable().optional(),
      splits: z
        .array(
          z.object({ partyId: z.string().min(1), shareBps: z.number().int().min(0).max(10000) }),
        )
        .min(1),
      rules: z.array(ruleSchema).default([]),
    })
    .parse(raw);
  if (x.effectiveTo && x.effectiveTo <= x.effectiveFrom)
    throw new ApiError(400, "Contract version end must be after its start.");
  if (x.splits.reduce((s, r) => s + r.shareBps, 0) !== 10000)
    throw new ApiError(400, "Royalty splits must allocate exactly 100%.");
  const contract = await db
    .prepare("SELECT * FROM finance_royalty_contracts WHERE id=?")
    .bind(x.contractId)
    .first<any>();
  if (!contract) throw new ApiError(404, "Royalty contract not found.");
  const versionId = seed?"rcv_"+seed:id("rcv");
  if(seed){
    const done=await db.prepare("SELECT contract_id,version,rules_version_hash FROM finance_royalty_contract_versions WHERE id=?").bind(versionId).first<any>();
    if(done)return {contractId:done.contract_id,versionId,version:Number(done.version),rulesVersionHash:done.rules_version_hash};
  }
  const previous = await db
    .prepare(
      "SELECT id,version FROM finance_royalty_contract_versions WHERE contract_id=? ORDER BY version DESC LIMIT 1",
    )
    .bind(x.contractId)
    .first<any>();
  if (x.supersedesVersionId) {
    const target = await db
      .prepare("SELECT id FROM finance_royalty_contract_versions WHERE id=? AND contract_id=?")
      .bind(x.supersedesVersionId, x.contractId)
      .first<any>();
    if (!target)
      throw new ApiError(
        400,
        "Superseded royalty-contract version does not belong to this contract.",
      );
  }
  const version = Number(previous?.version || 0) + 1;
  const supersedesVersionId = x.supersedesVersionId || previous?.id || null;
  const at = now();
  const canonical = JSON.stringify({
    contractId: x.contractId,
    version,
    supersedesVersionId,
    effectiveFrom: x.effectiveFrom,
    effectiveTo: x.effectiveTo || null,
    basis: x.basis,
    foreCommissionBps: x.foreCommissionBps,
    defaultRoyaltyRateBps: x.defaultRoyaltyRateBps ?? null,
    paymentTermsDays: x.paymentTermsDays,
    reserveBps: x.reserveBps,
    splits: x.splits,
    rules: x.rules,
    changeReason: x.changeReason,
  });
  const hash = await sha256(canonical);
  const statements:Parameters<CatalogDB["batch"]>[0]=[];
  statements.push(db
    .prepare(
      "INSERT INTO finance_royalty_contract_versions(id,contract_id,version,calculation_basis,fore_commission_bps,payment_terms_days,reserve_bps,effective_from,created_at,rules_version_hash,default_royalty_rate_bps,effective_to,notes,supersedes_version_id,created_by_user_id,change_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      versionId,
      x.contractId,
      version,
      x.basis,
      x.foreCommissionBps,
      x.paymentTermsDays,
      x.reserveBps,
      x.effectiveFrom,
      at,
      hash,
      x.defaultRoyaltyRateBps ?? null,
      x.effectiveTo || null,
      x.notes,
      supersedesVersionId,
      x.createdByUserId || null,
      x.changeReason,
    )
    );
  for (const [i, s] of x.splits.entries())
    statements.push(db
      .prepare(
        "INSERT INTO finance_royalty_splits(id,contract_version_id,party_id,share_bps,priority,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(id("rs"), versionId, s.partyId, s.shareBps, i, at)
      );
  const rules = x.rules.length
    ? x.rules
    : [
        {
          key: "default",
          priority: 100,
          conditions: {},
          action: {
            basis: x.basis === "net_revenue" ? "net_receipts" : x.basis,
            foreCommissionBps: x.foreCommissionBps,
            reserveBps: x.reserveBps,
            paymentTermsDays: x.paymentTermsDays,
          },
        },
      ];
  for (const r of rules)
    statements.push(db
      .prepare(
        "INSERT INTO finance_royalty_rules(id,contract_version_id,rule_key,priority,conditions_json,action_json,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        id("rule"),
        versionId,
        r.key,
        r.priority,
        JSON.stringify(r.conditions),
        JSON.stringify(r.action),
        at,
      )
      );
  await db.batch(statements);
  return { contractId: x.contractId, versionId, version, rulesVersionHash: hash };
}

async function recordUsageEvent(db: CatalogDB, raw: unknown) {
  const x = z
    .object({
      sourceType: z.enum([
        "subscription_read",
        "subscription_listen",
        "library_loan",
        "library_read",
        "library_listen",
        "wholesale_unit",
        "agency_unit",
      ]),
      sourceReference: z.string().min(1).max(240),
      productId: z.string().min(1),
      userId: z.string().nullable().optional(),
      territory: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .default("US"),
      currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/)
        .default("USD"),
      units: z.number().min(0).default(0),
      pagesRead: z.number().int().min(0).default(0),
      secondsConsumed: z.number().int().min(0).default(0),
      grossValueMinor: z.number().int().min(0).default(0),
      poolId: z.string().nullable().optional(),
      occurredAt: z.string().datetime(),
      deviceFingerprintHash: z.union([z.literal(""), z.string().min(16).max(128)]).default(""),
      networkFingerprintHash: z.union([z.literal(""), z.string().min(16).max(128)]).default(""),
      sessionFingerprintHash: z.union([z.literal(""), z.string().min(16).max(128)]).default(""),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(raw);
  const eventId = id("usage"),
    at = now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO finance_usage_events(id,source_type,source_reference,product_id,user_id,territory_code,currency,units,pages_read,seconds_consumed,gross_value_minor,pool_id,occurred_at,metadata_json,created_at,device_fingerprint_hash,network_fingerprint_hash,session_fingerprint_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      eventId,
      x.sourceType,
      x.sourceReference,
      x.productId,
      x.userId || null,
      x.territory.toUpperCase(),
      x.currency.toUpperCase(),
      x.units,
      x.pagesRead,
      x.secondsConsumed,
      x.grossValueMinor,
      x.poolId || null,
      x.occurredAt,
      JSON.stringify(x.metadata),
      at,
      x.deviceFingerprintHash,
      x.networkFingerprintHash,
      x.sessionFingerprintHash,
    )
    .run();
  const persisted = await db
    .prepare("SELECT * FROM finance_usage_events WHERE source_type=? AND source_reference=?")
    .bind(x.sourceType, x.sourceReference)
    .first<any>();
  return persisted;
}

async function processUsageEventRoyalty(db: CatalogDB, usageEventId: string) {
  const u = await db
    .prepare(
      `SELECT u.*,p.format,e.publisher_id FROM finance_usage_events u JOIN products p ON p.id=u.product_id JOIN editions e ON e.id=p.edition_id WHERE u.id=?`,
    )
    .bind(usageEventId)
    .first<any>();
  if (!u) throw new ApiError(404, "Usage event not found.");
  if (u.processed_at) return { usageEventId, status: "already_processed" };
  const risk = await assessUsageRisk(db, usageEventId);
  if (["hold", "block"].includes(risk.action))
    return {
      usageEventId,
      status: "held_for_risk_review",
      riskAssessmentId: risk.id,
      riskScore: risk.score,
    };
  const channel = String(u.source_type).startsWith("subscription")
    ? "subscription"
    : String(u.source_type).startsWith("library")
      ? "library"
      : String(u.source_type).startsWith("wholesale")
        ? "wholesale"
        : "agency";
  const quantity =
    channel === "subscription"
      ? Number(u.pages_read || 0) > 0
        ? Number(u.pages_read)
        : Number(u.seconds_consumed || 0) > 0
          ? Number(u.seconds_consumed)
          : Math.max(1, Number(u.units || 0))
      : Math.max(1, Math.round(Number(u.units || 1)));
  const meta = safeJson<any>(u.metadata_json, {});
  const calc = await calculateAndAccrueRoyalty(db, {
    sourceType: channel as any,
    sourceId: u.id,
    usageEventId: u.id,
    productId: u.product_id,
    publisherId: u.publisher_id,
    territory: u.territory_code || "US",
    format: u.format || "ebook",
    salesChannel: channel,
    currency: u.currency || "USD",
    quantity,
    grossValueMinor: Number(u.gross_value_minor || 0),
    customerPriceMinor: Number(u.gross_value_minor || 0),
    listPriceMinor: Number(u.gross_value_minor || 0),
    taxMinor: Number(meta.taxMinor || 0),
    processorFeeMinor: Number(meta.processorFeeMinor || 0),
    distributorFeeMinor: Number(meta.distributorFeeMinor || 0),
    rightsBasis: meta.rightsBasis || null,
    distributorId: meta.distributorId || null,
    subscriptionPlanId: meta.subscriptionPlanId || null,
    occurredAt: u.occurred_at,
    metadata: meta,
  });
  await db
    .prepare("UPDATE finance_usage_events SET processed_at=? WHERE id=?")
    .bind(now(), u.id)
    .run();
  return { usageEventId: u.id, calculationId: calc?.id, status: "processed" };
}

async function createUsagePool(db: CatalogDB, raw: unknown) {
  const x = z
    .object({
      poolType: z.enum(["subscription", "library", "wholesale"]),
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
      territory: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .nullable()
        .optional(),
      currency: z.string().regex(/^[A-Za-z]{3}$/),
      poolMinor: z.number().int().min(0),
      metric: z.enum(["units", "pages", "seconds", "weighted"]),
      rules: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(raw);
  if (x.periodEnd <= x.periodStart)
    throw new ApiError(400, "Usage-pool end must be after its start.");
  const poolId = seed?"pool_"+seed:id("pool"),
    at = now();
  await db
    .prepare(
      "INSERT OR IGNORE INTO finance_usage_pools(id,pool_type,period_start,period_end,territory_code,currency,pool_minor,metric,status,rules_json,created_at) VALUES(?,?,?,?,?,?,?,?,'draft',?,?)",
    )
    .bind(
      poolId,
      x.poolType,
      x.periodStart,
      x.periodEnd,
      x.territory?.toUpperCase() || null,
      x.currency.toUpperCase(),
      x.poolMinor,
      x.metric,
      JSON.stringify(x.rules),
      at,
    )
    .run();
  return { id: poolId, status: "draft" };
}

async function allocateUsagePool(db: CatalogDB, poolId: string) {
  const pool = await db
    .prepare("SELECT * FROM finance_usage_pools WHERE id=?")
    .bind(poolId)
    .first<any>();
  if (!pool) throw new ApiError(404, "Usage pool not found.");
  if (pool.status === "allocated" || pool.status === "closed")
    return { poolId, status: pool.status };
  if (pool.status !== "draft" && pool.status !== "locked")
    throw new ApiError(409, "Usage pool cannot be allocated from its current state.");
  const family =
    pool.pool_type === "subscription"
      ? "subscription_%"
      : pool.pool_type === "library"
        ? "library_%"
        : "wholesale_%";
  const recovering=pool.status==="locked";
  const rows = (
    await db
      .prepare(
        `SELECT * FROM finance_usage_events WHERE source_type LIKE ? AND occurred_at>=? AND occurred_at<? AND currency=? AND (? IS NULL OR territory_code=?) AND processed_at IS NULL AND (pool_id IS NULL OR pool_id=?) ORDER BY occurred_at,id`,
      )
      .bind(
        family,
        pool.period_start,
        pool.period_end,
        pool.currency,
        pool.territory_code,
        pool.territory_code,
        pool.id,
      )
      .all<any>()
  ).results;
  if(recovering){
    const assigned=(await db.prepare("SELECT id FROM finance_usage_events WHERE pool_id=? AND processed_at IS NULL ORDER BY occurred_at,id").bind(pool.id).all<any>()).results;
    for(const row of assigned)await processUsageEventRoyalty(db,row.id);
    const pending=Number((await db.prepare("SELECT COUNT(*) n FROM finance_usage_events WHERE pool_id=? AND processed_at IS NULL").bind(pool.id).first<any>())?.n||0);
    if(pending)return {poolId:pool.id,status:"locked",pending};
    await db.prepare("UPDATE finance_usage_pools SET status='allocated',allocated_at=? WHERE id=?").bind(now(),pool.id).run();
    return {poolId:pool.id,status:"allocated",recovered:true};
  }
  if (!rows.length) throw new ApiError(409, "No unprocessed usage events match this pool.");
  const rules = safeJson<any>(pool.rules_json, {});
  const weight = (r: any) =>
    pool.metric === "pages"
      ? Number(r.pages_read || 0)
      : pool.metric === "seconds"
        ? Number(r.seconds_consumed || 0)
        : pool.metric === "weighted"
          ? Number(r.units || 0) * Number(rules.unitWeight ?? 1) +
            Number(r.pages_read || 0) * Number(rules.pageWeight ?? 0) +
            Number(r.seconds_consumed || 0) * Number(rules.secondWeight ?? 0)
          : Number(r.units || 0);
  const weights = rows.map(weight),
    total = weights.reduce((a: number, b: number) => a + b, 0);
  if (total <= 0) throw new ApiError(409, "Usage pool has no positive allocation metric.");
  const raw = weights.map((w: number) => (Number(pool.pool_minor) * w) / total),
    alloc = raw.map((v: number) => Math.floor(v));
  let remaining = Number(pool.pool_minor) - alloc.reduce((a: number, b: number) => a + b, 0);
  raw
    .map((v: number, i: number) => ({ i, f: v - Math.floor(v) }))
    .sort((a: any, b: any) => b.f - a.f || a.i - b.i)
    .forEach((x: any) => {
      if (remaining-- > 0) alloc[x.i]++;
    });
  const at = now();
  const statements:Parameters<CatalogDB["batch"]>[0]=[
    db.prepare("UPDATE finance_usage_pools SET status='locked',locked_at=? WHERE id=? AND status='draft'").bind(at,pool.id)
  ];
  for(let i=0;i<rows.length;i++)statements.push(db.prepare(
    "UPDATE finance_usage_events SET gross_value_minor=?,pool_id=? WHERE id=? AND processed_at IS NULL"
  ).bind(alloc[i],pool.id,rows[i].id));
  await db.batch(statements);
  for(const row of rows)await processUsageEventRoyalty(db,row.id);
  const pending=Number((await db.prepare("SELECT COUNT(*) n FROM finance_usage_events WHERE pool_id=? AND processed_at IS NULL").bind(pool.id).first<any>())?.n||0);
  if(pending)return {poolId:pool.id,status:"locked",pending};
  await db
    .prepare("UPDATE finance_usage_pools SET status='allocated',allocated_at=? WHERE id=?")
    .bind(now(), pool.id)
    .run();
  return {
    poolId: pool.id,
    status: "allocated",
    events: rows.length,
    poolMinor: Number(pool.pool_minor),
    allocatedMinor: alloc.reduce((a: number, b: number) => a + b, 0),
  };
}

return {calculateAndAccrueRoyalty,accrueSaleRoyaltiesForOrder,createRoyaltyContractVersion,recordUsageEvent,processUsageEventRoyalty,createUsagePool,allocateUsagePool};
};
const privateRoyalty=createPrivateRoyalty();
const createPrivateFinance=(royalty=privateRoyalty,seed?:string)=>{
let sequence=0;
const {accrueSaleRoyaltiesForOrder,createRoyaltyContractVersion}=royalty;
const now = () => new Date().toISOString();
const uid = (p: string) => `${p}_${seed?seed+"_"+(++sequence):crypto.randomUUID()}`;

async function postLedger(
  db: CatalogDB,
  orderId: string | null,
  userId: string | null,
  type: string,
  account: string,
  amount: number,
  currency: string,
  external: string,
  metadata: any = {},
  statements?:Parameters<CatalogDB["batch"]>[0],
) {
  const exists = await db
    .prepare(
      "SELECT 1 ok FROM commerce_ledger_entries WHERE COALESCE(order_id,'')=COALESCE(?,'') AND entry_type=? AND account_code=? AND external_reference=? LIMIT 1",
    )
    .bind(orderId, type, account, external)
    .first<any>();
  if (exists) return;
  const statement=db
    .prepare(
      "INSERT OR IGNORE INTO commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      "led_"+crypto.randomUUID(),
      orderId,
      userId,
      type,
      account,
      amount,
      currency,
      external,
      JSON.stringify(metadata),
      now(),
    )
;
  if(statements)statements.push(statement);else await db.batch([statement]);
}

async function accrueRoyaltiesForOrder(db: CatalogDB, orderId: string) {
  return accrueSaleRoyaltiesForOrder(db, orderId);
}

async function reversalFromCalculation(
  db: CatalogDB,
  sourceType: "refund" | "chargeback",
  sourceId: string,
  original: any,
  ratio: number,
  order: any,
  refundId: string | null,
) {
  const reversalSource = `${sourceId}:${original.id}`;
  const exists = await db
    .prepare(
      "SELECT id FROM finance_royalty_calculations WHERE source_type=? AND source_id=? AND product_id=?",
    )
    .bind(sourceType, reversalSource, original.product_id)
    .first<any>();
  if (exists) return;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([sourceType, sourceId, original.id])),
  );
  const calcId =
      "roycalc_" +
      Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""),
    at = now(),
    scale = (n: any) =>
      -Math.min(Math.abs(Number(n || 0)), Math.round(Math.abs(Number(n || 0)) * ratio));
  const statements: Parameters<CatalogDB["batch"]>[0] = [];
  const appendLedger = (
    type: string,
    account: string,
    amount: number,
    reference: string,
    metadata: Record<string, unknown>,
  ) => {
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO commerce_ledger_entries(id,order_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          `led:${calcId}:${reference}:${account}`,
          original.order_id,
          order?.user_id || null,
          type,
          account,
          amount,
          original.currency,
          reference,
          JSON.stringify(metadata),
          at,
        ),
    );
  };
  statements.push(
    db
      .prepare(
        `INSERT INTO finance_royalty_calculations(id,source_type,source_id,order_id,order_item_id,product_id,contract_id,contract_version_id,contract_version_hash,rule_id,territory_code,format,sales_channel,currency,quantity,list_price_minor,customer_price_minor,tax_minor,processor_fee_minor,promotion_discount_minor,fore_funded_discount_minor,publisher_funded_discount_minor,distributor_fee_minor,net_receipts_minor,basis_minor,fore_commission_minor,royalty_pool_minor,rule_trace_json,input_snapshot_json,calculated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        calcId,
        sourceType,
        reversalSource,
        original.order_id,
        original.order_item_id,
        original.product_id,
        original.contract_id,
        original.contract_version_id,
        original.contract_version_hash,
        original.rule_id,
        original.territory_code,
        original.format,
        original.sales_channel,
        original.currency,
        original.quantity,
        scale(original.list_price_minor),
        scale(original.customer_price_minor),
        scale(original.tax_minor),
        scale(original.processor_fee_minor),
        scale(original.promotion_discount_minor),
        scale(original.fore_funded_discount_minor),
        scale(original.publisher_funded_discount_minor),
        scale(original.distributor_fee_minor),
        scale(original.net_receipts_minor),
        scale(original.basis_minor),
        scale(original.fore_commission_minor),
        scale(original.royalty_pool_minor),
        JSON.stringify([`reversal:${sourceType}`, `original:${original.id}`, `ratio:${ratio}`]),
        JSON.stringify({ reversalOf: original.id, ratio, sourceId }),
        at,
      ),
  );
  const allocations = (
    await db
      .prepare("SELECT * FROM finance_royalty_allocations WHERE calculation_id=? ORDER BY party_id")
      .bind(original.id)
      .all<any>()
  ).results;
  for (const a of allocations) {
    const royalty = scale(a.royalty_minor),
      withholding = scale(a.withholding_minor),
      reserve = scale(a.reserve_minor),
      payable = scale(a.payable_minor),
      legacyId = `roy:${calcId}:${a.party_id}`;
    if (original.order_id && original.order_item_id) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO finance_royalty_events(id,order_id,order_item_id,refund_id,contract_version_id,party_id,event_type,basis_minor,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,external_reference,created_at,royalty_calculation_id,sales_channel,territory_code,product_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            legacyId,
            original.order_id,
            original.order_item_id,
            refundId,
            original.contract_version_id,
            a.party_id,
            sourceType,
            scale(original.basis_minor),
            royalty,
            withholding,
            reserve,
            payable,
            original.currency,
            "accrued",
            at,
            reversalSource,
            at,
            calcId,
            original.sales_channel,
            original.territory_code,
            original.product_id,
          ),
      );
    }
    statements.push(
      db
        .prepare(
          "INSERT INTO finance_royalty_allocations(id,calculation_id,party_id,share_bps,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,legacy_royalty_event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'accrued',?,?,?)",
        )
        .bind(
          `royalloc:${calcId}:${a.party_id}`,
          calcId,
          a.party_id,
          a.share_bps,
          royalty,
          withholding,
          reserve,
          payable,
          original.currency,
          at,
          original.order_id ? legacyId : null,
          at,
        ),
    );
    const ref = `${calcId}:${a.party_id}`;
    appendLedger(`royalty_${sourceType}`, "royalty_expense", royalty, ref, {
      reversalOf: original.id,
      sourceId,
    });
    appendLedger(`royalty_${sourceType}`, `royalty_payable:${a.party_id}`, -payable, ref, {
      reversalOf: original.id,
      sourceId,
    });
    if (withholding)
      appendLedger(`royalty_${sourceType}`, "withholding_payable", -withholding, ref, {
        reversalOf: original.id,
      });
    if (reserve)
      appendLedger(`royalty_${sourceType}`, "royalty_reserve_liability", -reserve, ref, {
        reversalOf: original.id,
      });
  }
  // A calculation row cannot become the completion marker before its
  // allocations and balanced ledger exist. D1 rolls back the ENTIRE batch
  // on any failed posting. Competing exact retries either commit once or
  // observe the already committed unique calculation after losing the race.
  try {
    await db.batch(statements);
  } catch (error) {
    const committed = await db
      .prepare(
        "SELECT id FROM finance_royalty_calculations WHERE source_type=? AND source_id=? AND product_id=?",
      )
      .bind(sourceType, reversalSource, original.product_id)
      .first<{ id: string }>();
    if (!committed || committed.id !== calcId) throw error;
  }
}

async function reverseRoyaltiesForRefund(db: CatalogDB, refundId: string) {
  const refund = await db
    .prepare("SELECT * FROM commerce_refunds WHERE id=?")
    .bind(refundId)
    .first<any>();
  if (!refund) return;
  const order = await db
    .prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(refund.order_id)
    .first<any>();
  if (!order) return;
  const ratio = Math.min(1, Number(refund.amount_minor) / Math.max(1, Number(order.total_minor)));
  const calculations = (
    await db
      .prepare("SELECT * FROM finance_royalty_calculations WHERE order_id=? AND source_type='sale'")
      .bind(order.id)
      .all<any>()
  ).results;
  for (const c of calculations)
    await reversalFromCalculation(db, "refund", refund.id, c, ratio, order, refund.id);
}

async function createRoyaltyContract(db: CatalogDB, raw: unknown) {
  const x = z
    .object({
      name: z.string().min(1),
      publisherId: z.string().nullable().optional(),
      productId: z.string().nullable().optional(),
      editionId: z.string().nullable().optional(),
      territory: z.string().length(2).nullable().optional(),
      format: z.string().nullable().optional(),
      salesChannel: z
        .enum(["retail", "subscription", "library", "wholesale", "agency"])
        .default("retail"),
      effectiveFrom: z.string().datetime(),
      effectiveTo: z.string().datetime().nullable().optional(),
      basis: z.enum(["list_price", "customer_price", "net_revenue"]).default("net_revenue"),
      foreCommissionBps: z.number().int().min(0).max(10000).default(3000),
      defaultRoyaltyRateBps: z.number().int().min(0).max(10000).nullable().optional(),
      paymentTermsDays: z.number().int().min(0).max(730).default(60),
      reserveBps: z.number().int().min(0).max(10000).default(0),
      notes: z.string().max(2000).default(""),
      splits: z
        .array(z.object({ partyId: z.string(), shareBps: z.number().int().min(0).max(10000) }))
        .min(1),
      rules: z.array(z.any()).default([]),
    })
    .parse(raw);
  if (x.splits.reduce((s, r) => s + r.shareBps, 0) !== 10000)
    throw new ApiError(400, "Royalty splits must allocate exactly 100%.");
  const at = now(),
    id = uid("rc");
  await db
    .prepare(
      "INSERT OR IGNORE INTO finance_royalty_contracts(id,name,publisher_id,product_id,edition_id,territory_code,format,sales_channel,effective_from,effective_to,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?)",
    )
    .bind(
      id,
      x.name,
      x.publisherId || null,
      x.productId || null,
      x.editionId || null,
      x.territory?.toUpperCase() || null,
      x.format || null,
      x.salesChannel,
      x.effectiveFrom,
      x.effectiveTo || null,
      at,
      at,
    )
    .run();
  const version = await createRoyaltyContractVersion(db, {
    contractId: id,
    effectiveFrom: x.effectiveFrom,
    effectiveTo: x.effectiveTo,
    basis: x.basis,
    foreCommissionBps: x.foreCommissionBps,
    defaultRoyaltyRateBps: x.defaultRoyaltyRateBps,
    paymentTermsDays: x.paymentTermsDays,
    reserveBps: x.reserveBps,
    notes: x.notes,
    splits: x.splits,
    rules: x.rules,
  });
  return {
    id,
    versionId: version.versionId,
    version: version.version,
    rulesVersionHash: version.rulesVersionHash,
  };
}

async function createFinanceParty(db: CatalogDB, raw: unknown) {
  const x = z
      .object({
        type: z.enum(["publisher", "author", "agent", "narrator", "distributor", "other"]),
        displayName: z.string().min(1),
        publisherId: z.string().nullable().optional(),
        contributorId: z.string().nullable().optional(),
        taxCountry: z.string().length(2).nullable().optional(),
        withholdingBps: z.number().int().min(0).max(10000).default(0),
        payoutCurrency: z.string().length(3).default("USD"),
      })
      .parse(raw),
    at = now(),
    id = uid("party");
  await db
    .prepare(
      "INSERT OR IGNORE INTO finance_parties(id,party_type,display_name,publisher_id,contributor_id,tax_country,withholding_bps,payout_currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'active',?,?)",
    )
    .bind(
      id,
      x.type,
      x.displayName,
      x.publisherId || null,
      x.contributorId || null,
      x.taxCountry?.toUpperCase() || null,
      x.withholdingBps,
      x.payoutCurrency.toUpperCase(),
      at,
      at,
    )
    .run();
  return { id };
}

async function createPayoutBatch(db: CatalogDB, raw: unknown) {
  const x = z
      .object({
        currency: z.string().length(3),
        periodStart: z.string().datetime(),
        periodEnd: z.string().datetime(),
      })
      .parse(raw),
    at = now(),
    id = uid("paybatch"),
    currency = x.currency.toUpperCase();
  const existing=seed?await db.prepare("SELECT * FROM payout_batches WHERE id=?").bind(id).first<any>():null;
  if(existing){
    const items=(await db.prepare("SELECT id FROM payout_items WHERE batch_id=? ORDER BY id").bind(id).all<any>()).results;
    for(const item of items)await assessPayoutRisk(db,item.id);
    return {id,grossMinor:Number(existing.gross_minor),withholdingMinor:Number(existing.withholding_minor),netMinor:Number(existing.net_minor),parties:items.length};
  }
  const statements:Parameters<CatalogDB["batch"]>[0]=[];
  const riskItems:string[]=[];
  const eligible = await db
    .prepare(
      `SELECT party_id,SUM(royalty_minor) gross,SUM(withholding_minor) withholding,SUM(payable_minor) net FROM finance_royalty_allocations WHERE currency=? AND status='accrued' AND available_at<=? AND created_at>=? AND created_at<? AND NOT EXISTS(SELECT 1 FROM payout_allocation_links pal JOIN payout_items pi ON pi.id=pal.payout_item_id JOIN payout_batches pb ON pb.id=pi.batch_id WHERE pal.royalty_allocation_id=finance_royalty_allocations.id AND pb.status<>'canceled') GROUP BY party_id HAVING SUM(payable_minor)<>0`,
    )
    .bind(currency, at, x.periodStart, x.periodEnd)
    .all<any>();
  let gross = 0,
    withholding = 0,
    net = 0;
  statements.push(db
    .prepare(
      "INSERT INTO payout_batches(id,currency,period_start,period_end,status,created_at) VALUES(?,?,?,?,'draft',?)",
    )
    .bind(id, currency, x.periodStart, x.periodEnd, at)
    );
  for (const r of eligible.results) {
    const pi = uid("payi");
    statements.push(db
      .prepare(
        "INSERT INTO payout_items(id,batch_id,party_id,currency,gross_minor,withholding_minor,net_minor,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
      )
      .bind(pi, id, r.party_id, currency, r.gross, r.withholding, r.net, at)
      );
    const allocations = await db
      .prepare(
        "SELECT id,legacy_royalty_event_id,tax_profile_id FROM finance_royalty_allocations WHERE party_id=? AND currency=? AND status='accrued' AND available_at<=? AND created_at>=? AND created_at<? AND NOT EXISTS(SELECT 1 FROM payout_allocation_links pal JOIN payout_items pi ON pi.id=pal.payout_item_id JOIN payout_batches pb ON pb.id=pi.batch_id WHERE pal.royalty_allocation_id=finance_royalty_allocations.id AND pb.status<>'canceled')",
      )
      .bind(r.party_id, currency, at, x.periodStart, x.periodEnd)
      .all<any>();
    for (const a of allocations.results) {
      statements.push(db
        .prepare(
          "INSERT OR IGNORE INTO payout_allocation_links(payout_item_id,royalty_allocation_id) VALUES(?,?)",
        )
        .bind(pi, a.id)
        );
      if (a.legacy_royalty_event_id)
        statements.push(db
          .prepare(
            "INSERT OR IGNORE INTO payout_event_links(payout_item_id,royalty_event_id) VALUES(?,?)",
          )
          .bind(pi, a.legacy_royalty_event_id)
          );
    }
    const taxProfile =
      allocations.results.find((a: any) => a.tax_profile_id)?.tax_profile_id || null;
    if (taxProfile)
      statements.push(db
        .prepare("UPDATE payout_items SET tax_profile_id=? WHERE id=?")
        .bind(taxProfile, pi)
        );
    riskItems.push(pi);
    gross += Number(r.gross);
    withholding += Number(r.withholding);
    net += Number(r.net);
  }
  statements.push(db
    .prepare("UPDATE payout_batches SET gross_minor=?,withholding_minor=?,net_minor=? WHERE id=?")
    .bind(gross, withholding, net, id)
    );
  await db.batch(statements);
  for(const pi of riskItems)await assessPayoutRisk(db,pi);
  return {
    id,
    grossMinor: gross,
    withholdingMinor: withholding,
    netMinor: net,
    parties: eligible.results.length,
  };
}

async function approvePayoutBatch(db:CatalogDB,batchId:string){
 const b=await db.prepare("SELECT * FROM payout_batches WHERE id=?").bind(batchId).first<any>();
 if(!b||!["draft","approved"].includes(b.status))throw new ApiError(409,"Payout batch is not in draft status.");
 const held=Number((await db.prepare("SELECT COUNT(*) n FROM payout_items WHERE batch_id=? AND status='held'").bind(batchId).first<any>())?.n||0);
 if(b.status==="draft")await db.batch([
  db.prepare("UPDATE payout_batches SET status='approved',approved_at=? WHERE id=?").bind(now(),batchId),
  db.prepare("UPDATE finance_royalty_allocations SET status='payable' WHERE id IN (SELECT royalty_allocation_id FROM payout_allocation_links WHERE payout_item_id IN (SELECT id FROM payout_items WHERE batch_id=? AND status='pending')) AND status='accrued'").bind(batchId),
  db.prepare("UPDATE finance_royalty_events SET status='payable' WHERE id IN (SELECT royalty_event_id FROM payout_event_links WHERE payout_item_id IN (SELECT id FROM payout_items WHERE batch_id=? AND status='pending')) AND status='accrued'").bind(batchId)
 ]);
 return {id:batchId,status:"approved",heldItems:held};
}

async function reverseRoyaltiesForChargeback(
  db: CatalogDB,
  orderId: string,
  disputeId: string,
) {
  const order = await db
    .prepare("SELECT * FROM commerce_orders WHERE id=?")
    .bind(orderId)
    .first<any>();
  if (!order) return;
  const calculations = (
    await db
      .prepare("SELECT * FROM finance_royalty_calculations WHERE order_id=? AND source_type='sale'")
      .bind(orderId)
      .all<any>()
  ).results;
  for (const c of calculations)
    await reversalFromCalculation(db, "chargeback", disputeId, c, 1, order, null);
}

async function settlePayoutBatch(db: CatalogDB, raw: unknown) {
  const x = z
      .object({
        batchId: z.string().min(1),
        settlements: z
          .array(
            z.object({
              payoutItemId: z.string().min(1),
              externalPayoutId: z.string().min(3).max(180),
            }),
          )
          .min(1),
      })
      .parse(raw),
    batch = await db
      .prepare("SELECT * FROM payout_batches WHERE id=?")
      .bind(x.batchId)
      .first<any>();
  if (!batch || !["approved", "processing", "paid"].includes(batch.status))
    throw new ApiError(409, "Payout batch is not approved for settlement.");
  const at = now();
  for (const settlement of x.settlements) {
    const item = await db
      .prepare("SELECT * FROM payout_items WHERE id=? AND batch_id=?")
      .bind(settlement.payoutItemId, x.batchId)
      .first<any>();
    if (!item) throw new ApiError(404, "Payout item not found.");
    if (item.status === "paid") {
      if(item.external_payout_id!==settlement.externalPayoutId)
        throw new ApiError(409,"A paid item cannot change its payout-provider reference.");
      continue;
    }
    const reused=await db.prepare("SELECT id FROM payout_items WHERE external_payout_id=? AND id<>? LIMIT 1")
      .bind(settlement.externalPayoutId,item.id).first<any>();
    if(reused)throw new ApiError(409,"A payout-provider reference cannot settle two items.");
    if (item.status === "held")
      throw new ApiError(
        409,
        `Payout item is held by rights, fraud, or tax compliance (${item.hold_reason_code || "ACTIVE_HOLD"}).`,
      );
    const held = await db
      .prepare(
        "SELECT 1 ok FROM finance_royalty_allocations WHERE status='held' AND id IN (SELECT royalty_allocation_id FROM payout_allocation_links WHERE payout_item_id=?) LIMIT 1",
      )
      .bind(item.id)
      .first<any>();
    if (held)
      throw new ApiError(409, "Payout item contains royalties frozen by an active rights dispute.");
    const statements:Parameters<CatalogDB["batch"]>[0]=[];
    statements.push(db
      .prepare("UPDATE payout_items SET status='paid',external_payout_id=? WHERE id=?")
      .bind(settlement.externalPayoutId, item.id)
      );
    statements.push(db
      .prepare(
        "UPDATE finance_royalty_allocations SET status='paid' WHERE id IN (SELECT royalty_allocation_id FROM payout_allocation_links WHERE payout_item_id=?)",
      )
      .bind(item.id)
      );
    statements.push(db
      .prepare(
        "UPDATE finance_royalty_events SET status='paid' WHERE id IN (SELECT royalty_event_id FROM payout_event_links WHERE payout_item_id=?)",
      )
      .bind(item.id)
      );
    await postLedger(
      db,
      null,
      null,
      "royalty_payout",
      `royalty_payable:${item.party_id}`,
      Number(item.net_minor),
      item.currency,
      settlement.externalPayoutId,
      { payoutItemId: item.id },
      statements,
    );
    await postLedger(
      db,
      null,
      null,
      "royalty_payout",
      "cash",
      -Number(item.net_minor),
      item.currency,
      settlement.externalPayoutId,
      { payoutItemId: item.id },
      statements,
    );
    await db.batch(statements);
    try {
      const accounts = (
        await db
          .prepare("SELECT id FROM publishing_accounts WHERE finance_party_id=?")
          .bind(item.party_id)
          .all<any>()
      ).results;
      for (const a of accounts) {
        const members = (
          await db
            .prepare(
              "SELECT user_id FROM publishing_account_members WHERE account_id=? AND status='active' AND role IN ('owner','admin','analyst')",
            )
            .bind(a.id)
            .all<any>()
        ).results;
        for (const m of members)
          await emitNotification(db, {
            userId: String(m.user_id),
            eventType: "payout_sent",
            dedupeKey: `payout:${item.id}:${m.user_id}`,
            title: "Payout sent",
            body: `Cove sent your payout of ${formatMinorCurrency(Number(item.net_minor || 0), String(item.currency))}.`,
            subjectType: "payout_item",
            subjectId: String(item.id),
            actionUrl: "/publishing",
            payload: {
              batchId: x.batchId,
              payoutItemId: item.id,
              externalPayoutId: settlement.externalPayoutId,
              currency: item.currency,
              netMinor: Number(item.net_minor || 0),
            },
          });
      }
    } catch (e) {
      console.error("Payout notification enqueue failed", e);
    }
  }
  const remaining = Number(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM payout_items WHERE batch_id=? AND status<>'paid'")
        .bind(x.batchId)
        .first<any>()
    )?.n || 0,
  );
  await db
    .prepare(
      "UPDATE payout_batches SET status=?,paid_at=CASE WHEN ?=0 THEN ? ELSE paid_at END WHERE id=?",
    )
    .bind(remaining === 0 ? "paid" : "processing", remaining, at, x.batchId)
    .run();
  return { batchId: x.batchId, status: remaining === 0 ? "paid" : "processing", remaining };
}


return {accrueRoyaltiesForOrder,reverseRoyaltiesForRefund,createRoyaltyContract,createFinanceParty,createPayoutBatch,approvePayoutBatch,reverseRoyaltiesForChargeback,settlePayoutBatch};
};
const privateFinance=createPrivateFinance();
/* eslint-enable @typescript-eslint/no-explicit-any */


/* eslint-disable @typescript-eslint/no-explicit-any -- Private device and checkpointed erasure implementation; no public D1 fallback. */
const privateAccount=(()=>{
 type AccountDB=CoveEnv["DB"];
 const id=(p:string)=>`${p}_${crypto.randomUUID()}`;
async function registerDevice(
  db: AccountDB,
  userId: string,
  request: Request,
  raw: unknown,
) {
  const x = z
      .object({
        deviceKey: z.string().min(16).max(200),
        name: z.string().trim().min(1).max(120),
        platform: z.string().trim().min(1).max(80),
      })
      .parse(raw),
    at = now();
  const row = await db
    .prepare(
      `INSERT INTO devices(id,user_id,device_key,name,platform,last_seen_at,revoked_at,created_at) VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(user_id,device_key) DO UPDATE SET name=excluded.name,platform=excluded.platform,last_seen_at=excluded.last_seen_at WHERE devices.revoked_at IS NULL RETURNING id,name,platform,last_seen_at,created_at`,
    )
    .bind(id("device"), userId, x.deviceKey, x.name, x.platform, at, at)
    .first<any>();
  // A removed device key must never restore itself merely by registering
  // again. Rotate the key and explicitly enroll a new device instead.
  if (!row) throw new ApiError(409, "This device was revoked. Register with a new device key.");
  await recordAccountSecurityEvent(db, userId, "device_registered", request, {
    deviceId: row?.id,
    platform: x.platform,
  });
  return row;
}

async function revokeDevice(db:AccountDB,userId:string,deviceId:string,request:Request){
 const device=await db.prepare("SELECT id FROM devices WHERE id=? AND user_id=?").bind(deviceId,userId).first<any>();
 if(!device)throw new ApiError(404,"Device not found.");
 const at=now();
 await db.batch([
  db.prepare("UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?").bind(at,deviceId,userId),
  db.prepare("UPDATE audio_offline_licenses SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason='device_revoked' WHERE user_id=? AND device_id=? AND status='active'").bind(at,userId,deviceId),
  db.prepare("UPDATE commercial_delivery_grants SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason='device_revoked' WHERE user_id=? AND device_id=? AND status='active'").bind(at,userId,deviceId),
  db.prepare("UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason='device_revoked' WHERE user_id=? AND device_id=?").bind(at,userId,deviceId)
 ]);
 try{await recordAccountSecurityEvent(db,userId,"device_revoked",request,{deviceId});}
 catch{console.error("Private device revocation audit enqueue failed");}
 return {revoked:true};
}

type ErasureJob = {
  id: string;
  user_id: string;
  attempts: number;
  object_keys_json: string;
  storage_erased_at: string | null;
  database_erased_at: string | null;
  identity_erased_at: string | null;
};
async function maintainErasureLease(db: AccountDB, requestId: string, token: string) {
  const renewed = await db
    .prepare(
      "UPDATE account_deletion_requests SET lease_expires_at=? WHERE id=? AND lease_token=? AND status='executing' AND lease_expires_at>? RETURNING id",
    )
    .bind(new Date(Date.now() + 600000).toISOString(), requestId, token, now())
    .first<{ id: string }>();
  if (!renewed) throw new ApiError(409, "erasure_lease_lost");
}
async function processAccountDeletionQueue(env: CoveEnv, ownerSql:AuthoritySql, limit = 25) {
  const db = env.DB,
    current = now();
  const rows = (
    await db
      .prepare(
        "SELECT id FROM account_deletion_requests WHERE status IN ('cooling_off','queued','executing','blocked_legal_hold') AND execute_after<=? AND (next_retry_at IS NULL OR next_retry_at<=?) AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY execute_after LIMIT ?",
      )
      .bind(current, current, current, Math.max(1, Math.min(25, limit)))
      .all<{ id: string }>()
  ).results;
  let completed = 0,
    blocked = 0,
    retrying = 0;
  for (const candidate of rows) {
    const lease = crypto.randomUUID(),
      leaseUntil = new Date(Date.now() + 600000).toISOString();
    const r = await db
      .prepare(
        "UPDATE account_deletion_requests SET status='executing',lease_expires_at=?,lease_token=?,attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('cooling_off','queued','executing','blocked_legal_hold') AND execute_after<=? AND (next_retry_at IS NULL OR next_retry_at<=?) AND (lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING *",
      )
      .bind(leaseUntil, lease, now(), candidate.id, current, current, current)
      .first<ErasureJob>();
    if (!r) continue;
    try {
      const chargeback = await db
        .prepare(
          "SELECT 1 ok FROM commerce_orders WHERE user_id=? AND status IN ('disputed','chargeback_lost') LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const activeSubscription = await db
        .prepare(
          "SELECT 1 ok FROM subscriptions WHERE user_id=? AND status IN ('active','trialing','past_due') LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const activeStaff = await db
        .prepare("SELECT 1 ok FROM staff_principals WHERE user_id=? AND status='active' LIMIT 1")
        .bind(r.user_id)
        .first<any>();
      const publisherAuthority = await db
        .prepare(
          "SELECT 1 ok FROM publishing_account_members WHERE user_id=? AND status='active' AND role IN ('owner','admin') LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const socialGroupOwner = await db
        .prepare(
          "SELECT 1 ok FROM reading_groups g WHERE g.owner_user_id=? AND g.deleted_at IS NULL AND g.status='active' AND (SELECT COUNT(*) FROM reading_group_members m WHERE m.group_id=g.id AND m.status='active')>1 LIMIT 1",
        )
        .bind(r.user_id)
        .first<any>();
      const legalReason = chargeback
        ? "Open payment dispute/chargeback record"
        : activeSubscription
          ? "Active subscription must be canceled before erasure"
          : activeStaff
            ? "Active staff identity must be deprovisioned before erasure"
            : publisherAuthority
              ? "Publisher ownership/admin authority must be transferred or removed before erasure"
              : socialGroupOwner
                ? "Reading-group ownership must be transferred before erasure"
                : "";
      if (legalReason) {
        await db
          .prepare(
            "UPDATE account_deletion_requests SET status='blocked_legal_hold',legal_hold_reason=?,updated_at=?,lease_expires_at=NULL,lease_token=NULL,next_retry_at=? WHERE id=?",
          )
          .bind(legalReason, now(), new Date(Date.now() + 86400000).toISOString(), r.id)
          .run();
        blocked++;
        continue;
      }

      const authRow = await db
        .prepare("SELECT provider_id FROM auth_accounts WHERE app_id=?")
        .bind(r.user_id)
        .first<{ provider_id: string }>();
      if (
        env.FORE_AUTH_MODE === "supabase" &&
        (!authRow?.provider_id ||
          !env.SUPABASE_URL ||
          (!env.FORE_INGESTION_SIGNING_KEY && !env.SUPABASE_SECRET_KEY))
      )
        throw new ApiError(503, "identity_configuration_missing");
      denyAccountAccess(ownerSql,r.user_id,r.id);
      const at = now();
      await db
        .prepare("UPDATE auth_accounts SET disabled_at=COALESCE(disabled_at,?) WHERE app_id=?")
        .bind(at, r.user_id)
        .run();
      if (!r.storage_erased_at) {
        await maintainErasureLease(db, r.id, lease);
        const recorded = JSON.parse(r.object_keys_json) as string[];
        const imports = (
          await db
            .prepare("SELECT object_key FROM personal_imports WHERE user_id=?")
            .bind(r.user_id)
            .all<{ object_key: string }>()
        ).results
          .map((x) => x.object_key)
          .filter(Boolean);
        const orphaned: string[] = [];
        if (env.BUCKET?.list) {
          let cursor: string | undefined;
          do {
            await maintainErasureLease(db, r.id, lease);
            const page = await env.BUCKET.list({ prefix: `uploads/${r.user_id}/`, cursor });
            orphaned.push(...page.objects.map((object) => object.key));
            cursor = page.truncated ? page.cursor : undefined;
            if (page.truncated && !cursor) throw new ApiError(503, "storage_listing_incomplete");
          } while (cursor);
        }
        const keys = [...new Set([...recorded, ...imports, ...orphaned])];
        if (keys.length && !env.BUCKET) throw new ApiError(503, "storage_configuration_missing");
        await db
          .prepare(
            "UPDATE account_deletion_requests SET object_keys_json=?,cleanup_phase='storage',updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(JSON.stringify(keys), now(), r.id, lease)
          .run();
        for (const [index, key] of keys.entries()) {
          if (index % 25 === 0) await maintainErasureLease(db, r.id, lease);
          await env.BUCKET!.delete(key);
        }
        await db
          .prepare(
            "UPDATE account_deletion_requests SET storage_erased_at=?,updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(now(), now(), r.id, lease)
          .run();
      }
      if (!r.database_erased_at) {
        await maintainErasureLease(db, r.id, lease);
        const privateProducts = (
          await db
            .prepare(
              "SELECT p.id,p.edition_id,e.work_id,p.source_external_id FROM products p JOIN editions e ON e.id=p.edition_id AND e.release_status='private' WHERE p.source_name='upload' AND (EXISTS(SELECT 1 FROM personal_imports i WHERE i.product_id=p.id AND i.user_id=?) OR EXISTS(SELECT 1 FROM digital_assets a JOIN asset_versions v ON v.asset_id=a.id WHERE a.edition_id=e.id AND substr(v.object_key,1,length(?))=?)) AND NOT EXISTS(SELECT 1 FROM personal_imports other WHERE other.product_id=p.id AND other.user_id<>?)",
            )
            .bind(r.user_id, `uploads/${r.user_id}/`, `uploads/${r.user_id}/`, r.user_id)
            .all<{ id: string; edition_id: string; work_id: string; source_external_id: string }>()
        ).results;
        const ownedLists = (
          await db.prepare("SELECT id FROM social_lists WHERE user_id=?").bind(r.user_id).all<any>()
        ).results.map((x: any) => String(x.id));
        const ownedGroups = (
          await db
            .prepare("SELECT id FROM reading_groups WHERE owner_user_id=?")
            .bind(r.user_id)
            .all<any>()
        ).results.map((x: any) => String(x.id));
        for (const id of ownedLists)
          await db
            .prepare(
              "UPDATE social_posts SET deleted_at=COALESCE(deleted_at,?),body='[list removed]',updated_at=? WHERE context_type='list' AND context_id=?",
            )
            .bind(at, at, id)
            .run();
        for (const id of ownedGroups)
          await db
            .prepare(
              "UPDATE social_posts SET deleted_at=COALESCE(deleted_at,?),body='[group removed]',updated_at=? WHERE context_type='group' AND context_id=?",
            )
            .bind(at, at, id)
            .run();
        await db.batch([
          db.prepare("DELETE FROM notification_inbox WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_delivery_jobs WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM storefront_user_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_push_endpoints WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM notification_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM text_bookmarks WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_records WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_mutations WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_conflicts WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reader_settings WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM sync_clients WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM reading_journey_recipients WHERE recipient_user_id=?")
            .bind(r.user_id),
          db.prepare("DELETE FROM reading_journeys WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_progress_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_legal_consents WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM pending_account_legal_consents WHERE provider_id=?")
            .bind(authRow?.provider_id || ""),
          db
            .prepare("DELETE FROM social_annotation_shares WHERE recipient_user_id=?")
            .bind(r.user_id),
          db
            .prepare(
              "UPDATE social_posts SET deleted_at=COALESCE(deleted_at,?),body='[withdrawn]',passage_text='',recipient_user_id=NULL,moderation_status='removed',updated_at=? WHERE recipient_user_id=? OR user_id=?",
            )
            .bind(at, at, r.user_id, r.user_id),
          db.prepare("DELETE FROM customer_support_tickets WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_post_reactions WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM social_follows WHERE follower_user_id=? OR followed_user_id=?")
            .bind(r.user_id, r.user_id),
          db
            .prepare(
              "DELETE FROM social_follow_requests WHERE requester_user_id=? OR target_user_id=?",
            )
            .bind(r.user_id, r.user_id),
          db
            .prepare("DELETE FROM social_blocks WHERE blocker_user_id=? OR blocked_user_id=?")
            .bind(r.user_id, r.user_id),
          db
            .prepare("DELETE FROM social_mutes WHERE muter_user_id=? OR muted_user_id=?")
            .bind(r.user_id, r.user_id),
          db.prepare("DELETE FROM profile_top_books WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_annotation_shares WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_reader_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_list_likes WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_list_saves WHERE user_id=?").bind(r.user_id),
          db
            .prepare(
              "UPDATE social_posts SET user_id='deleted:'||substr(id,1,24),body='[deleted account]',passage_text='',updated_at=? WHERE user_id=?",
            )
            .bind(at, r.user_id),
          db
            .prepare("UPDATE social_audit_events SET actor_user_id=NULL WHERE actor_user_id=?")
            .bind(r.user_id),
          db
            .prepare(
              "UPDATE author_social_posts SET created_by_user_id='deleted:'||substr(id,1,24) WHERE created_by_user_id=?",
            )
            .bind(r.user_id),
          db.prepare("DELETE FROM social_lists WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_groups WHERE owner_user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_group_members WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM social_profiles WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM review_hearts WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reviews WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM annotations WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM definitions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_sessions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_states WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM reading_goals WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM book_metrics WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM completion_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM playback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM biosync_positions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM commercial_audio_playback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM commercial_biosync_positions WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM author_follow_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM author_follows WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM wishlist_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM wishlist_items WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM wishlist_profiles WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM preview_states WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM shopping_carts WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM shelves WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM matching_feedback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM matching_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_feedback WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_requests WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_user_features WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM recommendation_taste_controls WHERE user_id=?").bind(r.user_id),
          db
            .prepare("DELETE FROM recommendation_learning_boundaries WHERE user_id=?")
            .bind(r.user_id),
          db.prepare("DELETE FROM recommendation_privacy WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM search_query_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM merch_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM personal_export_events WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM personal_imports WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_addresses WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_preferences WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_billing_methods WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM account_gift_card_wallet WHERE user_id=?").bind(r.user_id),
          db.prepare("DELETE FROM profiles WHERE user_id=?").bind(r.user_id),
          db
            .prepare(
              "UPDATE audio_offline_licenses SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason=CASE WHEN revocation_reason='' THEN 'account_deleted' ELSE revocation_reason END WHERE user_id=? AND status='active'",
            )
            .bind(at, r.user_id),
          db
            .prepare("UPDATE commerce_customers SET email='',updated_at=? WHERE user_id=?")
            .bind(at, r.user_id),
          db
            .prepare(
              "UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,?),revoked_reason='account_deleted' WHERE user_id=?",
            )
            .bind(at, r.user_id),
          db
            .prepare(
              "UPDATE devices SET device_key='deleted:'||id,name='',platform='',revoked_at=COALESCE(revoked_at,?) WHERE user_id=?",
            )
            .bind(at, r.user_id),
          ...privateProducts.flatMap((product) => [
            db
              .prepare(
                "DELETE FROM external_identifiers WHERE entity_type='product' AND entity_id=?",
              )
              .bind(product.id),
            db.prepare("DELETE FROM products WHERE id=? AND source_name='upload'").bind(product.id),
            db
              .prepare("DELETE FROM editions WHERE id=? AND release_status='private'")
              .bind(product.edition_id),
            db
              .prepare(
                "DELETE FROM works WHERE id=? AND NOT EXISTS(SELECT 1 FROM editions WHERE work_id=?)",
              )
              .bind(product.work_id, product.work_id),
            db
              .prepare(
                "DELETE FROM contributors WHERE id=? AND NOT EXISTS(SELECT 1 FROM edition_contributors WHERE contributor_id=?)",
              )
              .bind(
                `con_upload_${product.source_external_id}`,
                `con_upload_${product.source_external_id}`,
              ),
          ]),
          db
            .prepare(
              "UPDATE auth_accounts SET email=?,username=NULL,disabled_at=COALESCE(disabled_at,?) WHERE app_id=?",
            )
            .bind(`deleted+${r.user_id.replace(/[^a-zA-Z0-9]/g, "")}@invalid.fore`, at, r.user_id),
        ]);

        await db
          .prepare(
            "UPDATE account_deletion_requests SET database_erased_at=?,cleanup_phase='identity',updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(now(), now(), r.id, lease)
          .run();
      }
      if (!r.identity_erased_at) {
        await maintainErasureLease(db, r.id, lease);
        if (env.FORE_AUTH_MODE === "supabase")
          await eraseProviderIdentity(env, authRow!.provider_id, r.user_id, r.id);
        await db
          .prepare(
            "UPDATE account_deletion_requests SET identity_erased_at=?,updated_at=? WHERE id=? AND lease_token=?",
          )
          .bind(now(), now(), r.id, lease)
          .run();
      }
      const done = await db
        .prepare(
          "UPDATE account_deletion_requests SET status='completed',cleanup_phase='complete',completed_at=?,updated_at=?,lease_expires_at=NULL,lease_token=NULL,next_retry_at=NULL,last_error_code='',legal_hold_reason='',object_keys_json='[]' WHERE id=? AND lease_token=? AND storage_erased_at IS NOT NULL AND database_erased_at IS NOT NULL AND identity_erased_at IS NOT NULL RETURNING id",
        )
        .bind(now(), now(), r.id, lease)
        .first<{ id: string }>();
      if (done) completed++;
    } catch (error) {
      const code =
        error instanceof ApiError && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "cleanup_failed";
      const retry = new Date(
        Date.now() + Math.min(86400000, 60000 * Math.pow(2, Math.min(r.attempts, 10))),
      ).toISOString();
      await db
        .prepare(
          "UPDATE account_deletion_requests SET status='queued',lease_expires_at=NULL,lease_token=NULL,next_retry_at=?,last_error_code=?,updated_at=? WHERE id=? AND lease_token=?",
        )
        .bind(retry, code, now(), r.id, lease)
        .run();
      retrying++;
      console.error(
        JSON.stringify({
          event: "account_erasure_retry",
          requestId: r.id,
          code,
          attempt: r.attempts,
        }),
      );
    }
  }
  return { processed: rows.length, completed, blocked, retrying };
}

return {registerDevice,revokeDevice,processAccountDeletionQueue};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Bounded, operator-triggered reconciliation of completed regional EPUBs.
 * Never grants rights, never re-ingests upstream assets, never runs on a customer
 * request. Verify the exact canonical object in private R2 before adding a
 * missing catalog pointer. Callers must supply the returned cursor to advance.
 */
async function repairRegionalEpubAssetsPrivate(
  env: Pick<CoveEnv, "DB" | "BUCKET">,
  options: { after?: string; limit?: number } = {},
) {
  if (!env.BUCKET?.head || !env.BUCKET?.get) return { skipped: "no_private_r2" };
  const suppliedAfter = options.after ?? "";
  if (!/^[a-z0-9_]{0,90}$/.test(suppliedAfter))
    throw new Error("Invalid regional asset repair cursor");
  // Only AU/CA/EU sources can be selected here. Start at the first regional
  // ID prefix, otherwise an empty cursor scans unrelated US Gutenberg rows.
  const after = suppliedAfter > "pga" ? suppliedAfter : "pga";
  const limit = Math.max(1, Math.min(16, Math.floor(options.limit ?? 8) || 8));
  // Source-level approval is insufficient: a separate operator could revoke
  // every live territorial grant without modifying the Gutenberg source row.
  // The candidate scan and EACH mutation require a currently valid grant.
  const liveGrant =
    " EXISTS(SELECT 1 FROM rights_grants g" +
    " WHERE g.edition_id=p.edition_id AND g.format='ebook'" +
    " AND g.sales_channel='retail' AND g.status='active' AND g.decision='allow'" +
    " AND g.source='gutenberg-'||c.source_id||'-public-domain'" +
    " AND g.territory_code IN (SELECT value FROM json_each(" +
    " CASE WHEN json_valid(c.rights_territories_json)" +
    " THEN c.rights_territories_json ELSE '[]' END))" +
    " AND (g.starts_at IS NULL OR datetime(g.starts_at)<=datetime('now'))" +
    " AND (g.ends_at IS NULL OR datetime(g.ends_at)>datetime('now'))" +
    // Deny precedence is territory-specific: a revoked CA grant cannot
    // invalidate an independent, still-permitted AU grant for the same EPUB.
    " AND NOT EXISTS(SELECT 1 FROM rights_grants deny" +
    " WHERE deny.edition_id=p.edition_id AND deny.format='ebook'" +
    " AND deny.sales_channel='retail' AND deny.status='active'" +
    " AND deny.decision='deny' AND deny.territory_code=g.territory_code" +
    " AND (deny.starts_at IS NULL OR datetime(deny.starts_at)<=datetime('now'))" +
    " AND (deny.ends_at IS NULL OR datetime(deny.ends_at)>datetime('now'))))";

  const rows = (
    await env.DB.prepare(
      "SELECT c.id,c.content_hash,p.edition_id," +
        " COALESCE(json_extract(c.formats_json,'$.\"application/epub+zip\"')," +
        " json_extract(c.formats_json,'$.\"application/epub+zip;\"')," +
        " json_extract(c.formats_json,'$.\"text/html\"'),'') source_url" +
        " FROM gutenberg_source_cache c INDEXED BY sqlite_autoindex_gutenberg_source_cache_1" +
        " CROSS JOIN products p ON p.source_external_id=c.id" +
        " AND p.source_name='gutenberg' AND p.format='ebook'" +
        " LEFT JOIN digital_assets d ON d.edition_id=p.edition_id AND d.kind='epub'" +
        " LEFT JOIN asset_versions v ON v.id=d.current_version_id" +
        " LEFT JOIN regional_epub_repair_receipts rr" +
        " ON rr.source_id=c.id AND rr.content_hash=c.content_hash" +
        " WHERE c.source_id IN ('pg_au','pg_ca','pg_eu')" +
        " AND c.epub_status='completed' AND c.ingest_status='active'" +
        " AND c.rights_status='public-domain' AND c.commercial_use_status='approved'" +
        " AND" +
        liveGrant +
        " AND COALESCE(c.content_hash,'')<>'' AND c.id>?" +
        " AND (d.id IS NULL OR v.id IS NULL OR COALESCE(v.object_key,'')=''" +
        " OR rr.status='pending')" +
        " ORDER BY c.id LIMIT ?",
    )
      .bind(after, limit)
      .all<{
        id: string;
        content_hash: string;
        edition_id: string;
        source_url: string;
      }>()
  ).results;
  let repaired = 0;
  let missingOrMismatched = 0;
  let conflicts = 0;
  let nextAfter = after;
  // The rights state is checked again by every write. Reader/checkout APIs
  // remain independently authoritative for every actual delivery.
  const eligible =
    "EXISTS(SELECT 1 FROM gutenberg_source_cache c" +
    " JOIN products p ON p.source_external_id=c.id" +
    " WHERE c.id=? AND p.edition_id=? AND p.source_name='gutenberg'" +
    " AND c.source_id IN ('pg_au','pg_ca','pg_eu')" +
    " AND c.epub_status='completed' AND c.ingest_status='active'" +
    " AND c.rights_status='public-domain' AND c.commercial_use_status='approved'" +
    " AND" +
    liveGrant +
    " AND c.content_hash=?)";
  for (const row of rows) {
    nextAfter = row.id;
    const key = "epubs/" + row.id + ".epub";
    const stored = await env.BUCKET.head(key);
    if (
      !stored ||
      stored.size <= 0 ||
      stored.customMetadata?.sha256 !== row.content_hash ||
      stored.httpMetadata?.contentType !== "application/epub+zip"
    ) {
      missingOrMismatched++;
      continue;
    }
    // R2 HEAD verifies catalog metadata, not actual bytes. In this disabled-
    // by-default operator-only lane, fully hash the original before *any*
    // primary catalog write; never download or re-convert an upstream EPUB.
    // The explicit bound prevents a corrupt object from exhausting Worker RAM.
    if (stored.size > 25 * 1024 * 1024) {
      missingOrMismatched++;
      continue;
    }
    const body = await env.BUCKET.get(key);
    if (!body || body.size !== stored.size) {
      missingOrMismatched++;
      continue;
    }
    const bytes = await body.arrayBuffer();
    if (bytes.byteLength !== stored.size) {
      missingOrMismatched++;
      continue;
    }
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sha256 !== row.content_hash) {
      missingOrMismatched++;
      continue;
    }
    const now = new Date().toISOString();
    // The verified R2 object is recorded before catalog mutations. If a tick
    // crashes at any later point, the pending receipt re-enters the candidate
    // frontier even when a prior attempt linked the final asset pointer.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO regional_epub_repair_receipts" +
        "(source_id,content_hash,edition_id,status,verified_at)" +
        " SELECT ?,?,?,'pending',? WHERE " +
        eligible,
    )
      .bind(row.id, row.content_hash, row.edition_id, now, row.id, row.edition_id, row.content_hash)
      .run();
    // Statements must remain rights-guarded individually. A D1 batch is a
    // single atomic transaction: no intermediate asset pointer is published.
    const insertAsset = env.DB.prepare(
      "INSERT OR IGNORE INTO digital_assets(id,edition_id,kind,drm_status,downloadable,created_at,updated_at)" +
        " SELECT ?,?,'epub','none',1,?,? WHERE " +
        eligible,
    ).bind(
      "asset_epub_gutenberg_" + row.id,
      row.edition_id,
      now,
      now,
      row.id,
      row.edition_id,
      row.content_hash,
    );
    const insertVersion = env.DB.prepare(
      "INSERT OR IGNORE INTO asset_versions(id,asset_id,version_number,source_url,object_key,mime_type,sha256,created_at)" +
        " SELECT ?,d.id,1,?,?,'application/epub+zip',?,?" +
        " FROM digital_assets d WHERE d.edition_id=? AND d.kind='epub' AND " +
        eligible,
    ).bind(
      "assetver_epub_gutenberg_" + row.id,
      row.source_url,
      key,
      row.content_hash,
      now,
      row.edition_id,
      row.id,
      row.edition_id,
      row.content_hash,
    );
    const updateVersion = env.DB.prepare(
      "UPDATE asset_versions SET object_key=?,sha256=?" +
        " WHERE asset_id=(SELECT id FROM digital_assets WHERE edition_id=? AND kind='epub')" +
        " AND version_number=1 AND COALESCE(object_key,'')='' AND " +
        eligible,
    ).bind(key, row.content_hash, row.edition_id, row.id, row.edition_id, row.content_hash);
    const promoteAsset = env.DB.prepare(
      "UPDATE digital_assets AS d SET current_version_id=(" +
        " SELECT v.id FROM asset_versions v WHERE v.asset_id=d.id" +
        " AND v.version_number=1 AND v.object_key=? AND v.sha256=?)" +
        " WHERE d.edition_id=? AND d.kind='epub'" +
        " AND (d.current_version_id IS NULL OR NOT EXISTS(" +
        " SELECT 1 FROM asset_versions prev WHERE prev.id=d.current_version_id" +
        " AND COALESCE(prev.object_key,'')<>'')) AND " +
        eligible,
    ).bind(key, row.content_hash, row.edition_id, row.id, row.edition_id, row.content_hash);
    try {
      await env.DB.batch([insertAsset, insertVersion, updateVersion, promoteAsset]);
    } catch (error) {
      console.warn("regional_epub_repair_batch_retry", row.id, String(error).slice(0, 140));
      conflicts++;
      continue;
    }
    // Only mark the receipt complete when the *actual* current version and
    // source SHA match AND the canonical live-rights predicate still holds.
    // If this final ACK fails or is interrupted, a subsequent tick replays
    // the same idempotent batch and then retries the receipt ACK.
    const completed = await env.DB.prepare(
      "UPDATE regional_epub_repair_receipts SET status='completed',completed_at=?" +
        " WHERE source_id=? AND content_hash=? AND status='pending'" +
        " AND EXISTS(SELECT 1 FROM digital_assets d" +
        " JOIN asset_versions v ON v.id=d.current_version_id" +
        " WHERE d.edition_id=? AND d.kind='epub' AND v.object_key=? AND v.sha256=?)" +
        " AND " +
        eligible +
        " RETURNING source_id",
    )
      .bind(
        now,
        row.id,
        row.content_hash,
        row.edition_id,
        key,
        row.content_hash,
        row.id,
        row.edition_id,
        row.content_hash,
      )
      .first();
    if (completed) repaired++;
    else conflicts++;
  }
  return {
    scanned: rows.length,
    repaired,
    missingOrMismatched,
    conflicts,
    nextAfter,
    maybeMore: rows.length === limit,
  };
}


/* QA-only moderation algorithm: transplant of the exact former shared action family.
 * The private Worker exclusively holds its D1 binding; public DB wrappers cannot
 * call this helper. Restoration deliberately requires future independently
 * certified positive evidence and is rejected before entering this code. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Audited historical D1 moderation statements */
const privateModeration=(()=>{
  const now=()=>new Date().toISOString();
  const id=(prefix:string)=>`${prefix}_${crypto.randomUUID()}`;
const caseEvent = (
  db: ModerationDB,
  caseId: string,
  eventType: string,
  actorType: "staff" | "publisher" | "reporter" | "system",
  actorUserId: string | null,
  payload: unknown = {},
) =>
  db
    .prepare(
      "INSERT INTO moderation_case_events(id,case_id,event_type,actor_type,actor_user_id,event_json,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      id("modevt"),
      caseId,
      eventType,
      actorType,
      actorUserId,
      JSON.stringify(payload || {}),
      now(),
    );
async function lifecycleForCase(db: ModerationDB, c: any) {
  if (c.subject_type === "edition")
    return db
      .prepare(
        "SELECT l.*,e.catalog_product_id,e.catalog_edition_id,t.account_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE e.id=?",
      )
      .bind(c.subject_id)
      .first<any>();
  if (c.subject_type === "title")
    return db
      .prepare(
        "SELECT l.*,e.catalog_product_id,e.catalog_edition_id,t.account_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id WHERE t.id=? ORDER BY e.updated_at DESC LIMIT 1",
      )
      .bind(c.subject_id)
      .first<any>();
  if (c.subject_type === "publication")
    return db
      .prepare(
        "SELECT l.*,e.catalog_product_id,e.catalog_edition_id,t.account_id FROM publishing_release_lifecycles l JOIN publishing_edition_drafts e ON e.id=l.publishing_edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_publications p ON p.edition_id=e.catalog_edition_id WHERE p.id=?",
      )
      .bind(c.subject_id)
      .first<any>();
  return null;
}


async function executeModerationAction(db: ModerationDB, staff: StaffContext, raw: unknown, operationId: string) {
  const x = z
    .object({
      caseId: z.string().min(1),
      actionType: z.enum([
        "no_action",
        "hide_review",
        "show_review",
        "warn_publisher",
        "restrict_publisher",
        "suspend_publisher",
        "suppress_title",
        "restore_title",
        "takedown_title",
        "retire_title",
        "reject_submission",
        "approve_submission",
        "escalate",
        "copyright_takedown",
        "copyright_restore",
        "impersonation_remove",
      ]),
      reasonCode: z.string().max(120).default(""),
      rationale: z.string().max(8000).default(""),
    })
    .parse(raw);
  const c = await db
    .prepare("SELECT * FROM moderation_cases WHERE id=?")
    .bind(x.caseId)
    .first<any>();
  if (!c) throw new ApiError(404, "Moderation case not found.");
  if (["approve_submission", "reject_submission"].includes(x.actionType))
    throw new ApiError(
      409,
      "Publishing submission decisions must use the publishing review workflow so immutable review evidence and release materialization remain consistent.",
    );
  const perm =
    x.actionType === "hide_review" || x.actionType === "show_review"
      ? "moderation.review.manage"
      : x.actionType.includes("copyright")
        ? "moderation.copyright.manage"
        : x.actionType === "impersonation_remove"
          ? "moderation.impersonation.manage"
          : x.actionType === "suppress_title"
            ? "moderation.emergency_suppress"
            : x.actionType.includes("takedown")
              ? "moderation.takedown"
              : x.actionType.includes("publisher")
                ? "moderation.sanction.manage"
                : x.actionType === "restore_title" || x.actionType === "retire_title"
                  ? "moderation.title.manage"
                  : "moderation.case.manage";
  if (!staff.permissions.has(perm) && !staff.permissions.has("staff.manage"))
    throw new ApiError(403, `Staff permission required: ${perm}.`);
  const at = now(),
    actionId = `modaction_${operationId.slice("moderation:".length)}`,
    stmts: any[] = [];
  const previous=await db.prepare("SELECT id,action_type,staff_user_id,case_id FROM moderation_actions WHERE id=?")
    .bind(actionId).first<any>();
  if(previous){
    if(previous.case_id!==x.caseId||previous.staff_user_id!==staff.userId||previous.action_type!==x.actionType)
      throw new ApiError(409,"Moderation command replay conflicts with an existing action.");
    return {id:actionId,actionType:x.actionType};
  }
  if (x.actionType === "hide_review" || x.actionType === "show_review") {
    if (c.subject_type !== "review")
      throw new ApiError(409, "This action requires a review subject.");
    stmts.push(
      db
        .prepare("UPDATE reviews SET moderation=? WHERE id=?")
        .bind(x.actionType === "hide_review" ? "hidden" : "visible", c.subject_id),
    );
  }
  if (["warn_publisher", "restrict_publisher", "suspend_publisher"].includes(x.actionType)) {
    const accountId = String(c.publishing_account_id || c.subject_id);
    const acct = await db
      .prepare("SELECT id FROM publishing_accounts WHERE id=?")
      .bind(accountId)
      .first<any>();
    if (!acct) throw new ApiError(409, "This case is not linked to a publishing account.");
    const sanctionType =
        x.actionType === "warn_publisher"
          ? "warning"
          : x.actionType === "restrict_publisher"
            ? "publishing_restriction"
            : "temporary_suspension",
      strike =
        x.actionType === "warn_publisher" ? 1 : x.actionType === "restrict_publisher" ? 3 : 5;
    if (x.actionType !== "warn_publisher")
      stmts.push(
        db
          .prepare("UPDATE publishing_accounts SET status=?,updated_at=? WHERE id=?")
          .bind(x.actionType === "suspend_publisher" ? "suspended" : "restricted", at, accountId),
      );
    stmts.push(
      db
        .prepare(
          "INSERT INTO moderation_sanctions(id,publishing_account_id,case_id,action_id,sanction_type,strike_points,status,starts_at,created_at) VALUES(?,?,?,?,?,?,'active',?,?)",
        )
        .bind(id("sanction"), accountId, x.caseId, actionId, sanctionType, strike, at, at),
    );
  }
  if (
    [
      "suppress_title",
      "restore_title",
      "takedown_title",
      "retire_title",
      "copyright_takedown",
      "copyright_restore",
      "impersonation_remove",
    ].includes(x.actionType)
  ) {
    const l = await lifecycleForCase(db, c);
    if (!l) throw new ApiError(409, "This case is not linked to a Cove Publishing release.");
    const restoring = x.actionType === "restore_title" || x.actionType === "copyright_restore";
    let restoredFrom: string | null = null;
    if (restoring) {
      const prior = await db
        .prepare(
          "SELECT from_state FROM publishing_lifecycle_events WHERE lifecycle_id=? AND to_state IN ('suppressed','takedown') ORDER BY created_at DESC LIMIT 1",
        )
        .bind(l.id)
        .first<any>();
      restoredFrom = prior?.from_state ? String(prior.from_state) : null;
    }
    const target =
      restoring && restoredFrom && !["suppressed", "takedown", "retired"].includes(restoredFrom)
        ? restoredFrom
        : restoring
          ? l.current_publication_version_id
            ? "live"
            : "approved"
          : x.actionType === "retire_title"
            ? "retired"
            : x.actionType === "takedown_title" ||
                x.actionType === "copyright_takedown" ||
                x.actionType === "impersonation_remove"
              ? "takedown"
              : "suppressed";
    const tsColumn =
      target === "suppressed"
        ? "suppressed_at"
        : target === "takedown"
          ? "takedown_at"
          : target === "retired"
            ? "retired_at"
            : null;
    stmts.push(
      db
        .prepare(
          `UPDATE publishing_release_lifecycles SET state=?,state_reason=?,${tsColumn ? `${tsColumn}=?,` : ""}updated_at=? WHERE id=?`,
        )
        .bind(
          ...(tsColumn
            ? [target, x.reasonCode || x.actionType, at, at, l.id]
            : [target, x.reasonCode || x.actionType, at, l.id]),
        ),
    );
    const hasServingVersion = !!l.current_publication_version_id,
      storefrontActive =
        ["preorder", "live", "updated"].includes(target) ||
        (hasServingVersion && !["suppressed", "takedown", "retired"].includes(target));
    if (l.catalog_product_id)
      stmts.push(
        db
          .prepare("UPDATE products SET storefront_status=?,updated_at=? WHERE id=?")
          .bind(storefrontActive ? "active" : "inactive", at, l.catalog_product_id),
      );
    if (l.catalog_edition_id) {
      const releaseStatus =
        target === "preorder" ? "preorder" : storefrontActive ? "available" : target;
      stmts.push(
        db
          .prepare("UPDATE editions SET release_status=?,updated_at=? WHERE id=?")
          .bind(releaseStatus, at, l.catalog_edition_id),
      );
    }
    stmts.push(
      db
        .prepare(
          "INSERT INTO publishing_lifecycle_events(id,lifecycle_id,from_state,to_state,trigger_type,actor_user_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?, 'moderation',?,?,?,?)",
        )
        .bind(
          id("lifeevt"),
          l.id,
          l.state,
          target,
          staff.userId,
          x.reasonCode,
          JSON.stringify({ caseId: x.caseId, actionType: x.actionType, restoredFrom }),
          at,
        ),
    );
  }
  if (x.actionType === "copyright_takedown")
    stmts.push(
      db
        .prepare(
          "UPDATE copyright_complaints SET notice_status='actioned',updated_at=? WHERE case_id=?",
        )
        .bind(at, x.caseId),
    );
  if (x.actionType === "copyright_restore")
    stmts.push(
      db
        .prepare(
          "UPDATE copyright_complaints SET notice_status='restored',updated_at=? WHERE case_id=?",
        )
        .bind(at, x.caseId),
    );
  if (x.actionType === "escalate")
    stmts.push(
      db
        .prepare(
          "UPDATE moderation_cases SET priority='urgent',status='in_review',updated_at=? WHERE id=?",
        )
        .bind(at, x.caseId),
    );
  stmts.push(
    db
      .prepare(
        "INSERT INTO moderation_actions(id,case_id,staff_user_id,action_type,reason_code,rationale,reversible,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        actionId,
        x.caseId,
        staff.userId,
        x.actionType,
        x.reasonCode,
        x.rationale,
        ["no_action", "retire_title", "escalate"].includes(x.actionType) ? 0 : 1,
        at,
      ),
  );
  if (x.actionType !== "escalate")
    stmts.push(
      db
        .prepare(
          `UPDATE moderation_cases SET status=?,resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END,updated_at=? WHERE id=?`,
        )
        .bind(
          x.actionType === "no_action" ? "resolved" : "actioned",
          x.actionType === "no_action" ? "resolved" : "actioned",
          at,
          at,
          x.caseId,
        ),
    );
  stmts.push(
    caseEvent(db, x.caseId, "action_applied", "staff", staff.userId, {
      actionId,
      actionType: x.actionType,
      reasonCode: x.reasonCode,
      rationale: x.rationale,
    }),
  );
  await db.batch(stmts);
  if (x.actionType === "hide_review" || x.actionType === "show_review")
    try {
      const review = await db
        .prepare("SELECT user_id,book_id FROM reviews WHERE id=?")
        .bind(c.subject_id)
        .first<any>();
      if (review?.user_id)
        await emitNotification(db, {
          userId: String(review.user_id),
          eventType: "review_moderated",
          dedupeKey: `review-moderated:${actionId}:${review.user_id}`,
          title:
            x.actionType === "hide_review"
              ? "Your review was moderated"
              : "Your review was restored",
          body:
            x.actionType === "hide_review"
              ? x.rationale || "A Cove moderator hid your review under the review guidelines."
              : x.rationale || "A Cove moderator restored your review.",
          urgency: x.actionType === "hide_review" ? "high" : "normal",
          subjectType: "review",
          subjectId: String(c.subject_id),
          actionUrl: review.book_id
            ? `/book/${encodeURIComponent(String(review.book_id))}`
            : "/library",
          payload: {
            caseId: x.caseId,
            actionId,
            actionType: x.actionType,
            reasonCode: x.reasonCode,
          },
        });
    } catch (e) {
      console.error("Review moderation notification enqueue failed", e);
    }
  return { id: actionId, actionType: x.actionType };
}
return {executeModerationAction};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */


/* Independently leased QA-only rights configuration writers.
 * Negative territory changes only; fresh legal proof required for positive rights. */
/* eslint-disable @typescript-eslint/no-explicit-any -- Original reviewed rights SQL */
const privateRightsConfiguration=(()=>{
 const now=()=>new Date().toISOString();
 const STATIC_TERRITORY_ALIASES:Record<string,string>={UK:"GB",EL:"GR"};
async function upsertRightsParty(db: CatalogDB, raw: unknown, operationId: string) {
  const x = z
      .object({
        id: z.string().max(160).optional(),
        displayName: z.string().trim().min(1).max(200),
        partyType: z
          .enum(["publisher", "author", "agent", "distributor", "estate", "licensor", "other"])
          .default("publisher"),
        publisherId: z.string().max(160).nullable().optional(),
        contributorId: z.string().max(160).nullable().optional(),
        contactEmail: z.string().email().or(z.literal("")).default(""),
        referenceCode: z.string().max(160).default(""),
        status: z.enum(["active", "inactive"]).default("active"),
      })
      .parse(raw),
    id = x.id || `rparty_${operationId.slice("rights:".length, "rights:".length+36)}`,
    at = now();
  await db
    .prepare(
      `INSERT INTO rights_parties(id,display_name,party_type,publisher_id,contributor_id,contact_email,reference_code,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,party_type=excluded.party_type,publisher_id=excluded.publisher_id,contributor_id=excluded.contributor_id,contact_email=excluded.contact_email,reference_code=excluded.reference_code,status=excluded.status,updated_at=excluded.updated_at`,
    )
    .bind(
      id,
      x.displayName,
      x.partyType,
      x.publisherId || null,
      x.contributorId || null,
      x.contactEmail,
      x.referenceCode,
      x.status,
      at,
      at,
    )
    .run();
  return { id };
}


async function rebuildAllTerritorySets(db: CatalogDB) {
  const [setsResult, rulesResult, territoriesResult, histResult, succResult] = await Promise.all([
    db.prepare("SELECT * FROM territory_sets WHERE status='active'").all<any>(),
    db.prepare("SELECT * FROM territory_set_rules ORDER BY position,id").all<any>(),
    db.prepare("SELECT code FROM territories WHERE is_sellable=1 ORDER BY code").all<any>(),
    db.prepare("SELECT * FROM territory_historical_entities").all<any>(),
    db.prepare("SELECT * FROM territory_historical_successors").all<any>(),
  ]);
  const sets = new Map(setsResult.results.map((r) => [String(r.id), r] as const)),
    rules = rulesResult.results;
  const allTerritories = new Set(territoriesResult.results.map((r) => String(r.code)));
  const successors = new Map<string, string[]>();
  for (const r of succResult.results) {
    const a = successors.get(String(r.historical_entity_id)) || [];
    a.push(String(r.territory_code));
    successors.set(String(r.historical_entity_id), a);
  }
  const memo = new Map<string, Set<string>>(),
    visiting = new Set<string>();
  const histExpand = (code: string, asOf: string | null) => {
    let entities = histResult.results.filter((r: any) => String(r.historical_code) === code);
    if (asOf)
      entities = entities.filter(
        (r: any) =>
          (!r.valid_from || String(r.valid_from) <= asOf) &&
          (!r.valid_to || String(r.valid_to) >= asOf),
      );
    if (entities.length !== 1)
      throw new ApiError(
        400,
        entities.length
          ? `Historical code ${code} is ambiguous; set an as-of date.`
          : `No historical mapping for ${code}.`,
      );
    return new Set(successors.get(String(entities[0].id)) || []);
  };
  const compute = (id: string): Set<string> => {
    if (memo.has(id)) return new Set(memo.get(id)!);
    if (visiting.has(id)) throw new ApiError(400, "Territory sets contain a circular reference.");
    const set = sets.get(id);
    if (!set) throw new ApiError(400, `Unknown territory set ${id}.`);
    visiting.add(id);
    if (set.set_type === "worldwide") {
      const out = new Set(allTerritories);
      memo.set(id, out);
      visiting.delete(id);
      return new Set(out);
    }
    const own = rules.filter((r: any) => String(r.set_id) === id),
      inc = new Set<string>(),
      exc = new Set<string>();
    const expand = (r: any) =>
      r.target_type === "territory"
        ? new Set([STATIC_TERRITORY_ALIASES[String(r.territory_code)] || String(r.territory_code)])
        : r.target_type === "set"
          ? compute(String(r.target_set_id))
          : histExpand(String(r.historical_code), set.as_of_date ? String(set.as_of_date) : null);
    for (const r of own.filter((r: any) => r.effect === "include"))
      for (const c of expand(r)) inc.add(c);
    for (const r of own.filter((r: any) => r.effect === "exclude"))
      for (const c of expand(r)) exc.add(c);
    for (const c of exc) inc.delete(c);
    for (const c of [...inc]) if (!allTerritories.has(c)) inc.delete(c);
    memo.set(id, inc);
    visiting.delete(id);
    return new Set(inc);
  };
  for (const id of sets.keys()) compute(id);
  const statements: any[] = [db.prepare("DELETE FROM territory_set_members")],
    at = now();
  for (const [setId, members] of memo) {
    const codes = [...members].sort();
    for (let i = 0; i < codes.length; i += 80) {
      const chunk = codes.slice(i, i + 80);
      if (!chunk.length) continue;
      const values = chunk.map(() => "(?,?,?,?)").join(",");
      const st = db.prepare(
        `INSERT INTO territory_set_members(set_id,territory_code,resolution_source,resolved_at) VALUES ${values}`,
      );
      const binds: any[] = [];
      for (const code of chunk) binds.push(setId, code, `resolved:${setId}`, at);
      statements.push(st.bind(...binds));
    }
  }
  await db.batch(statements);
  return memo;
}


async function upsertTerritorySet(db: CatalogDB, raw: unknown, operationId: string) {
  const x = z
    .object({
      id: z.string().max(180).optional(),
      code: z
        .string()
        .trim()
        .min(2)
        .max(40)
        .regex(/^[A-Za-z0-9_]+$/)
        .transform((v) => v.toUpperCase()),
      name: z.string().trim().min(1).max(200),
      setType: z.enum(["custom", "region", "market"]).default("custom"),
      description: z.string().max(2000).default(""),
      status: z.enum(["active", "inactive", "archived"]).default("active"),
      asOfDate: z.string().nullable().optional(),
      rules: z.array(scopeRuleSchema).max(600).default([]),
    })
    .parse(raw);
  const id = x.id || `rset_${crypto.randomUUID()}`,
    at = now();
  if (x.id) {
    const existing = await db
      .prepare("SELECT is_system FROM territory_sets WHERE id=?")
      .bind(id)
      .first<any>();
    if (existing && Number(existing.is_system))
      throw new ApiError(
        400,
        "System territory sets are versioned fixtures and cannot be edited. Create a custom set instead.",
      );
  }
  const statements: any[] = [
    db
      .prepare(
        `INSERT INTO territory_sets(id,code,name,set_type,description,status,is_system,as_of_date,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,set_type=excluded.set_type,description=excluded.description,status=excluded.status,as_of_date=excluded.as_of_date,updated_at=excluded.updated_at`,
      )
      .bind(id, x.code, x.name, x.setType, x.description, x.status, x.asOfDate || null, at, at),
    db.prepare("DELETE FROM territory_set_rules WHERE set_id=?").bind(id),
  ];
  x.rules.forEach((r, i) =>
    statements.push(
      db
        .prepare(
          `INSERT INTO territory_set_rules(id,set_id,effect,target_type,territory_code,target_set_id,historical_code,position,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          `tsr_${crypto.randomUUID()}`,
          id,
          r.effect,
          r.targetType,
          r.territoryCode ? normalizeTerritoryCode(r.territoryCode) : null,
          r.territorySetId || null,
          r.historicalCode ? String(r.historicalCode).toUpperCase() : null,
          i,
          at,
        ),
    ),
  );
  await db.batch(statements);
  const memo = await rebuildAllTerritorySets(db),
    members = [...(memo.get(id) || new Set<string>())].sort();
  await db
    .prepare(
      "INSERT OR IGNORE INTO rights_configuration_audit(id,entity_type,entity_id,action,snapshot_json,recorded_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(
      `rca_${operationId.slice("rights:".length)}`,
      "territory-set",
      id,
      x.id ? "update" : "insert",
      JSON.stringify({ ...x, resolvedTerritories: members }),
      at,
    )
    .run();
  return { id, code: x.code, memberCount: members.length, members };
}


 return {upsertRightsParty,upsertTerritorySet};
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

export class CoveLegalAuthority extends DurableObject<LegalAuthorityEnv> {
  private rightsConfigExecution=false;
  private moderationExecution=false;
  private regionalRepairExecution=false;
  private accountExecution=false;
  private financeExecution=false;
  private publicationExecutions=new Set<string>();
  private contractExecutions=new Set<string>();
  private publicationRecoveryRunning=false;
  private partnerFeedRunning=false;
  private settlementExecutions=new Set<string>();
  private settlementRecoveryRunning=false;
  constructor(ctx: { storage: { sql: unknown } }, env: LegalAuthorityEnv) {
    super(ctx, env);
    (ctx.storage.sql as AuthoritySql).exec("CREATE TABLE IF NOT EXISTS cove_finance_command_receipts(operation_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt_json TEXT)");
    createAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createAuthorityProofSchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialStorefrontSchema(ctx.storage.sql as unknown as AuthoritySql);
    createPaidEntitlementSchema(ctx.storage.sql as unknown as AuthoritySql);
    createMarketAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createPublicationMaterializationSchema(ctx.storage.sql as unknown as AuthoritySql);
    createContractVersionOwnerSchema(ctx.storage.sql as unknown as AuthoritySql);
    (ctx.storage.sql as AuthoritySql).exec(
      "CREATE TABLE IF NOT EXISTS cove_audio_metadata_command_receipts(operation_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt_json TEXT NOT NULL)"
    );
  }

  async fetch(request: Request): Promise<Response> {
    const noStore={ "cache-control": "no-store" };
    const env=this.env;
    // Disabled production mode exposes one private, authenticated read-only
    // challenge. This path cannot invoke any rights, payment or D1 command.
    // The QA lease below remains the ONLY authorized mutating/read mode.
    if(new URL(request.url).pathname===DISABLED_OWNER_ATTEST_ROUTE){
      if(!isDisabledProductionOwner(env))
        return new Response(null,{status:503,headers:noStore});
      if(request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
        return new Response(null,{status:401,headers:noStore});
      if(request.method!=="POST"||
         request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
        return new Response(null,{status:405,headers:noStore});
      const input=await request.text();
      if(input.length>128)return new Response(null,{status:413,headers:noStore});
      let parsed:unknown;
      try{parsed=JSON.parse(input);}catch{return new Response(null,{status:400,headers:noStore});}
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||
         Object.keys(parsed).join(",")!=="challenge"||
         !validOwnerChallenge((parsed as {challenge?:unknown}).challenge))
        return new Response(null,{status:400,headers:noStore});
      return Response.json(disabledOwnerReceipt((parsed as {challenge:string}).challenge),
        {headers:noStore});
    }
    if (!qaOwnerLeaseLive(env))
      return new Response(null,{status:503,headers:noStore});
    // All calls must arrive by private service binding with an independent
    // operator secret. Nothing on this Worker should be publicly routed.
    if (request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
      return new Response(null,{status:401,headers:noStore});
    if(request.method!=="POST") return new Response(null,{status:405,headers:noStore});
    const route=new URL(request.url).pathname;
    if(!["/deny","/deny-next","/deny-next-batch","/verify","/publish-allow","/authorize-batch",
      "/commercial/deny-next","/commercial/deny-batch","/commercial/subject/deny-next","/commercial/publish-verified",
      "/commercial/authorize-batch",
      "/storefront/authorize-batch","/storefront/publish-commercial",
      "/market/deny-next",
      "/commercial/order/deny-next","/commercial/order/verify","/commercial/order/revoke",
      "/commercial/order/settle",
      "/commercial/order/recover-settlements",
      "/commercial/refund/reserve",
      "/commercial/checkout/create-quote",
      "/commercial/checkout/materialize-draft",
      "/commercial/checkout/prepare-draft",
      "/commercial/checkout/cancel-unpaid",
      "/commercial/reconciliation/record",
      "/commercial/admin/monetary",
      "/commercial/checkout/register-stripe-customer",
      "/commercial/checkout/attach-payment-intent",
      "/commercial/payment/update-state",
      "/commercial/webhook/claim",
      "/commercial/webhook/finish",
      "/commercial/refund/post-accounting",
      "/commercial/refund/record-provider",
      "/commercial/dispute/sync-verified",
      "/commercial/entitlement/deny-next","/commercial/entitlement/deny-batch",
      "/commercial/entitlement/publish-verified",
      "/commercial/entitlement/publish-order-verified",
      "/publishing/partner/process-feed",
      "/catalog/normalize-gutenberg",
      "/catalog/personal-import",
      "/publishing/audio/register-upload",
      "/publishing/audio/qc-jobs",
      "/publishing/worker/jobs",
      "/publishing/audio/metadata",
      "/publishing/onboarding/review",
      "/preorder/private-action",
      "/trust/private-action",
      "/finance/private-action",
      "/account/private-action",
      "/catalog/repair-regional-assets",
      "/publishing/editor-action",
      "/publishing/partner/private-action",
      "/rights/private-configuration",
      "/catalog/observe-us",
      "/catalog/regional-state",
      "/catalog/verified-us-epub-cache",
      "/risk/private-create-hold",
      "/promotion/private-action",
      "/catalog/private-ingest-state",
      "/delivery/register-entitlement-device",
      "/delivery/private-negative",
      "/catalog/withdraw-stale",
      "/catalog/negative-source",
      "/moderation/private-action",
      "/support/private-action",
      "/publishing/contract/save-version",
      "/publication/materialize-submission",
      "/publication/activate-version",
      "/publication/open-preorder",
      "/publication/recover-recorded",
      "/commercial/entitlement/authorize"].includes(route))
      return new Response(null,{status:404,headers:noStore});
    if (request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json")
      return new Response(null,{status:415,headers:noStore});
    let raw:unknown;
    try {
      const bytes=await request.text();
      if(bytes.length>(route==="/publishing/contract/save-version"?32768:route==="/commercial/checkout/create-quote"?4096:route==="/publishing/audio/register-upload"?8192:route==="/publishing/audio/qc-jobs"?262144:route==="/publishing/worker/jobs"?262144:route==="/publishing/audio/metadata"?8192:route==="/publishing/onboarding/review"?8192:route==="/rights/private-configuration"?12288:route==="/moderation/private-action"?12288:route==="/support/private-action"?8192:route==="/preorder/private-action"?8192:route==="/trust/private-action"?262144:route==="/finance/private-action"?65536:route==="/account/private-action"?2048:route==="/publishing/editor-action"?262144:route==="/publishing/partner/private-action"?16384:route==="/commercial/checkout/materialize-draft"?2048:["/authorize-batch","/deny-next-batch","/commercial/authorize-batch","/commercial/deny-batch","/commercial/entitlement/deny-batch","/storefront/authorize-batch"].includes(route)?24000:1024)) return new Response(null,{status:413,headers:noStore});
      raw=JSON.parse(bytes);
    }catch {return new Response(null,{status:400,headers:noStore});}
    bindPrivateFinanceExecutors(env.PRIMARY_DB,{...privateRoyalty,...privateFinance});
    const sql=this.ctx.storage.sql as unknown as AuthoritySql;
    try {
      if(route==="/commercial/order/recover-settlements"){
        const input=raw as {limit?:unknown}|null;
        if(!input||Object.keys(input).join(",")!=="limit"||!Number.isSafeInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>25)
          return new Response(null,{status:400,headers:noStore});
        if(this.settlementRecoveryRunning)return new Response(null,{status:409,headers:noStore});
        this.settlementRecoveryRunning=true;
        try{
          // Two independent crash windows: a journal without a committed D1
          // receipt, and a receipt whose owner publication was interrupted.
          // Keyset cursors advance past blocked orders so retries cannot
          // starve later settlements, including internal-only tender.
          const cursors=sql.exec<{scope:string;after_id:string;after_time:string}>("SELECT scope,after_id,after_time FROM cove_paid_settlement_recovery_cursors").toArray();
          const journalCursor=cursors.find(c=>c.scope==="journal")?.after_id||"";
          let recorded=sql.exec<{order_id:string}>("SELECT order_id FROM cove_paid_settlement_commands WHERE state='pending' AND order_id>? ORDER BY order_id LIMIT ?",journalCursor,Number(input.limit)).toArray();
          if(!recorded.length&&journalCursor)recorded=sql.exec<{order_id:string}>("SELECT order_id FROM cove_paid_settlement_commands WHERE state='pending' ORDER BY order_id LIMIT ?",Number(input.limit)).toArray();
          const receiptCursor=cursors.find(c=>c.scope==="receipt");
          const readReceipts=(afterTime:string,afterId:string)=>env.PRIMARY_DB.prepare("SELECT order_id,settled_at FROM commerce_settlement_receipts WHERE owner_published_at IS NULL AND (settled_at>? OR (settled_at=? AND order_id>?)) ORDER BY settled_at,order_id LIMIT ?")
            .bind(afterTime,afterTime,afterId,input.limit).all<{order_id:string;settled_at:string}>();
          let receipts=(await readReceipts(receiptCursor?.after_time||"",receiptCursor?.after_id||"")).results;
          if(!receipts.length&&receiptCursor)receipts=(await readReceipts("","")).results;
          const pending:Array<{order_id:string}>=[],seen=new Set<string>();
          const through:{journal:string|null;receipt:{order_id:string;settled_at:string}|null}={journal:null,receipt:null};
          const receiptFirst=cursors.find(c=>c.scope==="turn")?.after_id==="receipt";
          for(let i=0;i<Number(input.limit)&&pending.length<Number(input.limit);i++){
            const takeJournal=()=>{const j=recorded[i];if(j&&pending.length<Number(input.limit)){
              through.journal=j.order_id;if(!seen.has(j.order_id)){seen.add(j.order_id);pending.push(j);}
            }};
            const takeReceipt=()=>{const r=receipts[i];if(r&&pending.length<Number(input.limit)){
              through.receipt=r;if(!seen.has(r.order_id)){seen.add(r.order_id);pending.push(r);}
            }};
            if(receiptFirst){takeReceipt();takeJournal();}else{takeJournal();takeReceipt();}
          }
          sql.exec("INSERT INTO cove_paid_settlement_recovery_cursors(scope,after_id,after_time) VALUES('turn',?,'') ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id",receiptFirst?"journal":"receipt");
          if(through.journal)sql.exec("INSERT INTO cove_paid_settlement_recovery_cursors(scope,after_id,after_time) VALUES('journal',?,'') ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id",through.journal);
          if(through.receipt)sql.exec("INSERT INTO cove_paid_settlement_recovery_cursors(scope,after_id,after_time) VALUES('receipt',?,?) ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id,after_time=excluded.after_time",through.receipt.order_id,through.receipt.settled_at);
          let recovered=0,blocked=0;
          for(const row of pending){
            const response=await this.fetch(new Request("https://legal-authority.internal/commercial/order/settle",{
              method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,"content-type":"application/json"},
              body:JSON.stringify({orderId:row.order_id})
            }));
            if(response.status===200)recovered++;else blocked++;
          }
          return Response.json({schema:"cove.owner-settlement-recovery.v1",checked:pending.length,recovered,blocked},{headers:noStore});
        }finally{this.settlementRecoveryRunning=false;}
      }
      if(route==="/commercial/order/settle"){
        const receipt=await executeOwnerPaidSettlement({env,sql,executing:this.settlementExecutions,
          publish:async order=>{
            const lines=(await env.PRIMARY_DB.prepare("SELECT id FROM commerce_order_items WHERE order_id=? AND preorder_id IS NULL LIMIT 26").bind(order.id).all<{id:string}>()).results;
            if(!lines.length)return; // Financial preorder reservation grants no bytes.
            const response=await this.fetch(new Request("https://legal-authority.internal/commercial/entitlement/publish-order-verified",{
              method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,"content-type":"application/json"},
              body:JSON.stringify({orderId:order.id,userId:order.user_id,territory:order.territory_code,channel:"retail"})
            }));
            if(response.status!==200)throw Error("owner_settlement_publication_incomplete");
          }},raw);
        return Response.json(receipt,{headers:noStore});
      }
      if(route==="/publication/recover-recorded") {
        const input=raw as {operationId?:unknown}|null;
        if(!input||Object.keys(input).join(",")!=="operationId"||
          typeof input.operationId!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(input.operationId))
          return new Response(null,{status:400,headers:noStore});
        if(this.publicationRecoveryRunning)return new Response(null,{status:409,headers:noStore});
        this.publicationRecoveryRunning=true;
        try {
          const result=await recoverPublicationCommands(sql,(path,body)=>this.fetch(new Request(
            "https://legal-authority.internal"+path,{method:"POST",headers:{
              authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,"content-type":"application/json"
            },body:JSON.stringify(body)})));
          return Response.json({schema:"cove.publication-recovery.v1",ownerFirst:true,
            operationId:input.operationId,...result},{headers:noStore});
        } finally {this.publicationRecoveryRunning=false;}
      }
      if(route==="/publishing/partner/process-feed") {
        const q=raw as {limit?:unknown;operationId?:unknown}|null;
        if(!q||typeof q!=="object"||Array.isArray(q)||
          Object.keys(q).sort().join(",")!=="limit,operationId"||
          !Number.isSafeInteger(q.limit)||Number(q.limit)<1||Number(q.limit)>25||
          typeof q.operationId!=="string"||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(q.operationId))
          return new Response(null,{status:400,headers:noStore});
        if(this.partnerFeedRunning)return new Response(null,{status:409,headers:noStore});
        this.partnerFeedRunning=true;
        try {
          const outcome=await processPartnerFeedQueuePrivate(env.PRIMARY_DB,Number(q.limit));
          return Response.json({schema:"cove.owner-partner-feed-sandbox.v1",
            ownerFirst:true,operationId:q.operationId,...outcome},{headers:noStore});
        }finally{this.partnerFeedRunning=false;}
      }
      if(route==="/catalog/normalize-gutenberg") {
        const input=raw as {sourceId?:unknown;operationId?:unknown}|null;
        if(!input||typeof input!=="object"||Array.isArray(input)||
           Object.keys(input).sort().join(",")!=="operationId,sourceId"||
           typeof input.sourceId!=="string"||
           !/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(input.sourceId)||
           typeof input.operationId!=="string"||
           !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(input.operationId))
          return new Response(null,{status:400,headers:noStore});
        // Never use a caller-supplied license, product, rights-grant or price.
        // In the isolated QA database, require independently existing approved
        // country evidence and a fully cached EPUB BEFORE normalizing.
        const source=await env.PRIMARY_DB.prepare(
          "SELECT source_id,copyright,rights_status,commercial_use_status,epub_status FROM gutenberg_source_cache WHERE id=?"
        ).bind(input.sourceId).first<{source_id:string;copyright:number;
          rights_status:string;commercial_use_status:string;epub_status:string}>();
        const evidence=await env.PRIMARY_DB.prepare(
          "SELECT id FROM gutenberg_rights_evidence WHERE cache_id=? AND status='approved' AND determination='public-domain' LIMIT 1"
        ).bind(input.sourceId).first<{id:string}>();
        if(!source||source.copyright!==0||source.rights_status!=="public-domain"||
           source.commercial_use_status!=="approved"||source.epub_status!=="completed"||
           !evidence)return new Response(null,{status:409,headers:noStore});
        await env.PRIMARY_DB.batch(commercialCatalogStatements(env.PRIMARY_DB,input.sourceId,new Date().toISOString()));
        return Response.json({schema:"cove.owner-catalog-free.v1",ownerFirst:true,
          sourceId:input.sourceId,productId:catalogIds(input.sourceId).productId,
          operationId:input.operationId,applied:true},{headers:noStore});
      }
      if(route==="/catalog/personal-import") {
        const q=raw as {id?:unknown;userId?:unknown;title?:unknown;author?:unknown;
          language?:unknown;objectKey?:unknown;createdAt?:unknown;operationId?:unknown}|null;
        if(!q||typeof q!=="object"||Array.isArray(q)||
           Object.keys(q).sort().join(",")!=="author,createdAt,id,language,objectKey,operationId,title,userId"||
           typeof q.id!=="string"||!/^upload_[0-9a-f-]{36}$/.test(q.id)||
           typeof q.userId!=="string"||!/^[a-zA-Z0-9_-]{8,160}$/.test(q.userId)||
           typeof q.title!=="string"||q.title.length>240||
           typeof q.author!=="string"||q.author.length>240||
           typeof q.language!=="string"||!/^[a-zA-Z-]{2,20}$/.test(q.language)||
           typeof q.objectKey!=="string"||q.objectKey!==`uploads/${q.userId}/${q.id}.epub`||
           typeof q.createdAt!=="string"||!Number.isFinite(Date.parse(q.createdAt))||
           Math.abs(Date.now()-Date.parse(q.createdAt))>15*60_000||
           typeof q.operationId!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(q.operationId))
          return new Response(null,{status:400,headers:noStore});
        if(!env.BUCKET||!await env.BUCKET.get(q.objectKey))
          return new Response(null,{status:409,headers:noStore});
        const existing=await env.PRIMARY_DB.prepare(
          "SELECT user_id FROM personal_imports WHERE id=?"
        ).bind(q.id).first<{user_id:string}>();
        if(existing&&existing.user_id!==q.userId)
          return new Response(null,{status:409,headers:noStore});
        if(!existing)await env.PRIMARY_DB.batch(personalImportStatements(env.PRIMARY_DB,{
          id:q.id,userId:q.userId,title:q.title,author:q.author,language:q.language,
          objectKey:q.objectKey,createdAt:q.createdAt
        }));
        return Response.json({schema:"cove.owner-personal-import.v1",ownerFirst:true,
          userId:q.userId,importId:q.id,productId:catalogIds(q.id).productId,
          operationId:q.operationId,applied:!existing},{headers:noStore});
      }
      if(route==="/publishing/audio/register-upload"){
        const input=z.object({
          userId:z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/),
          editionId:z.string().min(3).max(160),
          kind:z.enum(["chapter","preview"]),
          title:z.string().min(1).max(300),
          position:z.number().int().min(0).max(10000),
          durationMs:z.number().int().positive().max(86_400_000),
          sampleRateHz:z.number().int().min(8000).max(192000),
          bitrateKbps:z.number().int().min(16).max(1000).nullable(),
          bitrateMode:z.string().max(20),channels:z.number().int().min(1).max(8),
          rms:z.number().finite().nullable(),peak:z.number().finite().nullable(),
          noise:z.number().finite().nullable(),filename:z.string().min(1).max(240),
          mime:z.enum(["audio/mpeg","audio/mp4"]),
          length:z.number().int().positive().max(750*1024*1024),
          sha:z.string().regex(/^[a-f0-9]{64}$/),
          fileId:z.string().regex(/^audiofile_[a-f0-9-]{36}$/),
          key:z.string().min(1).max(1000),
          operationId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/)
        }).strict().parse(raw);
        const result=await registerPrivateCommercialAudioUpload(env,input);
        return Response.json({schema:"cove.owner-audio-upload.v1",ownerFirst:true,
          operationId:input.operationId,fileId:input.fileId,
          editionId:input.editionId,kind:input.kind,result},{headers:noStore});
      }
      if(route==="/publishing/audio/qc-jobs") {
        const input=z.object({
          action:z.enum(["lease","complete"]),
          payload:z.record(z.string(),z.unknown()),
          operationId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/)
        }).strict().parse(raw);
        const db=env.PRIMARY_DB as unknown as CoveEnv["DB"];
        const result=input.action==="lease"?
          await privateAudioQcQueues.leaseCommercialAudioQcJobs(db,input.payload):
          await privateAudioQcQueues.completeCommercialAudioQc(db,input.payload);
        return Response.json({schema:"cove.owner-audio-qc-jobs.v1",ownerFirst:true,
          operationId:input.operationId,action:input.action,result},{headers:noStore});
      }
      if(route==="/publishing/worker/jobs"){
        const input=z.object({
          action:z.enum(["lease-validation","complete-validation","lease-rights-scan","complete-rights-scan"]),
          payload:z.record(z.string(),z.unknown()),
          operationId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/)
        }).strict().parse(raw);
        // A QA service binding is NOT a verified worker principal. Positive scan
        // results cannot be deployed until the worker proof is independently signed.
        const db=env.PRIMARY_DB as unknown as PublishingDB;
        const result=input.action==="lease-validation"?
          await privatePublishingWorkQueues.leasePublishingValidationJobs(db,input.payload):
          input.action==="complete-validation"?
            await privatePublishingWorkQueues.completePublishingValidationJob(db,input.payload):
            input.action==="lease-rights-scan"?
              await privatePublishingWorkQueues.leaseRightsEvidenceScanJobs(db,input.payload):
              await privatePublishingWorkQueues.completeRightsEvidenceScanJob(db,input.payload);
        return Response.json({schema:"cove.owner-publishing-worker-jobs.v1",
          ownerFirst:true,operationId:input.operationId,action:input.action,result},{headers:noStore});
      }
      if(route==="/publishing/audio/metadata") {
        const input=z.object({
          action:z.enum(["profile","narrators","agreement-add","agreement-end"]),
          userId:z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/),
          payload:z.record(z.string(),z.unknown()),
          operationId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/)
        }).strict().parse(raw);
        // The owner never trusts caller-supplied edition/account/verification status;
        // every handler re-reads current member roles, draft and verified evidence.
        const fingerprint=new Uint8Array(await crypto.subtle.digest("SHA-256",
          new TextEncoder().encode(JSON.stringify(input))));
        const requestDigest=Array.from(fingerprint,b=>b.toString(16).padStart(2,"0")).join("");
        const prior=sql.exec<{request_digest:string;receipt_json:string}>(
          "SELECT request_digest,receipt_json FROM cove_audio_metadata_command_receipts WHERE operation_id=?",
          input.operationId).toArray()[0];
        if(prior) {
          if(prior.request_digest!==requestDigest)return new Response(null,{status:409,headers:noStore});
          return Response.json(JSON.parse(prior.receipt_json),{headers:noStore});
        }
        const action=input.action;
        const db=env.PRIMARY_DB as unknown as CoveEnv["DB"];
        if(action==="agreement-end") {
          const termination=z.object({
            agreementId:z.string().min(1).max(180),
            disposition:z.enum(["terminated","superseded"]),
            effectiveAt:z.string().datetime().optional(),
            replacementAgreementId:z.string().min(1).max(180).nullable().optional(),
            reason:z.string().trim().min(10).max(2000)
          }).parse(input.payload);
          const priorAgreement=await db.prepare(
            "SELECT na.edition_id,na.narrator_id FROM narration_agreements na JOIN publishing_edition_drafts e ON e.id=na.edition_id JOIN publishing_titles t ON t.id=e.title_id JOIN publishing_account_members m ON m.account_id=t.account_id WHERE na.id=? AND m.user_id=? AND m.status='active' AND m.role IN ('owner','admin','editor')"
          ).bind(termination.agreementId,input.userId).first<{edition_id:string;narrator_id:string}>();
          if(!priorAgreement)throw new ApiError(403,"Publisher authorization is not current.");
          const existing=await db.prepare(
            "SELECT id FROM narration_agreement_terminations WHERE agreement_id=?"
          ).bind(termination.agreementId).first<{id:string}>();
          if(existing)throw new ApiError(409,"Agreement is already terminated.");
          if(termination.disposition==="superseded") {
            if(!termination.replacementAgreementId)throw new ApiError(400,"Replacement required.");
            const replacement=await db.prepare(
              "SELECT id FROM narration_agreements WHERE id=? AND edition_id=? AND narrator_id=?"
            ).bind(termination.replacementAgreementId,priorAgreement.edition_id,priorAgreement.narrator_id).first<{id:string}>();
            if(!replacement)throw new ApiError(409,"Replacement must cover the same edition and narrator.");
          }
          const products=(await db.prepare(
            "SELECT DISTINCT p.product_id FROM publishing_publications p JOIN publishing_submission_snapshots ss ON ss.id=p.submission_id WHERE ss.edition_id=? AND p.product_id IS NOT NULL"
          ).bind(priorAgreement.edition_id).all<{product_id:string}>()).results;
          if(products.length>25)throw new ApiError(503,"Publication revocation set must be reviewed.");
          if(products.length){
            // A terminated audio performance licence withdraws *every* linked
            // published product synchronously, before D1 is allowed to change.
            const storage=this.ctx.storage as typeof this.ctx.storage & {
              transactionSync<T>(fn:()=>T):T;
            };
            storage.transactionSync(()=>{
              for(const [i,item] of products.entries()){
                const denied=denyCommercialProduct(sql,{productId:item.product_id,
                  operationId:"audio-termination:"+input.operationId+":"+i});
                if(!denied.applied)throw Error("owner_audio_termination_denial_failed");
              }
            });
          }
        }
        const result=action==="profile"?
          await privateAudioMetadata.saveCommercialAudioProfile(db,input.userId,input.payload):
          action==="narrators"?
            await privateAudioMetadata.replaceCommercialAudioNarrators(db,input.userId,input.payload):
            action==="agreement-add"?
              await privateAudioMetadata.addNarrationAgreement(db,input.userId,input.payload):
              await privateAudioMetadata.endNarrationAgreement(db,input.userId,input.payload);
        const ack={schema:"cove.owner-audio-metadata.v1",ownerFirst:true,
          operationId:input.operationId,action,userId:input.userId,result};
        sql.exec("INSERT INTO cove_audio_metadata_command_receipts(operation_id,request_digest,receipt_json) VALUES(?,?,?)",
          input.operationId,requestDigest,JSON.stringify(ack));
        return Response.json(ack,{headers:noStore});
      }
      if(route==="/catalog/repair-regional-assets"){
        const input=z.object({after:z.string().regex(/^[a-z0-9_]{0,90}$/).default(""),limit:z.number().int().min(1).max(16).default(8)}).strict().parse(raw);
        if(this.regionalRepairExecution)return new Response(null,{status:409,headers:noStore});
        this.regionalRepairExecution=true;
        try{
          const result=await repairRegionalEpubAssetsPrivate({DB:env.PRIMARY_DB,BUCKET:env.BUCKET} as Pick<CoveEnv,"DB"|"BUCKET">,input);
          return Response.json({schema:"cove.private-regional-epub-repair.v1",ownerFirst:true,
            after:input.after,limit:input.limit,result},{headers:noStore});
        }finally{this.regionalRepairExecution=false;}
      }
      if(route==="/account/private-action"){
        const input=z.discriminatedUnion("action",[
          z.object({action:z.literal("register-device"),userId:z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/),
            device:z.object({deviceKey:z.string().min(16).max(200),name:z.string().trim().min(1).max(120),platform:z.string().trim().min(1).max(80)}).strict()}).strict(),
          z.object({action:z.literal("revoke-device"),userId:z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/),deviceId:z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/)}).strict(),
          z.object({action:z.literal("erasure-tick"),limit:z.number().int().min(1).max(25)}).strict()
        ]).parse(raw);
        if(this.accountExecution){
          if(input.action==="erasure-tick")return Response.json({schema:"cove.private-account-qa.v1",ownerFirst:true,action:input.action,userId:null,
            result:{processed:0,completed:0,blocked:0,retrying:0}},{headers:noStore});
          return new Response(null,{status:409,headers:noStore});
        }
        this.accountExecution=true;
        try{
          let result:unknown;
          const db=env.PRIMARY_DB;
          if(input.action==="erasure-tick"){
            result=await privateAccount.processAccountDeletionQueue({...env,DB:db} as unknown as CoveEnv,sql,input.limit);
          }else{
            const user=await db.prepare("SELECT app_id,disabled_at FROM auth_accounts WHERE app_id=?")
              .bind(input.userId).first<{app_id:string;disabled_at:string|null}>();
            const denied=sql.exec("SELECT 1 ok FROM cove_account_access_denials WHERE user_id=?",input.userId).toArray().length;
            if(!user||user.disabled_at||denied)return new Response(null,{status:403,headers:noStore});
            // Cookies and caller-selected identity headers never cross this
            // protocol. The authenticated API supplies its verified app ID.
            const auditRequest=new Request("https://legal-authority.internal/account/device");
            result=input.action==="register-device"?
              await privateAccount.registerDevice(db,input.userId,auditRequest,input.device):
              await privateAccount.revokeDevice(db,input.userId,input.deviceId,auditRequest);
          }
          return Response.json({schema:"cove.private-account-qa.v1",ownerFirst:true,action:input.action,
            userId:input.action==="erasure-tick"?null:input.userId,result},{headers:noStore});
        }finally{this.accountExecution=false;}
      }
      if(route==="/finance/private-action"){
        const input=z.object({
          action:z.enum(["createFinanceParty","createRoyaltyContract","createRoyaltyContractVersion",
            "createPayoutBatch","approvePayoutBatch","settlePayoutBatch","recordUsageEvent",
            "processUsageEventRoyalty","createUsagePool","allocateUsagePool"]),
          actorUserId:z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/),
          operationId:z.string().regex(/^finance:[a-f0-9]{64}$/),args:z.tuple([z.unknown()])
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const principal=await db.prepare("SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'")
          .bind(input.actorUserId).first<{user_id:string}>();
        const permissions=(await db.prepare("SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?")
          .bind(input.actorUserId).all<{permission:string}>()).results.map(x=>x.permission);
        const required=["recordUsageEvent","processUsageEventRoyalty","createUsagePool","allocateUsagePool"].includes(input.action)?
          "finance.usage.ingest":input.action==="createRoyaltyContractVersion"?"finance.contract.manage":"finance.manage";
        if(!principal||!permissions.includes(required))return new Response(null,{status:403,headers:noStore});
        if(this.financeExecution)return new Response(null,{status:409,headers:noStore});
        this.financeExecution=true;
        try{
          const canonical=(x:unknown):string=>Array.isArray(x)?"["+x.map(canonical).join(",")+"]":
            x&&typeof x==="object"?"{"+Object.keys(x).sort().map(k=>JSON.stringify(k)+":"+canonical((x as Record<string,unknown>)[k])).join(",")+"}":JSON.stringify(x)??"null";
          const requestDigest=await sha256(canonical([input.action,input.actorUserId,input.args]));
          const prior=sql.exec<{request_digest:string;receipt_json:string|null}>("SELECT request_digest,receipt_json FROM cove_finance_command_receipts WHERE operation_id=?",input.operationId).toArray()[0];
          if(prior){
            if(prior.request_digest!==requestDigest)return new Response(null,{status:409,headers:noStore});
            if(prior.receipt_json)return new Response(prior.receipt_json,{headers:{...noStore,"content-type":"application/json"}});
          }else sql.exec("INSERT INTO cove_finance_command_receipts(operation_id,request_digest,receipt_json) VALUES(?,?,NULL)",input.operationId,requestDigest);
          // Stable, journal-bound IDs survive the gap between a committed D1
          // batch and a lost owner response. Replays reuse the same identities.
          const royalty=createPrivateRoyalty(input.operationId.slice(8));
          const finance=createPrivateFinance(royalty,input.operationId.slice(8));
          const funcs={...royalty,...finance};
          const argument=input.action==="createRoyaltyContractVersion"?
            {...z.record(z.string(),z.unknown()).parse(input.args[0]),createdByUserId:input.actorUserId}:input.args[0];
          const result=await (funcs[input.action] as (db:CatalogDB,arg:unknown)=>Promise<unknown>)(db,argument);
          const receipt={schema:"cove.private-finance-qa.v1",ownerFirst:true,actorUserId:input.actorUserId,
            action:input.action,operationId:input.operationId,result:result??null};
          // An incomplete risk-held usage allocation must remain recoverable.
          if(!(result&&typeof result==="object"&&"status" in result&&["locked","held_for_risk_review"].includes(String(result.status))))
            sql.exec("UPDATE cove_finance_command_receipts SET receipt_json=? WHERE operation_id=?",JSON.stringify(receipt),input.operationId);
          return Response.json(receipt,{headers:noStore});
        }finally{this.financeExecution=false;}
      }
      if(route==="/publishing/partner/private-action"){
        const input=z.object({
          action:z.enum(["certify","issue-credential","revoke-credential","submit-feed","asset-expectations","upload-asset","assign-contract","reconcile-public-domain"]),
          operationId:z.string().regex(/^partner:[a-f0-9-]{36}$/),
          payload:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const p=input.payload;
        if(["submit-feed","asset-expectations","upload-asset","assign-contract",
            "reconcile-public-domain","issue-credential"].includes(input.action))
          return new Response(null,{status:409,headers:noStore});
        const actor=z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/).parse(p.actorUserId);
        const data=z.record(z.string(),z.unknown()).parse(p.raw);
        const db=env.PRIMARY_DB;
        let result:unknown;
        if(input.action==="certify"){
          const state=z.enum(["paused","terminated"]).safeParse(data.productionStatus);
          if(!state.success)return new Response(null,{status:409,headers:noStore});
          const staff=await db.prepare(
            "SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'"
          ).bind(actor).first<{user_id:string}>();
          const permissions=(await db.prepare(
            "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
          ).bind(actor).all<{permission:string}>()).results.map(r=>r.permission);
          if(!staff||(!permissions.includes("publishing.partner.manage")&&!permissions.includes("staff.manage")))
            return new Response(null,{status:403,headers:noStore});
          result=await privateTraditionalPartner.certifyPartnerProfile(db,actor,data);
        }else if(input.action==="revoke-credential"){
          // The QA actor must exist independently and the original private
          // command validates active account membership and role on owner D1.
          const principal=await db.prepare(
            "SELECT app_id FROM auth_accounts WHERE app_id=?"
          ).bind(actor).first<{app_id:string}>();
          if(!principal)return new Response(null,{status:403,headers:noStore});
          result=await privateTraditionalPartner.revokePartnerCredential(db,actor,data);
        }
        return Response.json({schema:"cove.private-partner-negative-qa.v1",
          ownerFirst:true,operationId:input.operationId,
          action:input.action,result:result??null},{headers:noStore});
      }
      if(route==="/publishing/editor-action"){
        const input=z.object({action:z.enum(["account-save","member-invite","identity-start","tax-submit","payout-submit","title-save","edition-save","asset-upload","accessibility-sign","edition-submit","revision-open","update-policy","owner-optin","review-submission"]),
          operationId:z.string().regex(/^editor:[a-f0-9-]{36}$/),
          payload:z.record(z.string(),z.unknown())}).strict().parse(raw);
        const p=input.payload;
        const db=env.PRIMARY_DB as PublishingDB;
        const userid=z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/).parse(p.userId);
        const obj=(raw:unknown)=>z.record(z.string(),z.unknown()).parse(raw);
        if(["edition-submit","update-policy","owner-optin","asset-upload"].includes(input.action))
          return new Response(null,{status:409,headers:noStore});
        let result:unknown;
        if(input.action==="review-submission"){
          const staff=await db.prepare("SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'")
            .bind(userid).first<{user_id:string}>();
          const perms=(await db.prepare(
            "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
          ).bind(userid).all<{permission:string}>()).results.map(x=>x.permission);
          if(!staff||(!perms.includes("publishing.review")&&!perms.includes("staff.manage")))
            return new Response(null,{status:403,headers:noStore});
          const decision=obj(p.raw);
          if(!["reject","hold"].includes(String(decision.decision)))
            return new Response(null,{status:409,headers:noStore});
          result=await privatePublishingEditor.reviewPublishingSubmission({DB:db},userid,decision);
        }else{
          // QA auth-principal existence is NOT independent production JWT verification.
          const principal=await db.prepare("SELECT app_id FROM auth_accounts WHERE app_id=?")
            .bind(userid).first<{app_id:string}>();
          if(!principal)return new Response(null,{status:403,headers:noStore});
          switch(input.action){
            case "account-save":result=await privatePublishingEditor.upsertPublishingAccount(db,userid,obj(p.raw));break;
            case "member-invite":result=await privatePublishingEditor.invitePublishingMember(db,userid,obj(p.raw));break;
            case "identity-start":result=await privatePublishingEditor.startIdentityVerification(db,userid,obj(p.raw));break;
            case "tax-submit":result=await privatePublishingEditor.submitTaxProfile(db,userid,obj(p.raw));break;
            case "payout-submit":result=await privatePublishingEditor.submitPayoutAccount(db,userid,obj(p.raw));break;
            case "title-save":result=await privatePublishingEditor.savePublishingTitle(db,userid,obj(p.raw));break;
            case "edition-save":result=await privatePublishingEditor.savePublishingEdition(db,userid,obj(p.raw));break;
            case "accessibility-sign":result=await privatePublishingEditor.signPublishingAccessibilityDeclaration(db,userid,obj(p.raw));break;
            case "revision-open":result=await privatePublishingEditor.openPublishingRevision(db,userid,
              z.string().min(3).max(180).parse(p.editionId));break;
          }
        }
        return Response.json({schema:"cove.private-publishing-editor-qa.v1",ownerFirst:true,
          action:input.action,operationId:input.operationId,
          result:result??null},{headers:noStore});
      }
      if(route==="/trust/private-action"){
        const input=z.object({
          action:z.enum(["sign-rights","upload-evidence","assess-content",
            "submit-notice","validate-notice","submit-counter","validate-counter",
            "court-action","resolve-dispute","repeat-policy","review-evidence"]),
          operationId:z.string().regex(/^trust:[a-f0-9-]{36}$/),
          payload:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const db=env.PRIMARY_DB as PublishingDB;
        const p=input.payload;
        const actor=z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/);
        const staffAction=["validate-notice","validate-counter","court-action",
          "resolve-dispute","repeat-policy","review-evidence"].includes(input.action);
        let staff:StaffContext|null=null;
        if(staffAction){
          const userId=actor.parse(p.actorUserId);
          const account=await db.prepare("SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'")
            .bind(userId).first<{user_id:string}>();
          const perms=(await db.prepare(
            "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
          ).bind(userId).all<{permission:string}>()).results.map(r=>r.permission);
          const expected=input.action==="review-evidence"?"publishing.review":"moderation.copyright.manage";
          if(!account||(!perms.includes(expected)&&!perms.includes("staff.manage")))
            return new Response(null,{status:403,headers:noStore});
          staff={userId,permissions:new Set(perms)} as StaffContext;
        }
        const obj=(value:unknown)=>z.record(z.string(),z.unknown()).parse(value);
        let result:unknown;
        switch(input.action){
          case "sign-rights":{
            // A publisher's self-attestation is not independently verified legal authority.
            return new Response(null,{status:409,headers:noStore});
          }
          case "upload-evidence":{
            const userId=actor.parse(p.actorUserId),value=obj(p.raw);
            const bytes=z.array(z.number().int().min(0).max(255)).max(32768).parse(value.bytes);
            const input={...value,bytes:new Uint8Array(bytes)};
            result=await privateTrust.uploadRightsEvidence({DB:db,BUCKET:env.BUCKET} as PublishingEnv,
              userId,input as Parameters<typeof privateTrust.uploadRightsEvidence>[2]);
            break;
          }
          case "assess-content":{
            const submissionId=z.string().min(3).max(160).parse(p.submissionId);
            result=await privateTrust.assessSubmissionContentPolicy(db,submissionId);
            break;
          }
          case "submit-notice":{
            const userId=p.actorUserId===null?null:actor.parse(p.actorUserId);
            result=await privateTrust.submitCopyrightNotice(db,userId,obj(p.raw));
            break;
          }
          case "validate-notice":{
            const x=obj(p.raw);
            if(x.decision==="compliant_takedown")
              return new Response(null,{status:409,headers:noStore});
            if(!["needs_info","noncompliant"].includes(String(x.decision)))
              return new Response(null,{status:400,headers:noStore});
            result=await privateTrust.validateCopyrightNotice(db,staff!,x);
            break;
          }
          case "submit-counter":{
            const userId=actor.parse(p.actorUserId);
            result=await privateTrust.submitCopyrightCounterNotice(db,userId,obj(p.raw));
            break;
          }
          case "validate-counter":{
            const x=obj(p.raw);
            if(x.decision==="compliant_forward")
              return new Response(null,{status:409,headers:noStore});
            if(!["needs_info","reject"].includes(String(x.decision)))
              return new Response(null,{status:400,headers:noStore});
            result=await privateTrust.validateCopyrightCounterNotice(db,staff!,x);
            break;
          }
          case "court-action":{
            // Requires independently verified court filing evidence. Never
            // turn an unverified self-assertion into statutory authority.
            return new Response(null,{status:409,headers:noStore});
          }
          case "resolve-dispute":{
            const x=obj(p.raw);
            if(x.restoreContent===true||x.royaltyDisposition==="release"||
               x.resolutionCode!=="infringement_confirmed")
              return new Response(null,{status:409,headers:noStore});
            result=await privateTrust.resolveRightsDispute(db,staff!,x);
            break;
          }
          case "repeat-policy":
            // Retiring a publication needs a whole-product legal denial.
            // Overturns may reinstate rights; neither is yet certified.
            return new Response(null,{status:409,headers:noStore});
          case "review-evidence":{
            const x=obj(p.raw);
            if(x.status==="verified")return new Response(null,{status:409,headers:noStore});
            if(!["insufficient","rejected"].includes(String(x.status)))
              return new Response(null,{status:400,headers:noStore});
            result=await privateTrust.reviewRightsEvidence(db,staff!,x);
            break;
          }
        }
        return Response.json({schema:"cove.owner-trust-negative.v1",
          ownerFirst:true,operationId:input.operationId,
          action:input.action,result:result??null},{headers:noStore});
      }
      if(route==="/preorder/private-action"){
        const input=z.object({
          action:z.enum(["ensure-plan","register-paid","update-lowest","customer-cancel",
            "publisher-cancel","lease-refunds","complete-refund","advance"]),
          operationId:z.string().regex(/^preorder:[a-f0-9-]{36}$/),
          payload:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const p=input.payload;
        let result:unknown;
        switch(input.action){
          case "ensure-plan":{
            const a=z.object({productId:z.string().min(3).max(160),
              actorUserId:z.string().max(180).nullable()}).strict().parse(p);
            result=await privatePreorder.ensurePreorderReleasePlan(db,a.productId,a.actorUserId);
            break;
          }
          case "register-paid":
            // No caller-supplied paid status proves a Stripe settlement.
            return new Response(null,{status:409,headers:noStore});
          case "update-lowest":{
            const a=z.object({productId:z.string().min(3).max(160),
              reason:z.string().max(180)}).strict().parse(p);
            result=await privatePreorder.updatePreorderLowestPrice(db,a.productId,a.reason);
            break;
          }
          case "customer-cancel":{
            const a=z.object({userId:z.string().min(3).max(180),
              preorderId:z.string().min(3).max(180)}).strict().parse(p);
            result=await privatePreorder.customerCancelPreorder(db,a.userId,a.preorderId);
            break;
          }
          case "publisher-cancel":{
            const a=z.object({userId:z.string().min(3).max(180),
              input:z.object({accountId:z.string().min(3).max(180),
                releasePlanId:z.string().min(3).max(180),
                reason:z.string().trim().min(3).max(1000)}).strict()}).strict().parse(p);
            result=await privatePreorder.publisherCancelReleasePlan(db,a.userId,a.input);
            break;
          }
          case "lease-refunds":{
            const a=z.object({input:z.object({workerId:z.string().min(3).max(120),
              limit:z.number().int().min(1).max(100).optional(),
              leaseSeconds:z.number().int().min(30).max(1800).optional()}).strict()}).strict().parse(p);
            result=await privatePreorder.leasePreorderRefundJobs(db,a.input);
            break;
          }
          case "complete-refund":{
            const a=z.object({input:z.object({jobId:z.string().min(3).max(180),
              leaseToken:z.string().min(1).max(300),success:z.boolean(),
              providerRefundId:z.string().nullable().optional(),
              error:z.string().max(2000).optional()}).strict()}).strict().parse(p);
            if(a.input.success) return new Response(null,{status:409,headers:noStore});
            result=await privatePreorder.completePreorderRefundJob(db,a.input);
            break;
          }
          case "advance":{
            z.object({}).strict().parse(p);
            result=await privatePreorder.advancePreorders(db);
            break;
          }
        }
        return Response.json({schema:"cove.owner-preorder-qa.v1",ownerFirst:true,
          operationId:input.operationId,action:input.action,
          result:result??null},{headers:noStore});
      }
      if(route==="/rights/private-configuration") {
        const input=z.object({
          action:z.enum(["upsert-party","upsert-territory-set"]),
          actorUserId:z.string().regex(/^[A-Za-z0-9_-]{3,160}$/),
          operationId:z.string().regex(/^rights:[a-f0-9]{64}$/),
          payload:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",
          new TextEncoder().encode(JSON.stringify({action:input.action,
            actorUserId:input.actorUserId,payload:input.payload}))));
        const expected="rights:"+Array.from(digest,x=>x.toString(16).padStart(2,"0")).join("");
        if(expected!==input.operationId)return new Response(null,{status:409,headers:noStore});
        if(this.rightsConfigExecution)return new Response(null,{status:409,headers:noStore});
        this.rightsConfigExecution=true;
        try{
          const staff=await env.PRIMARY_DB.prepare(
            "SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'"
          ).bind(input.actorUserId).first<{user_id:string}>();
          if(!staff)return new Response(null,{status:403,headers:noStore});
          const permissions=(await env.PRIMARY_DB.prepare(
            "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
          ).bind(input.actorUserId).all<{permission:string}>()).results.map(r=>r.permission);
          if(!permissions.includes("commerce.manage")&&!permissions.includes("staff.manage"))
            return new Response(null,{status:403,headers:noStore});
          let result:unknown;
          if(input.action==="upsert-party"){
            const request=z.object({id:z.string().max(160).optional(),
              publisherId:z.string().nullable().optional(),
              contributorId:z.string().nullable().optional(),
              status:z.enum(["active","inactive"]).default("active")}).passthrough().parse(input.payload);
            const existing=request.id?await env.PRIMARY_DB.prepare(
              "SELECT status,publisher_id,contributor_id FROM rights_parties WHERE id=?"
            ).bind(request.id).first<{status:string;publisher_id:string|null;contributor_id:string|null}>():null;
            // Positive creation/reactivation and ownership rebinding require
            // separately verified legal evidence, not a staff-provided claim.
            if(request.status==="active"&&(!existing||existing.status!=="active"||
              String(existing.publisher_id||"")!==String(request.publisherId||"")||
              String(existing.contributor_id||"")!==String(request.contributorId||"")))
              return new Response(null,{status:409,headers:noStore});
            result=await privateRightsConfiguration.upsertRightsParty(
              env.PRIMARY_DB,input.payload,input.operationId);
          }else{
            const request=z.object({id:z.string().min(1).max(180),
              status:z.enum(["inactive","archived"]),
              rules:z.array(z.unknown()).length(0)}).passthrough().parse(input.payload);
            const existing=await env.PRIMARY_DB.prepare(
              "SELECT id,is_system FROM territory_sets WHERE id=?"
            ).bind(request.id).first<{id:string;is_system:number}>();
            if(!existing||Number(existing.is_system)!==0)
              return new Response(null,{status:409,headers:noStore});
            // Negative-only membership removal. No region, nested set, market
            // or positive grant may be introduced through this route.
            result=await privateRightsConfiguration.upsertTerritorySet(
              env.PRIMARY_DB,input.payload,input.operationId);
          }
          return Response.json({schema:"cove.owner-rights-config-qa.v1",ownerFirst:true,
            action:input.action,actorUserId:input.actorUserId,
            operationId:input.operationId,result},{headers:noStore});
        }finally{this.rightsConfigExecution=false;}
      }
      if(route==="/catalog/observe-us"){
        const bookSchema=z.object({
          id:z.string().regex(/^[0-9]{1,10}$/),
          count:z.number().int().min(0).max(1_000_000_000).optional(),
          expectedUpdatedAt:z.string().max(60).optional(),
          expectedProjectionUpdatedAt:z.string().max(60).optional()
        }).strict();
        const input=z.object({
          action:z.enum(["heartbeat","popularity"]),
          books:z.array(bookSchema).min(1).max(100)
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const ids=input.books.map(x=>x.id);
        if(new Set(ids).size!==ids.length||
           input.books.some(x=>input.action==="heartbeat"
             ?x.count!==undefined||x.expectedUpdatedAt!==undefined||x.expectedProjectionUpdatedAt!==undefined
             :x.count===undefined||!x.expectedUpdatedAt||!x.expectedProjectionUpdatedAt))
          return new Response(null,{status:409,headers:noStore});
        const observed=(await db.prepare(
          `SELECT c.id FROM gutenberg_source_cache c
            JOIN products p ON p.source_name='gutenberg' AND p.source_external_id=c.id
            WHERE c.id IN (${ids.map(()=>"?").join(",")})
              AND c.source_id='pg_us' AND c.copyright=0
              AND c.ingest_status='active' AND c.rights_status='public-domain'
              AND c.commercial_use_status='approved' AND c.rights_territories_json='["US"]'`
        ).bind(...ids).all<{id:string}>()).results;
        if(observed.length!==ids.length||new Set(observed.map(x=>x.id)).size!==ids.length)
          return new Response(null,{status:409,headers:noStore});
        const at=now();
        if(input.action==="heartbeat"){
          const unchanged=ids;
          await db.prepare(
            `UPDATE gutenberg_source_cache SET last_seen_at=?,source_updated_at=?
         WHERE id IN (${unchanged.map(() => "?").join(",")})`
          ).bind(at,at,...unchanged).run();
        }else{
          const statements:Parameters<typeof db.batch>[0]=[];
          for(const book of input.books){
            const id=book.id;
            const count=book.count!;
            statements.push(db.prepare(
              `UPDATE gutenberg_source_cache
            SET download_count=?,source_updated_at=?,last_seen_at=?,updated_at=?
            WHERE id=? AND updated_at=? AND ingest_status='active'
              AND rights_status='public-domain'
              AND commercial_use_status='approved'
              AND rights_territories_json='["US"]'`
            ).bind(count,at,at,at,id,book.expectedUpdatedAt));
            statements.push(db.prepare(
              `UPDATE catalog_search_documents
            SET download_count=?,updated_at=?
            WHERE product_id=? AND updated_at=?
              AND EXISTS(SELECT 1 FROM gutenberg_source_cache c
                WHERE c.id=? AND c.updated_at=? AND c.download_count=?
                  AND c.rights_status='public-domain'
                  AND c.commercial_use_status='approved'
                  AND c.rights_territories_json='["US"]')`
            ).bind(count,at,`prd_gutenberg_${id}`,book.expectedProjectionUpdatedAt,id,at,count));
          }
          await db.batch(statements);
        }
        return Response.json({schema:"cove.owner-us-catalog-observation.v1",
          ownerFirst:true,action:input.action,checked:ids.length,legalStatePreserved:true},
          {headers:noStore});
      }
      if(route==="/catalog/regional-state") {
        const input=z.object({
          action:z.enum(["acquire","degraded","unchanged","same-snapshot","complete","failed"]),
          sourceId:z.enum(["pg_ca","pg_au","pg_eu"]),leaseToken:z.string().uuid(),
          runId:z.string().regex(/^gir_[a-f0-9-]{36}$/),
          data:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const at=now();
        const nextSchema=z.string().datetime();
        const meta=z.object({
          next:nextSchema,etag:z.string().max(500).nullable().optional(),
          lastModified:z.string().max(500).nullable().optional()
        }).strict();
        const boundedNext=(value:string)=>{
          const distance=Date.parse(value)-Date.now();
          if(!Number.isFinite(distance)||distance<0||distance>8*86400000)
            throw new ApiError(409,"Regional source next-run window is invalid.");
          return value;
        };
        if(input.action==="acquire"){
          z.object({}).strict().parse(input.data);
          const selected=await db.prepare(
            "SELECT s.enabled FROM gutenberg_sources s JOIN gutenberg_source_states st ON st.source_id=s.id WHERE s.id=? AND s.enabled=1 AND (st.next_run_at IS NULL OR st.next_run_at='' OR st.next_run_at<=?) AND (st.lease_until IS NULL OR st.lease_until='' OR st.lease_until<?)"
          ).bind(input.sourceId,at,at).first<{enabled:number}>();
          if(!selected)return Response.json({schema:"cove.owner-regional-state.v1",ownerFirst:true,
            sourceId:input.sourceId,runId:input.runId,action:input.action,acquired:false},{headers:noStore});
          const leaseUntil=new Date(Date.now()+5*60*1000).toISOString();
          const acquired=await db.prepare(
            `UPDATE gutenberg_source_states SET status='running',lease_token=?,lease_until=?,last_run_at=?,last_error='',updated_at=? WHERE source_id=? AND (lease_until IS NULL OR lease_until='' OR lease_until<?) AND (next_run_at IS NULL OR next_run_at='' OR next_run_at<=?) RETURNING source_id`
          ).bind(input.leaseToken,leaseUntil,at,at,input.sourceId,at,at).first<{source_id:string}>();
          return Response.json({schema:"cove.owner-regional-state.v1",ownerFirst:true,
            sourceId:input.sourceId,runId:input.runId,action:input.action,acquired:!!acquired},{headers:noStore});
        }
        // Every completion is bound to the active primary-D1 lease and to the
        // privately checked run record. An unbound caller cannot unlock a source.
        const lease=await db.prepare(
          "SELECT st.source_id,st.content_hash,st.last_success_at FROM gutenberg_source_states st WHERE st.source_id=? AND st.status='running' AND st.lease_token=? AND st.lease_until>?"
        ).bind(input.sourceId,input.leaseToken,at)
         .first<{source_id:string;content_hash:string|null;last_success_at:string|null}>();
        const run=await db.prepare(
          "SELECT id FROM gutenberg_ingest_runs WHERE id=? AND source_id=? AND status='running'"
        ).bind(input.runId,input.sourceId).first<{id:string}>();
        if(!lease||!run)return new Response(null,{status:409,headers:noStore});
        const d=input.data;
        if(input.action==="degraded"){
          const x=z.object({warning:z.string().max(1500),next:nextSchema}).strict().parse(d);
          await db.prepare(
            `UPDATE gutenberg_source_states SET status='degraded',last_error=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=? AND lease_token=?`
          ).bind(x.warning,boundedNext(x.next),at,input.sourceId,input.leaseToken).run();
        }else if(input.action==="unchanged"){
          const x=meta.parse(d);
          await db.prepare(
            `UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?,attempts=0,next_run_at=?,lease_token=NULL,lease_until=NULL,
        etag=COALESCE(NULLIF(?,''),etag),last_modified=COALESCE(NULLIF(?,''),last_modified),updated_at=? WHERE source_id=? AND lease_token=?`
          ).bind(at,boundedNext(x.next),x.etag||"",x.lastModified||"",at,input.sourceId,input.leaseToken).run();
        }else if(input.action==="same-snapshot"){
          const x=meta.extend({bodyHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(d);
          if(lease.content_hash!==x.bodyHash||!lease.last_success_at)
            return new Response(null,{status:409,headers:noStore});
          await db.prepare(
            `UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?,last_error='',attempts=0,next_run_at=?,lease_token=NULL,lease_until=NULL,
        etag=?,last_modified=?,content_hash=?,updated_at=? WHERE source_id=? AND lease_token=?`
          ).bind(at,boundedNext(x.next),x.etag||"",x.lastModified||"",x.bodyHash,at,
              input.sourceId,input.leaseToken).run();
        }else if(input.action==="complete"){
          const x=meta.extend({
            cursorAfter:z.string().regex(/^\d+$/).nullable(),
            cycleStartedAt:z.string().datetime().nullable(),
            snapshotStart:z.string().datetime(),
            lastSuccessAt:z.string().datetime().nullable(),
            complete:z.boolean(),totalCatalogCount:z.number().int().min(0).max(100000000),
            seenCount:z.number().int().min(0).max(5000),
            acceptedCount:z.number().int().min(0).max(5000),
            quarantinedCount:z.number().int().min(0).max(100000000),
            bodyHash:z.string().regex(/^[a-f0-9]{64}$/)
          }).strict().parse(d);
          if(x.complete!==(x.cursorAfter===null)||
             (x.complete&&x.cycleStartedAt!==null)||
             (!x.complete&&!x.cycleStartedAt)||
             x.acceptedCount>x.seenCount||x.seenCount>x.totalCatalogCount||
             Date.parse(x.snapshotStart)>Date.now()+60000)
            return new Response(null,{status:409,headers:noStore});
          if(x.complete){
            const pending=await db.prepare(
              "SELECT COUNT(*) n FROM gutenberg_source_cache WHERE source_id=? AND last_seen_at<? AND ingest_status NOT IN ('stale','quarantined')"
            ).bind(input.sourceId,x.snapshotStart).first<{n:number}>();
            if(Number(pending?.n||0)>0)return new Response(null,{status:409,headers:noStore});
          }
          await db.prepare(
            `UPDATE gutenberg_source_states SET status='idle',cursor=?,cycle_started_at=?,last_success_at=?,last_error='',attempts=0,total_catalog_count=?,
      seen_count=seen_count+?,accepted_count=accepted_count+?,quarantined_count=quarantined_count+?,next_run_at=?,lease_token=NULL,lease_until=NULL,
      etag=?,last_modified=?,content_hash=?,updated_at=? WHERE source_id=? AND lease_token=?`
          ).bind(x.cursorAfter,x.cycleStartedAt,x.lastSuccessAt,x.totalCatalogCount,
            x.seenCount,x.acceptedCount,x.quarantinedCount,boundedNext(x.next),
            x.etag||"",x.lastModified||"",x.bodyHash,at,input.sourceId,input.leaseToken).run();
        }else if(input.action==="failed"){
          const x=z.object({message:z.string().max(1000),attempts:z.number().int().min(1).max(1000),
            retryAt:nextSchema}).strict().parse(d);
          await db.prepare(
            `UPDATE gutenberg_source_states SET status='failed',last_error=?,attempts=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=? AND lease_token=?`
          ).bind(x.message,x.attempts,boundedNext(x.retryAt),at,input.sourceId,input.leaseToken).run();
        }
        return Response.json({schema:"cove.owner-regional-state.v1",ownerFirst:true,
          sourceId:input.sourceId,runId:input.runId,action:input.action,acquired:true},{headers:noStore});
      }
      if(route==="/catalog/verified-us-epub-cache"){
        const input=z.object({
          cacheId:z.string().regex(/^[0-9]{1,10}$/),
          assetVersionId:z.string().min(3).max(180),
          sha256:z.string().regex(/^[a-f0-9]{64}$/)
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        if(!env.BUCKET)return new Response(null,{status:503,headers:noStore});
        const checked=await db.prepare(
          "SELECT av.object_key FROM gutenberg_source_cache c JOIN products p ON p.source_name='gutenberg' AND p.source_external_id=c.id JOIN digital_assets da ON da.edition_id=p.edition_id AND da.kind='epub' JOIN asset_versions av ON av.asset_id=da.id WHERE c.id=? AND av.id=? AND c.source_id='pg_us' AND c.copyright=0 AND c.rights_status='public-domain' AND c.commercial_use_status='approved' AND c.ingest_status='active' LIMIT 1"
        ).bind(input.cacheId,input.assetVersionId).first<{object_key:string|null}>();
        if(!checked)return new Response(null,{status:409,headers:noStore});
        const objectKey=checked.object_key||("epubs/"+input.cacheId+".epub");
        if(!/^epubs\/[a-zA-Z0-9_./-]{1,220}\.epub$/.test(objectKey)||
           objectKey.includes("..")||!objectKey.startsWith("epubs/"))
          return new Response(null,{status:409,headers:noStore});
        const object=await env.BUCKET.get(objectKey);
        if(!object||!Number.isSafeInteger(object.size)||object.size<100||
           object.size>25*1024*1024)return new Response(null,{status:409,headers:noStore});
        const bytes=new Uint8Array(await object.arrayBuffer());
        if(bytes.byteLength!==object.size)return new Response(null,{status:409,headers:noStore});
        await validateStoredEpub(bytes);
        const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
        const actual=Array.from(digest,x=>x.toString(16).padStart(2,"0")).join("");
        if(actual!==input.sha256)return new Response(null,{status:409,headers:noStore});
        const at=now();
        // A primary-D1 batch; both statements independently preserve source
        // rights and exact asset linkage after any intervening withdrawal.
        const result=await db.batch([
          db.prepare("UPDATE gutenberg_source_cache SET epub_status='completed',epub_cached_at=?,epub_last_error='',epub_next_attempt_at='',content_hash=?,canonicalization_version='pgus-upstream-v1' WHERE id=? AND source_id='pg_us' AND copyright=0 AND rights_status='public-domain' AND commercial_use_status='approved' AND ingest_status='active'")
            .bind(at,input.sha256,input.cacheId),
          db.prepare("UPDATE asset_versions SET object_key=?,sha256=? WHERE id=? AND EXISTS(SELECT 1 FROM digital_assets da JOIN products p ON p.edition_id=da.edition_id JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE da.id=asset_versions.asset_id AND da.kind='epub' AND p.source_name='gutenberg' AND c.id=? AND c.source_id='pg_us' AND c.copyright=0 AND c.rights_status='public-domain' AND c.commercial_use_status='approved' AND c.ingest_status='active')")
            .bind(objectKey,input.sha256,input.assetVersionId,input.cacheId)
        ]);
        const outcomes=result as Array<{meta?:{changes?:number}}>;
        if(outcomes.some(x=>Number(x.meta?.changes||0)!==1))
          return new Response(null,{status:409,headers:noStore});
        return Response.json({schema:"cove.owner-us-epub-cache.v1",ownerFirst:true,
          cacheId:input.cacheId,assetVersionId:input.assetVersionId,
          sha256:input.sha256,saved:true},{headers:noStore});
      }
      if(route==="/risk/private-create-hold"){
        const input=z.object({
          assessmentId:z.string().min(3).max(180),
          scope:z.enum(["checkout","account","publishing","usage_credit","payout","review_ranking"]),
          reasonCode:z.enum(["BUYER_RISK_REVIEW","BUYER_RISK_BLOCK","ACCOUNT_TAKEOVER_REVIEW",
            "PUBLISHER_RISK_REVIEW","PUBLISHER_RISK_BLOCK","SUSPICIOUS_USAGE",
            "PAYOUT_RISK_REVIEW","COMMUNITY_MANIPULATION_REVIEW"])
        }).strict().parse(raw);
        const db=env.PRIMARY_DB, at=now();
        const assessment=await db.prepare(
          "SELECT id,domain,subject_type,subject_id,action,created_at FROM risk_assessments WHERE id=?"
        ).bind(input.assessmentId).first<{
          id:string;domain:string;subject_type:string;subject_id:string;action:string;created_at:string
        }>();
        if(!assessment||!["hold","block"].includes(assessment.action))
          return new Response(null,{status:409,headers:noStore});
        const domainScope:Record<string,[string,string]>={
          checkout:["buyer","order"],account:["buyer","user"],
          publishing:["publisher","publishing_account"],usage_credit:["usage","usage_event"],
          payout:["payout","payout_item"],review_ranking:["community","review"]
        };
        const expected=domainScope[input.scope];
        const allowedReason:Record<string,string>={
          checkout:assessment.action==="block"?"BUYER_RISK_BLOCK":"BUYER_RISK_REVIEW",
          account:"ACCOUNT_TAKEOVER_REVIEW",
          publishing:assessment.action==="block"?"PUBLISHER_RISK_BLOCK":"PUBLISHER_RISK_REVIEW",
          usage_credit:"SUSPICIOUS_USAGE",payout:"PAYOUT_RISK_REVIEW",
          review_ranking:"COMMUNITY_MANIPULATION_REVIEW"
        };
        if(!expected||assessment.domain!==expected[0]||
           assessment.subject_type!==expected[1]||
           input.reasonCode!==allowedReason[input.scope])
          return new Response(null,{status:409,headers:noStore});
        // Never recreate a previously released hold from a stale assessment.
        const latest=await db.prepare(
          "SELECT id FROM risk_assessments WHERE domain=? AND subject_type=? AND subject_id=? ORDER BY created_at DESC,id DESC LIMIT 1"
        ).bind(assessment.domain,assessment.subject_type,assessment.subject_id).first<{id:string}>();
        if(latest?.id!==assessment.id)return new Response(null,{status:409,headers:noStore});
        let active=await db.prepare(
          "SELECT id FROM risk_holds WHERE subject_type=? AND subject_id=? AND hold_scope=? AND status='active' LIMIT 1"
        ).bind(assessment.subject_type,assessment.subject_id,input.scope).first<{id:string}>();
        if(!active){
          let amountMinor:number|null=null,currency:string|null=null;
          if(input.scope==="checkout"){
            const o=await db.prepare("SELECT total_minor,currency FROM commerce_orders WHERE id=?")
              .bind(assessment.subject_id).first<{total_minor:number;currency:string}>();
            if(!o)return new Response(null,{status:409,headers:noStore});
            amountMinor=Number(o.total_minor);currency=o.currency;
          }
          if(input.scope==="payout"){
            const p=await db.prepare("SELECT net_minor,currency FROM payout_items WHERE id=?")
              .bind(assessment.subject_id).first<{net_minor:number;currency:string}>();
            if(!p)return new Response(null,{status:409,headers:noStore});
            amountMinor=Number(p.net_minor);currency=p.currency;
          }
          const newId="risk_hold_"+crypto.randomUUID();
          await db.prepare(
            "INSERT INTO risk_holds(id,assessment_id,domain,subject_type,subject_id,hold_scope,reason_code,status,amount_minor,currency,release_conditions_json,created_by_type,created_at,expires_at) SELECT ?,a.id,a.domain,a.subject_type,a.subject_id,?,?,'active',?,?,?,'system',?,NULL FROM risk_assessments a WHERE a.id=? AND a.action IN ('hold','block') AND NOT EXISTS(SELECT 1 FROM risk_assessments newer WHERE newer.domain=a.domain AND newer.subject_type=a.subject_type AND newer.subject_id=a.subject_id AND (newer.created_at>a.created_at OR (newer.created_at=a.created_at AND newer.id>a.id))) AND NOT EXISTS(SELECT 1 FROM risk_holds h WHERE h.subject_type=a.subject_type AND h.subject_id=a.subject_id AND h.hold_scope=? AND h.status='active')"
          ).bind(newId,input.scope,input.reasonCode,amountMinor,currency,
            JSON.stringify({manualReview:true}),at,assessment.id,input.scope).run();
          active=await db.prepare(
            "SELECT id FROM risk_holds WHERE subject_type=? AND subject_id=? AND hold_scope=? AND status='active' LIMIT 1"
          ).bind(assessment.subject_type,assessment.subject_id,input.scope).first<{id:string}>();
        }
        if(!active)return new Response(null,{status:409,headers:noStore});
        return Response.json({schema:"cove.owner-risk-hold-qa.v1",
          ownerFirst:true,assessmentId:assessment.id,holdId:active.id,saved:true},{headers:noStore});
      }
      if(route==="/promotion/private-action"){
        const input=z.object({
          action:z.enum(["price-event","issue-coupon"]),
          payload:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        if(input.action==="price-event"){
          const x=z.object({campaignId:z.string().min(1).max(180),
            productId:z.string().min(1).max(180)}).strict().parse(input.payload);
          // No price, permission or event body is accepted from the shared caller.
          const row=await db.prepare(
            "SELECT c.id,c.starts_at,c.ends_at,pp.product_id,pr.amount_minor FROM promotion_campaigns c JOIN promotion_campaign_products pp ON pp.campaign_id=c.id JOIN promotions pr ON pr.campaign_id=c.id AND pr.id=('promo_campaign_'||c.id||'_'||pp.product_id) JOIN publishing_publications pub ON pub.product_id=pp.product_id AND pub.publishing_account_id=c.publishing_account_id WHERE c.id=? AND pp.product_id=? AND c.status IN ('approved','scheduled','live') AND pr.active=1 LIMIT 1"
          ).bind(x.campaignId,x.productId).first<{
            id:string;starts_at:string;ends_at:string;product_id:string;amount_minor:number
          }>();
          if(!row)return new Response(null,{status:409,headers:noStore});
          const payload=JSON.stringify({campaignId:row.id,productId:row.product_id,
            startsAt:row.starts_at,endsAt:row.ends_at,promotionalPriceMinor:row.amount_minor});
          const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",
            new TextEncoder().encode(JSON.stringify([row.id,row.product_id,payload]))));
          const eventId="out_"+Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
          const at=now();
          await db.prepare(
            "INSERT OR IGNORE INTO publishing_outbox(id,event_type,aggregate_type,aggregate_id,payload_json,status,attempts,available_at,created_at) VALUES(?,'promotion.price_changed','promotion_campaign',?,?,'pending',0,?,?)"
          ).bind(eventId,row.id,payload,at,at).run();
        }else{
          const x=z.object({
            userId:z.string().min(3).max(180),
            accountId:z.string().min(1).max(180),
            campaignId:z.string().min(1).max(180),
            code:z.string().min(3).max(80),
            kind:z.enum(["percent","amount"]),
            value:z.number().int().min(1).max(1_000_000_000),
            minimumSubtotalMinor:z.number().int().min(0).max(1_000_000_000),
            maxPerUser:z.number().int().min(1).max(100)
          }).strict().parse(input.payload);
          if(x.code!==x.code.trim().toUpperCase().replace(/\s+/g,"")||
             (x.kind==="percent"&&x.value>100))
            return new Response(null,{status:409,headers:noStore});
          // Ownership, campaign approval, and product scope must come from the
          // private primary—not the caller's already checked read.
          const member=await db.prepare(
            "SELECT role FROM publishing_account_members WHERE user_id=? AND account_id=? AND status='active'"
          ).bind(x.userId,x.accountId).first<{role:string}>();
          const campaign=await db.prepare(
            "SELECT currency,max_redemptions,starts_at,ends_at,funding_source,publisher_funding_bps,stackable FROM promotion_campaigns WHERE id=? AND publishing_account_id=? AND campaign_type='coupon' AND status IN ('scheduled','live')"
          ).bind(x.campaignId,x.accountId).first<{
            currency:string|null;max_redemptions:number|null;starts_at:string;ends_at:string;
            funding_source:string;publisher_funding_bps:number;stackable:number
          }>();
          if(!member||!campaign)return new Response(null,{status:403,headers:noStore});
          const products=(await db.prepare(
            "SELECT pp.product_id FROM promotion_campaign_products pp JOIN publishing_publications pub ON pub.product_id=pp.product_id AND pub.publishing_account_id=? WHERE pp.campaign_id=? ORDER BY pp.product_id"
          ).bind(x.accountId,x.campaignId).all<{product_id:string}>()).results.map(r=>r.product_id);
          const expected=await db.prepare(
            "SELECT COUNT(*) n FROM promotion_campaign_products WHERE campaign_id=?"
          ).bind(x.campaignId).first<{n:number}>();
          if(!products.length||products.length!==Number(expected?.n||0))
            return new Response(null,{status:409,headers:noStore});
          const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",
            new TextEncoder().encode(x.code)));
          const hash=Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
          const existing=await db.prepare(
            "SELECT campaign_id FROM commerce_promo_codes WHERE code_hash=?"
          ).bind(hash).first<{campaign_id:string|null}>();
          if(existing&&existing.campaign_id!==x.campaignId)
            return new Response(null,{status:409,headers:noStore});
          const at=now();
          const eventBytes=new Uint8Array(await crypto.subtle.digest("SHA-256",
            new TextEncoder().encode(JSON.stringify([x.campaignId,hash,x.kind,x.value,
              x.minimumSubtotalMinor,x.maxPerUser]))));
          const eventId="promoevt_"+Array.from(eventBytes,b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
          const results=await db.batch([
            db.prepare(
              "INSERT INTO commerce_promo_codes(code_hash,code_label,kind,value,currency,minimum_subtotal_minor,max_redemptions,max_per_user,redemptions,active,starts_at,ends_at,created_at,updated_at,campaign_id,funding_source,publisher_funding_bps,eligible_products_json,stackable) VALUES(?,?,?,?,?,?,?,?,0,1,?,?,?,?,?,?,?,?,?) ON CONFLICT(code_hash) DO UPDATE SET campaign_id=excluded.campaign_id,kind=excluded.kind,value=excluded.value,currency=excluded.currency,minimum_subtotal_minor=excluded.minimum_subtotal_minor,max_redemptions=excluded.max_redemptions,max_per_user=excluded.max_per_user,active=excluded.active,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at,funding_source=excluded.funding_source,publisher_funding_bps=excluded.publisher_funding_bps,eligible_products_json=excluded.eligible_products_json,stackable=excluded.stackable WHERE commerce_promo_codes.campaign_id=excluded.campaign_id"
            ).bind(hash,x.code,x.kind,x.value,campaign.currency||null,x.minimumSubtotalMinor,
              campaign.max_redemptions||null,x.maxPerUser,campaign.starts_at,campaign.ends_at,at,at,
              x.campaignId,campaign.funding_source,campaign.publisher_funding_bps,JSON.stringify(products),campaign.stackable),
            db.prepare(
              "INSERT OR IGNORE INTO promotion_campaign_events(id,campaign_id,event_type,actor_type,actor_id,event_json,created_at) SELECT ?,?,'coupon_issued','publisher',?,?,? WHERE EXISTS(SELECT 1 FROM commerce_promo_codes WHERE code_hash=? AND campaign_id=?)"
            ).bind(eventId,x.campaignId,x.userId,JSON.stringify({
              codeLabel:x.code,maxPerUser:x.maxPerUser}),at,hash,x.campaignId)
          ]);
          const receipt=results as Array<{meta?:{changes?:number}}>;
          if(Number(receipt[0]?.meta?.changes||0)!==1)
            return new Response(null,{status:409,headers:noStore});
        }
        return Response.json({schema:"cove.owner-promotion-private.v1",
          ownerFirst:true,action:input.action,saved:true},{headers:noStore});
      }
      if(route==="/catalog/private-ingest-state") {
        const input=z.object({
          action:z.enum(["recover-interrupted","mark-unavailable","claim-download",
            "touch-attempt","set-backoff","mark-failure","acquire-regional",
            "mark-degraded","mark-regional-failed"]),
          payload:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const p=input.payload;
        const source=z.enum(["pg_us","pg_ca","pg_au","pg_eu"]);
        const regional=z.enum(["pg_ca","pg_au","pg_eu"]);
        const cacheId=z.string().regex(/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/);
        const lease=z.string().uuid();
        let result:{saved?:boolean;claimed?:boolean}={saved:false};
        switch(input.action){
          case "recover-interrupted":{
            z.object({}).strict().parse(p);
            const at=now(),stale=new Date(Date.now()-15*60_000).toISOString();
            await db.prepare("UPDATE gutenberg_source_cache SET epub_status='retry',epub_next_attempt_at='',epub_last_error='Recovered after an interrupted EPUB download.',updated_at=? WHERE epub_status='downloading' AND updated_at<? AND ingest_status<>'quarantined'")
              .bind(at,stale).run();
            result={saved:true};break;
          }
          case "mark-unavailable":{
            const x=z.object({cacheId}).strict().parse(p);
            const row=await db.prepare("SELECT source_id FROM gutenberg_source_cache WHERE id=? AND ingest_status<>'quarantined'")
              .bind(x.cacheId).first<{source_id:string}>();
            if(!row)return new Response(null,{status:409,headers:noStore});
            await db.prepare("UPDATE gutenberg_source_cache SET epub_status='unavailable',epub_last_error='No supported source asset was provided.' WHERE id=? AND ingest_status<>'quarantined'")
              .bind(x.cacheId).run();
            result={saved:true};break;
          }
          case "claim-download":{
            const x=z.object({cacheId}).strict().parse(p),at=now();
            const claimed=await db.prepare("UPDATE gutenberg_source_cache SET epub_status='downloading',epub_last_error='',updated_at=? WHERE id=? AND epub_status IN ('pending','retry') AND (epub_next_attempt_at='' OR epub_next_attempt_at<=?) AND ingest_status<>'quarantined' AND EXISTS(SELECT 1 FROM gutenberg_sources s WHERE s.id=gutenberg_source_cache.source_id AND s.enabled=1) RETURNING id")
              .bind(at,x.cacheId,at).first<{id:string}>();
            result={claimed:!!claimed};break;
          }
          case "touch-attempt":{
            const x=z.object({sourceId:source}).strict().parse(p);
            await db.prepare("UPDATE gutenberg_source_states SET epub_last_attempt_at=? WHERE source_id=? AND EXISTS(SELECT 1 FROM gutenberg_sources s WHERE s.id=gutenberg_source_states.source_id AND s.enabled=1)")
              .bind(now(),x.sourceId).run();
            result={saved:true};break;
          }
          case "set-backoff":{
            const x=z.object({sourceId:source,retryAt:z.string().datetime()}).strict().parse(p);
            const t=Date.parse(x.retryAt),minimum=Date.now()+59_000,maximum=Date.now()+24*3600_000+10_000;
            if(!Number.isFinite(t)||t<minimum||t>maximum)return new Response(null,{status:409,headers:noStore});
            await db.prepare("UPDATE gutenberg_source_states SET epub_retry_after=? WHERE source_id=?")
              .bind(x.retryAt,x.sourceId).run();result={saved:true};break;
          }
          case "mark-failure":{
            const x=z.object({cacheId,attempts:z.number().int().min(1).max(100),
              status:z.enum(["retry","failed"]),retryAt:z.string().max(40),
              message:z.string().max(500)}).strict().parse(p);
            const row=await db.prepare("SELECT epub_attempts FROM gutenberg_source_cache WHERE id=? AND epub_status='downloading' AND ingest_status<>'quarantined'")
              .bind(x.cacheId).first<{epub_attempts:number}>();
            if(!row||Number(row.epub_attempts)+1!==x.attempts)
              return new Response(null,{status:409,headers:noStore});
            if(x.status==="retry"&&(!Number.isFinite(Date.parse(x.retryAt))||Date.parse(x.retryAt)>Date.now()+24*3600_000))
              return new Response(null,{status:409,headers:noStore});
            await db.prepare("UPDATE gutenberg_source_cache SET epub_status=?,epub_attempts=?,epub_next_attempt_at=?,epub_last_error=? WHERE id=? AND epub_status='downloading' AND ingest_status<>'quarantined'")
              .bind(x.status,x.attempts,x.retryAt,x.message,x.cacheId).run();
            result={saved:true};break;
          }
          case "acquire-regional":{
            const x=z.object({sourceId:regional,leaseToken:lease}).strict().parse(p);
            const at=now(),until=new Date(Date.now()+5*60_000).toISOString();
            const eligible=await db.prepare("SELECT id FROM gutenberg_sources WHERE id=? AND enabled=1")
              .bind(x.sourceId).first<{id:string}>();
            if(!eligible)return new Response(null,{status:409,headers:noStore});
            const claimed=await db.prepare("UPDATE gutenberg_source_states SET status='running',lease_token=?,lease_until=?,last_run_at=?,last_error='',updated_at=? WHERE source_id=? AND (lease_until IS NULL OR lease_until='' OR lease_until<?) AND (next_run_at IS NULL OR next_run_at='' OR next_run_at<=?) RETURNING source_id")
              .bind(x.leaseToken,until,at,at,x.sourceId,at,at).first<{source_id:string}>();
            result={claimed:!!claimed};break;
          }
          case "mark-degraded":{
            const x=z.object({sourceId:regional,leaseToken:lease,message:z.string().max(1000)}).strict().parse(p);
            const at=now(),next=new Date(Date.now()+6*3600_000).toISOString();
            const outcome=await db.prepare("UPDATE gutenberg_source_states SET status='degraded',last_error=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=? AND lease_token=? AND status='running'")
              .bind(x.message,next,at,x.sourceId,x.leaseToken).run();
            result={saved:Number((outcome as {meta?:{changes?:number}})?.meta?.changes||0)>0};break;
          }
          case "mark-regional-failed":{
            const x=z.object({sourceId:regional,leaseToken:lease,
              attempts:z.number().int().min(1).max(100),retryAt:z.string().datetime(),message:z.string().max(1000)}).strict().parse(p);
            const row=await db.prepare("SELECT attempts FROM gutenberg_source_states WHERE source_id=? AND lease_token=? AND status='running'")
              .bind(x.sourceId,x.leaseToken).first<{attempts:number}>();
            if(!row||Number(row.attempts)+1!==x.attempts||Date.parse(x.retryAt)>Date.now()+24*3600_000)
              return new Response(null,{status:409,headers:noStore});
            await db.prepare("UPDATE gutenberg_source_states SET status='failed',last_error=?,attempts=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=? AND lease_token=? AND status='running'")
              .bind(x.message,x.attempts,x.retryAt,now(),x.sourceId,x.leaseToken).run();
            result={saved:true};break;
          }
        }
        return Response.json({schema:"cove.owner-ingestion-state-qa.v1",ownerFirst:true,
          action:input.action,result},{headers:noStore});
      }
      if(route==="/delivery/register-entitlement-device"){
        const x=z.object({
          userId:z.string().min(3).max(180),
          entitlementId:z.string().min(3).max(180),
          productId:z.string().min(3).max(180),
          deviceId:z.string().min(3).max(180),
          maxActiveDevices:z.number().int().min(1).max(100)
        }).strict().parse(raw);
        const db=env.PRIMARY_DB,at=now();
        const [ent,device,policy]=await Promise.all([
          db.prepare("SELECT id FROM entitlements WHERE id=? AND user_id=? AND product_id=? AND status='active' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)")
            .bind(x.entitlementId,x.userId,x.productId,at,at).first<{id:string}>(),
          db.prepare("SELECT id FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL")
            .bind(x.deviceId,x.userId).first<{id:string}>(),
          db.prepare("SELECT max_active_devices FROM commercial_delivery_policies WHERE product_id=?")
            .bind(x.productId).first<{max_active_devices:number}>()
        ]);
        if(!ent||!device)return new Response(null,{status:409,headers:noStore});
        const dbMax=Math.max(1,Math.min(100,Number(policy?.max_active_devices||6))),
          max=Math.min(dbMax,x.maxActiveDevices);
        const current=await db.prepare(
          "SELECT 1 ok FROM commercial_entitlement_devices WHERE entitlement_id=? AND device_id=?"
        ).bind(x.entitlementId,x.deviceId).first<{ok:number}>();
        let changed=0;
        if(current){
          const done=await db.prepare(
            "UPDATE commercial_entitlement_devices SET last_used_at=? WHERE entitlement_id=? AND device_id=? AND EXISTS(SELECT 1 FROM entitlements e WHERE e.id=? AND e.user_id=? AND e.product_id=? AND e.status='active' AND (e.starts_at IS NULL OR e.starts_at<=?) AND (e.ends_at IS NULL OR e.ends_at>?))"
          ).bind(at,x.entitlementId,x.deviceId,x.entitlementId,x.userId,x.productId,at,at).run();
          changed=Number((done as {meta?:{changes?:number}})?.meta?.changes||0);
        }else{
          const used=await db.prepare(
            "SELECT COUNT(*) c FROM commercial_entitlement_devices ced JOIN devices d ON d.id=ced.device_id WHERE ced.entitlement_id=? AND d.user_id=? AND d.revoked_at IS NULL"
          ).bind(x.entitlementId,x.userId).first<{c:number}>();
          if(Number(used?.c||0)>=max)return new Response(null,{status:409,headers:noStore});
          const done=await db.prepare(
            "INSERT INTO commercial_entitlement_devices(entitlement_id,product_id,device_id,activated_at,last_used_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM entitlements e WHERE e.id=? AND e.user_id=? AND e.product_id=? AND e.status='active' AND (e.starts_at IS NULL OR e.starts_at<=?) AND (e.ends_at IS NULL OR e.ends_at>?)) AND EXISTS(SELECT 1 FROM devices d WHERE d.id=? AND d.user_id=? AND d.revoked_at IS NULL) AND (SELECT COUNT(*) FROM commercial_entitlement_devices ced JOIN devices d ON d.id=ced.device_id WHERE ced.entitlement_id=? AND d.user_id=? AND d.revoked_at IS NULL)<?"
          ).bind(x.entitlementId,x.productId,x.deviceId,at,at,x.entitlementId,x.userId,x.productId,at,at,x.deviceId,x.userId,x.entitlementId,x.userId,max).run();
          changed=Number((done as {meta?:{changes?:number}})?.meta?.changes||0);
        }
        if(changed!==1)return new Response(null,{status:409,headers:noStore});
        return Response.json({schema:"cove.owner-entitlement-device.v1",ownerFirst:true,
          entitlementId:x.entitlementId,deviceId:x.deviceId,saved:true},{headers:noStore});
      }
      if(route==="/delivery/private-negative") {
        const request=z.object({
          action:z.enum(["revoke-grant","withdraw-version","restrict-policy","expire-grant","exhaust-grant"]),
          payload:z.record(z.string(),z.unknown())
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const payload=request.payload;
        let result:unknown;
        if(request.action==="revoke-grant"){
          const x=z.object({userId:z.string().min(3).max(180),
            grantId:z.string().min(3).max(180)}).strict().parse(payload);
          const grant=await db.prepare(
            "SELECT id,user_id,status FROM commercial_delivery_grants WHERE id=? AND user_id=?"
          ).bind(x.grantId,x.userId).first<{id:string;user_id:string;status:string}>();
          if(!grant)return new Response(null,{status:404,headers:noStore});
          if(grant.status==="active")await db.prepare(
            "UPDATE commercial_delivery_grants SET status='revoked',revoked_at=?,revocation_reason='customer_revoked' WHERE id=? AND user_id=? AND status='active'"
          ).bind(now(),x.grantId,x.userId).run();
          result={revoked:true};
        }else if(request.action==="expire-grant"||request.action==="exhaust-grant"){
          const x=z.object({grantId:z.string().min(3).max(180)}).strict().parse(payload);
          // A token cannot request expiration/exhaustion: the private owner
          // independently compares its own current clock and usage counter.
          const current=await db.prepare(
            "SELECT status,expires_at,uses,max_uses FROM commercial_delivery_grants WHERE id=?"
          ).bind(x.grantId).first<{status:string;expires_at:string;uses:number;max_uses:number}>();
          if(!current)return new Response(null,{status:404,headers:noStore});
          const target=request.action==="expire-grant"?"expired":"exhausted";
          if(current.status!==target){
            if(current.status!=="active"||
               (target==="expired"&&Date.parse(current.expires_at)>Date.now())||
               (target==="exhausted"&&Number(current.uses)<Number(current.max_uses)))
              return new Response(null,{status:409,headers:noStore});
            const at=now();
            const statement=target==="expired"
              ?db.prepare("UPDATE commercial_delivery_grants SET status='expired' WHERE id=? AND status='active' AND expires_at<=?")
                .bind(x.grantId,at)
              :db.prepare("UPDATE commercial_delivery_grants SET status='exhausted' WHERE id=? AND status='active' AND uses>=max_uses")
                .bind(x.grantId);
            const outcome=await statement.run();
            if(Number((outcome as {meta?:{changes?:number}})?.meta?.changes||0)!==1)
              return new Response(null,{status:409,headers:noStore});
          }
          result={saved:true};
        }else{
          const actor=z.object({actorUserId:z.string().min(3).max(180)});
          const actorId=actor.parse(payload).actorUserId;
          const staff=await db.prepare(
            "SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'"
          ).bind(actorId).first<{user_id:string}>();
          if(!staff)return new Response(null,{status:403,headers:noStore});
          const perms=(await db.prepare(
            "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
          ).bind(actorId).all<{permission:string}>()).results.map(p=>p.permission);
          if(!perms.includes("commerce.manage")&&!perms.includes("staff.manage"))
            return new Response(null,{status:403,headers:noStore});
          const at=now();
          if(request.action==="withdraw-version"){
            const x=z.object({actorUserId:z.string().min(3).max(180),
              distribution:z.object({publicationVersionId:z.string().min(3).max(180),
                status:z.enum(["blocked","recalled"]),allowExistingOwners:z.literal(false),
                reasonCode:z.string().min(1).max(120),reasonDetail:z.string().max(2000)}).strict()
            }).strict().parse(payload);
            const d=x.distribution;
            const pv=await db.prepare("SELECT id FROM publishing_publication_versions WHERE id=?")
              .bind(d.publicationVersionId).first<{id:string}>();
            if(!pv)return new Response(null,{status:404,headers:noStore});
            const previous=await db.prepare(
              "SELECT distribution_status FROM publication_version_distribution_controls WHERE publication_version_id=?"
            ).bind(d.publicationVersionId).first<{distribution_status:string}>();
            if(previous?.distribution_status==="recalled"&&d.status!=="recalled")
              return new Response(null,{status:409,headers:noStore});
            const eventBytes=new Uint8Array(await crypto.subtle.digest("SHA-256",
              new TextEncoder().encode(JSON.stringify([actorId,d.publicationVersionId,d.status,d.reasonCode,d.reasonDetail]))));
            const eventId="dist_"+Array.from(eventBytes,b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
            await db.batch([
              db.prepare("INSERT INTO publication_version_distribution_controls(publication_version_id,distribution_status,allow_existing_owners,reason_code,reason_detail,effective_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(publication_version_id) DO UPDATE SET distribution_status=excluded.distribution_status,allow_existing_owners=excluded.allow_existing_owners,reason_code=excluded.reason_code,reason_detail=excluded.reason_detail,effective_at=excluded.effective_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
                .bind(d.publicationVersionId,d.status,0,d.reasonCode,d.reasonDetail,at,actorId,at),
              db.prepare("INSERT OR IGNORE INTO publication_version_distribution_events(id,publication_version_id,from_status,to_status,allow_existing_owners,reason_code,reason_detail,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
                .bind(eventId,d.publicationVersionId,previous?.distribution_status||null,d.status,0,d.reasonCode,d.reasonDetail,actorId,at),
              db.prepare("UPDATE commercial_delivery_grants SET status='revoked',revoked_at=?,revocation_reason=? WHERE publication_version_id=? AND status='active'")
                .bind(at,`distribution_${d.status}`,d.publicationVersionId)
            ]);
            result={saved:true};
          }else{
            const x=z.object({actorUserId:z.string().min(3).max(180),
              policy:z.object({productId:z.string().min(3).max(180),
                requireDeviceRegistration:z.boolean(),maxActiveDevices:z.number().int().min(1).max(100),
                maxDownloadsPerEntitlement:z.number().int().min(1).max(100000),
                tokenTtlSeconds:z.number().int().min(30).max(3600),
                tokenMaxUses:z.number().int().min(1).max(20),
                watermarkMode:z.enum(["none","license_marker"]),
                encryptionMode:z.enum(["none","external_wrapped_key"]),
                allowBrowserRead:z.boolean(),allowFileDownload:z.boolean()}).strict()
            }).strict().parse(payload);
            const p=x.policy;
            const exists=await db.prepare("SELECT id FROM products WHERE id=?")
              .bind(p.productId).first<{id:string}>();
            if(!exists)return new Response(null,{status:404,headers:noStore});
            const old=await db.prepare("SELECT * FROM commercial_delivery_policies WHERE product_id=?")
              .bind(p.productId).first<Record<string,unknown>>();
            // Positive relaxation and turning on public delivery need a fresh,
            // independently established paid-rights grant. Never derive it
            // from the staff request or an older policy snapshot.
            if(p.allowBrowserRead||p.allowFileDownload||!p.requireDeviceRegistration||
              p.maxActiveDevices>Number(old?.max_active_devices??6)||
              p.maxDownloadsPerEntitlement>Number(old?.max_downloads_per_entitlement??50)||
              p.tokenTtlSeconds>Number(old?.token_ttl_seconds??300)||
              p.tokenMaxUses>Number(old?.token_max_uses??2)||
              (old?.watermark_mode==="license_marker"&&p.watermarkMode!=="license_marker")||
              (old?.encryption_mode==="external_wrapped_key"&&p.encryptionMode!=="external_wrapped_key"))
              return new Response(null,{status:409,headers:noStore});
            await db.prepare("INSERT INTO commercial_delivery_policies(product_id,require_device_registration,max_active_devices,max_downloads_per_entitlement,token_ttl_seconds,token_max_uses,watermark_mode,encryption_mode,allow_browser_read,allow_file_download,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET require_device_registration=excluded.require_device_registration,max_active_devices=excluded.max_active_devices,max_downloads_per_entitlement=excluded.max_downloads_per_entitlement,token_ttl_seconds=excluded.token_ttl_seconds,token_max_uses=excluded.token_max_uses,watermark_mode=excluded.watermark_mode,encryption_mode=excluded.encryption_mode,allow_browser_read=excluded.allow_browser_read,allow_file_download=excluded.allow_file_download,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
              .bind(p.productId,1,p.maxActiveDevices,p.maxDownloadsPerEntitlement,p.tokenTtlSeconds,p.tokenMaxUses,p.watermarkMode,p.encryptionMode,0,0,actorId,at,at).run();
            result={saved:true,productId:p.productId,policy:p};
          }
        }
        return Response.json({schema:"cove.owner-negative-delivery-qa.v1",ownerFirst:true,
          action:request.action,result},{headers:noStore});
      }
      if(route==="/catalog/withdraw-stale") {
        const x=z.object({
          sourceId:z.enum(["pg_ca","pg_au","pg_eu"]),
          cycleStartedAt:z.string().datetime(),
          leaseToken:z.string().uuid(),
          runId:z.string().regex(/^gir_[0-9a-f-]{36}$/)
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const [lease,run]=await Promise.all([
          db.prepare("SELECT source_id,lease_token,lease_until,status FROM gutenberg_source_states WHERE source_id=? AND status='running' AND lease_token=? AND lease_until>?")
            .bind(x.sourceId,x.leaseToken,now()).first<{source_id:string;lease_token:string;lease_until:string;status:string}>(),
          db.prepare("SELECT source_id,status,started_at FROM gutenberg_ingest_runs WHERE id=? AND source_id=? AND status='running'")
            .bind(x.runId,x.sourceId).first<{source_id:string;status:string;started_at:string}>()
        ]);
        if(!lease||!run||x.cycleStartedAt>now()||x.cycleStartedAt>String(run.started_at))
          return new Response(null,{status:409,headers:noStore});
        // Independently count before mutating; the owner derives which catalog
        // rows must be denied, never trusts caller-provided product IDs.
        const candidate=await db.prepare(
          "SELECT COUNT(*) n FROM gutenberg_source_cache WHERE source_id=? AND last_seen_at<? AND ingest_status NOT IN ('stale','quarantined')"
        ).bind(x.sourceId,x.cycleStartedAt).first<{n:number}>();
        const staleCount=Number(candidate?.n||0);
        if(staleCount){
          // Batch is a single primary D1 transaction. Every effect is
          // subtractive, including source-derived grant suspension.
          await db.batch([
            db.prepare("UPDATE gutenberg_source_cache SET ingest_status='stale',rights_status='quarantined',commercial_use_status='quarantined',epub_status='pending',epub_next_attempt_at='',last_error='Source item was absent from the latest complete catalog snapshot.',updated_at=? WHERE source_id=? AND last_seen_at<? AND ingest_status NOT IN ('stale','quarantined')")
              .bind(now(),x.sourceId,x.cycleStartedAt),
            db.prepare("UPDATE products SET storefront_status='inactive',updated_at=? WHERE source_name='gutenberg' AND source_external_id IN (SELECT id FROM gutenberg_source_cache WHERE source_id=? AND ingest_status='stale')")
              .bind(now(),x.sourceId),
            db.prepare("UPDATE offers SET active=0,updated_at=? WHERE product_id IN (SELECT p.id FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE p.source_name='gutenberg' AND c.source_id=? AND c.ingest_status='stale')")
              .bind(now(),x.sourceId),
            db.prepare("UPDATE editions SET release_status='unavailable',updated_at=? WHERE id IN (SELECT p.edition_id FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE p.source_name='gutenberg' AND c.source_id=? AND c.ingest_status='stale')")
              .bind(now(),x.sourceId),
            db.prepare("UPDATE rights_grants SET status='suspended',updated_at=? WHERE source=? AND edition_id IN (SELECT p.edition_id FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE p.source_name='gutenberg' AND c.source_id=? AND c.ingest_status='stale')")
              .bind(now(),`gutenberg-${x.sourceId}-public-domain`,x.sourceId)
          ]);
        }
        return Response.json({schema:"cove.owner-catalog-stale-denial.v1",ownerFirst:true,
          sourceId:x.sourceId,runId:x.runId,denied:true,staleCount},{headers:noStore});
      }
      if(route==="/catalog/negative-source") {
        const x=z.object({
          action:z.enum(["quarantine-regional","mark-us-retry"]),
          cacheId:z.string().regex(/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/),
          reason:z.string().max(500)
        }).strict().parse(raw);
        const db=env.PRIMARY_DB;
        const row=await db.prepare("SELECT source_id FROM gutenberg_source_cache WHERE id=?")
          .bind(x.cacheId).first<{source_id:string}>();
        if(!row|| (x.action==="quarantine-regional"
          ? !["pg_ca","pg_au","pg_eu"].includes(row.source_id)
          : row.source_id!=="pg_us"||!/^[0-9]{1,10}$/.test(x.cacheId)))
          return new Response(null,{status:409,headers:noStore});
        const result=x.action==="quarantine-regional"
          ?await db.prepare("UPDATE gutenberg_source_cache SET rights_status='quarantined',commercial_use_status='quarantined',ingest_status='quarantined',epub_status='failed',epub_last_error=?,last_error=?,updated_at=? WHERE id=? AND source_id IN ('pg_ca','pg_au','pg_eu')")
            .bind(x.reason,x.reason,now(),x.cacheId).run()
          :await db.prepare("UPDATE gutenberg_source_cache SET epub_status='retry',epub_next_attempt_at='',epub_last_error='Stored EPUB failed validation; repair required.' WHERE id=? AND source_id='pg_us' AND ingest_status<>'quarantined'")
            .bind(x.cacheId).run();
        return Response.json({schema:"cove.owner-catalog-negative-source.v1",ownerFirst:true,
          cacheId:x.cacheId,action:x.action,denied:true,
          changed:Number((result as {meta?:{changes?:number}})?.meta?.changes||0)>0},{headers:noStore});
      }
      if(route==="/moderation/private-action") {
        const actionSchema=z.object({
          caseId:z.string().min(1).max(160),
          actionType:z.enum(["no_action","hide_review","show_review","warn_publisher",
            "restrict_publisher","suspend_publisher","suppress_title","restore_title",
            "takedown_title","retire_title","reject_submission","approve_submission",
            "escalate","copyright_takedown","copyright_restore","impersonation_remove"]),
          reasonCode:z.string().max(120).default(""),
          rationale:z.string().max(8000).default("")
        }).strict();
        const input=z.object({
          staffUserId:z.string().regex(/^[A-Za-z0-9_-]{3,160}$/),
          operationId:z.string().regex(/^moderation:[a-f0-9]{64}$/),
          action:actionSchema
        }).strict().parse(raw);
        const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",
          new TextEncoder().encode(JSON.stringify({staffUserId:input.staffUserId,action:input.action}))));
        const expected="moderation:"+Array.from(digest,x=>x.toString(16).padStart(2,"0")).join("");
        if(expected!==input.operationId)return new Response(null,{status:409,headers:noStore});
        // Positive restoration cannot be inferred from a previous moderation event:
        // it requires a separately verified fresh contract/territory/legal proof.
        if(["restore_title","copyright_restore","approve_submission"].includes(input.action.actionType))
          return new Response(null,{status:409,headers:noStore});
        if(this.moderationExecution)return new Response(null,{status:409,headers:noStore});
        this.moderationExecution=true;
        try {
          const staff=await env.PRIMARY_DB.prepare(
            "SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'"
          ).bind(input.staffUserId).first<{user_id:string}>();
          if(!staff)return new Response(null,{status:403,headers:noStore});
          const rows=(await env.PRIMARY_DB.prepare(
            "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
          ).bind(input.staffUserId).all<{permission:string}>()).results;
          const permissions=new Set(rows.map(x=>String(x.permission)));
          const context:StaffContext={userId:input.staffUserId,email:"",displayName:"",
            permissions,roles:[],mfaRequired:false};
          const result=await privateModeration.executeModerationAction(
            env.PRIMARY_DB as ModerationDB,context,input.action,input.operationId);
          return Response.json({schema:"cove.owner-moderation-qa.v1",ownerFirst:true,
            operationId:input.operationId,staffUserId:input.staffUserId,
            caseId:input.action.caseId,actionType:input.action.actionType,result},
            {headers:noStore});
        } finally {this.moderationExecution=false;}
      }
      if(route==="/support/private-action") {
        const input=z.object({
          staffUserId:z.string().regex(/^[A-Za-z0-9_-]{3,160}$/),
          operationId:z.string().regex(/^support:[a-f0-9]{64}$/),
          action:z.object({
            caseId:z.string().min(1),actionType:z.enum([
              "resend_receipt","refund","restore_entitlement","revoke_entitlement",
              "reset_publication","requeue_download","revoke_device","security_recovery","note_only"
            ]),
            targetId:z.string().min(1),reasonCode:z.string().min(2).max(120),
            rationale:z.string().trim().min(10).max(5000),
            idempotencyKey:z.string().min(16).max(200),
            amountMinor:z.number().int().positive().optional()
          }).strict()
        }).strict().parse(raw);
        if(input.operationId!=="support:"+(await sha256(input.action.idempotencyKey)))
          return new Response(null,{status:400,headers:noStore});
        const staff=await env.PRIMARY_DB.prepare(
          "SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'"
        ).bind(input.staffUserId).first<{user_id:string}>();
        const perms=(await env.PRIMARY_DB.prepare(
          "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
        ).bind(input.staffUserId).all<{permission:string}>()).results.map(r=>r.permission);
        if(!staff||!perms.length)return new Response(null,{status:403,headers:noStore});
        const expected={
          refund:"support.refund",restore_entitlement:"support.entitlement.manage",
          revoke_entitlement:"support.entitlement.manage",reset_publication:"support.publication.manage",
          requeue_download:"support.device.manage",revoke_device:"support.device.manage",
          security_recovery:"account.recovery.manage",resend_receipt:"support.receipt.resend",
          note_only:"support.case.manage"
        }[input.action.actionType];
        if(!expected||!perms.includes(expected))return new Response(null,{status:403,headers:noStore});
        const previous=await env.PRIMARY_DB.prepare(
          "SELECT * FROM support_actions WHERE idempotency_key=?"
        ).bind(input.action.idempotencyKey).first<{staff_user_id:string;case_id:string;action_type:string;target_id:string}>();
        if(previous&&(
          previous.staff_user_id!==input.staffUserId||
          previous.case_id!==input.action.caseId||
          previous.action_type!==input.action.actionType||
          previous.target_id!==input.action.targetId
        ))return new Response(null,{status:409,headers:noStore});
        const result=previous||await executeSupportActionOwned(
          {DB:env.PRIMARY_DB,COVE_SSR_STAGING:"1"} as unknown as CoveEnv,
          {userId:input.staffUserId} as StaffContext,
          p=>perms.includes(p),input.action,sql,
          fn=>(this.ctx.storage as typeof this.ctx.storage & {
            transactionSync<T>(fn:()=>T):T
          }).transactionSync(fn)
        );
        return Response.json({
          schema:"cove.owner-support-action.v1",ownerFirst:true,
          operationId:input.operationId,actionType:input.action.actionType,
          staffUserId:input.staffUserId,caseId:input.action.caseId,
          result
        },{headers:noStore});
      }
      if(route==="/publishing/onboarding/review") {
        const input=z.object({
          reviewerUserId:z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/),
          accountId:z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/),
          recordId:z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/),
          kind:z.enum(["identity","tax","payout"]),
          status:z.enum(["verified","failed","expired","manual_review","restricted"]),
          reasonCode:z.string().max(120),
          withholdingBps:z.number().int().min(0).max(10000).optional(),
          requirementsDue:z.array(z.string().max(240)).max(100).optional(),
          operationId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/)
        }).strict().parse(raw);
        // The service-binding secret is not a staff grant. The owner repeats
        // the staff principal + permission check in its own QA database.
        const principal=await env.PRIMARY_DB.prepare(
          "SELECT user_id FROM staff_principals WHERE user_id=? AND status='active'"
        ).bind(input.reviewerUserId).first<{user_id:string}>();
        const roles=(await env.PRIMARY_DB.prepare(
          "SELECT p.permission FROM staff_principal_roles pr JOIN staff_role_permissions p ON p.role_id=pr.role_id WHERE pr.user_id=?"
        ).bind(input.reviewerUserId).all<{permission:string}>()).results;
        if(!principal||!roles.some(r=>["publishing.review","staff.manage"].includes(r.permission)))
          return new Response(null,{status:403,headers:noStore});
        // These three positive statuses confer publisher identity, tax and
        // payout authority. No evidence provider is bound yet: deny them.
        if(input.status==="verified"||input.withholdingBps!==undefined||
           (input.kind!=="payout"&&input.status==="restricted"))
          return new Response(null,{status:409,headers:noStore});
        const tables={identity:"publishing_identity_verifications",
          tax:"publishing_tax_profiles",payout:"publishing_payout_accounts"} as const;
        // This identifier is from an internal constant, never dynamic SQL
        // sourced from a request; both IDs must match the existing record.
        const record=await env.PRIMARY_DB.prepare(
          "SELECT id,account_id,status FROM "+tables[input.kind]+" WHERE id=? AND account_id=?"
        ).bind(input.recordId,input.accountId).first<{id:string;account_id:string;status:string}>();
        const account=await env.PRIMARY_DB.prepare(
          "SELECT id,identity_status,tax_status,payout_status FROM publishing_accounts WHERE id=?"
        ).bind(input.accountId).first<Record<string,string>>();
        if(!record||!account)return new Response(null,{status:409,headers:noStore});
        const status=input.kind==="payout"&&
          ["expired","manual_review"].includes(input.status)?"restricted":input.status;
        const applied=record.status!==status||account[input.kind+"_status"]!==status;
        if(applied){
          const at=new Date().toISOString();
          const statements=input.kind==="identity"?[
            env.PRIMARY_DB.prepare(
              "UPDATE publishing_identity_verifications SET status=?,reason_code=?,decided_at=? WHERE id=? AND account_id=?"
            ).bind(status,input.reasonCode,at,input.recordId,input.accountId),
            env.PRIMARY_DB.prepare("UPDATE publishing_accounts SET identity_status=?,updated_at=? WHERE id=?")
              .bind(status,at,input.accountId)
          ]:input.kind==="tax"?[
            env.PRIMARY_DB.prepare(
              "UPDATE publishing_tax_profiles SET status=?,reason_code=?,withholding_bps=COALESCE(?,withholding_bps),validated_at=CASE WHEN ?='verified' THEN ? ELSE validated_at END,updated_at=? WHERE id=? AND account_id=?"
            ).bind(status,input.reasonCode,null,status,at,at,input.recordId,input.accountId),
            env.PRIMARY_DB.prepare("UPDATE publishing_accounts SET tax_status=?,updated_at=? WHERE id=?")
              .bind(status,at,input.accountId)
          ]:[
            env.PRIMARY_DB.prepare(
              "UPDATE publishing_payout_accounts SET status=?,requirements_due_json=?,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END,updated_at=? WHERE id=? AND account_id=?"
            ).bind(status,JSON.stringify(input.requirementsDue||[]),status,at,at,input.recordId,input.accountId),
            env.PRIMARY_DB.prepare("UPDATE publishing_accounts SET payout_status=?,updated_at=? WHERE id=?")
              .bind(status,at,input.accountId)
          ];
          statements.push(env.PRIMARY_DB.prepare(
            "INSERT INTO publishing_audit_events(id,account_id,actor_user_id,entity_type,entity_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)"
          ).bind("pubaudit_"+crypto.randomUUID(),input.accountId,input.reviewerUserId,
            input.kind+"_verification",input.recordId,"reviewed",
            JSON.stringify({status:input.status,reasonCode:input.reasonCode,operationId:input.operationId}),at));
          await env.PRIMARY_DB.batch(statements);
        }
        return Response.json({schema:"cove.owner-publishing-onboarding-negative.v1",
          ownerFirst:true,operationId:input.operationId,accountId:input.accountId,
          recordId:input.recordId,kind:input.kind,status:input.status,
          applied,saved:true},{headers:noStore});
      }
      if(route==="/publishing/contract/save-version") {
        const storage=this.ctx.storage as typeof this.ctx.storage & {transactionSync<T>(fn:()=>T):T};
        const receipt=await executeOwnerContractVersion({primary:env.PRIMARY_DB,sql,
          executing:this.contractExecutions,transactionSync:fn=>storage.transactionSync(fn),
          saveVersion:writeContractVersionPrimary},raw);
        return Response.json(receipt,{headers:noStore});
      }
      if(route==="/publication/materialize-submission") {
        const storage=this.ctx.storage as typeof this.ctx.storage & {transactionSync<T>(fn:()=>T):T};
        return await executePublicationMaterialization({primary:env.PRIMARY_DB,bucket:env.BUCKET,sql,
          autoApprove:env.FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK,
          executing:this.publicationExecutions,transactionSync:fn=>storage.transactionSync(fn),
          materialize:materializePublishingSubmissionOwned,
          publish:(path,body)=>this.fetch(new Request("https://legal-authority.internal"+path,{
            method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},body:JSON.stringify(body)
          }))},raw);
      }
      if(route==="/publication/open-preorder") {
        const storage=this.ctx.storage as typeof this.ctx.storage & {transactionSync<T>(fn:()=>T):T};
        return await executePublicationPreorder({primary:env.PRIMARY_DB,sql,
          executing:this.publicationExecutions,transactionSync:fn=>storage.transactionSync(fn),
          openPreorder:openPublicationPreorderOwned,
          publish:(path,input)=>this.fetch(new Request("https://legal-authority.internal"+path,{
            method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},body:JSON.stringify(input)
          }))},raw);
      }
      if(route==="/publication/activate-version") {
        const input=raw as {operationId?:unknown;publicationVersionId?:unknown;
          actorUserId?:unknown;triggerType?:unknown;territory?:unknown;currency?:unknown}|null;
        if(!input||typeof input.operationId!=="string"||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(input.operationId)||
          typeof input.publicationVersionId!=="string"||
          !/^[a-zA-Z0-9_-]{3,180}$/.test(input.publicationVersionId)||
          !(input.actorUserId===null||typeof input.actorUserId==="string"&&
            /^[a-zA-Z0-9_-]{3,180}$/.test(input.actorUserId))||
          !["staff","schedule","rollback"].includes(String(input.triggerType))||
          typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
          typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        if(input.triggerType!=="schedule") {
          if(input.actorUserId===null)return new Response(null,{status:403,headers:noStore});
          const permitted=await env.PRIMARY_DB.prepare(
            "SELECT 1 ok FROM staff_principals p JOIN staff_principal_roles r ON r.user_id=p.user_id JOIN staff_role_permissions permission ON permission.role_id=r.role_id WHERE p.user_id=? AND p.status='active' AND permission.permission IN (?, 'publishing.lifecycle.manage','staff.manage') LIMIT 1"
          ).bind(input.actorUserId,input.triggerType==="rollback"?"publishing.rollback":"publishing.review")
            .first<{ok:number}>();
          if(!permitted)return new Response(null,{status:403,headers:noStore});
        }
        const version=await env.PRIMARY_DB.prepare(
          "SELECT pv.manifest_json,pv.snapshot_sha256,pv.submission_id,pv.version_number,pv.lifecycle_id,l.state,l.current_publication_version_id,l.pending_publication_version_id,p.product_id,p.edition_id,p.work_id,s.snapshot_json,s.snapshot_sha256 submission_sha256,s.status submission_status,a.status account_status,a.identity_status,a.tax_status,a.payout_status FROM publishing_publication_versions pv JOIN publishing_release_lifecycles l ON l.id=pv.lifecycle_id JOIN publishing_publications p ON p.id=pv.publication_id JOIN publishing_submission_snapshots s ON s.id=pv.submission_id AND s.id=p.submission_id AND s.edition_id=l.publishing_edition_id AND s.account_id=p.publishing_account_id JOIN publishing_accounts a ON a.id=s.account_id WHERE pv.id=?"
        ).bind(input.publicationVersionId).first<{
          manifest_json:string;snapshot_sha256:string;submission_id:string;snapshot_json:string;
          submission_sha256:string;version_number:number;lifecycle_id:string;
          state:string;current_publication_version_id:string|null;pending_publication_version_id:string|null;product_id:string;edition_id:string;work_id:string;
          submission_status:string;account_status:string;identity_status:string;tax_status:string;payout_status:string
        }>();
        if(!version||["suppressed","takedown","retired"].includes(version.state)||
          version.submission_status!=="published"||version.account_status!=="active"||
          [version.identity_status,version.tax_status,version.payout_status].some(s=>s!=="verified"))
          return new Response(null,{status:409,headers:noStore});
        let manifest:{schemaVersion?:unknown;snapshotSha256?:unknown;submissionId?:unknown;
          productId?:unknown;catalogEditionId?:unknown;workId?:unknown;
          metadata?:{releaseDate?:unknown}};
        try{manifest=JSON.parse(version.manifest_json);}
        catch{return new Response(null,{status:409,headers:noStore});}
        if(!manifest||manifest.schemaVersion!==4||manifest.submissionId!==version.submission_id||
          manifest.snapshotSha256!==version.snapshot_sha256||
          !/^[a-f0-9]{64}$/.test(version.snapshot_sha256)||
          version.snapshot_sha256!==version.submission_sha256||typeof manifest.productId!=="string"||
          !commercialProductId.test(manifest.productId)||manifest.productId.startsWith("prd_gutenberg_")||
          manifest.productId!==version.product_id||manifest.catalogEditionId!==version.edition_id||
          manifest.workId!==version.work_id)
          return new Response(null,{status:409,headers:noStore});
        const snapshotDigest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(version.snapshot_json));
        if([...new Uint8Array(snapshotDigest)].map(b=>b.toString(16).padStart(2,"0")).join("")!==version.snapshot_sha256)
          return new Response(null,{status:409,headers:noStore});
        if(input.triggerType==="schedule") {
          const releaseAt=typeof manifest.metadata?.releaseDate==="string"?
            Date.parse(manifest.metadata.releaseDate):NaN;
          if(!Number.isFinite(releaseAt)||releaseAt>Date.now())
            return new Response(null,{status:409,headers:noStore});
        }
        const productId=manifest.productId;
        // Hash the canonical immutable manifest as well as every command
        // argument. Reusing an operation ID for changed evidence is invalid.
        const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({
          publicationVersionId:input.publicationVersionId,actorUserId:input.actorUserId,
          triggerType:input.triggerType,territory:input.territory,currency:input.currency,
          manifest:version.manifest_json
        })));
        const identity={operationId:input.operationId,productId,
          commandSha256:[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("")};
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        if(this.publicationExecutions.has(productId))
          return new Response(null,{status:409,headers:noStore});
        this.publicationExecutions.add(productId);
        try {
        const pending=sql.exec<{operation_id:string;command_sha256:string}>(
          "SELECT operation_id,command_sha256 FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
          productId).toArray()[0];
        // A caller that lost the response may have generated a new transport
        // ID. Reconcile only the SAME immutable command against its complete
        // canonical activation marker; never start a second primary executor.
        if(pending&&pending.command_sha256===identity.commandSha256&&
          version.current_publication_version_id===input.publicationVersionId)
          identity.operationId=pending.operation_id;
        const resuming=readPublicationCommand(sql,identity.operationId)!==null;
        // A delayed scheduler command cannot activate an old version after
        // a different release became current. Exact recorded-command replay
        // remains available for a completed initial/scheduled activation.
        if(input.triggerType==="schedule"&&!resuming&&
          (!["scheduled","preorder"].includes(version.state)||
            (version.pending_publication_version_id||version.current_publication_version_id)!==input.publicationVersionId))
          return new Response(null,{status:409,headers:noStore});
        if(!resuming&&version.current_publication_version_id===input.publicationVersionId) {
          const state=sql.exec<{epoch:number;verdict:string}>(
            "SELECT epoch,verdict FROM cove_commercial_authority WHERE product_id=?",productId).toArray()[0];
          const lastDenial=state?sql.exec<{operation_id:string}>(
            "SELECT operation_id FROM cove_commercial_withdrawal_ops WHERE product_id=? AND epoch=?",
            productId,state.epoch).toArray()[0]:null;
          if(state?.verdict==="deny"&&
            !lastDenial?.operation_id.startsWith("retail:publication:"))
            return new Response(null,{status:409,headers:noStore});
        }
        // Canonical activation retires the prior manifest's grants and may
        // terminate its publication-managed contract. Those identities can
        // cover OTHER products: withdraw their owner proofs before any write,
        // rather than relying only on this product's edit hold.
        const retiring:{subjectKind:"grant"|"contract";subjectId:string}[]=[];
        if(!resuming&&version.current_publication_version_id&&
          version.current_publication_version_id!==input.publicationVersionId) {
          const previous=await env.PRIMARY_DB.prepare(
            "SELECT manifest_json FROM publishing_publication_versions WHERE id=? AND lifecycle_id=?"
          ).bind(version.current_publication_version_id,version.lifecycle_id)
            .first<{manifest_json:string}>();
          if(!previous)return new Response(null,{status:409,headers:noStore});
          const prior=JSON.parse(previous.manifest_json) as {
            rightsGrantIds?:unknown;rightsContractManagedByPublication?:unknown;rightsContractId?:unknown
          };
          if(!prior||typeof prior!=="object")return new Response(null,{status:409,headers:noStore});
          let grants=Array.isArray(prior.rightsGrantIds)?prior.rightsGrantIds.map(String).filter(Boolean):[];
          if(!grants.length&&prior.rightsContractManagedByPublication&&prior.rightsContractId)
            grants=(await env.PRIMARY_DB.prepare("SELECT id FROM rights_grants WHERE contract_id=?")
              .bind(prior.rightsContractId).all<{id:string}>()).results.map(row=>row.id);
          const next=manifest as typeof manifest&{rightsGrantIds?:unknown;rightsContractId?:unknown;
            rightsContractManagedByPublication?:unknown};
          let nextGrants=Array.isArray(next.rightsGrantIds)?next.rightsGrantIds.map(String).filter(Boolean):[];
          if(!nextGrants.length&&next.rightsContractManagedByPublication&&next.rightsContractId)
            nextGrants=(await env.PRIMARY_DB.prepare("SELECT id FROM rights_grants WHERE contract_id=?")
              .bind(next.rightsContractId).all<{id:string}>()).results.map(row=>row.id);
          const retained=new Set(nextGrants);
          for(const subjectId of new Set(grants))
            if(!retained.has(subjectId))retiring.push({subjectKind:"grant",subjectId});
          if(prior.rightsContractManagedByPublication&&typeof prior.rightsContractId==="string"&&
            prior.rightsContractId!==next.rightsContractId)
            retiring.push({subjectKind:"contract",subjectId:prior.rightsContractId});
        }
        const command=storage.transactionSync(()=>{
          const pending=beginPublicationCommand(sql,identity);
          if(!resuming)recordPublicationRecovery(sql,identity,"/publication/activate-version",{
            publicationVersionId:input.publicationVersionId,actorUserId:input.actorUserId,
            triggerType:input.triggerType,territory:input.territory,currency:input.currency
          });
          retiring.forEach((subject,index)=>denyCommercialSubject(sql,{
            ...subject,operationId:"publication:"+identity.operationId+":retire:"+index
          }));
          return pending;
        });
        let result:{publicationVersionId:string;state:string;versionNumber:number};
        if(version.current_publication_version_id===input.publicationVersionId&&
          ["live","updated"].includes(version.state)) {
          const marker=await env.PRIMARY_DB.prepare(
            "SELECT id FROM publishing_publication_activations WHERE publication_version_id=? AND lifecycle_id=? LIMIT 1"
          ).bind(input.publicationVersionId,version.lifecycle_id).first<{id:string}>();
          if(!marker||!["live","updated"].includes(version.state))
            return new Response(null,{status:503,headers:noStore});
          result={publicationVersionId:input.publicationVersionId,state:version.state,
            versionNumber:Number(version.version_number)};
        } else {
          // A committed old operation cannot rerun an old version after a
          // newer publication became current. A new rollback command is
          // required and must independently reverify current legal evidence.
          if(command.state==="committed")
            return new Response(null,{status:409,headers:noStore});
          // A restarted owner cannot infer how much of an interrupted
          // multi-table primary command committed. Only a complete canonical
          // activation marker can reconcile it. Never blindly replay writes.
          if(resuming)return new Response(null,{status:503,headers:noStore});
          result=await activatePublicationVersionOwned(env.PRIMARY_DB,
            input.publicationVersionId,input.actorUserId as string|null,
            input.triggerType as "staff"|"schedule"|"rollback");
        }
        const completion=await env.PRIMARY_DB.prepare(
          "SELECT p.storefront_status,l.state,l.current_publication_version_id FROM products p JOIN publishing_release_lifecycles l ON l.id=? WHERE p.id=? AND EXISTS (SELECT 1 FROM publishing_publication_activations a WHERE a.lifecycle_id=l.id AND a.publication_version_id=?)"
        ).bind(version.lifecycle_id,productId,input.publicationVersionId).first<{
          storefront_status:string;state:string;current_publication_version_id:string|null
        }>();
        if(!completion||completion.storefront_status!=="active"||
          completion.current_publication_version_id!==input.publicationVersionId||
          !["live","updated"].includes(completion.state))
          return new Response(null,{status:503,headers:noStore});
        storage.transactionSync(()=>commitPublicationCommand(sql,identity,result));
        // Ending the write hold grants NOTHING. Both legal and offer
        // publication perform their own fresh canonical reads and epoch CAS.
        let publishedEpoch:number|null=null;
        for(const path of ["/commercial/publish-verified","/storefront/publish-commercial"]) {
          const verify=await this.fetch(new Request("https://legal-authority.internal"+path,{
            method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
              "content-type":"application/json"},body:JSON.stringify({productId,
              territory:input.territory,currency:input.currency,channel:"retail"})
          }));
          if(verify.status!==200)return new Response(null,{status:503,headers:noStore});
          const proof=await verify.json() as {applied?:unknown;epoch?:unknown};
          if(proof.applied!==true||!Number.isSafeInteger(proof.epoch)||Number(proof.epoch)<=0||
            publishedEpoch!==null&&proof.epoch!==publishedEpoch)
            return new Response(null,{status:503,headers:noStore});
          publishedEpoch=Number(proof.epoch);
        }
        storage.transactionSync(()=>markPublicationPublished(sql,identity,publishedEpoch!));
        return Response.json({schema:"cove.publication-activation.v1",ownerFirst:true,
          operationId:input.operationId,...result},{headers:noStore});
        } finally {this.publicationExecutions.delete(productId);}
      }
      if(route==="/market/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyMarket(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      // All territory-sensitive owner decisions, including historical paid
      // entitlements, are blocked by one durable market tombstone. This is
      // deliberately NOT an asynchronous fanout across product grants.
      const marketScopedRoutes=new Set([
        "/verify","/authorize-batch","/publish-allow",
        "/commercial/authorize-batch","/commercial/publish-verified",
        "/storefront/authorize-batch","/storefront/publish-commercial",
        "/commercial/entitlement/authorize",
        "/commercial/entitlement/publish-verified"
      ]);
      if(marketScopedRoutes.has(route) &&
         marketIsWithdrawn(sql,(raw as {territory?:unknown})?.territory))
        return new Response(null,{status:409,headers:noStore});
      if(route==="/commercial/order/verify"){
        return Response.json(readPaidOrderPermission(sql,raw),{headers:noStore});
      }
      if(route==="/commercial/order/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyPaidOrder(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/order/revoke"){
        // This command owns the canonical reconciliation, rather than
        // delegating raw SQL to an independently privileged QA writer.
        // Neither a buyer ID, entitlement list nor arbitrary SQL is accepted.
        const input=raw as {orderId?:unknown;operationId?:unknown}|null;
        if(!input||Array.isArray(input)||
           Object.keys(input).sort().join(",")!=="operationId,orderId"||
           typeof input.orderId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(input.orderId)||
           typeof input.operationId!=="string"||
           !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(input.operationId))
          return new Response(null,{status:400,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id FROM commerce_orders WHERE id=?"
        ).bind(input.orderId).first<{id:string;user_id:string}>();
        if(!order||order.id!==input.orderId||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(order.user_id))
          return new Response(null,{status:409,headers:noStore});
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        // ONE durable terminal order tombstone denies every old buyer proof
        // before the first canonical write, including a concurrent grant
        // whose D1 verification was already in flight. D1 failure leaves
        // this denial committed; the exact command can safely reconcile on
        // retry. An operation ID cannot be replayed for a different order.
        storage.transactionSync(()=>denyPaidOrder(sql,input));
        // A refunded buyer must not retain an active EPUB delivery token or
        // audio offline-license record. Reconcile all three canonical tables
        // atomically AFTER the durable owner veto. An interrupted D1 batch
        // leaves the whole order denied and is repairable with the same ID.
        await env.PRIMARY_DB.batch([
          env.PRIMARY_DB.prepare(
            "UPDATE entitlements SET status='revoked' WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase' AND status='active'"
          ).bind(order.user_id,input.orderId),
          env.PRIMARY_DB.prepare(
            "UPDATE audio_offline_licenses SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason='order_refunded' WHERE entitlement_id IN (SELECT id FROM entitlements WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase') AND status='active'"
          ).bind(new Date().toISOString(),order.user_id,input.orderId),
          env.PRIMARY_DB.prepare(
            "UPDATE commercial_delivery_grants SET status='revoked' WHERE user_id=? AND entitlement_id IN (SELECT id FROM entitlements WHERE user_id=? AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND entitlement_type='purchase') AND status='active'"
          ).bind(order.user_id,order.user_id,input.orderId)
        ]);
        return Response.json({schema:"cove.paid-order-revocation.v1",
          orderDenied:true,reconciled:true,orderId:input.orderId,
          operationId:input.operationId},{status:200,headers:noStore});
      }
      if(route==="/commercial/checkout/prepare-draft"){
        // PRE-PAYMENT OWNER ONLY. A failed conditional balance reservation
        // makes the whole batch abort (SQLite JSON1 error sentinel), including
        // quote consumption and ALL earlier tender/promo inserts. Never
        // return ready based on a preflight balance read alone.
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          return new Response(null,{status:400,headers:noStore});
        const input=raw as {userId?:unknown;orderId?:unknown;quoteId?:unknown};
        if(Object.keys(input).sort().join(",")!=="orderId,quoteId,userId"||
           typeof input.userId!=="string"||!/^[A-Za-z0-9_-]{8,160}$/.test(input.userId)||
           typeof input.orderId!=="string"||!/^ord_[a-f0-9-]{36}$/.test(input.orderId)||
           typeof input.quoteId!=="string"||!/^[A-Za-z0-9_-]{8,160}$/.test(input.quoteId))
          return new Response(null,{status:400,headers:noStore});
        const db=env.PRIMARY_DB,at=new Date().toISOString();
        const order=await db.prepare(
          "SELECT * FROM commerce_orders WHERE id=? AND user_id=? AND quote_id=?"
        ).bind(input.orderId,input.userId,input.quoteId)
          .first<{id:string;user_id:string;quote_id:string;status:string;capture_method:string;
            risk_assessment_id:string|null;risk_action:string|null;
            gift_card_minor:number;store_credit_minor:number;promo_discount_minor:number;
            stripe_due_minor:number;currency:string;
            total_minor:number;stripe_payment_intent_id:string|null}>();
        const quote=await db.prepare(
          "SELECT * FROM commerce_checkout_quotes WHERE id=? AND user_id=?"
        ).bind(input.quoteId,input.userId)
          .first<{id:string;user_id:string;gift_card_hash:string|null;promo_code_hash:string|null;
            consumed_at:string|null;expires_at:string}>();
        if(!order||!quote||order.status!=="pending_payment"||
           order.stripe_payment_intent_id!==null||
           !Number.isSafeInteger(Number(order.stripe_due_minor))||
           !ownerCheckoutPreparationMatchesQuote(order,quote))
          return new Response(null,{status:409,headers:noStore});
        // A durable fraud/refund/withdrawal denial wins over every retry.
        // The private owner must check its own tombstone rather than relying
        // only on an earlier API-layer /commercial/order/verify request.
        if(readPaidOrderPermission(sql,{orderId:order.id}).allowed!==true)
          return new Response(null,{status:409,headers:noStore});
        const verified=async()=>{
          const counts=await db.prepare(
            "SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN source_type='gift_card' THEN amount_minor ELSE 0 END),0) gift,COALESCE(SUM(CASE WHEN source_type='store_credit' THEN amount_minor ELSE 0 END),0) store FROM commerce_balance_reservations WHERE order_id=? AND status='reserved'"
          ).bind(order.id).first<{n:number;gift:number;store:number}>();
          const promo=await db.prepare(
            "SELECT COUNT(*) n,COALESCE(SUM(amount_minor),0) amount FROM commerce_promo_redemptions WHERE order_id=? AND status='reserved'"
          ).bind(order.id).first<{n:number;amount:number}>();
          return !!(counts&&promo&&
            Number(counts.n)===(Number(order.gift_card_minor)>0?1:0)+(Number(order.store_credit_minor)>0?1:0)&&
            Number(counts.gift)===Number(order.gift_card_minor)&&
            Number(counts.store)===Number(order.store_credit_minor)&&
            Number(promo.n)===(Number(order.promo_discount_minor)>0?1:0)&&
            Number(promo.amount)===Number(order.promo_discount_minor));
        };
        if(quote.consumed_at){
          if(!order.risk_assessment_id||!order.risk_action||
             !["allow","monitor","challenge","hold"].includes(order.risk_action)||
             !(await verified()))
            return new Response(null,{status:409,headers:noStore});
          return Response.json({schema:"cove.owner-checkout-preparation.v1",
            userId:input.userId,orderId:input.orderId,quoteId:input.quoteId,
            ready:true,blocked:false,riskAction:order.risk_action,
            captureMethod:order.capture_method,tenderReserved:true,quoteConsumed:true,
            applied:false},{headers:noStore});
        }
        if(quote.expires_at<=at)
          return new Response(null,{status:409,headers:noStore});
        // Persisted buyer risk is reused across retries. The first evaluation
        // is owner-invoked, rather than a stale caller-supplied risk verdict.
        const risk=order.risk_assessment_id&&order.risk_action?
          {action:order.risk_action}:
          await assessBuyerOrderRisk(db,order.id);
        if(!["allow","monitor","challenge","hold","block"].includes(risk.action))
          throw Error("owner_checkout_unknown_risk_action");
        if(risk.action==="block"||
           (risk.action==="hold"&&Number(order.stripe_due_minor)===0)){
          await db.prepare(
            "UPDATE commerce_orders SET status='canceled',canceled_at=?,failure_code='RISK_BLOCK',failure_message='Checkout requires fraud review.',updated_at=? WHERE id=? AND user_id=? AND status='pending_payment' AND stripe_payment_intent_id IS NULL"
          ).bind(at,at,order.id,input.userId).run();
          return Response.json({schema:"cove.owner-checkout-preparation.v1",
            userId:input.userId,orderId:input.orderId,quoteId:input.quoteId,
            ready:false,blocked:true,riskAction:risk.action,
            tenderReserved:false,quoteConsumed:false,applied:false},{headers:noStore});
        }
        const expires=new Date(Date.parse(at)+24*60*60_000).toISOString();
        const stmts=[];
        if(Number(order.gift_card_minor)>0){
          if(!quote.gift_card_hash)throw Error("owner_checkout_gift_identity_missing");
          stmts.push(db.prepare(
            "INSERT INTO commerce_balance_reservations(id,user_id,order_id,source_type,source_key,amount_minor,currency,status,expires_at,created_at,updated_at) SELECT ?,?,?,'gift_card',?,?,?,'reserved',?,?,? WHERE ? <= (SELECT balance_minor-COALESCE((SELECT SUM(amount_minor) FROM commerce_balance_reservations WHERE source_type='gift_card' AND source_key=? AND status='reserved'),0) FROM commerce_gift_cards WHERE code_hash=? AND status='active' AND currency=?)"
          ).bind(crypto.randomUUID(),input.userId,order.id,quote.gift_card_hash,
            order.gift_card_minor,order.currency,expires,at,at,
            order.gift_card_minor,quote.gift_card_hash,quote.gift_card_hash,order.currency));
        }
        if(Number(order.store_credit_minor)>0){
          stmts.push(db.prepare(
            "INSERT INTO commerce_balance_reservations(id,user_id,order_id,source_type,source_key,amount_minor,currency,status,expires_at,created_at,updated_at) SELECT ?,?,?,'store_credit',?,?,?,'reserved',?,?,? WHERE ? <= ((SELECT COALESCE(SUM(amount_minor),0) FROM commerce_store_credit_ledger WHERE user_id=? AND currency=?)-COALESCE((SELECT SUM(amount_minor) FROM commerce_balance_reservations WHERE source_type='store_credit' AND source_key=? AND currency=? AND status='reserved'),0))"
          ).bind(crypto.randomUUID(),input.userId,order.id,input.userId,
            order.store_credit_minor,order.currency,expires,at,at,
            order.store_credit_minor,input.userId,order.currency,input.userId,order.currency));
        }
        if(Number(order.promo_discount_minor)>0){
          if(!quote.promo_code_hash)throw Error("owner_checkout_promo_identity_missing");
          stmts.push(db.prepare(
            "INSERT INTO commerce_promo_redemptions(id,code_hash,user_id,order_id,quote_id,amount_minor,status,created_at,updated_at) SELECT ?,p.code_hash,?,?,?,?, 'reserved',?,? FROM commerce_promo_codes p WHERE p.code_hash=? AND p.active=1 AND (p.starts_at IS NULL OR p.starts_at<=?) AND (p.ends_at IS NULL OR p.ends_at>?) AND (p.max_redemptions IS NULL OR (SELECT COUNT(*) FROM commerce_promo_redemptions r WHERE r.code_hash=p.code_hash AND r.status IN ('reserved','applied'))<p.max_redemptions) AND (SELECT COUNT(*) FROM commerce_promo_redemptions r WHERE r.code_hash=p.code_hash AND r.user_id=? AND r.status IN ('reserved','applied'))<p.max_per_user"
          ).bind(crypto.randomUUID(),input.userId,order.id,input.quoteId,
            order.promo_discount_minor,at,at,quote.promo_code_hash,at,at,input.userId));
        }
        stmts.push(db.prepare(
          "UPDATE commerce_orders SET capture_method=?,updated_at=? WHERE id=? AND user_id=? AND quote_id=? AND risk_assessment_id IS NOT NULL AND risk_action=? AND status='pending_payment' AND stripe_payment_intent_id IS NULL"
        ).bind(risk.action==="hold"?"manual":order.capture_method,
          at,order.id,input.userId,input.quoteId,risk.action));
        stmts.push(db.prepare(
          "UPDATE commerce_checkout_quotes SET consumed_at=? WHERE id=? AND user_id=? AND consumed_at IS NULL AND expires_at>?"
        ).bind(at,input.quoteId,input.userId,at));
        // SQLite's CASE is lazy; the malformed JSON branch raises an error
        // that rolls back the ENTIRE D1 batch when any reservation or quote
        // invariant failed. No partial gift, credit or promotion hold can
        // become externally visible on an unsuccessful attempt.
        stmts.push(db.prepare(
          "SELECT CASE WHEN (SELECT consumed_at FROM commerce_checkout_quotes WHERE id=? AND user_id=?)=? AND (SELECT COUNT(*) FROM commerce_balance_reservations WHERE order_id=? AND status='reserved')=? AND (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_balance_reservations WHERE order_id=? AND status='reserved' AND source_type='gift_card')=? AND (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_balance_reservations WHERE order_id=? AND status='reserved' AND source_type='store_credit')=? AND (SELECT COUNT(*) FROM commerce_promo_redemptions WHERE order_id=? AND status='reserved')=? AND (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_promo_redemptions WHERE order_id=? AND status='reserved')=? AND (SELECT COUNT(*) FROM commerce_orders WHERE id=? AND user_id=? AND status='pending_payment' AND risk_assessment_id IS NOT NULL AND risk_action=? AND capture_method=? AND stripe_payment_intent_id IS NULL)=1 THEN 1 ELSE json_extract('invalid-checkout-preparation','$') END verified"
        ).bind(input.quoteId,input.userId,at,order.id,
          (Number(order.gift_card_minor)>0?1:0)+(Number(order.store_credit_minor)>0?1:0),
          order.id,order.gift_card_minor,order.id,order.store_credit_minor,
          order.id,Number(order.promo_discount_minor)>0?1:0,
          order.id,order.promo_discount_minor,order.id,input.userId,risk.action,
          risk.action==="hold"?"manual":order.capture_method));
        await db.batch(stmts);
        if(!(await verified()))
          throw Error("owner_checkout_preparation_commit_unconfirmed");
        return Response.json({schema:"cove.owner-checkout-preparation.v1",
          userId:input.userId,orderId:input.orderId,quoteId:input.quoteId,
          ready:true,blocked:false,riskAction:risk.action,
          captureMethod:risk.action==="hold"?"manual":order.capture_method,
          tenderReserved:true,quoteConsumed:true,applied:true},{headers:noStore});
      }
      if(route==="/commercial/checkout/create-quote"){
        // Only the isolated QA owner persists the quote, billing geography and
        // Stripe Tax evidence. Recompute the cart and pricing against the
        // canonical database: the caller supplies NO prices, SQL or rights proof.
        const command=raw as {userId?:unknown;request?:unknown}|null;
        if(!command||typeof command!=="object"||Array.isArray(command)||
           Object.keys(command).sort().join(",")!=="request,userId"||
           typeof command.userId!=="string"||
           !/^[A-Za-z0-9_-]{8,160}$/.test(command.userId))
          return new Response(null,{status:400,headers:noStore});
        const ownerEnv={
          DB:env.PRIMARY_DB,STRIPE_SECRET_KEY:env.STRIPE_SECRET_KEY,
          STRIPE_LIVEMODE:env.STRIPE_LIVEMODE,
          STRIPE_TAX_ENABLED:env.STRIPE_TAX_ENABLED,
          STRIPE_MINIMUM_CHARGE_MINOR:env.STRIPE_MINIMUM_CHARGE_MINOR,
          // This flag is minted *inside* the independently authorized QA owner,
          // never by a public backend request or its D1 capability.
          COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",
        } as CoveEnv;
        const quote=await checkoutQuote(ownerEnv,{id:command.userId},command.request);
        // The quote, tax evidence and provider calculation were persisted
        // by the canonical owner. It cannot ACK a caller-supplied amount.
        const stored=await env.PRIMARY_DB.prepare(
          "SELECT id, user_id, currency,total_minor,stripe_due_minor FROM commerce_checkout_quotes WHERE id=? AND user_id=?"
        ).bind(quote.id,command.userId).first<{id:string;user_id:string;currency:string;
          total_minor:number;stripe_due_minor:number}>();
        if(!stored||stored.currency!==quote.currency||
           Number(stored.total_minor)!==quote.totalMinor||
           Number(stored.stripe_due_minor)!==quote.stripeDueMinor)
          throw Error("owner_checkout_quote_commit_unconfirmed");
        return Response.json({...quote,schema:"cove.owner-checkout-quote.v1",
          userId:command.userId,persisted:true},{headers:noStore});
      }
      if(route==="/commercial/checkout/materialize-draft"){
        // A *pre-payment* isolated QA building block, NOT a completed
        // checkout: no risk verdict, tender reservation, quote consumption,
        // Stripe intent or entitlement is created by this command.
        // Production owner enablement remains hard disabled by the QA lease.
        const command=checkoutDraftCommand.parse(raw),db=env.PRIMARY_DB;
        const old=await db.prepare(
          "SELECT * FROM commerce_orders WHERE user_id=? AND (idempotency_key=? OR quote_id=?) LIMIT 2"
        ).bind(command.userId,command.idempotencyKey,command.quoteId)
          .all<{id:string;quote_id:string;idempotency_key:string;currency:string;stripe_due_minor:number}>();
        if(old.results.length){
          const existing=old.results[0];
          // A second client idempotency key for the SAME canonical quote may
          // resume that already-created order; a key linked to another quote
          // is always rejected by this exact owner-and-quote check.
          if(old.results.length!==1||existing.quote_id!==command.quoteId)
            return new Response(null,{status:409,headers:noStore});
          if(readPaidOrderPermission(sql,{orderId:existing.id}).allowed!==true)
            return new Response(null,{status:409,headers:noStore});
          const lines=await db.prepare(
            "SELECT COUNT(*) n FROM commerce_order_items WHERE order_id=?"
          ).bind(existing.id).first<{n:number}>();
          if(!lines||Number(lines.n)<1||Number(lines.n)>25)
            return new Response(null,{status:409,headers:noStore});
          return Response.json({schema:"cove.owner-checkout-draft.v1",
            userId:command.userId,quoteId:command.quoteId,
            idempotencyKey:command.idempotencyKey,orderId:existing.id,
            currency:existing.currency,stripeDueMinor:Number(existing.stripe_due_minor),
            lineCount:Number(lines.n),created:false,riskAssessed:false,
            tenderReserved:false,quoteConsumed:false,paymentAuthorized:false},
            {headers:noStore});
        }
        const quote=await db.prepare(
          "SELECT * FROM commerce_checkout_quotes WHERE id=? AND user_id=?"
        ).bind(command.quoteId,command.userId).first<Record<string,unknown>>();
        if(!quote)return new Response(null,{status:409,headers:noStore});
        const plan=planOwnerCheckoutDraft(command,quote,new Date().toISOString(),
          ()=>crypto.randomUUID());
        const q=plan.quote,at=plan.at;
        const statements=[
          db.prepare(
            "INSERT INTO commerce_orders(id,user_id,quote_id,invoice_number,status,currency,territory_code,subtotal_minor,promo_discount_minor,tax_minor,tax_inclusive_minor,gift_card_minor,store_credit_minor,total_minor,stripe_due_minor,billing_address_json,stripe_tax_calculation_id,capture_method,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
          ).bind(plan.orderId,command.userId,command.quoteId,plan.invoice,
            "pending_payment",q.currency,q.territory_code,q.subtotal_minor,
            q.promo_discount_minor,q.tax_minor,q.tax_inclusive_minor,
            q.gift_card_minor,q.store_credit_minor,q.total_minor,
            q.stripe_due_minor,q.billing_address_json,q.stripe_tax_calculation_id||null,
            command.captureMethod,command.idempotencyKey,at,at),
          ...plan.lines.map(line=>db.prepare(
            "INSERT INTO commerce_order_items(id,order_id,product_id,offer_id,title_snapshot,sku_snapshot,unit_amount_minor,discount_minor,tax_minor,total_minor,source_surface,source_request_id,pricing_decision_id,rights_decision_id,rights_grant_id,rights_snapshot_json,sales_channel,fulfillment_type,fulfillment_status,promotion_campaign_id,publisher_discount_funding_minor,fore_discount_funding_minor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'immediate','pending',?,?,?,?)"
          ).bind(line.id,plan.orderId,line.productId,line.offerId,line.title,
            line.sku,line.amountMinor,line.discountMinor,line.taxMinor,line.totalMinor,
            line.sourceSurface,line.sourceRequestId,line.pricingDecisionId,
            line.rightsDecisionId,line.rightsGrantId,line.rightsSnapshotJson,
            line.salesChannel,line.promotionCampaignId,line.publisherFunding,
            line.foreFunding,at))
        ];
        if(command.soundsStation&&stationBySlug(command.soundsStation)){
          statements.push(db.prepare(
            "INSERT OR IGNORE INTO commerce_sounds_purchase_attribution(order_id,station_slug,recording_id,captured_at) VALUES(?,?,?,?)"
          ).bind(plan.orderId,command.soundsStation,command.soundsRecording||null,at));
        }
        await db.batch(statements);
        const confirmed=await db.prepare(
          "SELECT COUNT(*) n FROM commerce_order_items WHERE order_id=?"
        ).bind(plan.orderId).first<{n:number}>();
        if(Number(confirmed?.n)!==plan.lines.length)
          throw Error("owner_checkout_draft_line_commit_unconfirmed");
        return Response.json({schema:"cove.owner-checkout-draft.v1",
          userId:command.userId,quoteId:command.quoteId,
          idempotencyKey:command.idempotencyKey,orderId:plan.orderId,
          currency:q.currency,stripeDueMinor:q.stripe_due_minor,
          lineCount:plan.lines.length,created:true,riskAssessed:false,
          tenderReserved:false,quoteConsumed:false,paymentAuthorized:false},
          {headers:noStore});
      }
      if(route==="/commercial/checkout/register-stripe-customer"){
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          throw Error("owner_stripe_customer_invalid");
        const c=raw as {userId?:unknown;customerId?:unknown};
        if(Object.keys(c).sort().join(",")!=="customerId,userId"||
          typeof c.userId!=="string"||!/^[a-zA-Z0-9_-]{8,160}$/.test(c.userId)||
          typeof c.customerId!=="string"||!/^cus_[a-zA-Z0-9_-]{4,150}$/.test(c.customerId))
          throw Error("owner_stripe_customer_invalid");
        const live=env.STRIPE_LIVEMODE==="true",secret=env.STRIPE_SECRET_KEY||"";
        if(!(live?/^(sk|rk)_live_/:/^(sk|rk|rkcs)_test_/).test(secret))
          throw Error("owner_stripe_customer_verifier_unavailable");
        const reply=await fetch(
          "https://api.stripe.com/v1/customers/"+encodeURIComponent(c.customerId),
          {headers:{authorization:"Bearer "+secret},redirect:"manual",signal:AbortSignal.timeout(15_000)}
        );
        if(reply.status!==200)throw Error("owner_stripe_customer_provider_unavailable");
        const bytes=await reply.text();
        if(bytes.length>32768)throw Error("owner_stripe_customer_provider_receipt_oversize");
        let customer:{object?:unknown;id?:unknown;livemode?:unknown;deleted?:unknown;
          metadata?:{fore_user_id?:unknown};email?:unknown};
        try{customer=JSON.parse(bytes);}catch{throw Error("owner_stripe_customer_provider_receipt_invalid");}
        if(customer.object!=="customer"||customer.deleted===true||
          customer.id!==c.customerId||customer.livemode!==live||
          customer.metadata?.fore_user_id!==c.userId)
          throw Error("owner_stripe_customer_provider_identity_mismatch");
        const email=typeof customer.email==="string"?customer.email.trim().toLowerCase():"";
        if(email.length>254)throw Error("owner_stripe_customer_provider_email_invalid");
        const already=await env.PRIMARY_DB.prepare(
          "SELECT user_id FROM commerce_customers WHERE stripe_customer_id=?"
        ).bind(c.customerId).first<{user_id:string}>();
        if(already&&already.user_id!==c.userId)
          throw Error("owner_stripe_customer_already_assigned");
        const present=await env.PRIMARY_DB.prepare(
          "SELECT stripe_customer_id FROM commerce_customers WHERE user_id=?"
        ).bind(c.userId).first<{stripe_customer_id:string|null}>();
        if(present?.stripe_customer_id&&present.stripe_customer_id!==c.customerId)
          throw Error("owner_stripe_customer_identity_immutable");
        const at=new Date().toISOString();
        const changed=await env.PRIMARY_DB.prepare(
          "INSERT INTO commerce_customers(user_id,stripe_customer_id,email,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,updated_at=excluded.updated_at,stripe_customer_id=excluded.stripe_customer_id WHERE commerce_customers.stripe_customer_id IS NULL OR commerce_customers.stripe_customer_id=excluded.stripe_customer_id"
        ).bind(c.userId,c.customerId,email,at,at).run() as {meta?:{changes?:number}};
        const confirmed=await env.PRIMARY_DB.prepare(
          "SELECT stripe_customer_id FROM commerce_customers WHERE user_id=?"
        ).bind(c.userId).first<{stripe_customer_id:string|null}>();
        if(confirmed?.stripe_customer_id!==c.customerId)
          throw Error("owner_stripe_customer_binding_unconfirmed");
        return Response.json({schema:"cove.owner-stripe-customer.v1",
          userId:c.userId,customerId:c.customerId,bound:true,applied:!present&&changed.meta?.changes===1},
          {headers:noStore});
      }
      if(route==="/commercial/checkout/attach-payment-intent"){
        const receipt=await executeOwnerCheckoutPaymentBinding(env,raw,async input=>{
          const {command:c,order,at,paymentAttemptId,stripeStatus,paymentMethodTypes}=input;
          const db=env.PRIMARY_DB;
          const results=await db.batch([
            db.prepare(
              "UPDATE commerce_orders SET stripe_customer_id=?,stripe_payment_intent_id=?,updated_at=? WHERE id=? AND user_id=? AND quote_id=? AND status IN ('pending_payment','processing','authorized','payment_failed') AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id=?) AND (stripe_customer_id IS NULL OR stripe_customer_id=?)"
            ).bind(c.customerId,c.paymentIntentId,at,c.orderId,c.userId,order.quote_id,c.paymentIntentId,c.customerId),
            db.prepare(
              "INSERT INTO commerce_payment_attempts(id,order_id,provider,provider_payment_id,status,amount_minor,currency,provider_payload_json,created_at,updated_at) SELECT ?,o.id,'stripe',?,?,?,?,?,?,? FROM commerce_orders o WHERE o.id=? AND o.user_id=? AND o.stripe_payment_intent_id=? AND o.stripe_customer_id=? AND NOT EXISTS (SELECT 1 FROM commerce_payment_attempts pa WHERE pa.order_id=o.id AND pa.provider_payment_id=?)"
            ).bind(paymentAttemptId,c.paymentIntentId,stripeStatus,Number(order.stripe_due_minor),
              order.currency,JSON.stringify({payment_method_types:paymentMethodTypes,
                capture_method:order.capture_method}),at,at,
              c.orderId,c.userId,c.paymentIntentId,c.customerId,c.paymentIntentId)
          ]) as Array<{meta?:{changes?:number}}>;
          const bound=await db.prepare(
            "SELECT stripe_payment_intent_id,stripe_customer_id FROM commerce_orders WHERE id=? AND user_id=?"
          ).bind(c.orderId,c.userId).first<{stripe_payment_intent_id:string;stripe_customer_id:string}>();
          const attempt=await db.prepare(
            "SELECT id FROM commerce_payment_attempts WHERE order_id=? AND provider_payment_id=?"
          ).bind(c.orderId,c.paymentIntentId).first<{id:string}>();
          if(bound?.stripe_payment_intent_id!==c.paymentIntentId||
             bound.stripe_customer_id!==c.customerId||!attempt)
            throw Error("owner_checkout_payment_binding_unconfirmed");
          return {applied:results[1]?.meta?.changes===1};
        });
        return Response.json(receipt,{headers:noStore});
      }
      if(route==="/commercial/payment/update-state"){
        // Only exact signed-Stripe adapters on the private QA lease may call
        // this fixed state machine; the owner independently verifies the
        // canonical order/PI mapping. Paid/refunded/withdrawn orders are
        // never reset to pending, authorized or canceled by stale webhooks.
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          throw Error("invalid_owner_payment_state_command");
        const q=raw as Record<string,unknown>,
          validId=/^[a-zA-Z0-9_-]{8,160}$/;
        if(Object.keys(q).sort().join(",")!=="failureCode,orderId,paymentIntentId,state"||
           typeof q.orderId!=="string"||!validId.test(q.orderId)||
           typeof q.paymentIntentId!=="string"||!/^pi_[a-zA-Z0-9_-]{4,150}$/.test(q.paymentIntentId)||
           !["processing","authorized","payment_failed","canceled"].includes(String(q.state))||
           (q.failureCode!==null&&(typeof q.failureCode!=="string"||
              !/^[a-zA-Z0-9_]{0,100}$/.test(q.failureCode)))||
           (q.state!=="payment_failed"&&q.failureCode!==null))
          throw Error("invalid_owner_payment_state_command");
        const existing=await env.PRIMARY_DB.prepare(
          "SELECT id,status FROM commerce_orders WHERE id=? AND stripe_payment_intent_id=?"
        ).bind(q.orderId,q.paymentIntentId).first<{id:string;status:string}>();
        if(!existing||existing.id!==q.orderId)
          throw Error("owner_payment_intent_order_mismatch");
        const at=new Date().toISOString();
        let applied=false;
        if(q.state==="authorized"){
          const result=await env.PRIMARY_DB.prepare(
            "UPDATE commerce_orders SET status='authorized',authorized_at=COALESCE(authorized_at,?),updated_at=? WHERE id=? AND stripe_payment_intent_id=? AND status IN ('pending_payment','processing','authorized')"
          ).bind(at,at,q.orderId,q.paymentIntentId).run() as {meta?:{changes?:number}};
          applied=result.meta?.changes===1;
        }else if(q.state==="processing"){
          const result=await env.PRIMARY_DB.prepare(
            "UPDATE commerce_orders SET status='processing',updated_at=? WHERE id=? AND stripe_payment_intent_id=? AND status='pending_payment'"
          ).bind(at,q.orderId,q.paymentIntentId).run() as {meta?:{changes?:number}};
          applied=result.meta?.changes===1;
        }else if(q.state==="payment_failed"){
          const result=await env.PRIMARY_DB.prepare(
            "UPDATE commerce_orders SET status='payment_failed',failure_code=?,failure_message='Payment failed',updated_at=? WHERE id=? AND stripe_payment_intent_id=? AND status IN ('pending_payment','processing','authorized','payment_failed')"
          ).bind(q.failureCode,at,q.orderId,q.paymentIntentId).run() as {meta?:{changes?:number}};
          applied=result.meta?.changes===1;
        }else{
          // Cancellation and tender release must be one D1 batch. A retry
          // against an already canceled order repairs reserved tender but
          // can never release funds for a paid/refunded successor.
          const results=await env.PRIMARY_DB.batch([
            env.PRIMARY_DB.prepare(
              "UPDATE commerce_orders SET status='canceled',canceled_at=COALESCE(canceled_at,?),updated_at=? WHERE id=? AND stripe_payment_intent_id=? AND status IN ('pending_payment','processing','authorized','payment_failed')"
            ).bind(at,at,q.orderId,q.paymentIntentId),
            env.PRIMARY_DB.prepare(
              "UPDATE commerce_balance_reservations SET status='released',updated_at=? WHERE order_id=? AND status='reserved' AND EXISTS(SELECT 1 FROM commerce_orders WHERE id=? AND stripe_payment_intent_id=? AND status='canceled')"
            ).bind(at,q.orderId,q.orderId,q.paymentIntentId),
            env.PRIMARY_DB.prepare(
              "UPDATE commerce_promo_redemptions SET status='released',updated_at=? WHERE order_id=? AND status='reserved' AND EXISTS(SELECT 1 FROM commerce_orders WHERE id=? AND stripe_payment_intent_id=? AND status='canceled')"
            ).bind(at,q.orderId,q.orderId,q.paymentIntentId)
          ]) as Array<{meta?:{changes?:number}}>;
          applied=results[0]?.meta?.changes===1;
        }
        return Response.json({schema:"cove.owner-payment-state.v1",
          orderId:q.orderId,paymentIntentId:q.paymentIntentId,state:q.state,
          ownerRecorded:true,applied},{headers:noStore});
      }
      if(route==="/commercial/webhook/claim"){
        // Only a private, stage-leased owner sees this command. The public
        // caller must have already verified Stripe HMAC and livemode. The
        // owner leases the canonical event using a conditional SQL claim;
        // repeated event IDs with altered payload digests never pass.
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          throw Error("owner_webhook_claim_invalid");
        const q=raw as Record<string,unknown>;
        if(Object.keys(q).sort().join(",")!=="eventId,eventType,livemode,payloadSha256"||
          typeof q.eventId!=="string"||!/^evt_[a-zA-Z0-9_-]{4,150}$/.test(q.eventId)||
          typeof q.eventType!=="string"||!/^[a-z0-9_.]{3,120}$/.test(q.eventType)||
          typeof q.livemode!=="boolean"||
          typeof q.payloadSha256!=="string"||!/^[a-f0-9]{64}$/.test(q.payloadSha256))
          throw Error("owner_webhook_claim_invalid");
        const at=new Date().toISOString(),token=crypto.randomUUID(),
          lease=new Date(Date.now()+300_000).toISOString();
        const claimed=await env.PRIMARY_DB.prepare(
          "INSERT INTO commerce_webhook_events(provider_event_id,event_type,livemode,payload_sha256,status,received_at,processing_token,processing_lease_until) VALUES(?,?,?,?,'received',?,?,?) ON CONFLICT(provider_event_id) DO UPDATE SET status='received',error='',processing_token=excluded.processing_token,processing_lease_until=excluded.processing_lease_until WHERE commerce_webhook_events.payload_sha256=excluded.payload_sha256 AND commerce_webhook_events.event_type=excluded.event_type AND commerce_webhook_events.livemode=excluded.livemode AND commerce_webhook_events.status<>'processed' AND (commerce_webhook_events.status='failed' OR commerce_webhook_events.processing_lease_until<=?) RETURNING provider_event_id"
        ).bind(q.eventId,q.eventType,q.livemode?1:0,q.payloadSha256,at,token,lease,at)
          .first<{provider_event_id:string}>();
        if(!claimed){
          const existing=await env.PRIMARY_DB.prepare(
            "SELECT event_type,livemode,status,payload_sha256 FROM commerce_webhook_events WHERE provider_event_id=?"
          ).bind(q.eventId).first<{event_type:string;livemode:number;status:string;payload_sha256:string}>();
          if(!existing||existing.payload_sha256!==q.payloadSha256||
             existing.event_type!==q.eventType||Boolean(existing.livemode)!==q.livemode)
            throw Error("owner_webhook_event_identity_collision");
          if(existing.status!=="processed")throw Error("owner_webhook_lease_active");
          return Response.json({schema:"cove.owner-webhook-claim.v1",
            eventId:q.eventId,payloadSha256:q.payloadSha256,
            claimed:false,duplicate:true,token:null},{headers:noStore});
        }
        return Response.json({schema:"cove.owner-webhook-claim.v1",
          eventId:q.eventId,payloadSha256:q.payloadSha256,
          claimed:true,duplicate:false,token},{headers:noStore});
      }
      if(route==="/commercial/webhook/finish"){
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          throw Error("owner_webhook_finish_invalid");
        const q=raw as Record<string,unknown>;
        if(Object.keys(q).sort().join(",")!=="eventId,outcome,payloadSha256,token"||
          typeof q.eventId!=="string"||!/^evt_[a-zA-Z0-9_-]{4,150}$/.test(q.eventId)||
          typeof q.payloadSha256!=="string"||!/^[a-f0-9]{64}$/.test(q.payloadSha256)||
          typeof q.token!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(q.token)||
          (q.outcome!=="processed"&&q.outcome!=="failed"))
          throw Error("owner_webhook_finish_invalid");
        const at=new Date().toISOString();
        const changed=await env.PRIMARY_DB.prepare(
          "UPDATE commerce_webhook_events SET status=?,processed_at=?,error=CASE WHEN ?='failed' THEN 'webhook_processing_failed' ELSE '' END,processing_lease_until='' WHERE provider_event_id=? AND payload_sha256=? AND processing_token=? AND status='received'"
        ).bind(q.outcome,at,q.outcome,q.eventId,q.payloadSha256,q.token)
          .run() as {meta?:{changes?:number}};
        if(changed.meta?.changes!==1)throw Error("owner_webhook_finish_lease_lost");
        return Response.json({schema:"cove.owner-webhook-finish.v1",
          eventId:q.eventId,payloadSha256:q.payloadSha256,token:q.token,
          outcome:q.outcome,finished:true},{headers:noStore});
      }
      if(route==="/commercial/refund/reserve"){
        // This reservation is the ONLY allowed enrolled refund intent writer.
        // The owner computes tender splits; no caller can supply a SQL string.
        const receipt=await executeOwnerRefundReservation(env.PRIMARY_DB,raw,async row=>{
          const write=await env.PRIMARY_DB.prepare(
            "INSERT INTO commerce_refunds(id,order_id,amount_minor,stripe_amount_minor,gift_card_amount_minor,store_credit_amount_minor,currency,reason,status,idempotency_key,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,'pending',?,?,? FROM commerce_orders o WHERE o.id=? AND o.status IN ('paid','partially_refunded','disputed') AND ?<=o.total_minor-COALESCE((SELECT SUM(amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0) AND ?<=o.stripe_due_minor-COALESCE((SELECT SUM(stripe_amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0) AND ?<=o.gift_card_minor-COALESCE((SELECT SUM(gift_card_amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0) AND ?<=o.store_credit_minor-COALESCE((SELECT SUM(store_credit_amount_minor) FROM commerce_refunds WHERE order_id=o.id AND status IN ('pending','succeeded')),0)"
          ).bind(row.refundId,row.orderId,row.amount,row.stripe,row.gift,row.store,
            row.currency,row.reason,row.idempotencyKey,row.at,row.at,row.orderId,
            row.amount,row.stripe,row.gift,row.store).run() as {meta?:{changes?:number}};
          return write;
        });
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/checkout/cancel-unpaid"){
        const receipt=await executeOwnerUnpaidCancellation(env,raw);
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/admin/monetary"){
        const receipt=await executeOwnerMonetaryAdmin(env,raw);
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/reconciliation/record"){
        const receipt=await recordOwnerReconciliationRun(env.PRIMARY_DB,raw);
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/dispute/sync-verified"){
        // Private legal owner independently fetches live Stripe evidence.
        // The signed webhook supplies only a dispute ID and event kind.
        const input=raw as {disputeId?:unknown;eventType?:unknown}|null;
        if(!input||Array.isArray(input)||
           Object.keys(input).sort().join(",")!=="disputeId,eventType"||
           typeof input.disputeId!=="string"||
           !/^dp_[A-Za-z0-9_-]{4,150}$/.test(input.disputeId)||
           !["charge.dispute.created","charge.dispute.updated",
             "charge.dispute.closed","charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated"].includes(String(input.eventType)))
          throw Error("owner_dispute_command_invalid");
        const dispute=await verifyOwnerStripeDispute(env,input.disputeId);
        const db=env.PRIMARY_DB;
        const order=await db.prepare(
          "SELECT id,user_id,currency,stripe_due_minor,stripe_charge_id,status FROM commerce_orders WHERE stripe_charge_id=?"
        ).bind(dispute.chargeId).first<{id:string;user_id:string;currency:string;
          stripe_due_minor:number;stripe_charge_id:string;status:string}>();
        if(order&&(order.stripe_charge_id!==dispute.chargeId||
           order.currency!==dispute.currency||
           !Number.isSafeInteger(Number(order.stripe_due_minor))||
           Number(order.stripe_due_minor)<dispute.amountMinor||
           !["paid","partially_refunded","refunded","disputed","chargeback_lost"].includes(order.status)))
          throw Error("owner_dispute_original_order_mismatch");
        if(order){
          // Durable whole-order veto FIRST. No bank win auto-restores grants.
          const storage=this.ctx.storage as typeof this.ctx.storage&{
            transactionSync<T>(fn:()=>T):T
          };
          storage.transactionSync(()=>denyPaidOrder(sql,{
            orderId:order.id,operationId:"dispute:"+dispute.id
          }));
          if(readPaidOrderPermission(sql,{orderId:order.id}).allowed!==false)
            throw Error("owner_dispute_denial_uncommitted");
        }
        const at=new Date().toISOString(),lost=dispute.status==="lost",
          won=dispute.status==="won",closed=lost||won||dispute.status==="warning_closed";
        const statements:Parameters<CatalogDB["batch"]>[0]=[];
        // Explicit rollback assertion: a repeat ID cannot change original
        // order, charge, currency or disputed amount.
        statements.push(db.prepare(
          "SELECT CASE WHEN EXISTS(SELECT 1 FROM commerce_disputes WHERE provider_dispute_id=? AND (COALESCE(order_id,'')<>? OR charge_id<>? OR amount_minor<>? OR currency<>?)) THEN json_extract('immutable_dispute_scope_conflict','$.deny') ELSE 1 END ok"
        ).bind(dispute.id,order?.id||"",dispute.chargeId,dispute.amountMinor,dispute.currency));
        statements.push(db.prepare(
          "INSERT INTO commerce_disputes(provider_dispute_id,order_id,charge_id,amount_minor,currency,reason,status,evidence_due_at,created_at,updated_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_dispute_id) DO UPDATE SET reason=excluded.reason,status=excluded.status,evidence_due_at=excluded.evidence_due_at,updated_at=excluded.updated_at,closed_at=COALESCE(commerce_disputes.closed_at,excluded.closed_at)"
        ).bind(dispute.id,order?.id||null,dispute.chargeId,dispute.amountMinor,
          dispute.currency,dispute.reason,dispute.status,dispute.evidenceDueAt,
          at,at,closed?at:null));
        if(order){
          statements.push(db.prepare(lost?
            "UPDATE commerce_orders SET status='chargeback_lost',updated_at=? WHERE id=? AND stripe_charge_id=? AND status IN ('paid','partially_refunded','refunded','disputed','chargeback_lost')":
            "UPDATE commerce_orders SET status='disputed',updated_at=? WHERE id=? AND stripe_charge_id=? AND status IN ('paid','partially_refunded','refunded','disputed')"
          ).bind(at,order.id,dispute.chargeId));
          statements.push(db.prepare(
            "UPDATE entitlements SET status='revoked' WHERE user_id=? AND entitlement_type='purchase' AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?) AND status='active'"
          ).bind(order.user_id,order.id));
          statements.push(db.prepare(
            "UPDATE audio_offline_licenses SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason='order_disputed' WHERE status='active' AND entitlement_id IN (SELECT id FROM entitlements WHERE user_id=? AND entitlement_type='purchase' AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?))"
          ).bind(at,order.user_id,order.id));
          statements.push(db.prepare(
            "UPDATE commercial_delivery_grants SET status='revoked' WHERE status='active' AND user_id=? AND entitlement_id IN (SELECT id FROM entitlements WHERE user_id=? AND entitlement_type='purchase' AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?))"
          ).bind(order.user_id,order.user_id,order.id));
          const postings:Array<[string,string,number]>=[
            ["dispute_open","dispute_receivable",dispute.amountMinor],
            ["dispute_open","stripe_receivable",-dispute.amountMinor]
          ];
          if(lost)postings.push(["dispute_lost","chargeback_loss",dispute.amountMinor],
            ["dispute_lost","dispute_receivable",-dispute.amountMinor]);
          if(won)postings.push(["dispute_won","stripe_receivable",dispute.amountMinor],
            ["dispute_won","dispute_receivable",-dispute.amountMinor]);
          for(const [type,account,amount] of postings){
            const marker="led_dispute:"+dispute.id+":"+type+":"+account;
            statements.push(db.prepare(
              "INSERT INTO commerce_ledger_entries(id,order_id,refund_id,user_id,entry_type,account_code,amount_minor,currency,external_reference,metadata_json,created_at) SELECT ?,?,NULL,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM commerce_ledger_entries WHERE id=?)"
            ).bind(marker,order.id,order.user_id,type,account,amount,dispute.currency,
              dispute.id,JSON.stringify({disputeId:dispute.id}),at,marker));
          }
        }
        await db.batch(statements);
        const recorded=await db.prepare(
          "SELECT provider_dispute_id,order_id,charge_id,amount_minor,currency,status FROM commerce_disputes WHERE provider_dispute_id=?"
        ).bind(dispute.id).first<{provider_dispute_id:string;order_id:string|null;
          charge_id:string;amount_minor:number;currency:string;status:string}>();
        if(!recorded||recorded.provider_dispute_id!==dispute.id||
           (recorded.order_id||"")!==(order?.id||"")||
           recorded.charge_id!==dispute.chargeId||
           recorded.amount_minor!==dispute.amountMinor||
           recorded.currency!==dispute.currency||
           recorded.status!==dispute.status)
          throw Error("owner_dispute_canonical_commit_unconfirmed");
        if(order){
          const expected:Array<[string,string,number]>=[
            ["dispute_open","dispute_receivable",dispute.amountMinor],
            ["dispute_open","stripe_receivable",-dispute.amountMinor]
          ];
          if(lost)expected.push(["dispute_lost","chargeback_loss",dispute.amountMinor],
            ["dispute_lost","dispute_receivable",-dispute.amountMinor]);
          if(won)expected.push(["dispute_won","stripe_receivable",dispute.amountMinor],
            ["dispute_won","dispute_receivable",-dispute.amountMinor]);
          for(const [type,account,amount] of expected){
            const marker="led_dispute:"+dispute.id+":"+type+":"+account;
            const entry=await db.prepare(
              "SELECT order_id,entry_type,account_code,amount_minor,currency,external_reference FROM commerce_ledger_entries WHERE id=?"
            ).bind(marker).first<{order_id:string;entry_type:string;account_code:string;
              amount_minor:number;currency:string;external_reference:string}>();
            if(!entry||entry.order_id!==order.id||entry.entry_type!==type||
               entry.account_code!==account||entry.amount_minor!==amount||
               entry.currency!==dispute.currency||entry.external_reference!==dispute.id)
              throw Error("owner_dispute_ledger_unreconciled");
          }
          if(lost)await reverseRoyaltiesForChargeback(db,order.id,dispute.id);
          if(readPaidOrderPermission(sql,{orderId:order.id}).allowed!==false)
            throw Error("owner_dispute_denial_lost");
        }
        return Response.json({schema:"cove.owner-dispute-sync.v1",
          disputeId:dispute.id,synced:true,linked:!!order,ownerDenied:!!order,
          accountingReconciled:true},{status:200,headers:noStore});
      }
      if(route==="/commercial/refund/record-provider"){
        // Synthetic QA owner lease + private DO bearer are enforced above.
        // Production must separately certify provider evidence provenance.
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          throw Error("invalid_refund_provider_command");
        const q=raw as Record<string,unknown>;
        const validId=/^[a-zA-Z0-9_-]{8,160}$/;
        const provider=/^re_[a-zA-Z0-9_-]{4,200}$/;
        const payment=/^pi_[a-zA-Z0-9_-]{4,200}$/;
        const accepted=new Set(["pending","requires_action","succeeded","failed","canceled"]);
        if(Object.keys(q).sort().join(",")!==
             "amountMinor,currency,orderId,paymentIntentId,providerRefundId,refundId,status"||
           typeof q.orderId!=="string"||!validId.test(q.orderId)||
           typeof q.refundId!=="string"||!validId.test(q.refundId)||
           typeof q.providerRefundId!=="string"||!provider.test(q.providerRefundId)||
           typeof q.paymentIntentId!=="string"||!payment.test(q.paymentIntentId)||
           typeof q.currency!=="string"||!/^[A-Z]{3}$/.test(q.currency)||
           typeof q.status!=="string"||!accepted.has(q.status)||
           !Number.isSafeInteger(q.amountMinor)||Number(q.amountMinor)<=0||
           Number(q.amountMinor)>1_000_000_000_000)
          throw Error("invalid_refund_provider_command");
        const refund=await env.PRIMARY_DB.prepare(
          "SELECT id,order_id,provider_refund_id,stripe_amount_minor,currency,status,succeeded_at FROM commerce_refunds WHERE id=?"
        ).bind(q.refundId).first<{id:string;order_id:string;provider_refund_id:string|null;
          stripe_amount_minor:number;currency:string;status:string;succeeded_at:string|null}>();
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,stripe_payment_intent_id,currency FROM commerce_orders WHERE id=?"
        ).bind(q.orderId).first<{id:string;stripe_payment_intent_id:string|null;currency:string}>();
        if(!refund||refund.id!==q.refundId||refund.order_id!==q.orderId||
           !order||order.id!==q.orderId||
           order.stripe_payment_intent_id!==q.paymentIntentId||
           order.currency!==q.currency||refund.currency!==q.currency||
           Number(refund.stripe_amount_minor)!==q.amountMinor||
           (refund.provider_refund_id&&refund.provider_refund_id!==q.providerRefundId))
          throw Error("owner_refund_provider_scope_mismatch");
        if(readPaidOrderPermission(sql,{orderId:q.orderId}).allowed!==false)
          throw Error("owner_refund_denial_required");
        // The private owner independently GETs Stripe's current refund
        // using its own credential. An adapter may not forge financial proof.
        const providerStatus=await independentlyVerifyOwnerStripeRefund(env,{
          orderId:q.orderId as string,refundId:q.refundId as string,
          providerRefundId:q.providerRefundId as string,
          paymentIntentId:q.paymentIntentId as string,
          amountMinor:q.amountMinor as number,currency:q.currency as string,
          status:q.status as string
        });
        if((refund.succeeded_at||refund.status==="succeeded")&&
           providerStatus!=="succeeded")
          throw Error("owner_refund_provider_regressed_after_success");
        // A late pending webhook cannot downgrade a Stripe-verified success.
        const state=refund.succeeded_at||refund.status==="succeeded"?
          "succeeded":providerStatus;
        if(refund.provider_refund_id!==q.providerRefundId||refund.status!==state){
          const write=await env.PRIMARY_DB.prepare(
            "UPDATE commerce_refunds SET provider_refund_id=?,status=CASE WHEN succeeded_at IS NOT NULL OR status='succeeded' THEN 'succeeded' ELSE ? END,updated_at=? WHERE id=? AND order_id=? AND (provider_refund_id IS NULL OR provider_refund_id=?)"
          ).bind(q.providerRefundId,state,new Date().toISOString(),
            q.refundId,q.orderId,q.providerRefundId).run() as {meta?:{changes?:number}};
          if((write.meta?.changes??0)===0)
            throw Error("owner_refund_provider_write_conflict");
        }
        const confirmed=await env.PRIMARY_DB.prepare(
          "SELECT id,order_id,provider_refund_id,status FROM commerce_refunds WHERE id=?"
        ).bind(q.refundId).first<{
          id:string;order_id:string;provider_refund_id:string|null;status:string}>();
        if(!confirmed||confirmed.id!==q.refundId||
           confirmed.order_id!==q.orderId||
           confirmed.provider_refund_id!==q.providerRefundId||
           confirmed.status!==state)
          throw Error("owner_refund_provider_confirmation_failed");
        return Response.json({schema:"cove.owner-refund-provider.v1",
          orderId:q.orderId,refundId:q.refundId,
          providerRefundId:q.providerRefundId,status:confirmed.status,
          ownerDenied:true,providerRecorded:true},
          {status:200,headers:noStore});
      }
      if(route==="/commercial/refund/post-accounting"){
        // Canonical finance posting is never delegated to caller-supplied SQL.
        // Only a persisted Stripe-success (or internal tender) refund under
        // the already durable whole-order owner veto can post. No rollback of
        // the owner denial occurs when D1 fails or a retry is interrupted.
        const receipt=await executeOwnerRefundAccounting(env.PRIMARY_DB,sql,raw,postRefundAccountingPrivate);
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/deny-batch"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          denyPaidEntitlementsBatch(sql,raw)
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>denyPaidEntitlement(sql,raw));
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/commercial/entitlement/authorize"){
        const row=readPaidAccess(sql,raw);
        return Response.json({schema:"cove.paid-access.v1",allowed:!!row,proof:row},
          {headers:noStore});
      }
      if(route==="/commercial/entitlement/publish-order-verified"){
        // No caller-supplied entitlement list is trusted. The strong owner
        // discovers ALL canonical lines for this exact paid order and
        // verifies their immutable purchase scopes against its own legal
        // grants. One DO transaction then publishes the entire cart or none.
        const q=raw as {orderId?:unknown;userId?:unknown;
          territory?:unknown;channel?:unknown}|null;
        if(!q||typeof q.orderId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(q.orderId)||
           typeof q.userId!=="string"||
           !/^[a-zA-Z0-9_-]{8,160}$/.test(q.userId)||
           typeof q.territory!=="string"||!/^[A-Z]{2}$/.test(q.territory)||
           q.channel!=="retail")
          return new Response(null,{status:400,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id,territory_code,status FROM commerce_orders WHERE id=? AND user_id=?"
        ).bind(q.orderId,q.userId).first<{
          id:string;user_id:string;territory_code:string;status:string
        }>();
        if(!order||order.status!=="paid"||order.territory_code!==q.territory)
          return new Response(null,{status:409,headers:noStore});
        const items=(await env.PRIMARY_DB.prepare(
          `SELECT oi.id,oi.product_id,oi.sales_channel,oi.preorder_id,
                  oi.entitlement_status,oi.rights_grant_id,oi.rights_snapshot_json,
                  e.id entitlement_id,e.status entitlement_state,e.source entitlement_source,
                  e.starts_at entitlement_starts_at,e.ends_at entitlement_ends_at
             FROM commerce_order_items oi LEFT JOIN entitlements e
               ON e.order_item_id=oi.id AND e.user_id=? AND
                  e.product_id=oi.product_id AND e.entitlement_type='purchase'
            WHERE oi.order_id=? ORDER BY oi.id LIMIT 26`
        ).bind(q.userId,q.orderId).all<{
          id:string;product_id:string;sales_channel:string;
          preorder_id:string|null;entitlement_status:string;
          rights_grant_id:string|null;rights_snapshot_json:string|null;
          entitlement_id:string|null;entitlement_state:string|null;
          entitlement_source:string|null;entitlement_starts_at:string|null;
          entitlement_ends_at:string|null;
        }>()).results;
        if(!items.length||items.length>25||
           new Set(items.map(x=>x.product_id)).size!==items.length)
          return new Response(null,{status:409,headers:noStore});
        // Preorders never mint a downloadable entitlement in this path.
        const delivered=items.filter(x=>!x.preorder_id);
        if(!delivered.length)
          return new Response(null,{status:409,headers:noStore});
        if(delivered.some(x=>x.entitlement_status!=="granted"||
           x.entitlement_state!=="active"||x.entitlement_source!=="commerce"||
           x.sales_channel!=="retail"||!x.entitlement_id))
          return new Response(null,{status:409,headers:noStore});
        // Read-only canonical buyer risk gate. Each denied/held line
        // invalidates the full cart, not just an individual ebook.
        const hold=await env.PRIMARY_DB.prepare(
          "SELECT 1 ok FROM risk_holds WHERE domain='buyer' AND subject_type='order' AND subject_id=? AND status='active' AND hold_scope IN ('checkout','entitlement') LIMIT 1"
        ).bind(q.orderId).first<{ok:number}>();
        if(hold)return new Response(null,{status:409,headers:noStore});
        const lines:VerifiedPaidOrderLine[]=[];
        const now=Date.now();
        for(const item of delivered){
          // A multi-book cart obeys the same time window as a single
          // purchase. Invalid canonical timestamps fail closed rather than
          // issuing a fresh five-minute owner lease for an expired line.
          const starts=item.entitlement_starts_at===null?null:
            Date.parse(item.entitlement_starts_at);
          const ends=item.entitlement_ends_at===null?null:
            Date.parse(item.entitlement_ends_at);
          if((starts!==null&&(!Number.isFinite(starts)||starts>now))||
             (ends!==null&&(!Number.isFinite(ends)||ends<=now)))
            return new Response(null,{status:409,headers:noStore});
          const rows=readCommercialProofs(sql,[item.product_id],
            q.territory,"retail");
          if(rows.length!==1)return new Response(null,{status:409,headers:noStore});
          const rights=rows[0]!;
          let purchased:unknown;
          try{purchased=JSON.parse(item.rights_snapshot_json||"null");}
          catch{return new Response(null,{status:409,headers:noStore});}
          const acquired=purchased as {
            grantId?:unknown;editionId?:unknown;territory?:unknown;
            salesChannel?:unknown;contractId?:unknown;contractVersionId?:unknown
          }|null;
          if(!acquired||acquired.grantId!==item.rights_grant_id||
             acquired.grantId!==rights.grant_id||
             acquired.editionId!==rights.edition_id||
             acquired.contractId!==rights.contract_id||
             acquired.contractVersionId!==rights.contract_version_id||
             acquired.territory!==q.territory||acquired.salesChannel!=="retail")
            return new Response(null,{status:409,headers:noStore});
          const expiry=Math.min(now+5*60_000,Date.parse(rights.valid_until),
            ends??Number.POSITIVE_INFINITY);
          if(!Number.isFinite(expiry)||expiry<=now)
            return new Response(null,{status:409,headers:noStore});
          const scope={
            entitlementId:item.entitlement_id!,userId:q.userId,
            productId:item.product_id
          };
          lines.push({...scope,territory:q.territory,channel:"retail",
            orderId:q.orderId,productEpoch:rights.epoch,
            validUntil:new Date(expiry).toISOString(),
            expectedEpoch:captureEntitlementEpoch(sql,scope)});
        }
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          publishVerifiedPaidOrderAtomic(sql,lines,Date.now())
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/entitlement/publish-verified"){
        const scope=validatePaidEntitlementScope(raw);
        const input=raw as {territory?:unknown;channel?:unknown};
        if(typeof input.territory!=="string" ||
           !/^[A-Z]{2}$/.test(input.territory)||
           !["retail","subscription","library"].includes(String(input.channel)))
          return new Response(null,{status:400,headers:noStore});
        // Product permission must already be published. Entitlement alone
        // NEVER overrides a global paid-contract withdrawal.
        const rights=readCommercialProofs(sql,[scope.productId],
          input.territory,input.channel as CommercialChannel);
        if(rights.length!==1)return new Response(null,{status:409,headers:noStore});
        const expected=captureEntitlementEpoch(sql,scope);
        const ent=await env.PRIMARY_DB.prepare(
          "SELECT id,user_id,product_id,status,entitlement_type,source,starts_at,ends_at,order_item_id FROM entitlements WHERE id=? AND user_id=? AND product_id=?"
        ).bind(scope.entitlementId,scope.userId,scope.productId)
          .first<{id:string;user_id:string;product_id:string;status:string;
            entitlement_type:string;source:string;starts_at:string|null;
            ends_at:string|null;order_item_id:string|null}>();
        if(!ent||ent.status!=="active"||ent.entitlement_type!=="purchase"||
           ent.source!=="commerce"||!ent.order_item_id)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const starts=ent.starts_at===null?null:Date.parse(ent.starts_at);
        const ends=ent.ends_at===null?null:Date.parse(ent.ends_at);
        if((starts!==null&&(!Number.isFinite(starts)||starts>now))||
           (ends!==null&&(!Number.isFinite(ends)||ends<=now)))
          return new Response(null,{status:409,headers:noStore});
        const order=await env.PRIMARY_DB.prepare(
          "SELECT co.id order_id,co.territory_code,coi.sales_channel,coi.preorder_id,coi.entitlement_status,co.status order_status,coi.rights_grant_id,coi.rights_snapshot_json FROM commerce_order_items coi JOIN commerce_orders co ON co.id=coi.order_id WHERE coi.id=? AND coi.product_id=? AND co.user_id=?"
        ).bind(ent.order_item_id,scope.productId,scope.userId)
          .first<{order_id:string;territory_code:string;sales_channel:string;preorder_id:string|null;
          entitlement_status:string;order_status:string;
          rights_grant_id:string|null;rights_snapshot_json:string|null}>();
        if(!order||order.entitlement_status!=="granted"||
           order.order_status!=="paid" ||order.preorder_id!==null||
           order.territory_code!==input.territory||
           order.sales_channel!==input.channel||
           order.rights_grant_id!==rights[0].grant_id)
          return new Response(null,{status:409,headers:noStore});
        // This compatibility endpoint may only publish a genuinely
        // single-delivery order. Otherwise a caller could expose the first
        // valid line of a cart whose second line fails atomic certification.
        // Preorders are financial reservations and do not deliver here.
        const inventory=await env.PRIMARY_DB.prepare(
          "SELECT COUNT(*) delivery_count FROM commerce_order_items WHERE order_id=? AND preorder_id IS NULL"
        ).bind(order.order_id).first<{delivery_count:number}>();
        if(!inventory||inventory.delivery_count!==1)
          return new Response(null,{status:409,headers:noStore});
        let purchased:unknown=null;
        try{purchased=JSON.parse(order.rights_snapshot_json||"");}
        catch{return new Response(null,{status:409,headers:noStore});}
        // The paid order's original acquisition identity must match ALL
        // dimensions of the fresh legal proof, not only a contract version.
        // An unrelated grant, edition, contract or market cannot launder
        // a settled buyer entitlement into a new legal scope.
        const acquired=purchased as {
          grantId?:unknown;editionId?:unknown;territory?:unknown;
          salesChannel?:unknown;contractId?:unknown;contractVersionId?:unknown
        }|null;
        if(!acquired ||
           acquired.grantId!==rights[0].grant_id ||
           acquired.editionId!==rights[0].edition_id ||
           acquired.territory!==input.territory ||
           acquired.salesChannel!==input.channel ||
           acquired.contractId!==rights[0].contract_id ||
           acquired.contractVersionId!==rights[0].contract_version_id)
          return new Response(null,{status:409,headers:noStore});
        const hold=await env.PRIMARY_DB.prepare(
          "SELECT 1 ok FROM risk_holds rh JOIN commerce_order_items oi ON oi.order_id=rh.subject_id WHERE rh.domain='buyer' AND rh.subject_type='order' AND rh.status='active' AND rh.hold_scope IN ('checkout','entitlement') AND oi.id=? LIMIT 1"
        ).bind(ent.order_item_id).first<{ok:number}>();
        if(hold)return new Response(null,{status:409,headers:noStore});
        const expiry=Math.min(Date.now()+5*60000,
          ends??Number.POSITIVE_INFINITY,
          Date.parse(rights[0].valid_until));
        if(!Number.isFinite(expiry)||expiry<=Date.now())
          return new Response(null,{status:409,headers:noStore});
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_paid_entitlement_verification");
          return publishFreshEntitlement(sql,{...scope,
            // The owner core must receive the exact acquisition market.
            // Omitting either field rejects all positive buyer publication.
            territory:input.territory,channel:input.channel as CommercialChannel,
            orderId:order.order_id,productEpoch:rights[0].epoch,
            validUntil:new Date(expiry).toISOString()
          },expected);
        });
        return Response.json(receipt,{status:receipt.applied?200:409,headers:noStore});
      }
      if(route==="/commercial/subject/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>denyCommercialSubject(sql,raw));
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/deny-batch"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>
          denyCommercialProductsBatch(sql,raw)
        );
        return Response.json(receipt,{status:200,headers:noStore});
      }
      if(route==="/commercial/deny-next"){
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>
          denyCommercialProduct(sql,raw)
        );
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      // Mixed free and contract-backed paid shelf. The entire authorization
      // happens under one strongly consistent SQLite owner, never primary D1.
      // Missing/unpublished rows are absent, not inferred from KV/R2.
      if(route==="/storefront/authorize-batch"){
        const input=raw as {ids?:unknown;territory?:unknown;currency?:unknown};
        if(!input||!Array.isArray(input.ids)||input.ids.length>128||
           new Set(input.ids).size!==input.ids.length||
           input.ids.some(id=>typeof id!=="string"||
             !/^prd_[a-zA-Z0-9_-]{3,120}$/.test(id))||
           typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
           typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        const free=input.ids.filter((id):id is string=>
          typeof id==="string"&&id.startsWith("prd_gutenberg_"));
        const paid=input.ids.filter((id):id is string=>
          typeof id==="string"&&!id.startsWith("prd_gutenberg_"));
        const rows=[
          ...readAuthorizedPresentations(sql,free,input.territory,input.currency),
          ...readCommercialStorefront(sql,paid,input.territory,input.currency)
        ];
        const position=new Map(input.ids.map((id,i)=>[id,i]));
        rows.sort((a,b)=>(position.get(a.product_id)??129)-(position.get(b.product_id)??129));
        return Response.json({schema:"cove.storefront-owner.v1",rows:rows.slice(0,25)},
          {headers:noStore});
      }
      if(route==="/storefront/publish-commercial"){
        const input=raw as {productId?:unknown;territory?:unknown;currency?:unknown};
        if(!input||typeof input.productId!=="string"||
           !commercialProductId.test(input.productId)||
           input.productId.startsWith("prd_gutenberg_")||
           typeof input.territory!=="string"||!/^[A-Z]{2}$/.test(input.territory)||
           typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
          return new Response(null,{status:400,headers:noStore});
        const rights=readCommercialProofs(sql,[input.productId],
          input.territory,"retail");
        if(rights.length!==1)return new Response(null,{status:409,headers:noStore});
        const row=(await authorizeStorefrontPresentationIds(
          env.PRIMARY_DB,[input.productId],input.territory,input.currency
        ))[0];
        if(!row||row.product_id!==input.productId||
           row.edition_id!==rights[0].edition_id||
           !row.offer_json)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const expires=Math.min(now+5*60_000,Date.parse(rights[0].valid_until));
        const storage=this.ctx.storage as typeof this.ctx.storage&{
          transactionSync<T>(fn:()=>T):T;
        };
        const receipt=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_offer_verification");
          return publishCommercialStorefront(sql,{
            product_id:row.product_id,edition_id:row.edition_id,
            product_public_id:row.product_public_id,
            edition_public_id:row.edition_public_id,
            territory:input.territory as string,currency:input.currency as string,
            rights_epoch:rights[0].epoch,
            grant_id:rights[0].grant_id,contract_id:rights[0].contract_id!,
            contract_version_id:rights[0].contract_version_id!,
            offer_json:row.offer_json!,
            valid_until:new Date(expires).toISOString()
          });
        });
        return Response.json(receipt,{headers:noStore});
      }
      if(route==="/commercial/authorize-batch"){
        const input=raw as {ids?:unknown;territory?:unknown;channel?:unknown};
        if(!input||!Array.isArray(input.ids)||
           typeof input.territory!=="string"||typeof input.channel!=="string")
          return new Response(null,{status:400,headers:noStore});
        const rows=readCommercialProofs(
          sql,input.ids,input.territory,input.channel as CommercialChannel
        );
        return Response.json({schema:"cove.commercial-legal.v1",rows},
          {headers:noStore});
      }
      if(route==="/commercial/publish-verified"){
        const input=raw as {productId?:unknown;territory?:unknown;channel?:unknown};
        if(!input||typeof input.productId!=="string"||
           !commercialProductId.test(input.productId) ||
           input.productId.startsWith("prd_gutenberg_")||
           typeof input.territory!=="string"||
           !/^[A-Z]{2}$/.test(input.territory)||
           !["retail","subscription","library"].includes(String(input.channel)))
          return new Response(null,{status:400,headers:noStore});
        if(sql.exec("SELECT 1 pending FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
          input.productId).toArray().length)
          return new Response(null,{status:409,headers:noStore});
        const startEpoch=captureCommercialEpoch(sql,input);
        const product=await env.PRIMARY_DB.prepare(
          "SELECT id,source_name,edition_id FROM products WHERE id=?"
        ).bind(input.productId).first<{
          id:string;source_name:string;edition_id:string
        }>();
        if(!product || ["gutenberg","upload"].includes(product.source_name))
          return new Response(null,{status:409,headers:noStore});
        // The canonical evaluator checks territorial grant priority, contract
        // version scope, license language, DRM, channel and current status.
        // Persist=false: owner publication does NOT add primary D1 writes.
        const decision=await resolveProductRights(
          env.PRIMARY_DB,input.productId,input.territory,{
            salesChannel:input.channel as CommercialChannel,persist:false
          }
        );
        if(!decision.allowed || !decision.grantId ||
           decision.editionId!==product.edition_id ||
           decision.productId!==product.id)
          return new Response(null,{status:409,headers:noStore});
        const now=Date.now();
        const upperBound=now+30*60*1000;
        const ends=[decision.endsAt,
          (decision.contractPolicy as {effectiveTo?:unknown}|null)?.effectiveTo]
          .filter((v):v is string=>typeof v==="string"&&v.length>0)
          .map(v=>Date.parse(v));
        if(ends.some(t=>!Number.isFinite(t) || t<=now))
          return new Response(null,{status:409,headers:noStore});
        const expiresAt=Math.min(upperBound,...ends);
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>{
          if(marketIsWithdrawn(sql,input.territory))
            throw Error("market_withdrawn_during_commercial_verification");
          return publishFreshCommercialProof(sql,{
            productId:product.id,editionId:product.edition_id,
            territory:input.territory as string,channel:input.channel as CommercialChannel,
            grantId:decision.grantId!,contractId:decision.contractId,
            contractVersionId:decision.contractVersionId,
            validUntil:new Date(expiresAt).toISOString(),
          },startEpoch);
        });
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/verify") {
        const input=raw as {sourceId?:unknown;territory?:unknown};
        if(!input||typeof input.sourceId!=="string"||typeof input.territory!=="string")
          return new Response(null,{status:400,headers:noStore});
        return Response.json(readAuthority(sql,input.sourceId,input.territory),
          {headers:noStore});
      }
      if(route==="/authorize-batch") {
        const input=raw as {ids?:unknown;territory?:unknown;currency?:unknown};
        if(!input||!Array.isArray(input.ids)||
           typeof input.territory!=="string"||typeof input.currency!=="string")
          return new Response(null,{status:400,headers:noStore});
        const rows=readAuthorizedPresentations(sql,input.ids,input.territory,input.currency);
        return Response.json({schema:"cove.legal-authorized.v1",rows},
          {headers:noStore});
      }
      if(route==="/deny-next-batch") {
        // Transaction boundary is mandatory even when an unexpected receipt
        // throws mid-batch: all owner fences persist or none persist.
        const storage=this.ctx.storage as typeof this.ctx.storage & {
          transactionSync<T>(fn:()=>T):T;
        };
        const verdict=storage.transactionSync(()=>
          persistSourceWithdrawalsBatch(sql,raw)
        );
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(route==="/deny-next") {
        const verdict=persistSourceWithdrawal(sql,raw);
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      const command=validateAuthorityCommand(raw);
      if(route==="/deny") {
        if(command.action!=="deny") return new Response(null,{status:400,headers:noStore});
        const verdict=applyAuthorityCommand(sql,command);
        // A stale/failed deny is NOT acknowledged as successful.
        return Response.json(verdict,{status:verdict.applied?200:409,headers:noStore});
      }
      if(command.action!=="allow"||command.territory==="*")
        return new Response(null,{status:400,headers:noStore});
      const input=raw as {currency?:unknown};
      if(typeof input.currency!=="string"||!/^[A-Z]{3}$/.test(input.currency))
        return new Response(null,{status:400,headers:noStore});
      // Positive transitions alone contact canonical primary D1. This
      // verifies a current retail grant, exact source/evidence/territory and
      // active market offer; the hot /verify path never consults D1.
      // It is NOT sufficient to enable production until ALL canonical legal
      // mutation writers have been enclosed in deny-first owner fencing.
      const proofStartRevision=capturePositiveVerificationFence(sql,command);
      const authorized=await authorizeStorefrontPresentationIds(
        env.PRIMARY_DB,["prd_gutenberg_"+command.sourceId],
        command.territory,input.currency
      );
      if(authorized.length!==1 ||
          authorized[0].product_id!=="prd_gutenberg_"+command.sourceId ||
          !authorized[0].offer_json)
        return new Response(null,{status:409,headers:noStore});
      const storage=this.ctx.storage as typeof this.ctx.storage&{
        transactionSync<T>(fn:()=>T):T;
      };
      const verdict=storage.transactionSync(()=>{
        if(marketIsWithdrawn(sql,command.territory))
          throw Error("market_withdrawn_during_source_verification");
        return commitFreshPositiveVerification(
        sql,command,proofStartRevision,input.currency as string,{
          productId:authorized[0].product_id,
          editionId:authorized[0].edition_id,
          productPublicId:authorized[0].product_public_id || null,
          editionPublicId:authorized[0].edition_public_id || null,
          offerJson:authorized[0].offer_json!,
        });
      });
      if(!verdict.applied)
        return Response.json(verdict,{status:409,headers:noStore});
      return Response.json(verdict,{status:200,headers:noStore});
    } catch(error) {
      console.error("cove_legal_authority_closed",error instanceof Error?error.name:"unknown");
      return new Response(null,{status:503,headers:route==="/commercial/order/settle"?
        {...noStore,"x-cove-owner-settlement-failure":ownerSettlementDiagnostic(error)}:noStore});
    }
  }
}
// Service-binding-only entrypoint for the separately authenticated QA caller.
// workers_dev=false, routes=[], no preview URLs; even this private entrypoint
// is disabled unless the dedicated QA primary ID and secret match exactly.
// The Durable Object remains the single legal serialization point.
export default {
  async fetch(request:Request,env:LegalAuthorityEnv):Promise<Response> {
    // Private service-binding proof only. The production owner stays
    // disabled for every existing rights, publication and payment route.
    if(new URL(request.url).pathname===DISABLED_OWNER_ATTEST_ROUTE){
      if(!isDisabledProductionOwner(env)||!env.LEGAL_AUTHORITY?.getByName)
        return new Response(null,{status:503,headers:{"cache-control":"no-store"}});
      if(request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
        return new Response(null,{status:401,headers:{"cache-control":"no-store"}});
      return env.LEGAL_AUTHORITY.getByName(PRODUCTION_OWNER_OBJECT).fetch(request);
    }
    if(!qaOwnerLeaseLive(env) || !env.LEGAL_AUTHORITY?.getByName)
      return new Response(null,{status:503,headers:{"cache-control":"no-store"}});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_RIGHTS_OWNER_SECRET)
      return new Response(null,{status:401,headers:{"cache-control":"no-store"}});
    return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1").fetch(request);
  }
};
