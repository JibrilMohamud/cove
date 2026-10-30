/* eslint-disable prettier/prettier -- Private legal-authority boundary is security-sensitive. */
import {ownerSettlementDiagnostic} from "./owner-settlement-diagnostic";
import { DurableObject } from "cloudflare:workers";
import {DISABLED_OWNER_ATTEST_ROUTE,PRODUCTION_OWNER_OBJECT,isDisabledProductionOwner,validOwnerChallenge,disabledOwnerReceipt} from "./production-disabled-owner-attestation";
import {publishVerifiedPaidOrderAtomic,type VerifiedPaidOrderLine} from "./paid-order-atomic-publication";
import {executeOwnerRefundAccounting} from "./refund-accounting-owner-executor";
import {executeOwnerRefundReservation} from "./refund-reservation-owner-executor";
import {executeOwnerCheckoutPaymentBinding} from "./checkout-payment-binding-owner-executor";
import {executeOwnerPaidSettlement} from "./paid-settlement-owner-executor";
import {upsertRightsGrant} from "../features/fore/rights.server";
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
import { authorizeStorefrontPresentationIds, type CatalogDB } from "../features/fore/catalog-model.server";
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
    const grant = await upsertRightsGrant(db as any, {
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
export class CoveLegalAuthority extends DurableObject<LegalAuthorityEnv> {
  private publicationExecutions=new Set<string>();
  private contractExecutions=new Set<string>();
  private publicationRecoveryRunning=false;
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
      "/commercial/checkout/register-stripe-customer",
      "/commercial/checkout/attach-payment-intent",
      "/commercial/payment/update-state",
      "/commercial/webhook/claim",
      "/commercial/webhook/finish",
      "/commercial/refund/post-accounting",
      "/commercial/refund/record-provider",
      "/commercial/entitlement/deny-next","/commercial/entitlement/deny-batch",
      "/commercial/entitlement/publish-verified",
      "/commercial/entitlement/publish-order-verified",
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
      if(bytes.length>(route==="/publishing/contract/save-version"?32768:["/authorize-batch","/deny-next-batch","/commercial/authorize-batch","/commercial/deny-batch","/commercial/entitlement/deny-batch","/storefront/authorize-batch"].includes(route)?24000:1024)) return new Response(null,{status:413,headers:noStore});
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
        // Provider identity is immutable and succeeded cannot regress under
        // out-of-order signed Stripe webhooks or caller retries.
        const state=refund.succeeded_at||refund.status==="succeeded"?
          "succeeded":q.status;
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
