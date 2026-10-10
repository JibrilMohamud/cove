import {createAuth,resolvedIdentity} from "./auth.server";
import {mirrorUrl} from './gutenberg-source';
import {
  canonicalizeRegionalDocument,
  canonicalizeRegionalEpub,
  fetchRegionalCatalog,
  fetchRegionalResource,
  regionalSourceConfig,
  sha256Hex,
  trustedRegionalAssetUrl,
  verifyEuropeRightsEvidence,
  type RegionalCatalogItem,
  type RegionalSourceId,
} from './gutenberg-federation.server';
import { z } from "zod";
import { addSeriesToCart, editionResolve, readingDataExport, seriesDetail, workDetail } from "./discovery.server";
import { ApiError, rateLimit } from "./service";
import { handleCommunity, migrateLegacy } from "./community.server";
import { handleSocial, recordReadingProgress, ensureReadingJourney, processAuthorSocialFanoutJobs } from "./social.server";
import {handlePipeline} from "./pipeline.server";
import { handleAudio } from "./audio.server";
import { handleVercelPublicRequest } from "./vercel-public.server";
import {
  commercialAudioPublisherSnapshot, saveCommercialAudioProfile, replaceCommercialAudioNarrators,
  addNarrationAgreement, endNarrationAgreement, uploadCommercialAudioFile, completeCommercialAudioQc, leaseCommercialAudioQcJobs,
  saveCommercialBiosyncLink, listCommercialAudiobooks, handleCommercialAudio
} from "./commercial-audio.server";
import {
  accountOverview, accountDataExport, saveAccountPreferences, saveAccountAddress, deleteAccountAddress,
  registerDevice, revokeAccountSession, revokeDevice, requestAccountDeletion, cancelAccountDeletion,
  processAccountDeletionQueue
} from "./account-management.server";
import { supportSearch,createSupportCase,supportCaseDetail,addSupportNote,executeSupportAction } from "./support.server";
import {
  notificationInbox, notificationPreferences, saveNotificationPreferences,
  registerPushEndpoint, revokePushEndpoint, markNotifications, processNotificationDeliveryQueue
} from "./notifications.server";
import {
  issueCommercialEpubGrant, serveCommercialEpubGrant, revokeDeliveryGrant, ownershipStatus,
  setDistributionControl, setCommercialDeliveryPolicy, snapshotAnnotationAnchor
} from "./delivery.server";
import JSZip from "jszip";
import seed from "./catalog-seed.json";
import type { CatalogBook } from "./client";
import {
  parseSearchInput,
  recordSearchClick,
  rebuildSearchIndex,
  searchCatalog,
  searchStatus,
  searchSuggestions,
  syncSearchIndex,
} from "./search.server";
import {
  catalogIds,
  commercialCatalogStatements,
  getCanonicalBook,
  personalImportStatements,
  resolveProduct,
} from "./catalog-model.server";
import {
  adminTaxonomySnapshot,
  resolveStorefrontPage,
  setManualEditionTaxonomy,
  syncEditionTaxonomy,
  syncTaxonomyBatch,
  taxonomyTree,
  upsertStorefrontPage,
  upsertTaxonomyMapping,
  upsertTaxonomyNode,
} from "./taxonomy.server";
import {
  adminMerchSnapshot,
  recordMerchEvent,
  setCollectionItems,
  storefrontMerchandising,
  upsertCampaign,
  upsertCollection,
  upsertExperiment,
  upsertPlacement,
} from "./merchandising.server";
import {
  bookRecommendations,
  followAuthor,
  homeRecommendations,
  processRecommendationJobs,
  runRecommendationMaintenance as maintainRecommendations,
  recommendationAccountState,
  recommendationFeedback,
  recommendationStatus,
  recordRecommendationEvent,
  rebuildItemNeighbors,
  refreshRecommendationEvaluations,
  refreshRecommendationMetrics,
  resetRecommendationProfile,
  setRecommendationPrivacy,
  upsertRecommendationExperiment,
  upsertRecommendationModel,
  wishlistProduct,
} from "./recommendations.server";
import {
  accountingCsv,
  adjustStoreCredit,
  captureAuthorizedOrder,
  cancelCheckoutOrder,
  commerceAdminSnapshot,
  checkoutQuote,
  commerceConfig,
  createCheckoutPayment,
  createPromoCode,
  invoiceRecord,
  invoiceHtml,
  issueGiftCard,
  orderDetail,
  orderHistory,
  reconcileStripe,
  recoverPayment,
  refundOrder,
  processPreorderRefundJobs,
  stripeWebhook,
  createBillingPortal,
  syncCustomerBillingMethods,
} from "./commerce.server";
import {
  addToCart,
  cartSnapshot,
  productDetail,
  previewPolicy,
  removeFromCart,
  runWishlistAlerts,
  savePreviewState,
  setWishlistItem,
  sharedWishlist,
  updateWishlistSharing,
  upsertPreviewPolicy,
  wishlistSnapshot,
} from "./retail.server";
import {
  approvePayoutBatch,
  createFinanceParty,
  createPayoutBatch,
  createRoyaltyContract,
  financeAdminSnapshot,
  settlePayoutBatch,
} from "./finance.server";
import { pricingAdminSnapshot, savePriceSchedule, upsertFxRate } from "./pricing.server";
import {
  createRiskPolicyVersion, manageRiskCase, reconcileCustomerTaxPeriod, registerPublisherTaxVerification, releaseRiskHold,
  refreshPublisherTaxReportingPeriod, riskOperationsSnapshot, riskTaxOperationsSnapshot, taxOperationsSnapshot, updatePublisherTaxReportingPeriod, upsertPublisherWithholdingRule, upsertRiskEntityLink, upsertTaxRegistration,
  verifyPublisherTaxWebhook,
} from "./risk-tax.server";
import {
  createRoyaltyContractVersion,
  recordUsageEvent,
  processUsageEventRoyalty,
  createUsagePool,
  allocateUsagePool,
} from "./royalty-engine.server";
import {
  creatorDashboard,
  creatorSalesCsv,
  creatorRoyaltyCsv,
  creatorStatementCsv,
  generateMonthlyStatement,
  refreshCreatorDailyMetrics,
  creatorTaxDocumentRecord,
  registerCreatorTaxDocument,
} from "./creator-reporting.server";
import {
  advancePreorders,
  customerCancelPreorder,
  customerPreorders,
  publisherCancelReleasePlan,
  publisherPreorderDashboard,
} from "./preorder.server";
import {
  advancePromotionCampaigns,
  cancelPromotionCampaign,
  createCampaignCoupon,
  promotionOperationsDashboard,
  publisherPromotionDashboard,
  recordStorefrontPromotionEvent,
  reviewPromotionCampaign,
  savePromotionCampaign,
  submitPromotionCampaign,
} from "./promotions.server";
import {
  adminPublishingSnapshot,
  advancePublishingReleaseSchedules,
  catalogPublishingAsset,
  completePublishingValidationJob,
  invitePublishingMember,
  leasePublishingValidationJobs,
  publishingReadiness,
  publishingSnapshot,
  publishingUploadLimit,
  openPublishingRevision,
  optInOwnedPublicationUpdate,
  rollbackPublishingVersion,
  readBoundedPublishingUpload,
  resolveDuplicateMatch,
  reviewPublishingOnboarding,
  reviewPublishingSubmission,
  savePenName,
  savePublishingAddress,
  savePublishingEdition,
  savePublishingTitle,
  signPublishingAccessibilityDeclaration,
  setPublishingUpdatePolicy,
  startIdentityVerification,
  submitPayoutAccount,
  submitPublishingEdition,
  submitTaxProfile,
  uploadPublishingAsset,
  upsertPublishingAccount,
} from "./publishing.server";
import {
  addModerationNote,
  bootstrapStaffPrincipal,
  decideModerationAppeal,
  executeModerationAction,
  manageModerationCase,
  manageStaffPrincipal,
  moderationDashboard,
  requireStaffPermission,
  submitAbuseReport,
  submitModerationAppeal,
} from "./moderation.server";
import {
  advanceRightsDisputeDeadlines,
  completeRightsEvidenceScanJob,
  completeRightsNotificationJob,
  leaseRightsEvidenceScanJobs,
  leaseRightsNotificationJobs,
  manageRepeatInfringerPolicy,
  publisherRightsSnapshot,
  publicPublishingPolicies,
  recordCopyrightCourtAction,
  resolveIdentitySimilarity,
  resolveRightsDispute,
  resolveRiskCluster,
  resolveSimilarityMatch,
  reviewRightsEvidence,
  rightsOperationsDashboard,
  signPublishingAiDisclosure,
  signPublishingRightsDeclaration,
  submitCopyrightCounterNotice,
  submitCopyrightNotice,
  uploadRightsEvidence,
  validateCopyrightCounterNotice,
  validateCopyrightNotice,
} from "./publishing-trust.server";
import {
  authorProfile,
  completeRetailEventOutbox,
  createRetailRankingPolicyVersion,
  createReviewIntegrityPolicyVersion,
  leaseRetailEventOutbox,
  processAuthorReleaseAlerts,
  publisherAuthorProfiles,
  queueAuthorReleaseAlerts,
  recordRetailEvent,
  refreshRetailDailyMetrics,
  refreshRetailRankings,
  retailChart,
  retailIntelligenceStatus,
  resolveReviewIntegritySignal,
  reviewAuthorVerification,
  saveAuthorProfile,
  setAuthorFollow,
  upsertRetailRiskLink,
} from "./retail-intelligence.server";
import {
  requestStorefrontTerritory,
  resolveProductRights,
  rightsAdminSnapshot,
  rightsAvailabilityCheck,
  territoryExpansionPreview,
  upsertRightsContract,
  upsertRightsGrant,
  upsertRightsParty,
  upsertTerritorySet,
} from "./rights.server";
import {
  authenticatePartnerRequest, assignPublisherContract, certifyPartnerProfile, deliverPartnerValidationResponses, issuePartnerCredential, partnerDashboard, partnerFeedAcknowledgement,
  processPartnerFeedQueue, reconcilePublicDomainWorks, rebuildWorkIdentityKeys, revealPartnerWebhookSecret, revokePartnerCredential, saveContractVersion,
  savePartnerChannel, savePartnerProfile, submitPartnerFeed, uploadPartnerAsset, uploadPartnerAssetBatch,
} from "./traditional-publishing.server";
import { localizationAdminSnapshot, recordStorefrontContext, resolveStorefrontContext, saveStorefrontPreferences, storefrontMarkets, storefrontPreferenceCookies, upsertMarket, upsertTaxonomyLocalization, upsertLocale, saveTranslationBundle, configureMarketOptions } from "./localization.server";
import { issueServiceCredential, requireServiceScope, revokeServiceCredential, saveServicePrincipal, servicePrincipalSnapshot } from "./privileged-access.server";
import { acknowledgeIncident, beginRequestTrace, deliverOperationalAlerts, operationsSnapshot, registerBackupArtifact, recordCapacityTest, recordErrorEvent, recordHttpRequest, recordRestoreDrill, refreshSloMeasurements, replayDeadLetter, runOperationalChecks, runSyntheticChecks, saveDeployment, saveMigrationControl, leaseOpsJobs, finishOpsJob, probeObjectStorage, probeCdnEdge, runTrackedWorker } from "./operations.server";
import {
  securityOperationsSnapshot, saveThreatModel, saveThreat, saveEdgeControl, verifySecurityHeaders, registerSecretReference, recordKeyRotation,
  recordSecurityScan, recordSbom, recordBuildProvenance, savePentest, submitDisclosureReport, manageDisclosureReport,
  declareSecurityIncident, updateSecurityIncident, setPublisherSecurityPolicy, updateSecurityFinding
} from "./security.server";
import {
  registerSyncClient, listSyncClients, revokeSyncClient, pushSyncBatch, pullSyncChanges, resolveSyncConflict, syncConflicts, syncBootstrapSnapshot,
  saveReaderSetting, readerSettings, listTextBookmarks, createTextBookmark, updateTextBookmark, deleteTextBookmark, recordSyncProjection
} from "./sync.server";

type Statement = {
  bind(...v: unknown[]): Statement;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
export type CoveEnv = {
  DB: { prepare(sql: string): Statement; batch(s: Statement[]): Promise<unknown> };
  BUCKET?: {
    get(key: string, options?: any): Promise<any>;
    head?(key: string): Promise<any>;
    put(key: string, value: any, opts?: any): Promise<any>;
    delete(key: string): Promise<void>;
  };
  GUTENDEX_BASE_URL?: string;
  GUTENBERG_MIRROR_BASE_URL?: string;
  FORE_GUTENBERG_CANADA_CATALOG_URL?: string;
  FORE_GUTENBERG_AUSTRALIA_CATALOG_URL?: string;
  FORE_GUTENBERG_EUROPE_FEED_URL?: string;
  FORE_GUTENBERG_EUROPE_TRUSTED_ORIGINS?: string;
  FORE_SEARCH_BACKEND?: string;
  FORE_SEARCH_URL?: string;
  FORE_SEARCH_SEARCH_KEY?: string;
  FORE_SEARCH_ADMIN_KEY?: string;
  FORE_SEARCH_INDEX?: string;
  FORE_SEARCH_EMBEDDER?: string;
  FORE_RECOMMENDER_URL?: string;
  FORE_RECOMMENDER_API_KEY?: string;
  FORE_RECOMMENDER_MODEL?: string;
  FORE_RECOMMENDER_TIMEOUT_MS?: string;
  FORE_STAFF_BOOTSTRAP_TOKEN?: string;
  FORE_PUBLISHING_AUTO_APPROVE_LOW_RISK?: string;
  FORE_PARTNER_WEBHOOK_MASTER_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  FORE_AUTH_MODE?: string;
  FORE_GOOGLE_ENABLED?: string;
  FORE_PUBLIC_URL?: string;
  FORE_DEFAULT_TERRITORY?: string;
  FORE_DMCA_AGENT_NAME?: string;
  FORE_DMCA_AGENT_EMAIL?: string;
  FORE_DMCA_AGENT_ADDRESS?: string;
  FORE_DMCA_AGENT_PHONE?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_VERSION?: string;
  STRIPE_TAX_ENABLED?: string;
  FORE_TAX_WEBHOOK_SECRET?: string;
  STRIPE_CAPTURE_METHOD?: string;
  STRIPE_MINIMUM_CHARGE_MINOR?: string;
  STRIPE_LIVEMODE?: string;
  FORE_EMAIL_API_URL?: string;
  FORE_EMAIL_API_KEY?: string;
  FORE_WEB_PUSH_API_URL?: string;
  FORE_WEB_PUSH_PUBLIC_KEY?: string;
  FORE_MOBILE_PUSH_API_URL?: string;
  FORE_PUSH_API_KEY?: string;
  FORE_ERROR_REPORTING_URL?: string;
  FORE_ERROR_REPORTING_TOKEN?: string;
  FORE_ALERT_WEBHOOK_URL?: string;
  FORE_ALERT_WEBHOOK_TOKEN?: string;
  FORE_ENVIRONMENT?: string;
  FORE_CSP_REPORT_URI?: string;
  FORE_SECURITY_CONTACT_EMAIL?: string;
  FORE_SECURITY_POLICY_URL?: string;
};
const now = () => new Date().toISOString();
async function requireStorefrontAdmin(request: Request, env: CoveEnv, permission = "storefront.manage") {
  return requireStaffPermission(database(env), identity(request), permission, request);
}
async function requireCommerceAdmin(request: Request, env: CoveEnv, permission = "commerce.manage") {
  return requireStaffPermission(database(env), identity(request), permission, request);
}
function requireStaffBootstrap(request: Request, env: CoveEnv) {
  const token = env.FORE_STAFF_BOOTSTRAP_TOKEN;
  if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) {
    throw new ApiError(403, "Staff bootstrap authorization required.");
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
function database(env: CoveEnv) {
  if (!env.DB)
    throw new ApiError(503, "Your reading room is temporarily unavailable. Please try again.");
  return env.DB;
}
function identity(request: Request) {
  const verified=resolvedIdentity(request);
  if(verified!==undefined)return verified;
  const id = request.headers.get("oai-authenticated-user-id");
  if (!id) return null;
  const email = request.headers.get("oai-authenticated-user-email") || "";
  let name = request.headers.get("oai-authenticated-user-full-name") || "";
  if (request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8")
    try {
      name = decodeURIComponent(name);
    } catch {}
  const assurance=request.headers.get("oai-authentication-assurance-level");
  return { id, email, name: name.slice(0, 100), registered: false, aal: assurance === "aal2" ? "aal2" : "aal1" as const, authProvider:"openai-host", authSubject:id, sessionFingerprint:undefined };
}
function requiredUser(request: Request) {
  const u = identity(request);
  if (!u) throw new ApiError(401, "Sign in to save your reading life.");
  return u;
}
const bookIdSchema = z.string().regex(/^(?:[1-9][0-9]{0,8}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100}|(?:upload|fore)_[a-f0-9-]{36}|prd_[a-f0-9]{32})$/);
async function body(request: Request, max = 60000) {
  const bytes = await bounded(request, max);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "Please send valid JSON.");
  }
}
async function bounded(response: Request | Response, max: number) {
  const size = Number(response.headers.get("content-length") || 0);
  if (size > max) throw new ApiError(413, "This file is too large. The EPUB limit is 25 MB.");
  if (!response.body) throw new ApiError(400, "The file was empty.");
  const reader = response.body.getReader();
  let len = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      len += value.byteLength;
      if (len > max) {
        await reader.cancel();
        throw new ApiError(413, "This file exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
async function cacheGet(env: CoveEnv, key: string) {
  try {
    const row = await database(env)
      .prepare("SELECT body FROM api_cache WHERE key = ? AND expires_at > ?")
      .bind(key, Date.now())
      .first();
    return row ? JSON.parse(row.body) : null;
  } catch {
    return null;
  }
}
async function cacheSet(env: CoveEnv, key: string, value: unknown, ttl = 21600000) {
  try {
    await database(env)
      .prepare(
        "INSERT INTO api_cache(key,body,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, expires_at=excluded.expires_at",
      )
      .bind(key, JSON.stringify(value), Date.now() + ttl)
      .run();
  } catch (e) {
    console.warn("Cache write unavailable");
  }
}
async function remoteJson(url: string) {
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(14000),
  });
  if (!r.ok)
    throw new ApiError(
      r.status === 404 ? 404 : 502,
      r.status === 404
        ? "No matching entry was found."
        : "The book service is taking a break. Please try again.",
    );
  return r.json();
}
function seedBook(id: string) {
  return (seed.results as unknown as CatalogBook[]).find((b) => String(b.id) === id);
}
const catalogBase = (env: CoveEnv) => {
  const raw = (env.GUTENDEX_BASE_URL || "https://gutendex.com").replace(/\/+$/, "");
  return raw.endsWith("/books") ? raw.slice(0, -6) : raw;
};
const firstCatalogUrl = (env: CoveEnv) => catalogBase(env) + "/books/?page=1";
const parseJsonArray = (value: unknown): any[] => {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const parseJsonObject = (value: unknown): Record<string, string> => {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
function rowBook(row: any): CatalogBook {
  return {
    id: row.id,
    title: row.title,
    authors: parseJsonArray(row.authors_json),
    summaries: row.summary ? [row.summary] : [],
    subjects: parseJsonArray(row.subjects_json),
    bookshelves: parseJsonArray(row.bookshelves_json),
    languages: parseJsonArray(row.languages_json),
    formats: parseJsonObject(row.formats_json),
    download_count: Number(row.download_count) || 0,
    copyright:
      row.copyright === null || row.copyright === undefined ? undefined : Boolean(row.copyright),
  };
}
function epubSource(formats: Record<string, string>) {
  return (
    formats["application/epub+zip"] ||
    formats["application/epub+zip;"] ||
    Object.entries(formats).find(([key]) => key.startsWith("application/epub"))?.[1] ||
    ""
  );
}
function canonicalAssetSource(formats: Record<string, string>) {
  const epub = epubSource(formats);
  if (epub) return { url: epub, mimeType: "application/epub+zip" as const };
  const html = formats["text/html"] || Object.entries(formats).find(([key]) => key.startsWith("text/html"))?.[1] || "";
  return html ? { url: html, mimeType: "text/html" as const } : null;
}
type CatalogSourceOptions = {
  sourceId?: "pg_us" | RegionalSourceId;
  sourceItemId?: string;
  sourceProject?: string;
  sourceLicenseUrl?: string;
  rightsStatus?: "pending" | "public-domain" | "permission" | "rejected" | "quarantined";
  rightsTerritories?: string[];
  rightsEvidenceUrl?: string;
  rightsEvidenceId?: string | null;
  commercialUseStatus?: "pending" | "approved" | "quarantined" | "rejected";
  trademarkCleanupRequired?: boolean;
  canonicalizationVersion?: string;
  sourceMetadata?: Record<string, unknown>;
  contentHash?: string;
};
export function catalogInsert(db: CoveEnv["DB"], book: any, sourceUrl: string, at: string, options: CatalogSourceOptions = {}) {
  const formats = book.formats || {};
  const sourceId = options.sourceId || "pg_us";
  const source = sourceId === "pg_us" ? epubSource(formats) : (canonicalAssetSource(formats)?.url || "");
  const sourceItemId = options.sourceItemId || String(book.id);
  const sourceProject = options.sourceProject || "Project Gutenberg";
  const sourceLicenseUrl = options.sourceLicenseUrl || "https://www.gutenberg.org/policy/license.html";
  const rightsStatus = options.rightsStatus || (book.copyright === false ? "public-domain" : "pending");
  const rightsTerritories = options.rightsTerritories || (sourceId === "pg_us" && book.copyright === false ? ["US"] : []);
  const commercialUseStatus = options.commercialUseStatus || (sourceId === "pg_us" && book.copyright === false ? "approved" : "pending");
  return db
    .prepare(
      `INSERT INTO gutenberg_source_cache(
        id,title,authors_json,summary,subjects_json,bookshelves_json,languages_json,formats_json,download_count,copyright,
        source_url,source_updated_at,first_ingested_at,updated_at,last_seen_at,ingest_status,ingest_attempts,last_error,
        epub_status,epub_attempts,epub_next_attempt_at,epub_cached_at,epub_last_error,
        source_id,source_item_id,source_project,source_license_url,rights_status,rights_territories_json,rights_evidence_url,
        rights_checked_at,rights_evidence_id,commercial_use_status,trademark_cleanup_required,canonicalization_version,source_metadata_json,content_hash
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,authors_json=excluded.authors_json,summary=excluded.summary,subjects_json=excluded.subjects_json,
        bookshelves_json=excluded.bookshelves_json,languages_json=excluded.languages_json,formats_json=excluded.formats_json,
        download_count=excluded.download_count,copyright=excluded.copyright,source_url=excluded.source_url,
        source_updated_at=excluded.source_updated_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,
        ingest_status='active',ingest_attempts=0,last_error='',source_id=excluded.source_id,source_item_id=excluded.source_item_id,
        source_project=excluded.source_project,source_license_url=excluded.source_license_url,
        rights_territories_json=excluded.rights_territories_json,rights_evidence_url=excluded.rights_evidence_url,
        source_metadata_json=excluded.source_metadata_json,content_hash=CASE WHEN gutenberg_source_cache.formats_json=excluded.formats_json AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN CASE WHEN excluded.content_hash<>'' THEN excluded.content_hash ELSE gutenberg_source_cache.content_hash END ELSE excluded.content_hash END,
        trademark_cleanup_required=excluded.trademark_cleanup_required,
        rights_status=CASE WHEN gutenberg_source_cache.commercial_use_status='approved' AND gutenberg_source_cache.rights_status='public-domain'
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN gutenberg_source_cache.rights_status ELSE excluded.rights_status END,
        commercial_use_status=CASE WHEN gutenberg_source_cache.commercial_use_status='approved' AND gutenberg_source_cache.rights_status='public-domain'
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN 'approved' ELSE excluded.commercial_use_status END,
        rights_evidence_id=CASE WHEN gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json
          AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN COALESCE(gutenberg_source_cache.rights_evidence_id,excluded.rights_evidence_id) ELSE excluded.rights_evidence_id END,
        rights_checked_at=CASE WHEN gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json
          AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN COALESCE(gutenberg_source_cache.rights_checked_at,excluded.rights_checked_at) ELSE excluded.rights_checked_at END,
        canonicalization_version=CASE WHEN gutenberg_source_cache.formats_json=excluded.formats_json AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'') THEN gutenberg_source_cache.canonicalization_version ELSE excluded.canonicalization_version END,
        epub_status=CASE WHEN gutenberg_source_cache.epub_status='completed' AND gutenberg_source_cache.formats_json=excluded.formats_json
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN 'completed' WHEN excluded.epub_status='unavailable' THEN 'unavailable' ELSE 'pending' END,
        epub_next_attempt_at=CASE WHEN gutenberg_source_cache.epub_status='completed' AND gutenberg_source_cache.formats_json=excluded.formats_json
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN gutenberg_source_cache.epub_next_attempt_at ELSE '' END,
        epub_last_error=CASE WHEN gutenberg_source_cache.epub_status='completed' AND gutenberg_source_cache.formats_json=excluded.formats_json
          AND gutenberg_source_cache.rights_territories_json=excluded.rights_territories_json AND gutenberg_source_cache.rights_evidence_url=excluded.rights_evidence_url AND COALESCE(json_extract(gutenberg_source_cache.source_metadata_json,'$.rightsFingerprint'),'')=COALESCE(json_extract(excluded.source_metadata_json,'$.rightsFingerprint'),'')
          THEN gutenberg_source_cache.epub_last_error ELSE '' END`,
    )
    .bind(
      String(book.id), book.title, JSON.stringify(book.authors || []), book.summaries?.[0] || "",
      JSON.stringify(book.subjects || []), JSON.stringify(book.bookshelves || []), JSON.stringify(book.languages || []), JSON.stringify(formats),
      Number(book.download_count) || 0, book.copyright === undefined || book.copyright === null ? null : book.copyright ? 1 : 0,
      sourceUrl, at, at, at, at, "active", 0, "", source ? "pending" : "unavailable", 0, "", null, "",
      sourceId, sourceItemId, sourceProject, sourceLicenseUrl, rightsStatus, JSON.stringify(rightsTerritories), options.rightsEvidenceUrl || sourceUrl,
      options.rightsEvidenceId ? at : null, options.rightsEvidenceId || null, commercialUseStatus, options.trademarkCleanupRequired ? 1 : 0,
      options.canonicalizationVersion || "", JSON.stringify(options.sourceMetadata || {}), options.contentHash || "",
    );
}

async function ensureCatalogState(env: CoveEnv) {
  const db = database(env);
  await db
    .prepare(
      "INSERT OR IGNORE INTO catalog_state(id,next_url,page,status,last_error,attempts,total_catalog_count) VALUES(1,NULL,1,'idle','',0,0)",
    )
    .run();
}
async function seedCatalog(env: CoveEnv) {
  const db = database(env);
  await ensureCatalogState(env);
  const row = await db.prepare("SELECT COUNT(*) AS count FROM gutenberg_source_cache").first<any>();
  if (Number(row?.count || 0) > 0) return;
  const at = now();
  const books = seed.results as unknown as CatalogBook[];
  const statements = books.map((book) =>
    catalogInsert(db, book, "https://www.gutenberg.org/ebooks/" + book.id + "/", at),
  );
  if (statements.length) await db.batch(statements);
  for (const book of books) {
    await db.batch(commercialCatalogStatements(db, String(book.id), at));
    await syncEditionTaxonomy(db, catalogIds(String(book.id)).editionId);
  }
  await syncSearchIndex(env, Math.min(100, books.length || 1)).catch((error) => console.warn("Initial search index sync failed", error));
}
async function getBook(env: CoveEnv, id: string, userId?: string): Promise<CatalogBook> {
  bookIdSchema.parse(id);
  const db = database(env);
  const canonical = await getCanonicalBook(db, id, userId);
  if (canonical) return canonical;
  if (id.startsWith("upload_")) throw new ApiError(404, "This book is not in your library.");
  if (id.startsWith("fore_") || id.startsWith("prd_")) throw new ApiError(404, "This edition is unavailable.");

  const stored = await db.prepare("SELECT copyright,source_url FROM gutenberg_source_cache WHERE id=?").bind(id).first<any>();
  if (stored) {
    if (stored.copyright !== 0) throw new ApiError(404, "This edition is not confirmed public domain.");
    await db.batch(commercialCatalogStatements(db, id, now()));
    await syncEditionTaxonomy(db, catalogIds(id).editionId);
    const migrated = await getCanonicalBook(db, id, userId);
    if (migrated) return migrated;
  }

  if (/^(?:pgca|pgau|pgeu)_/.test(id)) throw new ApiError(404, "This regional public-domain edition has not finished ingestion.");

  const seeded = seedBook(id);
  if (seeded) {
    const at = now();
    await db.batch([catalogInsert(db, seeded, "https://www.gutenberg.org/ebooks/" + seeded.id + "/", at)]);
    await db.batch(commercialCatalogStatements(db, String(seeded.id), at));
    await syncEditionTaxonomy(db, catalogIds(String(seeded.id)).editionId);
    const migrated = await getCanonicalBook(db, id, userId);
    if (migrated) return migrated;
  }

  const key = "book:" + id;
  let book = await cacheGet(env, key);
  if (!book) {
    book = (await remoteJson(catalogBase(env) + "/books/" + id + "/")) as CatalogBook;
    await cacheSet(env, key, book, 86400000);
  }
  if (!book?.id || book.copyright !== false)
    throw new ApiError(404, "This edition is not confirmed public domain.");
  const at = now();
  await db.batch([catalogInsert(db, book, book.formats?.["text/html"] || "https://www.gutenberg.org/ebooks/" + id + "/", at)]);
  await db.batch(commercialCatalogStatements(db, id, at));
  await syncEditionTaxonomy(db, catalogIds(id).editionId);
  const normalized = await getCanonicalBook(db, id, userId);
  if (!normalized) throw new ApiError(503, "This edition could not be normalized.");
  return normalized;
}

function fallbackCatalog(url: URL) {
  const q = (url.searchParams.get("search") || "").toLowerCase().split(/\s+/).filter(Boolean);
  const topic = (url.searchParams.get("topic") || "").toLowerCase();
  const lang = url.searchParams.get("languages");
  let results = (seed.results as unknown as CatalogBook[]).filter(
    (b) =>
      q.every((t) =>
        [b.title, String(b.id), ...b.authors.map((a) => a.name)]
          .join(" ")
          .toLowerCase()
          .includes(t),
      ) &&
      (!topic || [...b.subjects, ...b.bookshelves].join(" ").toLowerCase().includes(topic)) &&
      (!lang || b.languages.includes(lang)),
  );
  const sort = url.searchParams.get("sort");
  results.sort((a, b) =>
    sort === "ascending"
      ? Number(a.id) - Number(b.id)
      : sort === "descending"
        ? Number(b.id) - Number(a.id)
        : b.download_count - a.download_count,
  );
  const count = results.length;
  if (Number(url.searchParams.get("page") || 1) > 1) results = [];
  return {
    results,
    count,
    next: null,
    cached: true,
    warning:
      "The live catalog is temporarily unavailable. Showing the curated collection while the service reconnects.",
  };
}
async function ingestionStatus(env: CoveEnv) {
  await ensureCatalogState(env);
  const db = database(env);
  const [state, count, queued, cached, sources] = await Promise.all([
    db.prepare("SELECT * FROM catalog_state WHERE id=1").first<any>(),
    db.prepare("SELECT COUNT(*) AS count FROM gutenberg_source_cache").first<any>(),
    db.prepare("SELECT COUNT(*) AS count FROM gutenberg_source_cache WHERE epub_status IN ('pending','retry','downloading')").first<any>(),
    db.prepare("SELECT COUNT(*) AS count FROM gutenberg_source_cache WHERE epub_status='completed'").first<any>(),
    db.prepare(`SELECT s.id,s.code,s.name,s.jurisdiction_mode,s.default_territory_code,s.enabled,s.feed_kind,
      st.status,st.last_run_at,st.last_success_at,st.last_error,st.total_catalog_count,st.accepted_count,st.quarantined_count,st.next_run_at,
      (SELECT COUNT(*) FROM gutenberg_source_cache c WHERE c.source_id=s.id) cached_items,
      (SELECT COUNT(*) FROM gutenberg_source_cache c WHERE c.source_id=s.id AND c.rights_status='public-domain' AND c.commercial_use_status='approved') approved_items,
      (SELECT COUNT(*) FROM gutenberg_source_cache c WHERE c.source_id=s.id AND c.commercial_use_status='quarantined') quarantined_items
      FROM gutenberg_sources s LEFT JOIN gutenberg_source_states st ON st.source_id=s.id ORDER BY s.priority`).all<any>(),
  ]);
  return {
    status: state?.status || "idle",
    page: Number(state?.page || 1),
    nextUrl: state?.next_url || null,
    lastRunAt: state?.last_run_at || null,
    lastSuccessAt: state?.last_success_at || null,
    lastError: state?.last_error || "",
    totalCatalogCount: Number(state?.total_catalog_count || 0),
    cachedBooks: Number(count?.count || 0),
    cachedEpubs: Number(cached?.count || 0),
    queuedEpubs: Number(queued?.count || 0),
    sources: sources.results.map((r:any) => ({
      id:r.id,code:r.code,name:r.name,enabled:!!r.enabled,feedKind:r.feed_kind,jurisdictionMode:r.jurisdiction_mode,
      defaultTerritory:r.default_territory_code||null,status:r.status||"idle",lastRunAt:r.last_run_at||null,lastSuccessAt:r.last_success_at||null,
      lastError:r.last_error||"",nextRunAt:r.next_run_at||null,totalCatalogCount:Number(r.total_catalog_count||0),cachedItems:Number(r.cached_items||0),
      approvedItems:Number(r.approved_items||0),quarantinedItems:Number(r.quarantined_items||0),
    })),
  };
}
async function catalog(env: CoveEnv, url: URL, userId: string | null = null, storefrontTerritory = "US") {
  try {
    await seedCatalog(env);
    const input = { ...parseSearchInput(url), territory: storefrontTerritory };
    const result = await searchCatalog(env, input, userId);
    const state = await ingestionStatus(env);
    const next = input.page * result.limit < result.count
      ? "/api/fore/catalog?" + new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(input.page + 1) })
      : null;
    return {
      results: result.books,
      count: result.count,
      next,
      cached: true,
      facets: result.facets,
      search: { queryId: result.queryId, backend: result.backend, processingTimeMs: result.processingTimeMs, correctedQuery: result.correctedQuery || null, pageSize: result.limit },
      ingestion: state,
      ...(state.status === "failed" ? { warning: "The catalog updater is retrying in the background; cached books remain available." } : {}),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.warn("Commercial catalog search failed closed", error);
    throw new ApiError(503, "The catalog is temporarily unavailable while Cove verifies distribution rights.");
  }
}

function libraryRow(r: any, book: CatalogBook) {
  return {
    bookId: r.external_book_id,
    productId: r.product_id,
    book,
    status: r.status,
    progress: r.progress,
    cfi: r.cfi,
    shelves: parseJsonArray(r.legacy_shelves_json),
    rating: r.legacy_rating,
    review: r.legacy_review,
    updatedAt: r.updated_at,
    version: Number(r.version || 1),
  };
}

function annotationRow(r: any) {
  return {
    id: r.id,
    bookId: r.book_id,
    bookTitle: r.book_title,
    author: r.author,
    quote: r.quote,
    cfi: r.cfi,
    chapter: r.chapter,
    color: r.color,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: Number(r.version || 1),
  };
}
function definitionRow(r: any) {
  return {
    id: r.id,
    word: r.word,
    phonetic: r.phonetic,
    meaning: r.meaning,
    partOfSpeech: r.part_of_speech,
    bookId: r.book_id,
    bookTitle: r.book_title,
    cfi: r.cfi,
    context: r.context,
    source: r.source,
    createdAt: r.created_at,
  };
}
async function account(env: CoveEnv, request: Request) {
  const user = identity(request);
  if (!user) return { user: null, library: [], annotations: [], bookmarks: [], definitions: [] };
  const db = database(env);
  await migrateLegacy(env, user.id);
  const [profile, readingStates, annotations, definitions] = await Promise.all([
    db.prepare("SELECT name FROM profiles WHERE user_id=?").bind(user.id).first(),
    db
      .prepare(`SELECT rs.* FROM reading_states rs
        WHERE rs.user_id=? AND rs.in_library=1 AND EXISTS(
          SELECT 1 FROM entitlements e WHERE e.user_id=rs.user_id AND e.product_id=rs.product_id
          AND e.status='active' AND (e.starts_at IS NULL OR e.starts_at<=?) AND (e.ends_at IS NULL OR e.ends_at>?)
        ) ORDER BY rs.updated_at DESC`)
      .bind(user.id, now(), now())
      .all<any>(),
    db
      .prepare("SELECT * FROM annotations WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC")
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT * FROM definitions WHERE user_id=? ORDER BY created_at DESC")
      .bind(user.id)
      .all(),
  ]);
  const bookmarks = await listTextBookmarks(db, user.id);
  const library = [];
  for (const row of readingStates.results) {
    const book = await getCanonicalBook(db, row.external_book_id, user.id);
    if (book) library.push(libraryRow(row, book));
  }
  return {
    user: { ...user, name: profile?.name || user.name, registered: !!profile },
    library,
    annotations: annotations.results.map(annotationRow),
    bookmarks: bookmarks.bookmarks,
    definitions: definitions.results.map(definitionRow),
  };
}

function pageFromUrl(value: string) {
  try {
    return Number(new URL(value).searchParams.get("page") || 1);
  } catch {
    return 1;
  }
}
async function fetchGutenbergAsset(source: string, env: CoveEnv, sourceId: "pg_us" | RegionalSourceId, mimeType: "application/epub+zip" | "text/html") {
  const headers = { Accept: mimeType === "text/html" ? "text/html,application/xhtml+xml;q=0.9" : "application/epub+zip" };
  if (sourceId !== "pg_us") {
    const sourceUrl = trustedRegionalAssetUrl(sourceId, source, env);
    return fetchRegionalResource(sourceId, sourceUrl, env, {
      headers,
      signal: AbortSignal.timeout(60000),
    });
  }

  const sourceUrl = mirrorUrl(source, env.GUTENBERG_MIRROR_BASE_URL);
  const initial = new URL(sourceUrl);
  let target = initial;
  for (let hop = 0; hop < 5; hop++) {
    const trusted =
      target.protocol === "https:" &&
      !target.username &&
      !target.password &&
      !target.port &&
      (target.origin === initial.origin || ["www.gutenberg.org", "gutenberg.org"].includes(target.hostname));
    if (!trusted) throw new Error("Gutenberg asset redirect left the trusted mirror set.");
    const response = await fetch(target, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(60000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Gutenberg asset redirect omitted Location.");
    target = new URL(location, target);
  }
  throw new Error("Gutenberg asset exceeded the redirect limit.");
}
async function fetchGutenbergEpub(source: string, env: CoveEnv, sourceId: "pg_us" | RegionalSourceId = "pg_us") {
  return fetchGutenbergAsset(source, env, sourceId, "application/epub+zip");
}

async function insertRegionalEvidence(env: CoveEnv, row: any, contentHash: string, canonicalizationVersion: string) {
  const db = database(env);
  const territories = parseJsonArray(row.rights_territories_json).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));
  if (!territories.length) throw new Error("No country-level rights evidence was supplied for this item.");
  const checkedAt = now();
  const sourceMetadata = parseJsonObject(row.source_metadata_json || "{}");
  let firstEvidenceId = "";
  for (const territory of territories) {
    const evidenceHash = await sha256Hex(JSON.stringify({ sourceId: row.source_id, sourceItemId: row.source_item_id, territory, evidenceUrl: row.rights_evidence_url, itemFingerprint: sourceMetadata.rightsFingerprint || "", evidenceDigest: sourceMetadata.evidenceDigest || "", catalogHash: sourceMetadata.catalogHash || "", canonicalContentHash: contentHash }));
    const evidenceId = `gre_${String(row.source_id).replace(/[^a-z0-9_]/gi, "_")}_${territory.toLowerCase()}_${String(row.id).replace(/[^a-z0-9_]/gi, "_")}_${evidenceHash.slice(0, 12)}`;
    await db.prepare(`INSERT OR IGNORE INTO gutenberg_rights_evidence(
      id,source_id,cache_id,source_item_id,determination,territory_code,evidence_url,evidence_type,evidence_hash,parser_version,status,checked_at,created_at
    ) VALUES(?,?,?,?, 'public-domain',?,?,?,?,'regional-gutenberg-v1','approved',?,?)`)
      .bind(evidenceId, row.source_id, row.id, row.source_item_id, territory, row.rights_evidence_url || row.source_url,
        row.source_id === "pg_eu" ? "operator-review" : "source-catalog", evidenceHash, checkedAt, checkedAt).run();
    if (!firstEvidenceId) firstEvidenceId = evidenceId;
  }
  await db.prepare(`UPDATE gutenberg_source_cache SET rights_status='public-domain',commercial_use_status='approved',rights_checked_at=?,rights_evidence_id=?,
    canonicalization_version=?,content_hash=?,epub_status='completed',epub_cached_at=?,epub_last_error='',epub_next_attempt_at='',ingest_status='active',last_error='' WHERE id=?`)
    .bind(checkedAt, firstEvidenceId, canonicalizationVersion, contentHash, checkedAt, row.id).run();
  const editionId = catalogIds(String(row.id)).editionId;
  const grantSource = `gutenberg-${String(row.source_id)}-public-domain`;
  // Suspend the previous source-derived grant set before rebuilding it from this exact evidence
  // snapshot. This prevents an old country grant from surviving if upstream jurisdiction evidence
  // is narrowed on a later verification pass.
  await db.prepare(`UPDATE rights_grants SET status='suspended',updated_at=? WHERE edition_id=? AND source=? AND status='active'`)
    .bind(checkedAt, editionId, grantSource).run();
  await db.batch(commercialCatalogStatements(db, String(row.id), checkedAt));
  await db.prepare(`UPDATE rights_grants SET status='active',updated_at=?,source_evidence_id=(
      SELECT ge.id FROM gutenberg_rights_evidence ge JOIN gutenberg_source_cache c ON c.id=ge.cache_id
      WHERE ge.cache_id=? AND ge.status='approved' AND ge.determination='public-domain'
        AND upper(ge.territory_code)=upper(rights_grants.territory_code)
        AND EXISTS(SELECT 1 FROM json_each(c.rights_territories_json) jt WHERE upper(jt.value)=upper(ge.territory_code))
      ORDER BY ge.checked_at DESC,ge.created_at DESC,ge.id DESC LIMIT 1
    ) WHERE edition_id=? AND source=? AND EXISTS(
      SELECT 1 FROM gutenberg_rights_evidence ge JOIN gutenberg_source_cache c ON c.id=ge.cache_id
      WHERE ge.cache_id=? AND ge.status='approved' AND ge.determination='public-domain'
        AND upper(ge.territory_code)=upper(rights_grants.territory_code)
        AND EXISTS(SELECT 1 FROM json_each(c.rights_territories_json) jt WHERE upper(jt.value)=upper(ge.territory_code))
    )`)
    .bind(checkedAt, row.id, editionId, grantSource, row.id).run();
  await syncEditionTaxonomy(db, editionId);
  return { territories, evidenceId: firstEvidenceId };
}

async function quarantineRegionalItem(env: CoveEnv, id: string, message: string) {
  await database(env).prepare(`UPDATE gutenberg_source_cache SET rights_status='quarantined',commercial_use_status='quarantined',ingest_status='quarantined',
    epub_status='failed',epub_last_error=?,last_error=?,updated_at=? WHERE id=?`).bind(message.slice(0, 500), message.slice(0, 500), now(), id).run();
}

async function cachePendingEpubs(env: CoveEnv, limit = 1) {
  if (!env.BUCKET) return { attempted: 0, downloaded: 0, failed: 0, quarantined: 0 };
  const db = database(env);
  const staleDownloadBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db.prepare(`UPDATE gutenberg_source_cache
    SET epub_status='retry',epub_next_attempt_at='',epub_last_error='Recovered after an interrupted EPUB download.',updated_at=?
    WHERE epub_status='downloading' AND updated_at<?`)
    .bind(now(), staleDownloadBefore).run();
  const queued = await db.prepare(`WITH ranked AS (
      SELECT id,title,authors_json,languages_json,source_id,source_item_id,formats_json,epub_attempts,rights_territories_json,rights_evidence_url,source_url,content_hash,source_metadata_json,
        ROW_NUMBER() OVER(PARTITION BY source_id ORDER BY updated_at ASC,id ASC) source_rank
      FROM gutenberg_source_cache WHERE epub_status IN ('pending','retry') AND ingest_status<>'quarantined'
        AND (epub_next_attempt_at='' OR epub_next_attempt_at<=?)
    ) SELECT id,title,authors_json,languages_json,source_id,source_item_id,formats_json,epub_attempts,rights_territories_json,rights_evidence_url,source_url,content_hash,source_metadata_json
      FROM ranked ORDER BY source_rank ASC,source_id ASC,id ASC LIMIT ?`)
    .bind(now(), Math.max(4, Math.min(16, limit))).all<any>();
  let downloaded = 0, failed = 0, quarantined = 0;
  for (const row of queued.results) {
    const id = String(row.id);
    const sourceId = String(row.source_id || "pg_us") as "pg_us" | RegionalSourceId;
    const formats = parseJsonObject(row.formats_json);
    const sourceAsset = sourceId === "pg_us"
      ? (epubSource(formats) ? { url: epubSource(formats), mimeType: "application/epub+zip" as const } : null)
      : canonicalAssetSource(formats);
    if (!sourceAsset) {
      await db.prepare("UPDATE gutenberg_source_cache SET epub_status='unavailable',epub_last_error='No supported source asset was provided.' WHERE id=?").bind(id).run();
      continue;
    }
    await db.prepare("UPDATE gutenberg_source_cache SET epub_status='downloading',epub_last_error='',updated_at=? WHERE id=?").bind(now(),id).run();
    try {
      if (sourceId === "pg_eu") {
        const metadata = parseJsonObject(row.source_metadata_json || "{}");
        await verifyEuropeRightsEvidence(String(row.rights_evidence_url || ""), String(metadata.evidenceDigest || ""), env);
      }
      const response = await fetchGutenbergAsset(sourceAsset.url, env, sourceId, sourceAsset.mimeType);
      if (!response.ok) throw new Error(`${sourceAsset.mimeType === "text/html" ? "HTML" : "EPUB"} source returned ${response.status}`);
      const rawBytes = await bounded(response, 30 * 1024 * 1024);
      let bytes = rawBytes, contentHash = await sha256Hex(rawBytes), canonicalizationVersion = sourceId === "pg_us" ? "pgus-upstream-v1" : "";
      let canonicalMetadata: { title: string; authors: { name: string }[]; languages: string[] } | null = null;
      if (sourceId !== "pg_us") {
        try {
          const canonical = sourceAsset.mimeType === "text/html"
            ? await canonicalizeRegionalDocument(rawBytes, sourceId, {
                mimeType: "text/html",
                title: String(row.title || ""),
                authors: parseJsonArray(row.authors_json).map((author: any) => ({ name: String(author?.name || author || "") })).filter((author: any) => author.name),
                languages: parseJsonArray(row.languages_json).map(String),
                sourceItemId: String(row.source_item_id || row.id),
              })
            : await canonicalizeRegionalEpub(rawBytes, sourceId);
          bytes = canonical.bytes; contentHash = canonical.sha256; canonicalizationVersion = canonical.canonicalizationVersion; canonicalMetadata = canonical.metadata;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/copyright|permission-only|branding remains|rights evidence|evidence digest|quarantined/i.test(message)) {
            await quarantineRegionalItem(env, id, message); quarantined++; continue;
          }
          throw error;
        }
      } else if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("Downloaded file is not an EPUB archive.");
      await env.BUCKET.put(`epubs/${id}.epub`, bytes, { httpMetadata: { contentType: "application/epub+zip", cacheControl: "31536000" }, customMetadata: { source: sourceId, sourceFormat: sourceAsset.mimeType, sha256: contentHash, canonicalization: canonicalizationVersion } });
      if (sourceId === "pg_us") {
        await db.prepare("UPDATE gutenberg_source_cache SET epub_status='completed',epub_cached_at=?,epub_last_error='',epub_next_attempt_at='',content_hash=?,canonicalization_version=? WHERE id=?")
          .bind(now(), contentHash, canonicalizationVersion, id).run();
        await db.batch(commercialCatalogStatements(db, id, now()));
      } else {
        if (canonicalMetadata) {
          const authorsJson = JSON.stringify(canonicalMetadata.authors);
          const languagesJson = JSON.stringify(canonicalMetadata.languages);
          await db.prepare(`UPDATE gutenberg_source_cache SET
            title=CASE WHEN ?<>'' THEN ? ELSE title END,
            authors_json=CASE WHEN ?<>'[]' THEN ? ELSE authors_json END,
            languages_json=CASE WHEN ?<>'[]' THEN ? ELSE languages_json END,updated_at=? WHERE id=?`)
            .bind(canonicalMetadata.title, canonicalMetadata.title, authorsJson, authorsJson, languagesJson, languagesJson, now(), id).run();
        }
        await insertRegionalEvidence(env, row, contentHash, canonicalizationVersion);
      }
      // Ensure the canonical asset version points to Cove-controlled storage after successful validation.
      try {
        await db.prepare("UPDATE asset_versions SET object_key=?,sha256=? WHERE asset_id=? AND version_number=1")
          .bind(`epubs/${id}.epub`, contentHash, `asset_epub_gutenberg_${id}`).run();
      } catch { /* asset row may not exist until the next normalization pass */ }
      downloaded++;
    } catch (error) {
      const attempts = Number(row.epub_attempts || 0) + 1;
      const retryAt = new Date(Date.now() + Math.min(24 * 60 * 60 * 1000, Math.pow(2, attempts) * 5 * 60 * 1000)).toISOString();
      await db.prepare("UPDATE gutenberg_source_cache SET epub_status=?,epub_attempts=?,epub_next_attempt_at=?,epub_last_error=? WHERE id=?")
        .bind(attempts >= 8 ? "failed" : "retry", attempts, retryAt, error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), id).run();
      failed++;
    }
  }
  return { attempted: queued.results.length, downloaded, failed, quarantined };
}

function regionalBook(item: RegionalCatalogItem) {
  return {
    id: item.externalId, title: item.title, authors: item.authors, summaries: [], subjects: item.subjects,
    bookshelves: item.bookshelves, languages: item.languages.length ? item.languages : ["en"], formats: item.formats,
    download_count: 0, copyright: false,
  };
}

async function runRegionalCatalogIngestion(env: CoveEnv, epubLimit = 1) {
  const db = database(env);
  const current = now();
  const due = await db.prepare(`SELECT s.*,st.cursor,st.cycle_started_at,st.etag,st.last_modified,st.content_hash state_content_hash,
      st.status state_status,st.next_run_at,st.lease_until,st.attempts state_attempts,st.last_success_at
      FROM gutenberg_sources s JOIN gutenberg_source_states st ON st.source_id=s.id
      WHERE s.enabled=1 AND s.id IN ('pg_ca','pg_au','pg_eu')
        AND (st.next_run_at IS NULL OR st.next_run_at='' OR st.next_run_at<=?)
        AND (st.lease_until IS NULL OR st.lease_until='' OR st.lease_until<?)
      ORDER BY s.priority LIMIT 1`).bind(current, current).first<any>();
  if (!due) return { skipped: "regional-sources-fresh", epubs: await cachePendingEpubs(env, epubLimit) };
  const sourceId = String(due.id) as RegionalSourceId;
  const lease = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const runId = `gir_${crypto.randomUUID()}`;
  let cursorBefore = Math.max(0, Number.parseInt(String(due.cursor || "0"), 10) || 0);
  await db.prepare(`UPDATE gutenberg_source_states SET status='running',lease_token=?,lease_until=?,last_run_at=?,last_error='',updated_at=? WHERE source_id=?`)
    .bind(lease, leaseUntil, current, current, sourceId).run();
  await db.prepare(`INSERT INTO gutenberg_ingest_runs(id,source_id,started_at,status,cursor_before,error) VALUES(?,?,?,'running',?,'')`)
    .bind(runId, sourceId, current, cursorBefore ? String(cursorBefore) : null).run();
  try {
    const headers: Record<string,string> = {};
    // Conditional GET is only safe at the beginning of a catalog cycle. A resumed batch still
    // needs the body in order to address its cursor, even when the upstream ETag is unchanged.
    if (cursorBefore === 0 && due.etag) headers["If-None-Match"] = due.etag;
    if (cursorBefore === 0 && due.last_modified) headers["If-Modified-Since"] = due.last_modified;
    const result = await fetchRegionalCatalog(sourceId, env, headers);
    if (result.status === "degraded") {
      const next = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      await db.prepare(`UPDATE gutenberg_source_states SET status='degraded',last_error=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=?`)
        .bind(result.warning, next, now(), sourceId).run();
      await db.prepare(`UPDATE gutenberg_ingest_runs SET completed_at=?,status='partial',cursor_after=?,error=? WHERE id=?`)
        .bind(now(), cursorBefore ? String(cursorBefore) : null, result.warning, runId).run();
      return { sourceId, degraded: true, warning: result.warning, epubs: await cachePendingEpubs(env, epubLimit) };
    }
    if (result.status === "not-modified") {
      const next = new Date(Date.now() + Number(due.refresh_seconds || 86400) * 1000).toISOString();
      await db.prepare(`UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?,attempts=0,next_run_at=?,lease_token=NULL,lease_until=NULL,
        etag=COALESCE(NULLIF(?,''),etag),last_modified=COALESCE(NULLIF(?,''),last_modified),updated_at=? WHERE source_id=?`)
        .bind(now(), next, result.etag, result.lastModified, now(), sourceId).run();
      await db.prepare(`UPDATE gutenberg_ingest_runs SET completed_at=?,status='not-modified',cursor_after=NULL,response_etag=?,response_last_modified=? WHERE id=?`)
        .bind(now(), result.etag, result.lastModified, runId).run();
      return { sourceId, notModified: true, epubs: await cachePendingEpubs(env, epubLimit) };
    }
    // Multi-document catalogs such as PGA A-M/N-Z cannot rely on one upstream ETag. The combined
    // snapshot hash gives us equivalent no-op behavior after fetching the small index documents,
    // avoiding thousands of unnecessary D1 writes when the catalog has not changed.
    if (cursorBefore === 0 && due.state_content_hash && due.last_success_at && String(due.state_content_hash) === result.bodyHash) {
      const completed = now();
      const next = new Date(Date.now() + Number(due.refresh_seconds || 86400) * 1000).toISOString();
      await db.prepare(`UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?,last_error='',attempts=0,next_run_at=?,lease_token=NULL,lease_until=NULL,
        etag=?,last_modified=?,content_hash=?,updated_at=? WHERE source_id=?`)
        .bind(completed, next, result.etag, result.lastModified, result.bodyHash, completed, sourceId).run();
      await db.prepare(`UPDATE gutenberg_ingest_runs SET completed_at=?,status='not-modified',cursor_after=NULL,fetched_count=?,response_etag=?,response_last_modified=?,response_hash=? WHERE id=?`)
        .bind(completed, result.items.length, result.etag, result.lastModified, result.bodyHash, runId).run();
      return { sourceId, notModified: true, snapshotHash: result.bodyHash, epubs: await cachePendingEpubs(env, epubLimit) };
    }

    // If an upstream catalog changes while a multi-run cycle is in progress, restart from zero.
    // This prevents a cursor from being applied to a different snapshot and skipping records.
    let cycleStartedAt = cursorBefore > 0 ? String(due.cycle_started_at || current) : current;
    if (cursorBefore > 0 && due.state_content_hash && String(due.state_content_hash) !== result.bodyHash) {
      cursorBefore = 0;
      cycleStartedAt = current;
    }
    const cfg = regionalSourceConfig(sourceId, env);
    const batchLimit = Math.max(1, Math.min(5000, Number(due.max_items_per_run || 500)));
    const items = result.items.slice(cursorBefore, cursorBefore + batchLimit);
    let accepted = 0;
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      const at = now();
      const statements = chunk.map((item) => catalogInsert(db, regionalBook(item), item.sourceUrl, at, {
        sourceId, sourceItemId: item.sourceItemId, sourceProject: String(due.name), sourceLicenseUrl: String(due.license_url || cfg.license),
        rightsStatus: "pending", rightsTerritories: item.territories, rightsEvidenceUrl: item.evidenceUrl, commercialUseStatus: "pending",
        trademarkCleanupRequired: !!due.trademark_cleanup_required, sourceMetadata: { ...(item.metadata || {}), catalogHash: result.bodyHash },
      }));
      if (statements.length) await db.batch(statements);
      accepted += statements.length;
    }

    const nextOffset = cursorBefore + items.length;
    const complete = nextOffset >= result.items.length;
    const completed = now();
    const cursorAfter = complete ? null : String(nextOffset);
    const next = complete
      ? new Date(Date.now() + Number(due.refresh_seconds || 86400) * 1000).toISOString()
      : new Date(Date.now() + 60 * 1000).toISOString();

    let staleCount = 0;
    if (complete) {
      const stale = await db.prepare(`SELECT COUNT(*) count FROM gutenberg_source_cache
        WHERE source_id=? AND last_seen_at<? AND ingest_status NOT IN ('stale','quarantined')`).bind(sourceId, cycleStartedAt).first<any>();
      staleCount = Number(stale?.count || 0);
      if (staleCount) {
        // Source retractions/corrections fail closed. Keep the canonical object for audit, but
        // remove storefront eligibility until the item is observed and re-verified again.
        await db.prepare(`UPDATE gutenberg_source_cache SET ingest_status='stale',rights_status='quarantined',commercial_use_status='quarantined',
          epub_status='pending',epub_next_attempt_at='',last_error='Source item was absent from the latest complete catalog snapshot.',updated_at=?
          WHERE source_id=? AND last_seen_at<? AND ingest_status NOT IN ('stale','quarantined')`).bind(completed, sourceId, cycleStartedAt).run();
        await db.prepare(`UPDATE products SET storefront_status='inactive',updated_at=? WHERE source_name='gutenberg' AND source_external_id IN
          (SELECT id FROM gutenberg_source_cache WHERE source_id=? AND ingest_status='stale')`).bind(completed, sourceId).run();
        await db.prepare(`UPDATE offers SET active=0,updated_at=? WHERE product_id IN
          (SELECT p.id FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE p.source_name='gutenberg' AND c.source_id=? AND c.ingest_status='stale')`)
          .bind(completed, sourceId).run();
        await db.prepare(`UPDATE editions SET release_status='unavailable',updated_at=? WHERE id IN
          (SELECT p.edition_id FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE p.source_name='gutenberg' AND c.source_id=? AND c.ingest_status='stale')`)
          .bind(completed, sourceId).run();
        await db.prepare(`UPDATE rights_grants SET status='suspended',updated_at=? WHERE source=? AND edition_id IN
          (SELECT p.edition_id FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE p.source_name='gutenberg' AND c.source_id=? AND c.ingest_status='stale')`)
          .bind(completed, `gutenberg-${sourceId}-public-domain`, sourceId).run();
      }
    }

    await db.prepare(`UPDATE gutenberg_source_states SET status='idle',cursor=?,cycle_started_at=?,last_success_at=?,last_error='',attempts=0,total_catalog_count=?,
      seen_count=seen_count+?,accepted_count=accepted_count+?,quarantined_count=quarantined_count+?,next_run_at=?,lease_token=NULL,lease_until=NULL,
      etag=?,last_modified=?,content_hash=?,updated_at=? WHERE source_id=?`)
      .bind(cursorAfter, complete ? null : cycleStartedAt, complete ? completed : due.last_success_at || null, result.items.length, items.length, accepted, staleCount,
        next, result.etag, result.lastModified, result.bodyHash, completed, sourceId).run();
    await db.prepare(`UPDATE gutenberg_ingest_runs SET completed_at=?,status=?,cursor_before=?,cursor_after=?,fetched_count=?,accepted_count=?,quarantined_count=?,
      response_etag=?,response_last_modified=?,response_hash=? WHERE id=?`)
      .bind(completed, complete ? "succeeded" : "partial", cursorBefore ? String(cursorBefore) : null, cursorAfter, items.length, accepted, staleCount,
        result.etag, result.lastModified, result.bodyHash, runId).run();

    const epubs = await cachePendingEpubs(env, Math.max(epubLimit, 2));
    if (epubs.downloaded || staleCount) await syncSearchIndex(env, Math.min(200, Math.max(5, epubs.downloaded * 5 + staleCount))).catch((error) => console.warn("Regional search sync failed", error));
    return { sourceId, fetched: items.length, total: result.items.length, accepted, cursor: cursorAfter, complete, stale: staleCount, epubs };
  } catch (error) {
    const attempts = Number(due.state_attempts || 0) + 1;
    const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
    const retryAt = new Date(Date.now() + Math.min(24 * 60 * 60 * 1000, Math.pow(2, attempts) * 5 * 60 * 1000)).toISOString();
    await db.prepare(`UPDATE gutenberg_source_states SET status='failed',last_error=?,attempts=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE source_id=?`)
      .bind(message, attempts, retryAt, now(), sourceId).run();
    await db.prepare(`UPDATE gutenberg_ingest_runs SET completed_at=?,status='failed',cursor_before=?,cursor_after=?,error=? WHERE id=?`)
      .bind(now(), cursorBefore ? String(cursorBefore) : null, cursorBefore ? String(cursorBefore) : null, message, runId).run();
    return { sourceId, failed: true, error: message, retryAt, epubs: await cachePendingEpubs(env, epubLimit) };
  }
}

export async function runCatalogIngestion(env: CoveEnv, epubLimit = 1) {
  await seedCatalog(env);
  const regional = await runRegionalCatalogIngestion(env, Math.max(1, epubLimit)).catch((error) => ({ failed: true, error: error instanceof Error ? error.message : String(error) }));
  const db = database(env);
  const state = await db.prepare("SELECT * FROM catalog_state WHERE id=1").first<any>();
  const current = Date.now();
  if (state?.next_run_at && Date.parse(state.next_run_at) > current) {
    const epubs = await cachePendingEpubs(env, epubLimit);
    return { skipped: "backoff", epubs, regional };
  }
  if (
    state?.status === "running" &&
    state.last_run_at &&
    current - Date.parse(state.last_run_at) < 10 * 60 * 1000
  )
    return { skipped: "running", page: Number(state.page || 1), regional };
  if (
    state?.status !== "failed" &&
    !state?.next_url &&
    state?.last_success_at &&
    current - Date.parse(state.last_success_at) < 24 * 60 * 60 * 1000
  ) {
    const epubs = await cachePendingEpubs(env, epubLimit);
    return { skipped: "fresh", page: Number(state.page || 1), epubs, regional };
  }
  const started = now();
  await db
    .prepare("UPDATE catalog_state SET status='running',last_run_at=?,last_error='' WHERE id=1")
    .bind(started)
    .run();
  const sourceUrl = state?.next_url || firstCatalogUrl(env);
  const page = pageFromUrl(sourceUrl);
  try {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CoveReader/1.0 (persistent Gutenberg catalog harvester)",
      },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error("Catalog source returned " + response.status);
    const payload = (await response.json()) as any;
    if (!Array.isArray(payload.results))
      throw new Error("Catalog source returned an invalid page.");
    const at = now();
    const accepted = payload.results.filter(
      (book: any) => book.copyright === false && Boolean(epubSource(book.formats || {})),
    );
    const statements = accepted.map((book: any) =>
      catalogInsert(
        db,
        book,
        book.formats?.["text/html"] || "https://www.gutenberg.org/ebooks/" + book.id + "/",
        at,
      ),
    );
    if (statements.length) await db.batch(statements);
    for (const book of accepted) {
      await db.batch(commercialCatalogStatements(db, String(book.id), at));
      await syncEditionTaxonomy(db, catalogIds(String(book.id)).editionId);
    }
    await syncSearchIndex(env, Math.min(500, Math.max(50, accepted.length))).catch((error) => console.warn("Catalog search sync failed", error));
    const nextUrl = typeof payload.next === "string" ? payload.next : null;
    if (nextUrl && new URL(nextUrl).origin !== new URL(catalogBase(env)).origin)
      throw new Error("Invalid catalog pagination origin.");
    const success = now();
    await db
      .prepare(
        "UPDATE catalog_state SET next_url=?,page=?,status='idle',last_run_at=?,last_success_at=?,last_error='',attempts=0,total_catalog_count=?,cycle_started_at=CASE WHEN ?=1 THEN ? ELSE cycle_started_at END,next_run_at=? WHERE id=1",
      )
      .bind(
        nextUrl,
        page + 1,
        success,
        success,
        Number(payload.count || 0),
        page,
        success,
        nextUrl ? "" : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      )
      .run();
    const epubs = await cachePendingEpubs(env, epubLimit);
    return {
      page,
      sourceUrl,
      fetched: payload.results.length,
      inserted: statements.length,
      nextUrl,
      complete: !nextUrl,
      epubs,
      regional,
    };
  } catch (error) {
    const attempts = Number(state?.attempts || 0) + 1;
    const retryAt = new Date(
      Date.now() + Math.min(24 * 60 * 60 * 1000, Math.pow(2, attempts) * 5 * 60 * 1000),
    ).toISOString();
    const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
    await db
      .prepare(
        "UPDATE catalog_state SET status='failed',last_error=?,attempts=?,next_run_at=? WHERE id=1",
      )
      .bind(message, attempts, retryAt)
      .run();
    return {
      failed: true,
      error: message,
      retryAt,
      epubs: await cachePendingEpubs(env, epubLimit),
      regional,
    };
  }
}
let ingestionInFlight: Promise<any> | null = null;
export function kickCatalogIngestion(env: CoveEnv) {
  if (ingestionInFlight) return ingestionInFlight;
  ingestionInFlight = runCatalogIngestion(env, 1)
    .catch((error) => {
      console.warn(
        "Catalog ingestion failed",
        error instanceof Error ? error.message : String(error),
      );
    })
    .finally(() => {
      ingestionInFlight = null;
    });
  return ingestionInFlight;
}
function zipJoin(base: string, href: string) {
  const raw = href.split("#")[0].split("?")[0];
  const parts = (base ? base.split("/") : []).filter(Boolean);
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(decodeURIComponent(part));
  }
  return parts.join("/");
}
async function currentEpubAsset(env: CoveEnv, product: any, userId?: string) {
  const db = database(env);
  if(userId){
    const pinned=await db.prepare(`SELECT pin.publication_version_id,l.owner_update_policy,pv.manifest_json FROM entitlements e JOIN publishing_entitlement_version_pins pin ON pin.entitlement_id=e.id JOIN publishing_release_lifecycles l ON l.id=pin.lifecycle_id JOIN publishing_publication_versions pv ON pv.id=pin.publication_version_id WHERE e.user_id=? AND e.product_id=? AND e.entitlement_type='purchase' AND e.status='active' LIMIT 1`).bind(userId,product.id).first<any>();
    if(pinned&&pinned.owner_update_policy!=="auto_update"){
      let manifest:any={};try{manifest=JSON.parse(String(pinned.manifest_json||"{}"))}catch{}
      const epub=(manifest.catalogAssets||[]).find((a:any)=>a.kind==="epub");
      if(epub?.catalogAssetVersionId){const asset=await db.prepare(`SELECT da.id asset_id,da.downloadable,av.id asset_version_id,av.object_key,av.source_url,av.mime_type,av.sha256,av.version_number FROM asset_versions av JOIN digital_assets da ON da.id=av.asset_id WHERE av.id=? AND da.edition_id=? AND da.kind='epub' LIMIT 1`).bind(epub.catalogAssetVersionId,product.edition_id).first<any>();if(asset)return asset;}
    }
  }
  const asset = await db.prepare(`SELECT da.id asset_id,da.downloadable,av.id asset_version_id,av.object_key,av.source_url,av.mime_type,av.sha256,av.version_number
    FROM digital_assets da JOIN asset_versions av ON av.id=da.current_version_id
    WHERE da.edition_id=? AND da.kind='epub' LIMIT 1`).bind(product.edition_id).first<any>();
  if (!asset) throw new ApiError(404, "An EPUB is not available for this edition.");
  return asset;
}
async function sourceEpubBytes(env: CoveEnv, product: any, asset: any, externalId: string) {
  const key = asset.object_key || (product.source_name === "gutenberg" ? `epubs/${externalId}.epub` : "");
  const cached = key && env.BUCKET ? await env.BUCKET.get(key) : null;
  if (cached) return { bytes: new Uint8Array(await cached.arrayBuffer()), key, mimeType: asset.mime_type || "application/epub+zip" };
  if (product.source_name === "upload") throw new ApiError(404, "This imported file is unavailable.");
  // Customer requests never fetch publisher-controlled URLs. Commercial assets must be ingested into
  // Cove-controlled object storage first; only the vetted Gutenberg mirror path may hydrate on demand.
  if (product.source_name !== "gutenberg") throw new ApiError(503, "This commercial edition has not finished secure asset ingestion.");
  if (!asset.source_url) throw new ApiError(404, "An EPUB source is not available for this edition.");
  if (/^(?:pgca|pgau|pgeu)_/.test(externalId))
    throw new ApiError(503, "This regional public-domain edition must be served from Cove's verified canonical cache.");
  const response = await fetchGutenbergEpub(asset.source_url, env, "pg_us");
  if (!response.ok) throw new ApiError(502, "The EPUB could not be downloaded. Please try again.");
  const bytes = await bounded(response, 25 * 1024 * 1024);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ApiError(502, "The source did not return an EPUB.");
  if (key && env.BUCKET) await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/epub+zip", cacheControl: "31536000" } });
  return { bytes, key, mimeType: asset.mime_type || "application/epub+zip" };
}
async function activeEntitlement(db: ReturnType<typeof database>, userId: string | undefined, productId: string) {
  if (!userId) return false;
  const at=now();
  return !!(await db.prepare(`SELECT 1 ok FROM entitlements WHERE user_id=? AND product_id=? AND status='active'
    AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1`).bind(userId,productId,at,at).first<any>());
}
async function requireFullBookAccess(env: CoveEnv, product: any, userId: string | undefined, territory: string) {
  if (product.source_name === "upload") return;
  const db=database(env);
  // A completed purchase/loan/subscription remains the user's entitlement even if they travel or
  // a distribution grant later expires. Rights govern acquisition; entitlements govern access.
  if (await activeEntitlement(db,userId,product.id)) return;
  if (product.source_name === "gutenberg") {
    const rights=await resolveProductRights(db,String(product.id),territory,{salesChannel:"retail",persist:true,context:{source:"full-file-delivery",userId:userId||null}});
    if (rights.allowed) return;
    throw new ApiError(404,"This edition is not available in your storefront.");
  }
  if (!userId) throw new ApiError(401, "Sign in to access this edition.");
  throw new ApiError(403, "This edition requires an active purchase, loan, subscription, gift, or publisher entitlement.");
}
async function getEpub(env: CoveEnv, id: string, userId: string | undefined, territory: string, request?: Request) {
  await getBook(env, id, userId);
  const product = await resolveProduct(database(env), id, userId);
  await requireFullBookAccess(env, product, userId, territory);
  if (!["gutenberg", "upload"].includes(String(product.source_name))) {
    if (!userId) throw new ApiError(401, "Sign in to access this edition.");
    const grant = await issueCommercialEpubGrant(env, userId, { productId: product.id, purpose: "read", deviceId: request ? (request.headers.get("x-fore-device-id") || new URL(request.url).searchParams.get("deviceId") || null) : null }, request);
    return new Response(null, { status: 307, headers: { Location: grant.url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }
  const asset = await currentEpubAsset(env, product, userId);
  const loaded = await sourceEpubBytes(env, product, asset, String(product.source_external_id || id));
  return new Response(loaded.bytes as any, {
    headers: {
      "Content-Type": loaded.mimeType,
      "Content-Length": String(loaded.bytes.byteLength),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="fore-${id}.epub"`,
      "X-Cove-Asset-Version": String(asset.version_number || 1),
    },
  });
}
async function getDownloadEpub(env: CoveEnv, id: string, userId: string | undefined, territory: string, request?: Request) {
  await getBook(env, id, userId);
  const product = await resolveProduct(database(env), id, userId);
  await requireFullBookAccess(env, product, userId, territory);
  if (!["gutenberg", "upload"].includes(String(product.source_name))) {
    if (!userId) throw new ApiError(401, "Sign in to download this edition.");
    const grant = await issueCommercialEpubGrant(env, userId, { productId: product.id, purpose: "download", deviceId: request ? (request.headers.get("x-fore-device-id") || new URL(request.url).searchParams.get("deviceId") || null) : null }, request);
    return new Response(null, { status: 307, headers: { Location: grant.url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }
  const asset = await currentEpubAsset(env, product, userId);
  if (!asset.downloadable) {
    throw new ApiError(403, "This edition can be read in Cove, but its distribution license does not permit EPUB download/export.");
  }
  const loaded = await sourceEpubBytes(env, product, asset, String(product.source_external_id || id));
  return new Response(loaded.bytes as any, {
    headers: {
      "Content-Type": loaded.mimeType,
      "Content-Length": String(loaded.bytes.byteLength),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="fore-${id}.epub"`,
      "X-Cove-Asset-Version": String(asset.version_number || 1),
      "X-Cove-Export-Class": "book-content-only",
    },
  });
}
async function createPreviewEpub(source: Uint8Array, policy: any) {
  const zip = await JSZip.loadAsync(source);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (!container) throw new ApiError(422, "This EPUB cannot be sampled because its package manifest is missing.");
  const rootfile = container.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!rootfile) throw new ApiError(422, "This EPUB package is invalid.");
  const opfFile = zip.file(rootfile);
  let opf = await opfFile?.async("string");
  if (!opf) throw new ApiError(422, "This EPUB package document is unavailable.");
  const opfDir = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/")) : "";
  const manifest = new Map<string,{id:string;href:string;media:string;properties:string;full:string}>();
  for (const m of opf.matchAll(/<item\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const full=m[0],id=m[1],href=full.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]||"",media=full.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i)?.[1]||"",properties=full.match(/\bproperties\s*=\s*["']([^"']+)["']/i)?.[1]||"";
    manifest.set(id,{id,href,media,properties,full});
  }
  const spineIds=[...opf.matchAll(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m=>m[1]).filter(id=>manifest.has(id));
  if(!spineIds.length)throw new ApiError(422,"This EPUB has no readable spine.");
  const maxPct=Math.max(1,Math.min(50,Number(policy.max_percentage||20))),hardCap=Math.max(1,Math.ceil(spineIds.length*maxPct/100));
  const wanted=String(policy.mode)==="chapters"?Number(policy.limit_value||1):Math.ceil(spineIds.length*Math.min(maxPct,Number(policy.limit_value||10))/100);
  const count=Math.max(1,Math.min(spineIds.length,hardCap,wanted)),selected=new Set(spineIds.slice(0,count));
  // Preserve only the selected reading documents and the presentation assets they actually reference.
  // Keeping every image/font from the publisher EPUB would leak future pages in fixed-layout/image books.
  const keepIds=new Set<string>(),keepPaths=new Set(["mimetype","META-INF/container.xml",rootfile]),pathToItem=new Map<string,any>();
  for(const [id,item] of manifest){if(item.href)pathToItem.set(zipJoin(opfDir,item.href),item);if(selected.has(id)||item.properties.split(/\s+/).includes("nav")||item.media.toLowerCase()==="application/x-dtbncx+xml")keepIds.add(id);}
  const safeDependency=(media:string)=>{const m=media.toLowerCase();return m.startsWith("image/")||m==="text/css"||m.startsWith("font/")||["application/font-woff","application/vnd.ms-opentype","application/x-font-ttf"].includes(m);};
  const queue:string[]=[];for(const id of keepIds){const item=manifest.get(id);if(item?.href){const p=zipJoin(opfDir,item.href);keepPaths.add(p);queue.push(p);}}
  const seen=new Set<string>();
  while(queue.length){const current=queue.shift()!;if(seen.has(current))continue;seen.add(current);const file=zip.file(current);if(!file)continue;const item=pathToItem.get(current),media=String(item?.media||"").toLowerCase();if(!(media==="text/css"||media.includes("xhtml")||media==="text/html"||media==="image/svg+xml"))continue;
    let text="";try{text=await file.async("string");}catch{continue;}const dir=current.includes("/")?current.slice(0,current.lastIndexOf("/")):"";
    const refs=[...text.matchAll(/(?:src|href|poster|xlink:href)\s*=\s*["']([^"'#]+)["']/gi),...text.matchAll(/url\(\s*["']?([^"')#]+)["']?\s*\)/gi),...text.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)].map(m=>m[1]).filter(Boolean);
    for(const ref of refs){if(/^(?:data:|https?:|mailto:|javascript:)/i.test(ref))continue;const target=zipJoin(dir,ref),dep=pathToItem.get(target);if(!dep||!safeDependency(String(dep.media||"")))continue;keepIds.add(dep.id);if(!keepPaths.has(target)){keepPaths.add(target);queue.push(target);}}
  }
  for(const name of Object.keys(zip.files)){if(zip.files[name].dir)continue;if(!keepPaths.has(name))zip.remove(name);}
  // Remove manifest declarations for excluded files and remove excluded spine references. The nav may
  // retain links to omitted chapters, but those resources are physically absent from the derivative.
  opf=opf.replace(/<item\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi,(tag,id)=>keepIds.has(String(id))?tag:"");
  opf=opf.replace(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi,(tag,id)=>selected.has(String(id))?tag:"");
  zip.file(rootfile,opf);
  zip.file("mimetype","application/epub+zip",{compression:"STORE"});
  const bytes=await zip.generateAsync({type:"uint8array",compression:"DEFLATE",compressionOptions:{level:6}});
  return{bytes,spineItems:count};
}
async function getPreviewEpub(env:CoveEnv,id:string,userId?:string,territory="US"){
  await getBook(env,id,userId);const db=database(env),product=await resolveProduct(db,id,userId);
  if(product.source_name==="upload")throw new ApiError(404,"Personal imports do not expose public samples.");
  const rights=await resolveProductRights(db,String(product.id),territory.toUpperCase(),{salesChannel:"retail",persist:true,context:{source:"preview-delivery",userId:userId||null}});
  if(!rights.allowed)throw new ApiError(404,"A preview is not available in this storefront.");
  const {policy}=await previewPolicy(db,product.id);
  const asset=await currentEpubAsset(env,product),key=`previews/${encodeURIComponent(product.id)}/${encodeURIComponent(asset.asset_version_id)}/p${Number(policy.version||1)}.epub`;
  const known=await db.prepare("SELECT * FROM preview_derivatives WHERE product_id=? AND asset_version_id=? AND policy_version=?").bind(product.id,asset.asset_version_id,Number(policy.version||1)).first<any>();
  if(env.BUCKET){const cached=await env.BUCKET.get(known?.object_key||key);if(cached)return new Response(cached.body,{headers:{"Content-Type":"application/epub+zip","Content-Length":String(cached.size),"Cache-Control":"private, no-store","Content-Disposition":`inline; filename="fore-${id}-sample.epub"`,"X-Cove-Preview":"1"}});}
  const source=await sourceEpubBytes(env,product,asset,String(product.source_external_id||id)),derived=await createPreviewEpub(source.bytes,policy),digest=new Uint8Array(await crypto.subtle.digest("SHA-256",derived.bytes)),sha=[...digest].map(x=>x.toString(16).padStart(2,"0")).join("");
  if(env.BUCKET)await env.BUCKET.put(key,derived.bytes,{httpMetadata:{contentType:"application/epub+zip",cacheControl:"86400"}});
  await db.prepare(`INSERT INTO preview_derivatives(id,product_id,asset_version_id,policy_version,object_key,spine_items,size_bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id,asset_version_id,policy_version) DO UPDATE SET object_key=excluded.object_key,spine_items=excluded.spine_items,size_bytes=excluded.size_bytes,sha256=excluded.sha256,created_at=excluded.created_at`).bind(known?.id||crypto.randomUUID(),product.id,asset.asset_version_id,Number(policy.version||1),key,derived.spineItems,derived.bytes.byteLength,sha,now()).run();
  return new Response(derived.bytes as any,{headers:{"Content-Type":"application/epub+zip","Content-Length":String(derived.bytes.byteLength),"Cache-Control":"private, no-store","Content-Disposition":`inline; filename="fore-${id}-sample.epub"`,"X-Cove-Preview":"1"}});
}

const libraryInput = z.object({
  bookId: bookIdSchema,
  status: z.enum(["want-to-read", "reading", "finished"]).optional(),
  progress: z.number().min(0).max(1).optional(),
  cfi: z.string().max(3000).optional(),
  shelves: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  rating: z.number().min(0.5).max(5).multipleOf(0.5).nullable().optional(),
  review: z.string().max(10000).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});
const annotationInput = z.object({
  bookId: bookIdSchema,
  quote: z.string().trim().min(1).max(12000),
  cfi: z.string().min(1).max(3000),
  chapter: z.string().max(300).default(""),
  color: z.enum(["yellow", "green", "blue", "pink", "purple"]).default("yellow"),
  note: z.string().max(12000).default(""),
  progress: z.number().min(0).max(1).optional(),
});
const definitionInput = z.object({
  word: z.string().trim().min(1).max(100),
  phonetic: z.string().max(200).default(""),
  meaning: z.string().min(1).max(5000),
  partOfSpeech: z.string().max(60).default(""),
  bookId: z.union([bookIdSchema, z.literal("")]).default(""),
  cfi: z.string().max(3000).default(""),
  context: z.string().max(12000).default(""),
  source: z.string().max(500).default("https://dictionaryapi.dev/"),
});
function clientIp(request: Request) {
  return (
    request.headers.get("x-cove-client-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    ""
  );
}

async function rateLimitSearchRequest(request: Request, env: CoveEnv, userId: string | null, bucket: string, limit: number) {
  const ip = clientIp(request);
  const actor = userId ? `user:${userId}` : ip ? `ip:${ip}` : null;
  if (actor) await rateLimit(env, `search:${bucket}:${actor}`, limit);
}

export async function runRecommendationMaintenance(env: CoveEnv) {
  const db=database(env);
  const [recommendations,wishlistAlerts]=await Promise.all([maintainRecommendations(db),runWishlistAlerts(db,"US",500,"")]);
  return {recommendations,wishlistAlerts};
}

export async function runPublishingReleaseMaintenance(env: CoveEnv) {
  return advancePublishingReleaseSchedules(database(env));
}

async function reportExternalError(env:CoveEnv,request:Request,error:unknown){
  if(!env.FORE_ERROR_REPORTING_URL)return;
  let endpoint:URL;try{endpoint=new URL(env.FORE_ERROR_REPORTING_URL);const host=endpoint.hostname.toLowerCase().replace(/^\[|\]$/g,"");if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||host==="localhost"||host.endsWith(".local")||host.endsWith(".internal")||host==="::1"||host.startsWith("fe80:")||host.startsWith("fc")||host.startsWith("fd"))return;const m=host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);if(m){const [a,b]=[Number(m[1]),Number(m[2])];if(a===10||a===127||a===0||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168))return;}}catch{return;}
  const redact=(v:string)=>String(v||"").replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/ig,"$1[REDACTED]").replace(/fore_svc_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,"fore_svc_[REDACTED]").replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+\b/g,"[REDACTED_STRIPE_SECRET]").replace(/([?&](?:token|secret|key|signature|password)=)[^&#\s]+/ig,"$1[REDACTED]");
  const e=error instanceof Error?error:new Error(String(error));
  const payload={service:"fore-api",requestId:request.headers.get("x-fore-request-id"),traceId:request.headers.get("x-fore-trace-id"),method:request.method,path:new URL(request.url).pathname,errorClass:e.name,message:redact(e.message).slice(0,1200),stack:redact((e.stack||"").split("\n").slice(0,12).join("\n")).slice(0,4000),at:now()};
  try{await fetch(endpoint.toString(),{method:"POST",redirect:"manual",headers:{"content-type":"application/json",...(env.FORE_ERROR_REPORTING_TOKEN?{"authorization":`Bearer ${env.FORE_ERROR_REPORTING_TOKEN}`}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(3000)});}catch{}
}

export async function handleCoveApi(request: Request, env: CoveEnv): Promise<Response | null> {
  if(!new URL(request.url).pathname.startsWith('/api/fore/'))return null;
  const trace=beginRequestTrace(request),headers=new Headers(request.headers);
  headers.set("x-fore-request-id",trace.requestId);headers.set("x-fore-trace-id",trace.traceId);headers.set("x-fore-span-id",trace.spanId);
  const tracedRequest=new Request(request,{headers});
  const auth=await createAuth(tracedRequest,env);
  const raw=await handleCoveRequest(tracedRequest,env,auth);
  if(!raw)return null;
  const decorated=auth.decorate(raw),responseHeaders=new Headers(decorated.headers);
  responseHeaders.set("x-fore-request-id",trace.requestId);responseHeaders.set("traceparent",trace.traceparent);
  const response=new Response(decorated.body,{status:decorated.status,statusText:decorated.statusText,headers:responseHeaders});
  if(env.DB)await recordHttpRequest(env.DB as any,trace,tracedRequest,response,{actorKind:identity(tracedRequest)?"user":"anonymous"});
  return response;
}
async function handleCoveRequest(request: Request, env: CoveEnv, auth:Awaited<ReturnType<typeof createAuth>>): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/fore/")) return null;
  const path = url.pathname.slice("/api/fore".length);
  try {
    if (request.method === "GET" && path === "/health/live") return json({ok:true,service:"fore-api",at:now()});
    if (request.method === "GET" && path === "/health/ready") {
      if (!env.DB) return json({ok:true,service:"fore-api",mode:"vercel-public-domain",database:false,commercialFeatures:false,at:now()});
      try {const db=database(env),started=Date.now();await db.prepare("SELECT 1 ok").first<any>();const markets=await db.prepare("SELECT COUNT(*) count FROM storefront_markets WHERE market_status='active'").first<any>();const ready=Number(markets?.count||0)>0;return json({ok:ready,service:"fore-api",database:true,activeMarkets:Number(markets?.count||0),latencyMs:Date.now()-started,at:now()},ready?200:503);} catch {return json({ok:false,service:"fore-api",database:false,at:now()},503);}
    }
    // Stripe webhooks are authenticated by Stripe-Signature, not browser Origin/JSON CSRF rules.
    if (request.method === "POST" && path === "/stripe/webhook") {
      return json(await stripeWebhook(env, request));
    }
    // Tax-provider adapters normalize specialist-provider webhooks into this signed contract.
    if (request.method === "POST" && path === "/tax/provider/webhook") {
      const payload=await verifyPublisherTaxWebhook(request,env.FORE_TAX_WEBHOOK_SECRET||"");
      return json(await registerPublisherTaxVerification(database(env),payload));
    }
    // Traditional-publisher integration calls are machine-to-machine. They authenticate with
    // scoped CovePartner credentials and deliberately bypass browser Origin/CSRF checks.
    if (path.startsWith("/partner/v1/")) {
      const db=database(env);
      if (request.method === "POST" && path === "/partner/v1/feeds") {
        const principal=await authenticatePartnerRequest(db,request,"feeds:write");
        await rateLimit(env,`partner-feed:${principal.credentialId}`,120);
        return json(await submitPartnerFeed(env,request,principal),202);
      }
      if (request.method === "POST" && path === "/partner/v1/assets") {
        const principal=await authenticatePartnerRequest(db,request,"assets:write");
        await rateLimit(env,`partner-asset:${principal.credentialId}`,240);
        return json(await uploadPartnerAsset(env,request,principal),201);
      }
      if (request.method === "POST" && path === "/partner/v1/assets/batch") {
        const principal=await authenticatePartnerRequest(db,request,"assets:write");
        await rateLimit(env,`partner-asset-batch:${principal.credentialId}`,30);
        return json(await uploadPartnerAssetBatch(env,request,principal),207);
      }
      const ackMatch=path.match(/^\/partner\/v1\/feeds\/([^/]+)\/ack$/);
      if (request.method === "GET" && ackMatch) {
        const principal=await authenticatePartnerRequest(db,request,"feeds:read");
        return json(await partnerFeedAcknowledgement(db,principal,decodeURIComponent(ackMatch[1])));
      }
      if (request.method === "GET" && path === "/partner/v1/ping") {
        const principal=await authenticatePartnerRequest(db,request,"catalog:read");
        return json({ok:true,environment:principal.environment,accountId:principal.accountId,apiVersion:"v1"});
      }
      throw new ApiError(404,"Unknown partner API endpoint.");
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (
        (origin && origin !== url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new ApiError(403, "This request could not be verified.");
      if (
        path !== "/upload" && path !== "/publishing/assets/upload" && path !== "/publishing/rights-evidence/upload" && path !== "/publishing/audio/upload" && !/^\/pipeline\/(media|text)\//.test(path) &&
        !request.headers.get("content-type")?.startsWith("application/json")
      )
        throw new ApiError(415, "JSON is required for this action.");
    }
    if (!env.DB) {
      const publicResponse = await handleVercelPublicRequest(request, env, path);
      if (publicResponse) return publicResponse;
    }
    const authResponse=await auth.handle(path);
    if(authResponse)return authResponse;
    await auth.identify();
    const machineDb=database(env);
    if(path.startsWith("/machine/v1/")){
      if(request.method!=="POST")throw new ApiError(405,"Machine endpoints require POST.");
      if(path==="/machine/v1/ops/check"){const principal=await requireServiceScope(machineDb,request,"operations.check");return json(await runTrackedWorker(machineDb,"operations.check",principal.principalId,async()=>({...await runOperationalChecks(machineDb),storage:await probeObjectStorage(machineDb,env.BUCKET),cdn:await probeCdnEdge(machineDb,env.FORE_PUBLIC_URL||"")})));}
      if(path==="/machine/v1/ops/synthetics"){const principal=await requireServiceScope(machineDb,request,"operations.synthetic");return json(await runTrackedWorker(machineDb,"operations.synthetic",principal.principalId,()=>runSyntheticChecks(machineDb)));}
      if(path==="/machine/v1/ops/slos"){const principal=await requireServiceScope(machineDb,request,"operations.check");return json(await runTrackedWorker(machineDb,"operations.slos",principal.principalId,()=>refreshSloMeasurements(machineDb)));}
      if(path==="/machine/v1/ops/jobs/lease"){const principal=await requireServiceScope(machineDb,request,"operations.queue");const x=z.object({queueKey:z.string().min(1),limit:z.number().int().min(1).max(100).default(10)}).parse(await body(request));return json(await leaseOpsJobs(machineDb,principal.principalId,x.queueKey,x.limit));}
      if(path==="/machine/v1/ops/jobs/complete"){const principal=await requireServiceScope(machineDb,request,"operations.queue");const x=z.object({jobId:z.string().min(1),success:z.boolean(),error:z.string().max(4000).default(""),retryAfterSeconds:z.number().int().min(1).max(86400).default(60)}).parse(await body(request));return json(await finishOpsJob(machineDb,{...x,workerId:principal.principalId}));}
      if(path==="/machine/v1/ops/backup"){await requireServiceScope(machineDb,request,"operations.backup");return json(await registerBackupArtifact(machineDb,await body(request)));}
      if(path==="/machine/v1/ops/alerts"){const principal=await requireServiceScope(machineDb,request,"operations.alert");return json(await runTrackedWorker(machineDb,"operations.alerts",principal.principalId,()=>deliverOperationalAlerts(machineDb,env.FORE_ALERT_WEBHOOK_URL||"",env.FORE_ALERT_WEBHOOK_TOKEN||"",100)));}
      if(path==="/machine/v1/search/reindex"){await requireServiceScope(machineDb,request,"search.reindex");const x=z.object({limit:z.number().int().min(1).max(500).default(500)}).parse(await body(request));return json(await rebuildSearchIndex(env,x.limit));}
      if(path==="/machine/v1/security/scan"){await requireServiceScope(machineDb,request,"security.evidence.write");return json(await recordSecurityScan(machineDb,await body(request)),201);}
      if(path==="/machine/v1/security/sbom"){await requireServiceScope(machineDb,request,"security.evidence.write");return json(await recordSbom(machineDb,await body(request)),201);}
      if(path==="/machine/v1/security/provenance"){await requireServiceScope(machineDb,request,"security.evidence.write");return json(await recordBuildProvenance(machineDb,await body(request)),201);}
      if(path==="/machine/v1/security/headers"){await requireServiceScope(machineDb,request,"security.evidence.write");return json(await verifySecurityHeaders(machineDb,null,await body(request)),201);}
      throw new ApiError(404,"Unknown machine endpoint.");
    }
    const dbForContext=machineDb;
    const currentIdentity=identity(request);
    const storefront=await resolveStorefrontContext(dbForContext,request,currentIdentity?.id||null,env.FORE_DEFAULT_TERRITORY||"US");
    const storefrontTerritory=storefront.rightsCountry;
    if (request.method === "GET" && path === "/storefront/context") {
      await recordStorefrontContext(dbForContext,storefront,currentIdentity?.id||null);
      return json({...storefront,availableMarkets:await storefrontMarkets(dbForContext)});
    }
    if (request.method === "POST" && path === "/storefront/context") {
      const input=z.object({country:z.string().regex(/^[A-Z]{2}$/).optional(),locale:z.string().max(35).optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional()}).parse(await body(request));
      await saveStorefrontPreferences(dbForContext,currentIdentity?.id||null,input);
      const headers=new Headers({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
      for(const c of storefrontPreferenceCookies(input,url.protocol==="https:"))headers.append("Set-Cookie",c);
      return new Response(JSON.stringify({saved:true}),{status:200,headers});
    }
    if (request.method === "GET" && path.startsWith("/authors/") && path.split("/").length===3) { const ref=decodeURIComponent(path.slice("/authors/".length)); return json(await authorProfile(database(env),ref,identity(request)?.id||null,storefrontTerritory)); }
    if (request.method === "GET" && path.startsWith("/charts/")) { const chartKey=decodeURIComponent(path.slice("/charts/".length)); return json(await retailChart(database(env),chartKey,storefrontTerritory,Number(url.searchParams.get("limit")||50))); }
    if (request.method === "POST" && path === "/events") { const payload=await body(request) as Record<string,unknown>,eventType=z.enum(["search_performed","search_result_clicked","product_viewed"]).parse(payload.eventType),userId=identity(request)?.id||null,anonymousId=z.string().min(8).max(120).parse(payload.anonymousId),actor=userId||anonymousId; await rateLimit(env,`retail-event:${actor}`,240); const bucket=Math.floor(Date.now()/(eventType==="product_viewed"?1800000:300000)),productId=typeof payload.productId==="string"?payload.productId:"",queryId=typeof payload.queryId==="string"?payload.queryId:"",dedupeKey=`client:${eventType}:${actor}:${queryId}:${productId}:${bucket}`; return json(await recordRetailEvent(database(env),userId,{...payload,eventType,anonymousId,territory:storefrontTerritory,currency:null,amountMinor:null,quantity:1,dedupeKey},"client")); }
    if (request.method === "GET" && path === "/checkout/config") return json({...commerceConfig(env),storefront:{country:storefront.storefrontCountry,rightsCountry:storefront.rightsCountry,locale:storefront.locale,currency:storefront.currency,taxInclusive:storefront.taxInclusive,checkoutEnabled:storefront.checkoutEnabled,paymentMethods:storefront.paymentMethods}});
    if (request.method === "GET" && path.startsWith("/catalog-assets/")) {
      return await catalogPublishingAsset(env, decodeURIComponent(path.slice("/catalog-assets/".length)));
    }
    if (request.method === "POST" && path === "/admin/staff/bootstrap") {
      requireStaffBootstrap(request, env);
      return json(await bootstrapStaffPrincipal(database(env), identity(request)?.id || "breakglass-bootstrap", await body(request)));
    }
    if (request.method === "POST" && path === "/admin/staff/principal") {
      const db=database(env),who=identity(request),staff=await requireStaffPermission(db,who,"staff.manage");
      return json(await manageStaffPrincipal(db,staff,await body(request)));
    }
    if(path.startsWith("/admin/localization/")||path.startsWith("/admin/operations/")||path.startsWith("/admin/service-principals")||path.startsWith("/admin/security/")){
      const db=database(env),who=identity(request);
      if(path.startsWith("/admin/security/")&&who?.authProvider!=="openai-host"&&who?.aal!=="aal2") throw new ApiError(403,"Security administration requires multi-factor authentication (AAL2).");
      if(request.method==="GET"&&path==="/admin/localization/status"){await requireStaffPermission(db,who,"localization.read",request);return json(await localizationAdminSnapshot(db));}
      if(request.method==="POST"&&path==="/admin/localization/market"){const staff=await requireStaffPermission(db,who,"localization.manage",request);return json(await upsertMarket(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/localization/taxonomy"){const staff=await requireStaffPermission(db,who,"localization.manage",request);return json(await upsertTaxonomyLocalization(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/localization/locale"){const staff=await requireStaffPermission(db,who,"localization.manage",request);return json(await upsertLocale(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/localization/translations"){const staff=await requireStaffPermission(db,who,"localization.manage",request);return json(await saveTranslationBundle(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/localization/market-options"){const staff=await requireStaffPermission(db,who,"localization.manage",request);return json(await configureMarketOptions(db,staff.userId,await body(request)));}
      if(request.method==="GET"&&path==="/admin/operations/status"){await requireStaffPermission(db,who,"operations.read",request);return json(await operationsSnapshot(db));}
      if(request.method==="POST"&&path==="/admin/operations/check"){await requireStaffPermission(db,who,"operations.manage",request);return json({...await runOperationalChecks(db),storage:await probeObjectStorage(db,env.BUCKET),cdn:await probeCdnEdge(db,env.FORE_PUBLIC_URL||"")});}
      if(request.method==="POST"&&path==="/admin/operations/slo"){await requireStaffPermission(db,who,"operations.manage",request);return json(await refreshSloMeasurements(db));}
      if(request.method==="POST"&&path==="/admin/operations/synthetic"){await requireStaffPermission(db,who,"operations.manage",request);return json(await runSyntheticChecks(db));}
      if(request.method==="POST"&&path==="/admin/operations/incident"){const staff=await requireStaffPermission(db,who,"operations.manage",request);return json(await acknowledgeIncident(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/operations/restore-drill"){const staff=await requireStaffPermission(db,who,"operations.manage",request);return json(await recordRestoreDrill(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/operations/deployment"){const staff=await requireStaffPermission(db,who,"operations.deploy",request);return json(await saveDeployment(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/operations/migration-control"){const staff=await requireStaffPermission(db,who,"operations.deploy",request);return json(await saveMigrationControl(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/operations/capacity"){const staff=await requireStaffPermission(db,who,"operations.manage",request);return json(await recordCapacityTest(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/operations/dlq/replay"){const staff=await requireStaffPermission(db,who,"operations.manage",request);return json(await replayDeadLetter(db,staff.userId,await body(request)));}
      if(request.method==="GET"&&path==="/admin/service-principals"){await requireStaffPermission(db,who,"service_principal.read",request);return json(await servicePrincipalSnapshot(db));}
      if(request.method==="POST"&&path==="/admin/service-principals/save"){const staff=await requireStaffPermission(db,who,"service_principal.manage",request);return json(await saveServicePrincipal(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/service-principals/credential"){const staff=await requireStaffPermission(db,who,"service_principal.manage",request);return json(await issueServiceCredential(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/service-principals/revoke"){const staff=await requireStaffPermission(db,who,"service_principal.manage",request);return json(await revokeServiceCredential(db,staff.userId,await body(request)));}
      if(request.method==="GET"&&path==="/admin/security/status"){await requireStaffPermission(db,who,"security.read",request);return json(await securityOperationsSnapshot(db));}
      if(request.method==="POST"&&path==="/admin/security/threat-model"){const staff=await requireStaffPermission(db,who,"security.manage",request);return json(await saveThreatModel(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/threat"){await requireStaffPermission(db,who,"security.manage",request);return json(await saveThreat(db,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/edge-control"){const staff=await requireStaffPermission(db,who,"security.manage",request);return json(await saveEdgeControl(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/headers/verify"){const staff=await requireStaffPermission(db,who,"security.manage",request);return json(await verifySecurityHeaders(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/secret-reference"){await requireStaffPermission(db,who,"security.manage",request);return json(await registerSecretReference(db,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/key-rotation"){const staff=await requireStaffPermission(db,who,"security.manage",request);return json(await recordKeyRotation(db,"staff",staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/finding"){const staff=await requireStaffPermission(db,who,"security.manage",request);return json(await updateSecurityFinding(db,staff.userId,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/pentest"){await requireStaffPermission(db,who,"security.manage",request);return json(await savePentest(db,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/disclosure"){await requireStaffPermission(db,who,"security.manage",request);return json(await manageDisclosureReport(db,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/incident"){await requireStaffPermission(db,who,"security.manage",request);return json(await declareSecurityIncident(db,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/incident/update"){await requireStaffPermission(db,who,"security.manage",request);return json(await updateSecurityIncident(db,await body(request)));}
      if(request.method==="POST"&&path==="/admin/security/publisher-policy"){const staff=await requireStaffPermission(db,who,"security.manage",request);return json(await setPublisherSecurityPolicy(db,staff.userId,await body(request)));}
    }
    if (path.startsWith("/admin/publishing/") || path.startsWith("/admin/moderation/") || path.startsWith("/admin/rights/") || path.startsWith("/admin/accessibility/") || path.startsWith("/admin/support/") || path.startsWith("/admin/audio/") || path.startsWith("/admin/risk-tax/") || path.startsWith("/admin/risk/") || path.startsWith("/admin/tax/")) {
      const db=database(env),who=identity(request);
      if(path.startsWith("/admin/support/") && who?.aal!=="aal2") throw new ApiError(403,"Customer support operations require MFA (AAL2).");
      if (request.method === "GET" && path === "/admin/risk/status") { const staff=await requireStaffPermission(db,who,"risk.case.read"); return json({...await riskOperationsSnapshot(db),staff:{userId:staff.userId,permissions:[...staff.permissions]}}); }
      if (request.method === "GET" && path === "/admin/tax/status") { const staff=await requireStaffPermission(db,who,"tax.compliance.read"); return json({...await taxOperationsSnapshot(db),staff:{userId:staff.userId,permissions:[...staff.permissions]}}); }
      if (request.method === "GET" && path === "/admin/risk-tax/status") { const staff=await requireStaffPermission(db,who,"risk.case.read"); await requireStaffPermission(db,who,"tax.compliance.read"); const snapshot=await riskTaxOperationsSnapshot(db); return json({...snapshot,staff:{userId:staff.userId,permissions:[...staff.permissions]}}); }
      if (request.method === "POST" && path === "/admin/risk/case") { const staff=await requireStaffPermission(db,who,"risk.case.manage"); return json(await manageRiskCase(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/risk/hold/release") { const staff=await requireStaffPermission(db,who,"risk.hold.manage"); return json(await releaseRiskHold(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/risk/link") { await requireStaffPermission(db,who,"risk.link.manage"); return json(await upsertRiskEntityLink(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/risk/policy") { const staff=await requireStaffPermission(db,who,"risk.policy.manage"); return json(await createRiskPolicyVersion(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/tax/registration") { await requireStaffPermission(db,who,"tax.compliance.manage"); return json(await upsertTaxRegistration(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/tax/withholding-rule") { await requireStaffPermission(db,who,"tax.compliance.manage"); return json(await upsertPublisherWithholdingRule(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/tax/publisher-verification") { await requireStaffPermission(db,who,"tax.compliance.manage"); return json(await registerPublisherTaxVerification(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/tax/reconcile") { await requireStaffPermission(db,who,"tax.compliance.manage"); return json(await reconcileCustomerTaxPeriod(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/tax/reporting/refresh") { await requireStaffPermission(db,who,"tax.compliance.manage"); return json(await refreshPublisherTaxReportingPeriod(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/tax/reporting/update") { await requireStaffPermission(db,who,"tax.compliance.manage"); return json(await updatePublisherTaxReportingPeriod(db,await body(request))); }
      if (request.method === "GET" && path === "/admin/support/search") { const staff=await requireStaffPermission(db,who,"support.read"); return json(await supportSearch(db,url.searchParams.get("q")||"",staff.permissions.has("support.payment.read")||staff.permissions.has("staff.manage"))); }
      if (request.method === "POST" && path === "/admin/support/cases") { const staff=await requireStaffPermission(db,who,"support.case.manage"); return json(await createSupportCase(db,staff,await body(request))); }
      if (request.method === "GET" && path.startsWith("/admin/support/cases/")) { const staff=await requireStaffPermission(db,who,"support.read"); return json(await supportCaseDetail(db,decodeURIComponent(path.slice("/admin/support/cases/".length)),staff.permissions.has("support.payment.read")||staff.permissions.has("staff.manage"))); }
      if (request.method === "POST" && path === "/admin/support/note") { const staff=await requireStaffPermission(db,who,"support.case.manage"); return json(await addSupportNote(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/support/action") { const staff=await requireStaffPermission(db,who,"support.case.manage"); return json(await executeSupportAction(env,staff,(p)=>staff.permissions.has(p)||staff.permissions.has("staff.manage"),await body(request))); }
      if (request.method === "POST" && path === "/admin/audio/biosync-link") { const staff=await requireStaffPermission(db,who,"audio.qc.review"); return json(await saveCommercialBiosyncLink(env,staff.userId,await body(request))); }
      if (request.method === "GET" && path === "/admin/publishing/status") { const staff=await requireStaffPermission(db,who,"moderation.case.read"); return json({...await adminPublishingSnapshot(db),staff:{userId:staff.userId,email:staff.email,displayName:staff.displayName,roles:staff.roles,permissions:[...staff.permissions],mfaRequired:staff.mfaRequired}}); }
      if (request.method === "GET" && path === "/admin/accessibility/audits") { await requireStaffPermission(db,who,"accessibility.audit.read"); return json({audits:(await db.prepare("SELECT * FROM accessibility_audit_runs ORDER BY created_at DESC LIMIT 250").all<any>()).results,policy:(await db.prepare("SELECT * FROM accessibility_policy_versions WHERE status='active' ORDER BY created_at DESC LIMIT 1").first<any>())||null}); }
      if (request.method === "POST" && path === "/admin/accessibility/audit") { const staff=await requireStaffPermission(db,who,"accessibility.audit.manage"),x=z.object({surface:z.enum(["store","checkout","reader","publishing","staff","auth","sitewide"]),standard:z.string().min(1).max(120).default("WCAG 2.2 AA"),scanner:z.string().min(1).max(120),scannerVersion:z.string().max(120).default(""),status:z.enum(["passed","warning","failed"]),criticalCount:z.number().int().min(0).default(0),seriousCount:z.number().int().min(0).default(0),moderateCount:z.number().int().min(0).default(0),minorCount:z.number().int().min(0).default(0),reportObjectKey:z.string().max(500).nullable().optional(),reportSha256:z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),commitRef:z.string().max(200).default("")}).parse(await body(request)),auditId=`a11yaudit_${crypto.randomUUID()}`,at=new Date().toISOString(); await db.prepare("INSERT INTO accessibility_audit_runs(id,surface,standard,scanner,scanner_version,status,critical_count,serious_count,moderate_count,minor_count,report_object_key,report_sha256,commit_ref,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(auditId,x.surface,x.standard,x.scanner,x.scannerVersion,x.status,x.criticalCount,x.seriousCount,x.moderateCount,x.minorCount,x.reportObjectKey||null,x.reportSha256||null,x.commitRef,staff.userId,at).run(); return json({id:auditId,createdAt:at}); }
      if (request.method === "POST" && path === "/admin/publishing/onboarding-review") { const staff=await requireStaffPermission(db,who,"publishing.review"); return json(await reviewPublishingOnboarding(db, staff.userId, await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/submission-review") { const staff=await requireStaffPermission(db,who,"publishing.review"); return json(await reviewPublishingSubmission(env, staff.userId, await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/duplicate-review") { const staff=await requireStaffPermission(db,who,"publishing.duplicate_review"); return json(await resolveDuplicateMatch(db, staff.userId, await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/rollback") { const staff=await requireStaffPermission(db,who,"publishing.rollback"); return json(await rollbackPublishingVersion(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/distribution-control") { const staff=await requireStaffPermission(db,who,"publishing.rollback"); return json(await setDistributionControl(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/delivery-policy") { const staff=await requireStaffPermission(db,who,"publishing.rollback"); return json(await setCommercialDeliveryPolicy(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/promotion-review") { const staff=await requireStaffPermission(db,who,"promotions.review"); return json(await reviewPromotionCampaign(db,staff.userId,await body(request))); }
      if (request.method === "GET" && path === "/admin/publishing/promotions") { await requireStaffPermission(db,who,"promotions.operations.read"); return json(await promotionOperationsDashboard(db)); }
      if (request.method === "POST" && path === "/admin/publishing/royalty-contract-version") { const staff=await requireStaffPermission(db,who,"finance.contract.manage"); const input=await body(request) as Record<string,unknown>; return json(await createRoyaltyContractVersion(db,{...input,createdByUserId:staff.userId})); }
      if (request.method === "POST" && path === "/admin/publishing/distribution-contract-version") { const staff=await requireStaffPermission(db,who,"finance.contract.manage"); return json(await saveContractVersion(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/contract-assignment") { const staff=await requireStaffPermission(db,who,"finance.contract.manage"); return json(await assignPublisherContract(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/partner-certification") { const staff=await requireStaffPermission(db,who,"publishing.review"); return json(await certifyPartnerProfile(db,staff.userId,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/work-reconcile") { const staff=await requireStaffPermission(db,who,"publishing.review"); const x=z.object({limit:z.number().int().min(1).max(1000).default(250)}).parse(await body(request)); return json({...await reconcilePublicDomainWorks(db,x.limit),staffUserId:staff.userId}); }
      if (request.method === "POST" && path === "/admin/publishing/statement") { await requireStaffPermission(db,who,"finance.statement.generate"); return json(await generateMonthlyStatement(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/daily-metrics") { await requireStaffPermission(db,who,"finance.metrics.refresh"); return json(await refreshCreatorDailyMetrics(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/usage-event") { await requireStaffPermission(db,who,"finance.usage.ingest"); return json(await recordUsageEvent(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/usage-event/process") { await requireStaffPermission(db,who,"finance.usage.ingest"); const x=z.object({usageEventId:z.string().min(1)}).parse(await body(request)); return json(await processUsageEventRoyalty(db,x.usageEventId)); }
      if (request.method === "POST" && path === "/admin/publishing/usage-pool") { await requireStaffPermission(db,who,"finance.usage.ingest"); return json(await createUsagePool(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/usage-pool/allocate") { await requireStaffPermission(db,who,"finance.usage.ingest"); const x=z.object({poolId:z.string().min(1)}).parse(await body(request)); return json(await allocateUsagePool(db,x.poolId)); }
      if (request.method === "POST" && path === "/admin/publishing/tax-document") { await requireStaffPermission(db,who,"finance.tax_document.manage"); return json(await registerCreatorTaxDocument(db,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/author-verification") { const staff=await requireStaffPermission(db,who,"authors.verify"); return json(await reviewAuthorVerification(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/publishing/ranking-policy") { const staff=await requireStaffPermission(db,who,"analytics.operations.manage"); return json(await createRetailRankingPolicyVersion(db,staff,await body(request))); }
      if (request.method === "GET" && path === "/admin/publishing/retail-intelligence") { const staff=await requireStaffPermission(db,who,"moderation.case.read"),status=await retailIntelligenceStatus(db); const analytics=staff.permissions.has("analytics.operations.read")||staff.permissions.has("staff.manage"),authors=staff.permissions.has("authors.verify")||staff.permissions.has("staff.manage"),reviews=staff.permissions.has("reviews.integrity.read")||staff.permissions.has("reviews.integrity.manage")||staff.permissions.has("staff.manage"); return json({...status,eventsLast24h:analytics?status.eventsLast24h:[],outbox:analytics?status.outbox:[],rankingSnapshots:analytics?status.rankingSnapshots:[],openReviewSignals:reviews?status.openReviewSignals:[],reviewSignalQueue:reviews?status.reviewSignalQueue:[],pendingAuthorProfiles:authors?status.pendingAuthorProfiles:[],authorProfiles:authors?status.authorProfiles:[]}); }
      if (request.method === "POST" && path === "/admin/moderation/review-integrity-policy") { const staff=await requireStaffPermission(db,who,"reviews.integrity.policy.manage"); return json(await createReviewIntegrityPolicyVersion(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/moderation/review-integrity") { const staff=await requireStaffPermission(db,who,"reviews.integrity.manage"); return json(await resolveReviewIntegritySignal(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/moderation/account-risk-link") { const staff=await requireStaffPermission(db,who,"reviews.integrity.manage"); return json(await upsertRetailRiskLink(db,staff,await body(request))); }
      if (request.method === "GET" && path === "/admin/moderation/status") { const staff=await requireStaffPermission(db,who,"moderation.case.read"),includeStaff=staff.permissions.has("staff.manage"),includeAudit=staff.permissions.has("moderation.audit.read")||includeStaff; return json({...await moderationDashboard(db,includeAudit,includeStaff),staff:{userId:staff.userId,email:staff.email,displayName:staff.displayName,roles:staff.roles,permissions:[...staff.permissions],mfaRequired:staff.mfaRequired}}); }
      if (request.method === "POST" && path === "/admin/moderation/case") { const staff=await requireStaffPermission(db,who,"moderation.case.manage"); return json(await manageModerationCase(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/moderation/note") { const staff=await requireStaffPermission(db,who,"moderation.note.write"); return json(await addModerationNote(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/moderation/action") { const staff=await requireStaffPermission(db,who,"moderation.case.read"); return json(await executeModerationAction(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/moderation/appeal-decision") { const staff=await requireStaffPermission(db,who,"moderation.appeal.decide"); return json(await decideModerationAppeal(db,staff,await body(request))); }
      if (request.method === "GET" && path === "/admin/rights/status") { await requireStaffPermission(db,who,"moderation.case.read"); return json(await rightsOperationsDashboard(db)); }
      const rightsEvidenceMatch=path.match(/^\/admin\/rights\/evidence\/([^/]+)$/);
      if (request.method === "GET" && rightsEvidenceMatch) {
        await requireStaffPermission(db,who,"rights.evidence.review");
        const evidenceId=decodeURIComponent(rightsEvidenceMatch[1]);
        const evidence=await db.prepare("SELECT id,original_filename,mime_type,size_bytes,object_key,scan_status FROM publishing_rights_evidence WHERE id=?").bind(evidenceId).first<any>();
        if(!evidence)throw new ApiError(404,"Rights evidence not found.");
        if(evidence.scan_status!=="clean")throw new ApiError(409,"Rights evidence can be downloaded by staff only after the security scan passes.");
        if(!env.BUCKET)throw new ApiError(503,"Rights evidence storage is not configured.");
        const object=await env.BUCKET.get(String(evidence.object_key));if(!object)throw new ApiError(404,"Rights evidence object is unavailable.");
        const filename=String(evidence.original_filename||"rights-evidence").replace(/["\r\n\\]/g,"_");
        return new Response(object.body,{headers:{"Content-Type":String(evidence.mime_type||"application/octet-stream"),"Content-Length":String(object.size||evidence.size_bytes||0),"Content-Disposition":`attachment; filename="${filename}"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox"}});
      }
      if (request.method === "POST" && path === "/admin/rights/notice-validation") { const staff=await requireStaffPermission(db,who,"rights.notice.validate"); return json(await validateCopyrightNotice(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/counter-validation") { const staff=await requireStaffPermission(db,who,"rights.counter_notice.validate"); return json(await validateCopyrightCounterNotice(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/court-action") { const staff=await requireStaffPermission(db,who,"rights.dispute.resolve"); return json(await recordCopyrightCourtAction(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/resolve") { const staff=await requireStaffPermission(db,who,"rights.dispute.resolve"); return json(await resolveRightsDispute(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/repeat-infringer") { const staff=await requireStaffPermission(db,who,"rights.repeat_infringer.manage"); return json(await manageRepeatInfringerPolicy(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/evidence-review") { const staff=await requireStaffPermission(db,who,"rights.evidence.review"); return json(await reviewRightsEvidence(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/similarity-review") { const staff=await requireStaffPermission(db,who,"rights.cluster.review"); return json(await resolveSimilarityMatch(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/identity-review") { const staff=await requireStaffPermission(db,who,"rights.identity_similarity.review"); return json(await resolveIdentitySimilarity(db,staff,await body(request))); }
      if (request.method === "POST" && path === "/admin/rights/cluster-review") { const staff=await requireStaffPermission(db,who,"rights.cluster.review"); return json(await resolveRiskCluster(db,staff,await body(request))); }
    }
    if (path.startsWith("/publishing-worker/")) {
      await requireServiceScope(database(env), request, "publishing.worker");
      if (request.method === "POST" && path === "/publishing-worker/jobs/lease") return json(await leasePublishingValidationJobs(database(env), await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/jobs/complete") return json(await completePublishingValidationJob(database(env), await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/releases/tick") return json(await advancePublishingReleaseSchedules(database(env)));
      if (request.method === "POST" && path === "/publishing-worker/rights/deadlines") return json(await advanceRightsDisputeDeadlines(database(env)));
      if (request.method === "POST" && path === "/publishing-worker/rights/notifications/lease") return json(await leaseRightsNotificationJobs(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/rights/notifications/complete") return json(await completeRightsNotificationJob(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/rights/evidence/lease") return json(await leaseRightsEvidenceScanJobs(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/rights/evidence/complete") return json(await completeRightsEvidenceScanJob(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/preorders/tick") return json(await advancePreorders(database(env)));
      if (request.method === "POST" && path === "/publishing-worker/preorders/refunds") return json(await processPreorderRefundJobs(env,await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/promotions/tick") return json(await advancePromotionCampaigns(database(env)));
      if (request.method === "POST" && path === "/publishing-worker/authors/alerts/tick") { const db=database(env); const queued=await queueAuthorReleaseAlerts(db); const processed=await processAuthorReleaseAlerts(db,100); return json({...queued,...processed}); }
      if (request.method === "POST" && path === "/publishing-worker/authors/social/tick") { const x=z.object({limit:z.number().int().min(1).max(50).default(10),batchSize:z.number().int().min(1).max(1000).default(500)}).parse(await body(request)); return json(await processAuthorSocialFanoutJobs(database(env),x.limit,x.batchSize)); }
      if (request.method === "POST" && path === "/publishing-worker/analytics/metrics") { const x=z.object({days:z.number().int().min(1).max(365).default(90)}).parse(await body(request)); return json(await refreshRetailDailyMetrics(database(env),x.days)); }
      if (request.method === "POST" && path === "/publishing-worker/analytics/rankings") { const x=z.object({territory:z.string().regex(/^[A-Z]{2}$/).default("US")}).parse(await body(request)); return json(await refreshRetailRankings(database(env),x.territory)); }
      if (request.method === "POST" && path === "/publishing-worker/analytics/outbox/lease") return json(await leaseRetailEventOutbox(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/analytics/outbox/complete") return json(await completeRetailEventOutbox(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/audio/qc/lease") return json(await leaseCommercialAudioQcJobs(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/audio/qc/complete") return json(await completeCommercialAudioQc(database(env),await body(request)));
      if (request.method === "POST" && path === "/publishing-worker/accounts/deletions") { const x=z.object({limit:z.number().int().min(1).max(100).default(25)}).parse(await body(request)); return json(await processAccountDeletionQueue(env,x.limit)); }
      if (request.method === "POST" && path === "/publishing-worker/partner-feeds/tick") { const x=z.object({limit:z.number().int().min(1).max(100).default(25)}).parse(await body(request)); return json(await processPartnerFeedQueue(database(env),x.limit)); }
      if (request.method === "POST" && path === "/publishing-worker/partner-acknowledgements/tick") { const x=z.object({limit:z.number().int().min(1).max(200).default(50)}).parse(await body(request)); return json(await deliverPartnerValidationResponses(env,x.limit)); }
      if (request.method === "POST" && path === "/publishing-worker/work-reconciliation/tick") { const x=z.object({limit:z.number().int().min(1).max(1000).default(250)}).parse(await body(request)); return json(await reconcilePublicDomainWorks(database(env),x.limit)); }
      if (request.method === "POST" && path === "/publishing-worker/work-identities/tick") { const x=z.object({limit:z.number().int().min(1).max(5000).default(1000)}).parse(await body(request)); return json(await rebuildWorkIdentityKeys(database(env),x.limit)); }
      if (request.method === "POST" && path === "/publishing-worker/notifications/deliver") { const x=z.object({limit:z.number().int().min(1).max(200).default(50)}).parse(await body(request)); return json(await processNotificationDeliveryQueue(env,x.limit)); }
    }
    if (request.method === "POST" && path === "/security/disclosure") { const actor=clientIp(request)||"anonymous"; await rateLimit(env,`security-disclosure:${actor}`,5); return json(await submitDisclosureReport(database(env),await body(request,30000)),202); }
        if (request.method === "POST" && path === "/moderation/report") { const reporter=identity(request)?.id||null,actor=reporter||clientIp(request)||"anonymous"; await rateLimit(env,`moderation-report:${actor}`,60); return json(await submitAbuseReport(database(env),reporter,await body(request))); }
    if (request.method === "POST" && (path === "/moderation/copyright-complaint" || path === "/rights/copyright-notice")) { const reporter=identity(request)?.id||null,actor=reporter||clientIp(request)||"anonymous"; await rateLimit(env,`copyright-notice:${actor}`,10); return json(await submitCopyrightNotice(database(env),reporter,await body(request))); }
    if (request.method !== "GET" && /^\/social\/authors\/[^/]+\/posts(?:\/[^/]+)?$/.test(path)) {
      const socialIdentity=identity(request);
      if (!socialIdentity) throw new ApiError(401,"Sign in to manage an author profile.");
      if (socialIdentity.authProvider!=="openai-host" && socialIdentity.aal!=="aal2") throw new ApiError(403,"Multi-factor authentication is required for author publishing actions.");
    }
    const extended =
      (await handlePipeline(request,env,path,identity(request)?.id||null)) ||
      (await handleCommercialAudio(request, env, path, identity(request)?.id || null, storefrontTerritory)) ||
      (await handleAudio(request, env, path, identity(request)?.id || null, storefrontTerritory)) ||
      (await handleSocial(request, env, path, identity(request)?.id || null)) ||
      (await handleCommunity(request, env, path, identity(request)?.id || null, getBook));
    if (extended) return extended;
    if (request.method === "GET" && path === "/catalog") {
      const searchUserId = identity(request)?.id || null;
      await rateLimitSearchRequest(request, env, searchUserId, "catalog", 180);
      const result = await catalog(env, url, searchUserId, storefrontTerritory);
      kickCatalogIngestion(env);
      return json(result);
    }
    if (request.method === "GET" && path === "/search/suggest") {
      await rateLimitSearchRequest(request, env, identity(request)?.id || null, "suggest", 240);
      const query = z.string().trim().min(2).max(100).parse(url.searchParams.get("q"));
      const territory = storefrontTerritory
      return json({ suggestions: await searchSuggestions(env, query, territory) });
    }
    if (request.method === "POST" && path === "/search/click") {
      await rateLimitSearchRequest(request, env, identity(request)?.id || null, "click", 240);
      const input = z.object({ queryId: z.string().uuid(), productId: z.string().min(1).max(120), position: z.number().int().min(1).max(1000) }).parse(await body(request));
      return json(await recordSearchClick(database(env), input));
    }
    if (request.method === "GET" && path === "/search/status") return json(await searchStatus(env));
    if (request.method === "GET" && path === "/taxonomy") {
      const territory = storefrontTerritory
      const language = z.string().max(16).parse(url.searchParams.get("language") || "");
      return json(await taxonomyTree(database(env), territory, language, storefront.locale));
    }
    if (request.method === "GET" && path === "/storefront/page") {
      const territory = storefrontTerritory
      const language = z.string().min(2).max(16).default(storefront.language).parse(url.searchParams.get("language") || storefront.language);
      const pagePath = z.string().min(1).max(240).parse(url.searchParams.get("path") || "/");
      return json(await resolveStorefrontPage(database(env), pagePath, territory, language, storefront.locale));
    }
    if (request.method === "GET" && path === "/merchandising") {
      await rateLimitSearchRequest(request, env, identity(request)?.id || null, "merch", 240);
      const territory = storefrontTerritory
      const language = z.string().min(2).max(16).default(storefront.language).parse(url.searchParams.get("language") || storefront.language);
      const visitorId = z.string().uuid().parse(url.searchParams.get("visitor"));
      return json(await storefrontMerchandising(env, { territory, language, visitorId, userId: identity(request)?.id || null }));
    }
    if (request.method === "POST" && path === "/merchandising/event") {
      await rateLimitSearchRequest(request, env, identity(request)?.id || null, "merch-event", 360);
      return json(await recordMerchEvent(database(env), await body(request), identity(request)?.id || null));
    }
    if (request.method === "GET" && path === "/recommendations/home") {
      const recUserId = identity(request)?.id || null;
      await rateLimitSearchRequest(request, env, recUserId, "recommend-home", 180);
      const territory = storefrontTerritory
      const visitorId = z.string().uuid().parse(url.searchParams.get("visitor"));
      const limit = z.coerce.number().int().min(4).max(20).default(12).parse(url.searchParams.get("limit") || "12");
      return json(await homeRecommendations(env, { userId: recUserId, visitorId, territory, limit }));
    }
    if (request.method === "GET" && path === "/recommendations/book") {
      const recUserId = identity(request)?.id || null;
      await rateLimitSearchRequest(request, env, recUserId, "recommend-book", 180);
      const territory = storefrontTerritory
      const visitorId = z.string().uuid().parse(url.searchParams.get("visitor"));
      const bookId = bookIdSchema.parse(url.searchParams.get("bookId"));
      const product = await resolveProduct(database(env), bookId, recUserId || undefined);
      return json(await bookRecommendations(env, { userId: recUserId, visitorId, territory, anchorProductId: product.id, limit: 10 }));
    }
    if (request.method === "POST" && path === "/recommendations/event") {
      const recUserId = identity(request)?.id || null;
      await rateLimitSearchRequest(request, env, recUserId, "recommend-event", 480);
      return json(await recordRecommendationEvent(database(env), recUserId, await body(request)));
    }
    if (request.method === "GET" && path === "/admin/recommendations/status") {
      await requireStorefrontAdmin(request, env, "recommendations.read");
      return json(await recommendationStatus(database(env)));
    }
    if (request.method === "POST" && path === "/admin/recommendations/metrics") {
      await requireStorefrontAdmin(request, env, "recommendations.manage");
      return json(await refreshRecommendationMetrics(database(env)));
    }
    if (request.method === "POST" && path === "/admin/recommendations/neighbors") {
      await requireStorefrontAdmin(request, env, "recommendations.manage");
      const input = z.object({ limit:z.number().int().min(1).max(500).default(100), afterProductId:z.string().max(180).default("") }).parse(await body(request));
      return json(await rebuildItemNeighbors(database(env), input.limit, input.afterProductId));
    }
    if (request.method === "POST" && path === "/admin/recommendations/jobs") {
      await requireStorefrontAdmin(request, env, "recommendations.manage");
      const input = z.object({ limit:z.number().int().min(1).max(100).default(25) }).parse(await body(request));
      return json(await processRecommendationJobs(database(env), input.limit));
    }
    if (request.method === "POST" && path === "/admin/recommendations/experiment") {
      await requireStorefrontAdmin(request, env, "recommendations.manage");
      return json(await upsertRecommendationExperiment(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/recommendations/model") {
      await requireStorefrontAdmin(request, env, "recommendations.manage");
      return json(await upsertRecommendationModel(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/recommendations/evaluate") {
      await requireStorefrontAdmin(request, env, "recommendations.manage");
      const input = z.object({ windowDays:z.number().int().min(1).max(180).default(30) }).parse(await body(request));
      return json(await refreshRecommendationEvaluations(database(env), input.windowDays));
    }
    if (request.method === "GET" && path === "/admin/taxonomy") {
      await requireStorefrontAdmin(request, env, "taxonomy.read");
      return json(await adminTaxonomySnapshot(database(env)));
    }
    if (request.method === "POST" && path === "/admin/taxonomy/node") {
      await requireStorefrontAdmin(request, env, "taxonomy.manage");
      return json(await upsertTaxonomyNode(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/taxonomy/mapping") {
      await requireStorefrontAdmin(request, env, "taxonomy.manage");
      return json(await upsertTaxonomyMapping(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/taxonomy/manual") {
      await requireStorefrontAdmin(request, env, "taxonomy.manage");
      return json(await setManualEditionTaxonomy(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/taxonomy/sync") {
      await requireStorefrontAdmin(request, env, "taxonomy.manage");
      const input = z.object({ limit: z.number().int().min(1).max(1000).default(250), afterEditionId: z.string().max(160).default("") }).parse(await body(request));
      return json(await syncTaxonomyBatch(database(env), input.limit, input.afterEditionId));
    }
    if (request.method === "POST" && path === "/admin/storefront/page") {
      await requireStorefrontAdmin(request, env, "storefront.manage");
      return json(await upsertStorefrontPage(database(env), await body(request)));
    }
    if (request.method === "GET" && path === "/admin/merchandising") {
      await requireStorefrontAdmin(request, env, "merchandising.read");
      return json(await adminMerchSnapshot(database(env)));
    }
    if (request.method === "POST" && path === "/admin/merchandising/campaign") {
      await requireStorefrontAdmin(request, env, "merchandising.manage");
      return json(await upsertCampaign(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/merchandising/collection") {
      await requireStorefrontAdmin(request, env, "merchandising.manage");
      return json(await upsertCollection(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/merchandising/collection-items") {
      await requireStorefrontAdmin(request, env, "merchandising.manage");
      return json(await setCollectionItems(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/merchandising/placement") {
      await requireStorefrontAdmin(request, env, "merchandising.manage");
      return json(await upsertPlacement(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/merchandising/experiment") {
      await requireStorefrontAdmin(request, env, "merchandising.manage");
      return json(await upsertExperiment(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/search/reindex") {
      await requireStorefrontAdmin(request, env, "search.reindex");
      const requestedLimit = Number(url.searchParams.get("limit") || 500);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) throw new ApiError(400, "Invalid reindex batch size.");
      return json(await rebuildSearchIndex(env, requestedLimit));
    }
    if (request.method === "GET" && path === "/admin/preview-policies") {
      await requireStorefrontAdmin(request, env, "storefront.read");
      const rows=await database(env).prepare(`SELECT pp.*,e.title,p.id product_id,p.source_name FROM preview_policies pp JOIN editions e ON e.id=pp.edition_id LEFT JOIN products p ON p.edition_id=e.id ORDER BY pp.updated_at DESC LIMIT 500`).all<any>();
      return json({policies:rows.results});
    }
    if (request.method === "POST" && path === "/admin/preview-policy") {
      await requireStorefrontAdmin(request, env, "storefront.manage");
      return json(await upsertPreviewPolicy(database(env), await body(request)));
    }
    if (request.method === "POST" && path === "/admin/wishlist-alerts") {
      await requireStorefrontAdmin(request, env, "merchandising.manage");
      const input=z.object({territory:z.string().regex(/^[A-Z]{2}$/).default("US"),limit:z.number().int().min(1).max(1000).default(250),after:z.string().max(400).default("")}).parse(await body(request));
      return json(await runWishlistAlerts(database(env),input.territory,input.limit,input.after));
    }
    if (path.startsWith("/admin/commerce/")) {
      const commercePermission=request.method==="GET"?(path==="/admin/commerce/accounting.csv"?"finance.read":"commerce.read"):(path.includes("payout")||path.includes("royalty-contract")||path.includes("finance-party")||path.includes("fx-rate")||path.includes("price-schedule")?"finance.manage":"commerce.manage");
      await requireCommerceAdmin(request, env, commercePermission);
      if (request.method === "GET" && path === "/admin/commerce/status") { const [commerce,finance,pricing,rights]=await Promise.all([commerceAdminSnapshot(database(env)),financeAdminSnapshot(database(env)),pricingAdminSnapshot(database(env)),rightsAdminSnapshot(database(env))]); return json({...commerce,finance,pricing,rights}); }
      if (request.method === "GET" && path === "/admin/commerce/rights") return json(await rightsAdminSnapshot(database(env)));
      if (request.method === "POST" && path === "/admin/commerce/rights-party") return json(await upsertRightsParty(database(env),await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/territory-set") return json(await upsertTerritorySet(database(env),await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/territory-expand") return json(await territoryExpansionPreview(database(env),await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/rights-contract") return json(await upsertRightsContract(database(env),await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/rights-grant") return json(await upsertRightsGrant(database(env),await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/rights-check") return json(await rightsAvailabilityCheck(database(env),await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/finance-party") return json(await createFinanceParty(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/royalty-contract") return json(await createRoyaltyContract(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/payout-batch") return json(await createPayoutBatch(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/payout-approve") { const x=z.object({batchId:z.string().min(1)}).parse(await body(request)); return json(await approvePayoutBatch(database(env),x.batchId)); }
      if (request.method === "POST" && path === "/admin/commerce/payout-settle") return json(await settlePayoutBatch(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/fx-rate") return json(await upsertFxRate(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/price-schedule") return json(await savePriceSchedule(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/promo") return json(await createPromoCode(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/gift-card") return json(await issueGiftCard(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/store-credit") return json(await adjustStoreCredit(database(env), await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/refund") return json(await refundOrder(env, await body(request)));
      if (request.method === "POST" && path === "/admin/commerce/capture") { const x=z.object({orderId:z.string().min(8).max(120)}).parse(await body(request)); return json(await captureAuthorizedOrder(env,x.orderId)); }
      if (request.method === "POST" && path === "/admin/commerce/reconcile") { const x=z.object({limit:z.number().int().min(1).max(500).default(100)}).parse(await body(request)); return json(await reconcileStripe(env,x.limit)); }
      if (request.method === "GET" && path === "/admin/commerce/accounting.csv") { const from=z.string().datetime().parse(url.searchParams.get("from")); const to=z.string().datetime().parse(url.searchParams.get("to")); return new Response(await accountingCsv(database(env),from,to),{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename=fore-accounting-${from.slice(0,10)}-${to.slice(0,10)}.csv`,"Cache-Control":"no-store"}}); }
    }
    if (request.method === "GET" && path === "/ingestion") return json(await ingestionStatus(env));
    if (request.method === "GET" && path === "/account") return json(await account(env, request));
    if (request.method === "GET" && path === "/publishing/policies") return json(await publicPublishingPolicies(database(env)));
    if (request.method === "GET" && path === "/rights/contact") return json({designatedAgent:{name:env.FORE_DMCA_AGENT_NAME||null,email:env.FORE_DMCA_AGENT_EMAIL||null,address:env.FORE_DMCA_AGENT_ADDRESS||null,phone:env.FORE_DMCA_AGENT_PHONE||null},intakePath:"/copyright"});
    if (request.method === "GET" && path.startsWith("/series/") && path.endsWith("/detail")) {
      const ref=decodeURIComponent(path.slice("/series/".length,-"/detail".length));
      return json(await seriesDetail(database(env),ref,identity(request)?.id||null,storefrontTerritory));
    }
    if (request.method === "GET" && path.startsWith("/editions/") && path.endsWith("/resolve")) {
      const editionId=decodeURIComponent(path.slice("/editions/".length,-"/resolve".length));
      return json(await editionResolve(database(env),editionId));
    }
    if (request.method === "GET" && path.startsWith("/works/")) {
      const workId=decodeURIComponent(path.slice("/works/".length));
      return json(await workDetail(database(env),workId,identity(request)?.id||null,storefrontTerritory));
    }
    if (request.method === "GET" && path.startsWith("/shared-wishlist/")) {
      const token=path.split("/")[2]||"";
      return json(await sharedWishlist(database(env),token,storefrontTerritory));
    }
    if (request.method === "GET" && path.startsWith("/products/") && path.endsWith("/resolve")) {
      const ref=decodeURIComponent(path.slice("/products/".length,-"/resolve".length));
      const product=await resolveProduct(database(env),ref,identity(request)?.id);
      const book=await getCanonicalBook(database(env),ref,identity(request)?.id);
      if(!book) throw new ApiError(404,"This edition is unavailable.");
      return json({productId:String(product.public_id||product.id),internalProductId:String(product.id),editionId:book.publicEditionId||book.editionId,workId:book.publicWorkId||book.workId,externalBookId:String(product.source_external_id),sourceName:String(product.source_name)});
    }
    if (request.method === "GET" && path.startsWith("/products/") && path.endsWith("/detail")) {
      const ref=decodeURIComponent(path.slice("/products/".length,-"/detail".length));
      return json(await productDetail(database(env),ref,identity(request)?.id||null,storefrontTerritory));
    }
    if (request.method === "GET" && path.startsWith("/books/")) {
      const bits = path.split("/");
      const id = bookIdSchema.parse(bits[2]);
      if (bits[3] === "epub") return await getEpub(env, id, identity(request)?.id, storefrontTerritory, request);
      if (bits[3] === "download" && bits[4] === "epub") return await getDownloadEpub(env, id, identity(request)?.id, storefrontTerritory, request);
      if (bits[3] === "preview" && bits[4] === "epub") return await getPreviewEpub(env,id,identity(request)?.id,storefrontTerritory);
      if (bits[3] === "detail") return json(await productDetail(database(env),id,identity(request)?.id||null,storefrontTerritory));
      const viewerId=identity(request)?.id;
      const product=await resolveProduct(database(env),id,viewerId);
      if(product.source_name!=="upload" && !(await activeEntitlement(database(env),viewerId,product.id))){
        const rights=await resolveProductRights(database(env),String(product.id),storefrontTerritory,{salesChannel:"retail"});
        if(!rights.allowed)throw new ApiError(404,"This edition is not available in your storefront.");
      }
      return json(await getBook(env, id, viewerId));
    }
    if (request.method === "GET" && path === "/dictionary") {
      const word = z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-zA-Z][a-zA-Z '-]*$/)
        .parse(url.searchParams.get("word"));
      const key = "dictionary:" + word.toLowerCase();
      const cached = await cacheGet(env, key);
      if (cached) return json(cached);
      const d = await remoteJson(
        "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word),
      );
      await cacheSet(env, key, d, 7 * 86400000);
      return json(d);
    }
    if (request.method === "POST" && path === "/promotions/event") {
      const payload:any=await body(request);
      const visitor=String(payload?.visitorId||"").slice(0,180);
      await rateLimit(env,`promotion-event:${visitor||clientIp(request)||"anon"}`,240);
      return json(await recordStorefrontPromotionEvent(database(env),identity(request)?.id||null,payload));
    }
    if (request.method === "GET" && path.startsWith("/delivery/epub/")) {
      await rateLimit(env,`delivery-token:${clientIp(request)||"anon"}`,240);
      return await serveCommercialEpubGrant(env,decodeURIComponent(path.slice("/delivery/epub/".length)),request);
    }
    const user = requiredUser(request);
    const db = database(env);
    const requirePublisherMfa=()=>{ if(user.authProvider!=="openai-host"&&user.aal!=="aal2") throw new ApiError(403,"This publishing action requires multi-factor authentication. Verify a second factor in Account Security, then try again."); };
    if(request.method!=="GET" && path.startsWith("/publishing/")) requirePublisherMfa();
    if (request.method === "GET" && path === "/account/management") return json(await accountOverview(db,user.id,request,user.sessionFingerprint));
    if (request.method === "GET" && path === "/notifications") return json(await notificationInbox(db,user.id,{limit:Number(url.searchParams.get("limit")||50),unreadOnly:url.searchParams.get("unread")==="1"}));
    if (request.method === "GET" && path === "/notifications/preferences") return json(await notificationPreferences(db,user.id));
    if (request.method === "GET" && path === "/notifications/config") return json({webPushPublicKey:env.FORE_WEB_PUSH_PUBLIC_KEY||null,mobilePushConfigured:!!env.FORE_MOBILE_PUSH_API_URL});
    if (request.method === "POST" && path === "/notifications/preferences") return json(await saveNotificationPreferences(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/notifications/mark") return json(await markNotifications(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/notifications/push/register") return json(await registerPushEndpoint(db,user.id,await body(request),request));
    if (request.method === "POST" && path === "/notifications/push/revoke") { const x=z.object({endpointId:z.string().min(1)}).parse(await body(request)); return json(await revokePushEndpoint(db,user.id,x.endpointId)); }
    if (request.method === "POST" && path === "/delivery/epub/grant") { await rateLimit(env,`delivery-grant:${user.id}`,120); return json(await issueCommercialEpubGrant(env,user.id,await body(request),request),201); }
    if (request.method === "POST" && path === "/delivery/grant/revoke") { const x=z.object({grantId:z.string().min(1)}).parse(await body(request)); return json(await revokeDeliveryGrant(db,user.id,x.grantId)); }
    if (request.method === "GET" && path === "/delivery/ownership") { const productId=z.string().min(1).parse(url.searchParams.get("productId")); return json(await ownershipStatus(db,user.id,productId)); }
    if (request.method === "POST" && path === "/delivery/annotation-anchor") return json(await snapshotAnnotationAnchor(db,user.id,await body(request)));
    if (request.method === "GET" && path === "/account/export") { const payload=await accountDataExport(db,user.id); return new Response(JSON.stringify(payload,null,2),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="fore-account-export-${new Date().toISOString().slice(0,10)}.json"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}}); }
    if (request.method === "POST" && path === "/account/billing-portal") { const returnUrl=(env.FORE_PUBLIC_URL?new URL("/profile",env.FORE_PUBLIC_URL).toString():new URL("/profile",request.url).toString()); return json(await createBillingPortal(env,{id:user.id,email:user.email,name:user.name},returnUrl)); }
    if (request.method === "POST" && path === "/account/billing-methods/refresh") return json(await syncCustomerBillingMethods(env,{id:user.id,email:user.email,name:user.name}));
    if (request.method === "POST" && path === "/account/preferences") return json(await saveAccountPreferences(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/account/address") return json(await saveAccountAddress(db,user.id,await body(request)));
    if (request.method === "DELETE" && path.startsWith("/account/address/")) return json(await deleteAccountAddress(db,user.id,decodeURIComponent(path.slice("/account/address/".length))));
    if (request.method === "POST" && path === "/account/session/revoke") { const x=z.object({sessionId:z.string().min(1)}).parse(await body(request)); return json(await revokeAccountSession(db,user.id,x.sessionId,request)); }
    if (request.method === "POST" && path === "/account/device/register") return json(await registerDevice(db,user.id,request,await body(request)));
    if (request.method === "POST" && path === "/account/device/revoke") { const x=z.object({deviceId:z.string().min(1)}).parse(await body(request)); return json(await revokeDevice(db,user.id,x.deviceId,request)); }
    if (request.method === "GET" && path === "/sync/clients") return json(await listSyncClients(db,user.id));
    if (request.method === "POST" && path === "/sync/clients/revoke") return json(await revokeSyncClient(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/sync/register") return json(await registerSyncClient(db,user.id,await body(request)),201);
    if (request.method === "POST" && path === "/sync/push") return json(await pushSyncBatch(db,user.id,await body(request,1_000_000)));
    if (request.method === "POST" && path === "/sync/pull") return json(await pullSyncChanges(db,user.id,await body(request)));
    if (request.method === "GET" && path === "/sync/bootstrap") return json(await syncBootstrapSnapshot(db,user.id));
    if (request.method === "GET" && path === "/sync/conflicts") return json(await syncConflicts(db,user.id));
    if (request.method === "POST" && path === "/sync/conflicts/resolve") return json(await resolveSyncConflict(db,user.id,await body(request)));
    if (request.method === "GET" && path === "/reader/settings") return json(await readerSettings(db,user.id));
    if (request.method === "POST" && path === "/reader/settings") return json(await saveReaderSetting(db,user.id,await body(request)));
    if (request.method === "GET" && path === "/bookmarks") return json(await listTextBookmarks(db,user.id,url.searchParams.get("bookId")||undefined));
    if (request.method === "POST" && path === "/bookmarks") return json(await createTextBookmark(db,user.id,await body(request)),201);
    if (path.startsWith("/bookmarks/")) { const bookmarkId=decodeURIComponent(path.slice("/bookmarks/".length)); if(request.method==="PATCH")return json(await updateTextBookmark(db,user.id,bookmarkId,await body(request))); if(request.method==="DELETE")return json(await deleteTextBookmark(db,user.id,bookmarkId,await body(request))); }
    if (request.method === "POST" && path === "/account/delete") return json(await requestAccountDeletion(db,user.id,request,await body(request)));
    if (request.method === "POST" && path === "/account/delete/cancel") return json(await cancelAccountDeletion(db,user.id,request));
    if (request.method === "GET" && path === "/publishing/audio") { const editionId=z.string().min(1).parse(url.searchParams.get("editionId")); return json(await commercialAudioPublisherSnapshot(db,user.id,editionId)); }
    if (request.method === "POST" && path === "/publishing/audio/profile") { requirePublisherMfa(); return json(await saveCommercialAudioProfile(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/audio/narrators") { requirePublisherMfa(); return json(await replaceCommercialAudioNarrators(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/audio/agreement") { requirePublisherMfa(); return json(await addNarrationAgreement(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/audio/agreement/end") { requirePublisherMfa(); return json(await endNarrationAgreement(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/audio/upload") { requirePublisherMfa(); return json(await uploadCommercialAudioFile(env,user.id,request,url.searchParams),201); }
    if (request.method === "POST" && path === "/authors/follow") return json(await setAuthorFollow(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/publishing/author-profile") return json(await saveAuthorProfile(db,user.id,await body(request)));
    if (request.method === "GET" && path === "/publishing/author-profiles") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); return json(await publisherAuthorProfiles(db,user.id,accountId)); }
    if (request.method === "GET" && path === "/publishing") return json(await publishingSnapshot(db, user.id, url.searchParams.get("accountId")));
    if (request.method === "GET" && path === "/publishing/dashboard") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); return json(await creatorDashboard(db,user.id,accountId,url.searchParams.get("from"),url.searchParams.get("to"))); }
    if (request.method === "GET" && path === "/publishing/sales.csv") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); const csv=await creatorSalesCsv(db,user.id,accountId,url.searchParams.get("from"),url.searchParams.get("to")); return new Response(csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="fore-sales-${accountId}.csv"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}}); }
    if (request.method === "GET" && path === "/publishing/royalties.csv") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); const csv=await creatorRoyaltyCsv(db,user.id,accountId,url.searchParams.get("from"),url.searchParams.get("to")); return new Response(csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="fore-royalties-${accountId}.csv"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}}); }
    if (request.method === "GET" && path.startsWith("/publishing/statements/") && path.endsWith(".csv")) { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); const statementId=decodeURIComponent(path.slice("/publishing/statements/".length,-4)); const out=await creatorStatementCsv(db,user.id,accountId,statementId); return new Response(out.csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="fore-statement-${statementId}-r${out.revision}.csv"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","X-Cove-Statement-Snapshot-SHA256":out.snapshotSha256,"X-Cove-Export-SHA256":out.exportSha256}}); }
    if (request.method === "GET" && path === "/publishing/preorders") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); return json(await publisherPreorderDashboard(db,user.id,accountId)); }
    if (request.method === "POST" && path === "/publishing/preorders/cancel-release") return json(await publisherCancelReleasePlan(db,user.id,await body(request)));
    if (request.method === "GET" && path === "/publishing/promotions") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); return json(await publisherPromotionDashboard(db,user.id,accountId)); }
    if (request.method === "POST" && path === "/publishing/promotions") return json(await savePromotionCampaign(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/publishing/promotions/submit") return json(await submitPromotionCampaign(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/publishing/promotions/cancel") return json(await cancelPromotionCampaign(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/publishing/promotions/coupon") return json(await createCampaignCoupon(db,user.id,await body(request)));
    if (request.method === "GET" && path.startsWith("/publishing/tax-document/")) {
      const accountId=z.string().min(1).parse(url.searchParams.get("accountId")),documentId=decodeURIComponent(path.slice("/publishing/tax-document/".length));
      const record=await creatorTaxDocumentRecord(db,user.id,accountId,documentId);
      if(!env.BUCKET)throw new ApiError(503,"Tax document storage is not configured.");
      const object=await env.BUCKET.get(String(record.object_key)); if(!object)throw new ApiError(404,"Tax document file is unavailable.");
      const filename=`fore-tax-${record.tax_year}-${String(record.document_type||"document").replace(/[^A-Za-z0-9_-]/g,"_")}.pdf`;
      return new Response(object.body,{headers:{"Content-Type":String(record.mime_type||"application/pdf"),"Content-Disposition":`attachment; filename="${filename}"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox"}});
    }
    if (request.method === "GET" && path === "/publishing/partner") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); return json(await partnerDashboard(db,user.id,accountId)); }
    if (request.method === "POST" && path === "/publishing/partner/profile") { requirePublisherMfa(); return json(await savePartnerProfile(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/partner/webhook-secret") { requirePublisherMfa(); const x=z.object({accountId:z.string().min(1)}).parse(await body(request)); return json(await revealPartnerWebhookSecret(env,user.id,x.accountId)); }
    if (request.method === "POST" && path === "/publishing/partner/channel") { requirePublisherMfa(); return json(await savePartnerChannel(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/partner/credential") { requirePublisherMfa(); return json(await issuePartnerCredential(db,user.id,await body(request)),201); }
    if (request.method === "POST" && path === "/publishing/partner/credential/revoke") { requirePublisherMfa(); return json(await revokePartnerCredential(db,user.id,await body(request))); }
    if (request.method === "GET" && path === "/publishing/rights") { const accountId=z.string().min(1).parse(url.searchParams.get("accountId")); return json(await publisherRightsSnapshot(db,user.id,accountId)); }
    if (request.method === "POST" && path === "/publishing/rights-declaration") { requirePublisherMfa(); return json(await signPublishingRightsDeclaration(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/accessibility-declaration") { requirePublisherMfa(); return json(await signPublishingAccessibilityDeclaration(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/ai-disclosure") { requirePublisherMfa(); return json(await signPublishingAiDisclosure(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/counter-notice") { requirePublisherMfa(); return json(await submitCopyrightCounterNotice(db,user.id,await body(request))); }
    if (request.method === "POST" && path === "/publishing/rights-evidence/upload") {
      requirePublisherMfa();
      const declarationId=z.string().min(1).max(180).parse(url.searchParams.get("declarationId"));
      const evidenceType=z.enum(["license","assignment","contract","registration","permission","public_domain_source","identity_authority","other"]).parse(url.searchParams.get("evidenceType"));
      const filename=z.string().trim().min(1).max(240).parse(url.searchParams.get("filename")||"evidence.bin");
      await rateLimit(env,`rights-evidence-upload:${user.id}`,30);
      const bytes=await readBoundedPublishingUpload(request,25*1024*1024);
      return json(await uploadRightsEvidence(env,user.id,{declarationId,evidenceType,description:url.searchParams.get("description")||"",filename,mimeType:request.headers.get("content-type")||"application/octet-stream",bytes,issuedBy:url.searchParams.get("issuedBy")||"",issuedAt:url.searchParams.get("issuedAt")||null,expiresAt:url.searchParams.get("expiresAt")||null}),201);
    }
    if (request.method === "POST" && path === "/publishing/account") return json(await upsertPublishingAccount(db, user.id, await body(request)));
    if (request.method === "POST" && path === "/publishing/address") return json(await savePublishingAddress(db, user.id, await body(request)));
    if (request.method === "POST" && path === "/publishing/pen-name") return json(await savePenName(db, user.id, await body(request)));
    if (request.method === "POST" && path === "/publishing/team/invite") { requirePublisherMfa(); return json(await invitePublishingMember(db, user.id, await body(request))); }
    if (request.method === "POST" && path === "/publishing/identity/start") { requirePublisherMfa(); return json(await startIdentityVerification(db, user.id, await body(request))); }
    if (request.method === "POST" && path === "/publishing/tax-profile") { requirePublisherMfa(); return json(await submitTaxProfile(db, user.id, await body(request))); }
    if (request.method === "POST" && path === "/publishing/payout-account") { requirePublisherMfa(); return json(await submitPayoutAccount(db, user.id, await body(request))); }
    if (request.method === "POST" && path === "/publishing/title") return json(await savePublishingTitle(db, user.id, await body(request)));
    if (request.method === "POST" && path === "/publishing/edition") return json(await savePublishingEdition(db, user.id, await body(request)));
    if (request.method === "GET" && path.startsWith("/publishing/edition/") && path.endsWith("/readiness")) {
      const editionId=decodeURIComponent(path.slice("/publishing/edition/".length,-"/readiness".length));
      return json(await publishingReadiness(db,user.id,editionId));
    }
    if (request.method === "POST" && path.startsWith("/publishing/edition/") && path.endsWith("/submit")) {
      requirePublisherMfa();
      const editionId=decodeURIComponent(path.slice("/publishing/edition/".length,-"/submit".length));
      await rateLimit(env,`publishing-submit:${user.id}`,20);
      return json(await submitPublishingEdition(env,user.id,editionId));
    }
    if (request.method === "POST" && path.startsWith("/publishing/edition/") && path.endsWith("/revision")) {
      const editionId=decodeURIComponent(path.slice("/publishing/edition/".length,-"/revision".length));
      return json(await openPublishingRevision(db,user.id,editionId));
    }
    if (request.method === "POST" && path === "/publishing/update-policy") return json(await setPublishingUpdatePolicy(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/library/publication-update") return json(await optInOwnedPublicationUpdate(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/publishing/appeal") return json(await submitModerationAppeal(db,user.id,await body(request)));
    if (request.method === "POST" && path === "/publishing/assets/upload") {
      const editionId=z.string().min(1).max(180).parse(url.searchParams.get("editionId"));
      const kind=z.enum(["manuscript","cover","supplement","audio"]).parse(url.searchParams.get("kind"));
      const filename=z.string().trim().min(1).max(240).parse(url.searchParams.get("filename")||"upload.bin");
      await rateLimit(env,`publishing-upload:${user.id}`,60);
      const bytes=await readBoundedPublishingUpload(request,publishingUploadLimit(kind));
      return json(await uploadPublishingAsset(env,user.id,{editionId,kind,filename,mimeType:request.headers.get("content-type")||"application/octet-stream",bytes}),201);
    }
    if (request.method === "POST" && path === "/checkout/quote") { await rateLimit(env,`checkout:quote:${user.id}`,30); return json(await checkoutQuote(env,user,await body(request))); }
    if (request.method === "POST" && path === "/checkout/payment") { await rateLimit(env,`checkout:payment:${user.id}`,12); return json(await createCheckoutPayment(env,user,await body(request))); }
    if (request.method === "GET" && path.startsWith("/checkout/recover/")) { await rateLimit(env,`checkout:recover:${user.id}`,60); return json(await recoverPayment(env,user.id,decodeURIComponent(path.slice("/checkout/recover/".length)))); }
    if (request.method === "POST" && path.startsWith("/series/") && path.endsWith("/cart")) {
      const ref=decodeURIComponent(path.slice("/series/".length,-"/cart".length));
      await rateLimit(env,`series-cart:${user.id}`,30);
      return json(await addSeriesToCart(db,ref,user.id,storefrontTerritory));
    }
    if (request.method === "GET" && path.startsWith("/exports/reading-data/")) {
      await rateLimit(env,`reading-export:${user.id}`,30);
      const bookId=bookIdSchema.parse(decodeURIComponent(path.slice("/exports/reading-data/".length)));
      const purpose=z.enum(["reading-data","private-backup"]).catch("reading-data").parse(url.searchParams.get("purpose")||"reading-data");
      return json(await readingDataExport(db,user.id,bookId,purpose));
    }
    if (request.method === "GET" && path === "/preorders") return json(await customerPreorders(db,user.id));
    if (request.method === "POST" && path.startsWith("/preorders/") && path.endsWith("/cancel")) { const preorderId=decodeURIComponent(path.slice("/preorders/".length,-"/cancel".length)); return json(await customerCancelPreorder(db,user.id,preorderId)); }
    if (request.method === "GET" && path === "/orders") return json(await orderHistory(db,user.id));
    if (request.method === "POST" && path.startsWith("/orders/") && path.endsWith("/cancel")) { const orderId=decodeURIComponent(path.slice("/orders/".length,-"/cancel".length)); return json(await cancelCheckoutOrder(env,user.id,orderId)); }
    if (request.method === "GET" && path.startsWith("/orders/")) {
      const rest=path.slice("/orders/".length), html=rest.endsWith("/invoice.html"), invoice=rest.endsWith("/invoice"), orderId=decodeURIComponent(html?rest.slice(0,-"/invoice.html".length):invoice?rest.slice(0,-"/invoice".length):rest);
      if(html)return new Response(await invoiceHtml(db,user.id,orderId),{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
      return json(invoice?await invoiceRecord(db,user.id,orderId):await orderDetail(db,user.id,orderId));
    }
    if (request.method === "GET" && path === "/wishlist") {
      return json(await wishlistSnapshot(db,user.id,storefrontTerritory));
    }
    if (request.method === "POST" && path === "/wishlist/item") {
      const input=await body(request); return json(await wishlistProduct(db,user.id,{...(input as Record<string,unknown>),territory:storefrontTerritory}));
    }
    if (request.method === "POST" && path === "/wishlist/sharing") {
      return json(await updateWishlistSharing(db,user.id,await body(request)));
    }
    if (request.method === "GET" && path === "/cart") {
      return json(await cartSnapshot(db,user.id,storefrontTerritory));
    }
    if (request.method === "POST" && path === "/cart/item") {
      const input=await body(request); return json(await addToCart(db,user.id,{...(input as Record<string,unknown>),territory:storefrontTerritory}));
    }
    if (request.method === "DELETE" && path.startsWith("/cart/item/")) {
      return json(await removeFromCart(db,user.id,decodeURIComponent(path.slice("/cart/item/".length))));
    }
    if (request.method === "GET" && path === "/preview/state") {
      const productId=z.string().min(1).max(180).parse(url.searchParams.get("productId"));
      return json((await db.prepare("SELECT cfi,sample_progress,started_at,updated_at,converted_at,version FROM preview_states WHERE user_id=? AND product_id=?").bind(user.id,productId).first<any>())||{cfi:"",sample_progress:0});
    }
    if (request.method === "POST" && path === "/preview/state") {
      return json(await savePreviewState(db,user.id,await body(request)));
    }
    if (request.method === "GET" && path === "/recommendations/account") {
      return json(await recommendationAccountState(db, user.id));
    }
    if (request.method === "POST" && path === "/recommendations/privacy") {
      return json(await setRecommendationPrivacy(db, user.id, await body(request)));
    }
    if (request.method === "POST" && path === "/recommendations/reset") {
      return json(await resetRecommendationProfile(db, user.id, await body(request)));
    }
    if (request.method === "POST" && path === "/recommendations/feedback") {
      return json(await recommendationFeedback(db, user.id, await body(request)));
    }
    if (request.method === "POST" && path === "/recommendations/follow-author") {
      return json(await followAuthor(db, user.id, await body(request)));
    }
    if (request.method === "POST" && path === "/recommendations/wishlist") {
      const input=await body(request); return json(await wishlistProduct(db,user.id,{...(input as Record<string,unknown>),territory:storefrontTerritory}));
    }
    if (request.method === "POST" && path === "/profile") {
      const { name } = z
        .object({ name: z.string().trim().min(1).max(80) })
        .parse(await body(request));
      await db
        .prepare(
          "INSERT INTO profiles(user_id,name,created_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name",
        )
        .bind(user.id, name, now())
        .run();
      return json({ saved: true });
    }
    if (request.method === "POST" && path === "/library") {
      const input = libraryInput.parse(await body(request));
      await getBook(env, input.bookId, user.id);
      const product = await resolveProduct(db, input.bookId, user.id);
      const sourceExternalId = String(product.source_external_id || input.bookId);
      const at = now();

      if (product.source_name === "gutenberg") {
        const rights=await resolveProductRights(db,String(product.id),storefrontTerritory,{salesChannel:"retail",persist:true,context:{source:"public-domain-acquisition",userId:user.id}});
        if(!rights.allowed)throw new ApiError(404,"This edition is not available in your storefront.");
        await db
          .prepare(`INSERT INTO entitlements(id,user_id,product_id,entitlement_type,status,source,granted_at,updated_at)
            VALUES(?,?,?,'public-domain','active','gutenberg',?,?)
            ON CONFLICT(user_id,product_id,entitlement_type) DO UPDATE SET status='active',updated_at=excluded.updated_at`)
          .bind(crypto.randomUUID(), user.id, product.id, at, at)
          .run();
      } else {
        const entitlement = await db
          .prepare(`SELECT 1 ok FROM entitlements WHERE user_id=? AND product_id=? AND status='active'
            AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) LIMIT 1`)
          .bind(user.id, product.id, at, at)
          .first<any>();
        if (!entitlement)
          throw new ApiError(403, "This edition requires an active purchase, loan, subscription, gift, or publisher entitlement.");
      }

      const [old,previewState] = await Promise.all([
        db.prepare("SELECT * FROM reading_states WHERE user_id=? AND product_id=?").bind(user.id, product.id).first<any>(),
        db.prepare("SELECT * FROM preview_states WHERE user_id=? AND product_id=?").bind(user.id, product.id).first<any>(),
      ]);
      const legacyShelves = input.shelves ?? (old ? parseJsonArray(old.legacy_shelves_json) : []);
      const nextStatus = input.status ?? old?.status ?? "want-to-read";
      // Preserve the preview CFI when full access begins, but never copy the sample-relative percentage:
      // 80% through a 15% sample is not 80% through the complete book.
      const handoffCfi = input.cfi ?? old?.cfi ?? previewState?.cfi ?? "";
      const handoffProgress = input.progress ?? old?.progress ?? 0;
      const currentVersion = Number(old?.version || 0);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw Object.assign(new ApiError(409, "Your reading position changed on another device. Reload before overwriting it."), {
          syncConflict: {
            serverVersion: currentVersion,
            server: old ? { status: old.status, progress: Number(old.progress), cfi: old.cfi, updatedAt: old.updated_at } : null,
          },
        });
      }
      const nextRating = input.rating !== undefined ? input.rating : (old?.legacy_rating ?? null);
      const nextReview = input.review ?? old?.legacy_review ?? "";
      const reviewMigrated = old && JSON.stringify(legacyShelves) === String(old.legacy_shelves_json || "[]") && nextRating === old.legacy_rating && nextReview === String(old.legacy_review || "")
        ? Number(old.review_migrated || 0) : 0;
      let savedState: any;
      if (old) {
        savedState = await db.prepare(`UPDATE reading_states SET external_book_id=?,in_library=1,status=?,progress=?,cfi=?,legacy_shelves_json=?,legacy_rating=?,legacy_review=?,review_migrated=?,updated_at=?,version=version+1
          WHERE user_id=? AND product_id=? AND version=? RETURNING version,updated_at`)
          .bind(sourceExternalId,nextStatus,handoffProgress,handoffCfi,JSON.stringify(legacyShelves),nextRating,nextReview,reviewMigrated,at,user.id,product.id,currentVersion).first<any>();
      } else {
        savedState = await db.prepare(`INSERT INTO reading_states(user_id,product_id,external_book_id,in_library,status,progress,cfi,legacy_shelves_json,legacy_rating,legacy_review,review_migrated,updated_at,version)
          VALUES(?,?,?,1,?,?,?,?,?,?,0,?,1) ON CONFLICT(user_id,product_id) DO NOTHING RETURNING version,updated_at`)
          .bind(user.id,product.id,sourceExternalId,nextStatus,handoffProgress,handoffCfi,JSON.stringify(legacyShelves),nextRating,nextReview,at).first<any>();
      }
      if (!savedState) throw new ApiError(409, "Your reading position changed on another device. Reload before overwriting it.");
      const savedVersion = Number(savedState.version);
      const operations = [];
      const completionId = nextStatus === "finished" && old?.status !== "finished" ? crypto.randomUUID() : null;
      if (completionId)
        operations.push(db.prepare("INSERT INTO completion_events(id,user_id,product_id,external_book_id,finished_at) VALUES(?,?,?,?,?)").bind(completionId, user.id, product.id, sourceExternalId, at));
      if (previewState && !previewState.converted_at) operations.push(db.prepare("UPDATE preview_states SET converted_at=?,updated_at=?,version=version+1 WHERE user_id=? AND product_id=?").bind(at,at,user.id,product.id));
      if (operations.length) await db.batch(operations);
      await recordSyncProjection(db,{userId:user.id,entityType:"reading_position",entityId:String(product.id),payload:{productId:String(product.id),externalBookId:sourceExternalId,status:nextStatus,progress:handoffProgress,cfi:handoffCfi},explicitVersion:savedVersion});
      await recordReadingProgress(db,user.id,String(product.id),{source:"ebook",progress:handoffProgress,cfi:handoffCfi,at,dedupeKey:`ebook-progress:${user.id}:${product.id}:${savedVersion}`});
      if (!old) await recordRecommendationEvent(db, user.id, { type: "library_add", productId: product.id, surface: "library" });
      if (nextStatus === "finished" && old?.status !== "finished") await recordRecommendationEvent(db, user.id, { type: "completion", productId: product.id, surface: "library" });
      if (nextStatus === "finished" && old?.status !== "finished") await recordRetailEvent(db,user.id,{eventType:"book_finished",productId:String(product.id),externalBookId:sourceExternalId,sourceSurface:"library",properties:{progress:handoffProgress},dedupeKey:`book-finished:${user.id}:${product.id}:${at.slice(0,10)}`});
      let readingJourneyId:string|null=null;
      if (completionId) { try { const journey=await ensureReadingJourney(db,user.id,completionId); readingJourneyId=String(journey.id); } catch (e) { console.error("Reading Journey generation failed",e); } }
      if (input.rating !== undefined && input.rating !== null) await recordRecommendationEvent(db, user.id, { type: "rating", productId: product.id, value: input.rating, surface: "library" });
      if (input.rating !== undefined || input.review !== undefined || input.shelves !== undefined) await migrateLegacy(env, user.id);
      return json({ saved: true, version:savedVersion, updatedAt:savedState.updated_at, entitlement: product.source_name === "gutenberg" ? "public-domain" : "existing", readingJourneyId });
    }
    if (request.method === "DELETE" && path.startsWith("/library/")) {
      const id = bookIdSchema.parse(path.split("/")[2]);
      const product = await resolveProduct(db, id, user.id);
      await db
        .prepare("UPDATE reading_states SET in_library=0,updated_at=? WHERE user_id=? AND product_id=?")
        .bind(now(), user.id, product.id)
        .run();
      return json({ deleted: true, entitlementRetained: true });
    }
    if (request.method === "POST" && path === "/annotations") {
      const input = annotationInput.parse(await body(request));
      const b = await getBook(env, input.bookId, user.id);
      const id = crypto.randomUUID(), date = now();
      await db.prepare(
        "INSERT INTO annotations(id,user_id,book_id,book_title,author,quote,cfi,chapter,color,note,created_at,updated_at,version,progress) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
      ).bind(id,user.id,input.bookId,b.title,b.authors.map((a) => a.name).join(", "),input.quote,input.cfi,input.chapter,input.color,input.note,date,date,input.progress??null).run();
      await recordSyncProjection(db,{userId:user.id,entityType:"annotation",entityId:id,payload:{bookId:input.bookId,cfi:input.cfi,quote:input.quote,chapter:input.chapter,color:input.color,note:input.note,progress:input.progress??null},explicitVersion:1});
      try{const product=await resolveProduct(db,input.bookId,user.id);if(!["gutenberg","upload"].includes(String(product.source_name))){const ownership=await ownershipStatus(db,user.id,String(product.id));await snapshotAnnotationAnchor(db,user.id,{annotationId:id,productId:String(product.id),publicationVersionId:ownership.resolvedPublicationVersionId||null,assetVersionId:ownership.assetVersionId||null});}}catch(e){console.error("Annotation version anchor snapshot failed",e);}
      return json({ id, saved: true, version:1, updatedAt:date }, 201);
    }
    if (path.startsWith("/annotations/")) {
      const id = z.string().uuid().parse(path.split("/")[2]);
      const existing = await db.prepare("SELECT * FROM annotations WHERE id=? AND user_id=? AND deleted_at IS NULL").bind(id, user.id).first<any>();
      if (!existing) throw new ApiError(404, "This annotation was not found.");
      if (request.method === "PATCH") {
        const input = z.object({
          note: z.string().max(12000),
          color: z.enum(["yellow", "green", "blue", "pink", "purple"]),
          expectedVersion: z.number().int().min(1),
        }).parse(await body(request));
        if(Number(existing.version)!==input.expectedVersion) throw Object.assign(new ApiError(409,"This annotation changed on another device."),{syncConflict:{serverVersion:Number(existing.version),server:annotationRow(existing)}});
        const updatedAt=now(), saved=await db.prepare("UPDATE annotations SET note=?,color=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND deleted_at IS NULL AND version=? RETURNING version").bind(input.note,input.color,updatedAt,id,user.id,input.expectedVersion).first<any>();
        if(!saved) throw new ApiError(409,"This annotation changed on another device.");
        await recordSyncProjection(db,{userId:user.id,entityType:"annotation",entityId:id,payload:{bookId:existing.book_id,cfi:existing.cfi,quote:existing.quote,chapter:existing.chapter,color:input.color,note:input.note,progress:existing.progress??null},explicitVersion:Number(saved.version)});
        return json({ saved: true, version:Number(saved.version), updatedAt });
      }
      if (request.method === "DELETE") {
        const input=z.object({expectedVersion:z.number().int().min(1)}).parse(await body(request));
        if(Number(existing.version)!==input.expectedVersion) throw new ApiError(409,"This annotation changed on another device.");
        const deletedAt=now(),nextVersion=Number(existing.version)+1,saved=await db.prepare("UPDATE annotations SET deleted_at=?,updated_at=?,version=? WHERE id=? AND user_id=? AND deleted_at IS NULL AND version=? RETURNING id").bind(deletedAt,deletedAt,nextVersion,id,user.id,input.expectedVersion).first<any>();
        if(!saved) throw new ApiError(409,"This annotation changed on another device.");
        await recordSyncProjection(db,{userId:user.id,entityType:"annotation",entityId:id,payload:{bookId:existing.book_id,cfi:existing.cfi,quote:existing.quote,chapter:existing.chapter,color:existing.color,note:existing.note,progress:existing.progress??null},tombstone:true,explicitVersion:nextVersion});
        return json({ deleted: true, version:nextVersion });
      }
    }
    if (request.method === "POST" && path === "/definitions") {
      const input = definitionInput.parse(await body(request));
      const b = input.bookId ? await getBook(env, input.bookId, user.id) : null;
      const id = crypto.randomUUID();
      await db
        .prepare(
          "INSERT INTO definitions(id,user_id,word,phonetic,meaning,part_of_speech,book_id,book_title,cfi,context,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          user.id,
          input.word,
          input.phonetic,
          input.meaning,
          input.partOfSpeech,
          input.bookId,
          b?.title || "",
          input.cfi,
          input.context,
          input.source,
          now(),
        )
        .run();
      return json({ id, saved: true }, 201);
    }
    if (request.method === "DELETE" && path.startsWith("/definitions/")) {
      const id = z.string().uuid().parse(path.split("/")[2]);
      await db.prepare("DELETE FROM definitions WHERE id=? AND user_id=?").bind(id, user.id).run();
      return json({ deleted: true });
    }
    if (request.method === "POST" && path === "/upload") {
      if (!env.BUCKET) throw new ApiError(503, "Book uploads are temporarily unavailable.");
      const bytes = await bounded(request, 25 * 1024 * 1024);
      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(bytes);
      } catch {
        throw new ApiError(400, "Choose a valid, DRM-free EPUB file.");
      }
      const entries = Object.values(zip.files);
      if (
        entries.length > 3000 ||
        entries.reduce((n, f) => n + ((f as any)._data?.uncompressedSize || 0), 0) >
          60 * 1024 * 1024
      )
        throw new ApiError(413, "This EPUB expands beyond the supported size.");
      if (
        (await zip.file("mimetype")?.async("string")) !== "application/epub+zip" ||
        !zip.file("META-INF/container.xml")
      )
        throw new ApiError(400, "This file is not a valid EPUB.");
      if (zip.file("META-INF/encryption.xml"))
        throw new ApiError(
          400,
          "Encrypted EPUBs are not supported. Please use a DRM-free edition.",
        );
      const title = z.string().trim().min(1).max(300).parse(url.searchParams.get("title"));
      const author = (url.searchParams.get("author") || "Unknown author").slice(0, 200);
      const language = (url.searchParams.get("language") || "en").slice(0, 20);
      const id = "upload_" + crypto.randomUUID(),
        key = `uploads/${user.id}/${id}.epub`,
        createdAt = now();
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/epub+zip" } });
      try {
        await db.batch(
          personalImportStatements(db, {
            id,
            userId: user.id,
            title,
            author,
            language,
            objectKey: key,
            createdAt,
          }),
        );
      } catch (e) {
        await env.BUCKET.delete(key);
        throw e;
      }
      const book = await getCanonicalBook(db, id, user.id);
      return json({ id, book }, 201);
    }
    return json({ error: "This action was not found." }, 404);
  } catch (e) {
    if (!(e instanceof ApiError) && !(e instanceof z.ZodError)) {if(env.DB) await recordErrorEvent(env.DB as any,undefined,request,e,{method:request.method});await reportExternalError(env,request,e);}
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError)
      return json(
        { error: "Some information is missing or invalid. Please check your entry." },
        400,
      );
    console.error(
      "Cove service error",
      e instanceof Error ? e.message : "Unknown",
      (e as any)?.cause?.code || "",
    );
    return json(
      {
        error:
          request.method === "GET"
            ? "This content could not be loaded. Please try again."
            : "We could not save your changes. Please try again.",
      },
      503,
    );
  }
}
