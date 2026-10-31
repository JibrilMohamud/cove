/* eslint-disable prettier/prettier -- Private legal-authority boundary is security-sensitive. */
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
import {ensurePreorderReleasePlan} from "../features/fore/preorder.server";
import {
  recordPublicationActivation,stableJson,safeJson,audit,ensurePublishingLifecycle,
  scopeToGrant,bucketBytes,ensureCatalogParties,publicationVersionManifest,
} from "../features/fore/publishing.server";
import {ownerContractVersionSchema} from "./owner-contract-version-schema";
import {ApiError} from "../features/fore/service";
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
  captureEntitlementEpoch,createPaidEntitlementSchema,
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

type LegalAuthorityEnv = {
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
      await ensurePreorderReleasePlan(db as any, productId, reviewerUserId);
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
      await ensurePreorderReleasePlan(db as any, String(m.productId), null);
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

export class CoveLegalAuthority extends DurableObject<LegalAuthorityEnv> {
  private publicationExecutions=new Set<string>();
  private contractExecutions=new Set<string>();
  private publicationRecoveryRunning=false;
  private partnerFeedRunning=false;
  private settlementExecutions=new Set<string>();
  private settlementRecoveryRunning=false;
  constructor(ctx: { storage: { sql: unknown } }, env: LegalAuthorityEnv) {
    super(ctx, env);
    createAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createAuthorityProofSchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createCommercialStorefrontSchema(ctx.storage.sql as unknown as AuthoritySql);
    createPaidEntitlementSchema(ctx.storage.sql as unknown as AuthoritySql);
    createMarketAuthoritySchema(ctx.storage.sql as unknown as AuthoritySql);
    createPublicationMaterializationSchema(ctx.storage.sql as unknown as AuthoritySql);
    createContractVersionOwnerSchema(ctx.storage.sql as unknown as AuthoritySql);
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
      "/publishing/onboarding/review",
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
      if(bytes.length>(route==="/publishing/contract/save-version"?32768:route==="/commercial/checkout/create-quote"?4096:route==="/publishing/onboarding/review"?8192:route==="/commercial/checkout/materialize-draft"?2048:["/authorize-batch","/deny-next-batch","/commercial/authorize-batch","/commercial/deny-batch","/commercial/entitlement/deny-batch","/storefront/authorize-batch"].includes(route)?24000:1024)) return new Response(null,{status:413,headers:noStore});
      raw=JSON.parse(bytes);
    }catch {return new Response(null,{status:400,headers:noStore});}
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
