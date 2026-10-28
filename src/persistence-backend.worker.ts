import { seedMusicProfiles } from "./features/fore/music-profiles.server";
export { BackendOwnerAttestation } from "./storefront-strangler/backend-owner-attestation-entrypoint";
import { scopePublicationOwnerEnv } from "./storefront-strangler/publication-owner-routing.server";
import {
  attestDisabledOwnerFromBackend,
  DISABLED_OWNER_ATTEST_ROUTE,
} from "./storefront-strangler/production-disabled-owner-attestation";
import { verifyAudioStorage } from "./features/fore/audio-coverage.server";
import { runLiteraryProfileTick } from "./features/fore/literary-profiles.server";
import { runStoredAssetTick } from "./features/fore/catalog-assets.server";
import { contentPipelineOwner } from "./lib/content-processing-owner.server";
import { repairRegionalEpubAssets } from "./features/fore/regional-epub-asset-repair.server";
import { handleCanonicalMusicHandoff } from "./lib/music-canonical-handoff";
import {
  discoverSoundtrackCandidates,
  importOneReviewedSoundtrack,
  recheckOnePublishedSoundtrack,
} from "./features/fore/soundtracks.server";
import { processAccountDeletionQueue } from "./features/fore/account-management.server";
import { processNotificationDeliveryQueue } from "./features/fore/notifications.server";
import { processAuthorSocialFanoutJobs } from "./features/fore/social.server";
import { processPartnerFeedQueue } from "./features/fore/traditional-publishing.server";
import { advancePreorders } from "./features/fore/preorder.server";
import { processPreorderRefundJobs } from "./features/fore/commerce.server";
import {
  queueAuthorReleaseAlerts,
  processAuthorReleaseAlerts,
} from "./features/fore/retail-intelligence.server";

import {
  handleCoveApi,
  runCatalogIngestion,
  runCatalogAssetMaintenance,
  runRegionalCatalogIngestion,
  runPublishingReleaseMaintenance,
  runRecommendationMaintenance,
  type CoveEnv,
} from "./features/fore/api.server";
import { syncSearchIndex } from "./features/fore/search.server";
import { hostedBiosyncChunks } from "./features/fore/hosted-biosync-chunks.server";
import { cachedPublicApi, prunePublicCache } from "./features/fore/public-api-cache.server";
import { refreshPublicStatus } from "./features/fore/public-status.server";
import { handleSeoDocumentRequest } from "./features/fore/seo.server";
import { isPublicSeoDocumentPath } from "./lib/public-seo-document-path";
import { admitCatalogBatch, catalogAdmissionBudget } from "./lib/catalog-ingestion-backpressure";
import {
  audioComputeAdmission,
  type AudioComputeEnv,
} from "./features/fore/audio-compute-budget.server";

type BackendEnv = CoveEnv &
  AudioComputeEnv & {
    FORE_BACKEND_TOKEN?: string;
    FORE_BACKEND_TOKEN_SHA256?: string;
    FORE_PUBLIC_URL?: string;
    FORE_CATALOG_PAGES_PER_TICK?: string;
    FORE_CATALOG_EPUBS_PER_TICK?: string;
    FORE_CATALOG_ADMISSION_MAX_MS?: string;
    FORE_ASSETS_PER_MINUTE?: string;
    FORE_CONTENT_PIPELINE_EXTERNAL?: string;
    FORE_LEGACY_LITERARY_CRON_ENABLED?: string;
    FORE_REGIONAL_EPUB_REPAIR_ENABLED?: string;
    FORE_MUSIC_CANONICAL_HANDOFF_ENABLED?: string;
    FORE_MUSIC_CANONICAL_HANDOFF_TOKEN_SHA256?: string;
    FORE_MUSIC_CANONICAL_HANDOFF_PROBE_MS?: string;
    FORE_REGIONAL_EPUB_REPAIR_PROBE_MS?: string;
    FORE_INGESTION_TRIGGER_TOKEN?: string;
    FORE_INGESTION_SIGNING_KEY?: string;
    AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  };

type ExecutionContextLike = {
  waitUntil?(promise: Promise<unknown>): void;
};

type CatalogBatchInput = {
  maxPages?: unknown;
  epubLimit?: unknown;
  maxMillis?: unknown;
};

type CoveCacheGlobal = typeof globalThis & {
  caches?: {
    default?: Cache;
  };
};

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function backendTokenHash(env: BackendEnv) {
  const configured = (env.FORE_BACKEND_TOKEN_SHA256 || "").toLowerCase();
  if (/^[a-f0-9]{64}$/.test(configured)) return configured;

  try {
    const row = await env.DB.prepare(
      "SELECT value FROM cove_runtime_config WHERE key='backend_token_sha256'",
    ).first<{ value?: string }>();
    const persisted = String(row?.value || "").toLowerCase();
    return /^[a-f0-9]{64}$/.test(persisted) ? persisted : "";
  } catch {
    return "";
  }
}

async function authorized(request: Request, env: BackendEnv) {
  const supplied = request.headers.get("x-cove-backend-token") || "";
  if (supplied.length < 24) return false;

  const expected = env.FORE_BACKEND_TOKEN || "";
  if (expected.length >= 24 && safeEqual(expected, supplied)) return true;

  const expectedHash = await backendTokenHash(env);
  if (!expectedHash) return false;
  return safeEqual(expectedHash, await sha256Hex(supplied));
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function logicalRequest(request: Request, env: BackendEnv) {
  const backendUrl = new URL(request.url);
  const forwardedPublicUrl = request.headers.get("x-cove-public-url");
  let publicBase = env.FORE_PUBLIC_URL || "";
  if (forwardedPublicUrl) {
    try {
      const candidate = new URL(forwardedPublicUrl);
      if (candidate.protocol === "https:" || candidate.hostname === "localhost") {
        publicBase = candidate.origin;
      }
    } catch {
      // Fall back to the configured canonical public origin.
    }
  }
  if (!publicBase) return request;

  const publicUrl = new URL(backendUrl.pathname + backendUrl.search, publicBase);
  const headers = new Headers(request.headers);
  headers.delete("x-cove-backend-token");
  headers.delete("x-cove-backend-host");
  headers.delete("x-cove-public-url");
  // Browser requests cannot impersonate a user by supplying platform identity
  // headers. Cove account identity must come from a verified Supabase session.
  for (const name of [
    "oai-authenticated-user-id",
    "oai-authenticated-user-email",
    "oai-authenticated-user-full-name",
    "oai-authenticated-user-full-name-encoding",
    "oai-authentication-assurance-level",
  ]) {
    headers.delete(name);
  }
  return new Request(publicUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: request.redirect,
  });
}

function catalogInput(value: unknown): CatalogBatchInput {
  return value && typeof value === "object" ? (value as CatalogBatchInput) : {};
}

function terminalIngestionResult(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const result = value as { complete?: unknown; failed?: unknown; skipped?: unknown };
  return (
    result.complete === true ||
    result.failed === true ||
    result.skipped === "fresh" ||
    result.skipped === "backoff" ||
    result.skipped === "running" ||
    result.skipped === "deadline" ||
    result.skipped === "lease-lost"
  );
}

async function catalogBatch(request: Request, env: BackendEnv) {
  let input: CatalogBatchInput = {};
  try {
    input = catalogInput(await request.json());
  } catch {
    // Malformed control input uses the bounded defaults below.
  }

  const configuredPages = Number(env.FORE_CATALOG_PAGES_PER_TICK || 5);
  const configuredEpubs = Number(env.FORE_CATALOG_EPUBS_PER_TICK || 2);
  const maxPages = Math.max(1, Math.min(12, Number(input.maxPages || configuredPages) || 5));
  const epubLimit = Math.max(0, Math.min(64, Number(input.epubLimit ?? configuredEpubs) || 0));
  const maxMillis = Math.max(
    10_000,
    Math.min(240_000, Number(input.maxMillis || 220_000) || 220_000),
  );
  const deadline = Date.now() + maxMillis;
  const results: unknown[] = [];
  // Index metadata first. Regional scraping and EPUB transfers share the remaining
  // deadline, but cannot consume a page's asset allowance or stop later pages.
  const metadataDeadline = deadline - Math.min(30_000, maxMillis * 0.2);
  for (let i = 0; i < maxPages && Date.now() < metadataDeadline; i++) {
    const result = await runCatalogIngestion(env, 0, {
      deadlineMs: metadataDeadline,
      includeRegional: false,
      deferSearchSync: true,
    });
    results.push(result);
    if (terminalIngestionResult(result)) break;
  }
  const regional =
    Date.now() < deadline
      ? await runRegionalCatalogIngestion(env, 0, Math.min(deadline, Date.now() + 20_000)).catch(
          (error) => ({
            failed: true,
            error: String(error),
          }),
        )
      : { skipped: "deadline" };
  const epubs = await runCatalogAssetMaintenance(env, epubLimit, deadline);
  // Defer only the nonauthoritative, retryable search-index projection.
  // Catalog metadata and regional rights/evidence MUST always be processed,
  // including urgent withdrawals or changed commercial-use determinations.
  // The next scheduled tick resumes the unsynchronized index backlog.
  let searchSync: { skipped: string; reason: string; probeMs: number } | undefined;
  if (Date.now() < deadline) {
    const admission = await admitCatalogBatch(
      env.DB,
      catalogAdmissionBudget(env.FORE_CATALOG_ADMISSION_MAX_MS),
    );
    if (admission.allowed) {
      await syncSearchIndex(env, 500).catch((error) =>
        console.warn("Catalog search sync failed", error),
      );
    } else {
      searchSync = {
        skipped: "primary_busy",
        reason: admission.reason,
        probeMs: admission.probeMs,
      };
      console.warn(
        JSON.stringify({
          event: "catalog_search_index_deferred",
          reason: admission.reason,
          probeMs: admission.probeMs,
        }),
      );
    }
  }
  return json({
    ok: !results.some(
      (value) => value && typeof value === "object" && "failed" in value && value.failed === true,
    ),
    pagesAttempted: results.length,
    results,
    regional,
    epubs,
    ...(searchSync ? { searchSync } : {}),
  });
}

async function maintenance(env: BackendEnv) {
  const [recommendations, publishing] = await Promise.allSettled([
    runRecommendationMaintenance(env),
    runPublishingReleaseMaintenance(env),
  ]);

  return json({
    ok: recommendations.status === "fulfilled" && publishing.status === "fulfilled",
    recommendations:
      recommendations.status === "fulfilled"
        ? recommendations.value
        : { error: String(recommendations.reason) },
    publishing:
      publishing.status === "fulfilled" ? publishing.value : { error: String(publishing.reason) },
  });
}

function base64url(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function ingestionTriggerHeaders(env: BackendEnv, target: URL) {
  const legacySecret = env.FORE_INGESTION_TRIGGER_TOKEN || "";
  if (legacySecret.length >= 24) {
    return { authorization: `Bearer ${legacySecret}` };
  }

  const signingKey = env.FORE_INGESTION_SIGNING_KEY || "";
  if (!signingKey) {
    throw new Error(
      "FORE_INGESTION_SIGNING_KEY or legacy FORE_INGESTION_TRIGGER_TOKEN is required for audio scheduling.",
    );
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(signingKey) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const timestamp = String(Date.now());
  const message = `${timestamp}\nPOST\n${target.pathname}${target.search}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(message),
  );
  return {
    "x-cove-ingestion-timestamp": timestamp,
    "x-cove-ingestion-signature": base64url(signature),
  };
}

async function persistAudioTriggerDiagnostic(
  env: BackendEnv,
  key: "audio_trigger_last_error" | "audio_trigger_last_success" | "audio_trigger_last_timeout",
  value: Record<string, unknown>,
) {
  const at = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO cove_runtime_config(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    )
      .bind(key, JSON.stringify({ ...value, at }), at)
      .run();
  } catch (error) {
    console.warn("Unable to persist Cove audio trigger diagnostic", error);
  }
}

async function triggerVercelAudio(env: BackendEnv, path: string) {
  const admission = await audioComputeAdmission(env);
  if (!admission.allowed) {
    console.info("Cove audio compute deferred", admission.reason);
    return;
  }
  if (!env.FORE_PUBLIC_URL) {
    throw new Error("FORE_PUBLIC_URL is required for audio scheduling.");
  }

  const target = new URL(path, env.FORE_PUBLIC_URL);
  const response = await fetch(target, {
    method: "POST",
    headers: new Headers(
      Object.entries(await ingestionTriggerHeaders(env, target)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    signal: AbortSignal.timeout(290_000),
  });
  if (!response.ok) {
    const body = (await response.text()).replace(/[\r\n\t]+/g, " ").slice(0, 900);
    if (response.status === 524) {
      await persistAudioTriggerDiagnostic(env, "audio_trigger_last_timeout", {
        path,
        status: response.status,
        body,
        disposition: "in-flight",
      });
      console.warn(
        `Cove audio trigger timed out at the transport boundary for ${path}; D1 lease recovery remains authoritative.`,
      );
      return;
    }
    await persistAudioTriggerDiagnostic(env, "audio_trigger_last_error", {
      path,
      status: response.status,
      body,
    });
    throw new Error(`Audio ingestion trigger failed (${response.status}) for ${path}`);
  }
  await persistAudioTriggerDiagnostic(env, "audio_trigger_last_success", {
    path,
    status: response.status,
  });
}

async function scheduledCatalog(env: BackendEnv) {
  const request = new Request("https://cove.internal/__cove/ingestion/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      maxPages: env.FORE_CATALOG_PAGES_PER_TICK || 5,
      epubLimit: 0,
      maxMillis: 220_000,
    }),
  });
  const response = await catalogBatch(request, env);
  if (!response.ok) {
    throw new Error("Scheduled catalog ingestion failed.");
  }
}

async function runCommercialQueues(cron: string, env: BackendEnv) {
  if (await d1QuotaBlocked()) return;
  const tasks: Array<[string, () => Promise<unknown>]> = [];
  if (cron === "*/10 * * * *") {
    tasks.push(["notifications", () => processNotificationDeliveryQueue(env, 50)]);
  }
  if (cron === "23 * * * *") {
    tasks.push(
      ["author-social-fanout", () => processAuthorSocialFanoutJobs(env.DB, 10, 250)],
      ["partner-feed", () => processPartnerFeedQueue(env.DB, 15)],
      [
        "author-release-alerts",
        async () => {
          await queueAuthorReleaseAlerts(env.DB);
          return processAuthorReleaseAlerts(env.DB, 50);
        },
      ],
    );
  }
  if (cron === "41 4 * * *") {
    tasks.push(["preorder-settlement", () => advancePreorders(env.DB)]);
    if (env.STRIPE_SECRET_KEY)
      tasks.push([
        "preorder-refunds",
        () =>
          processPreorderRefundJobs(env, {
            workerId: "cove-cloudflare-scheduled",
            limit: 20,
            leaseSeconds: 300,
          }),
      ]);
  }
  for (const [name, operation] of tasks) {
    try {
      const result = await operation();
      console.info(JSON.stringify({ event: "cove_queue_tick", name, result }));
    } catch (error) {
      console.error("Cove scheduled queue failed", name, error);
      if (isD1QuotaError(error)) {
        await markD1QuotaBlocked();
        break;
      }
    }
  }
}
async function scheduledMaintenance(env: BackendEnv) {
  const response = await maintenance(env);
  if (!response.ok) throw new Error("Scheduled Cove maintenance failed.");
}

const D1_QUOTA_CACHE_KEY = new Request(
  "https://cove-persistence-backend.cove-jibrilmohamud.workers.dev/__cove/internal/d1-quota-block-v2",
);

function isD1QuotaError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("exceeded d1's free tier daily row write limit") ||
    message.includes("exceeded d1's free tier daily row read limit")
  );
}

async function d1QuotaBlocked() {
  const runtimeCache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (!runtimeCache) return false;
  return Boolean(await runtimeCache.match(D1_QUOTA_CACHE_KEY));
}

async function markD1QuotaBlocked() {
  const runtimeCache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (!runtimeCache) return;
  await runtimeCache.put(
    D1_QUOTA_CACHE_KEY,
    new Response("quota-backoff", {
      headers: { "cache-control": "public, max-age=900" },
    }),
  );
}

async function audioTrackTriggerSlots(env: BackendEnv) {
  const at = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN status='queued' AND next_attempt_at<=? THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN status='running' AND lease_until>? THEN 1 ELSE 0 END) running
    FROM audio_jobs
    WHERE kind='track'`,
  )
    .bind(at, at)
    .first<{ queued?: number; running?: number }>();
  const queued = Number(row?.queued || 0);
  const running = Number(row?.running || 0);
  const targetConcurrency = queued >= 128 ? 2 : 1;
  return {
    queued,
    running,
    slots: Math.max(0, Math.min(2, targetConcurrency - running)),
  };
}

async function audioAlignmentTriggerSlots(env: BackendEnv) {
  const at = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN kind='align' AND status='queued' AND next_attempt_at<=? AND attempts<6 THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN kind='align' AND status='running' AND lease_until>? THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN kind='track' AND status='running' AND lease_until>? THEN 1 ELSE 0 END) active_tracks
    FROM audio_jobs
    WHERE kind IN ('align','track')`,
  )
    .bind(at, at, at)
    .first<{ queued?: number; running?: number; active_tracks?: number }>();
  const queued = Number(row?.queued || 0);
  const running = Number(row?.running || 0);
  const activeTracks = Number(row?.active_tracks || 0);
  return {
    queued,
    running,
    activeTracks,
    slots: queued > 0 && running === 0 && activeTracks === 0 ? 1 : 0,
  };
}

async function warmOneShortBiosyncTranscript(env: BackendEnv) {
  // The first end-to-end map proved hosted Whisper works on short tracks.
  // Warm one independent ASR transcript per hour; the existing Vercel/GitHub
  // verifier still has to match the exact EPUB before publishing any map.
  if (!env.AI || !env.BUCKET) return;
  const rows = await env.DB.prepare(
    "SELECT e.id edition_id,json_extract(t.value,'$.id') track_id,json_extract(t.value,'$.sha256') audio_sha " +
      "FROM audio_jobs j JOIN audio_editions e ON e.id=json_extract(j.payload_json,'$.editionId') " +
      "JOIN json_each(e.tracks_json) t ON json_extract(t.value,'$.id')=json_extract(j.payload_json,'$.trackId') " +
      "WHERE j.kind='align' AND j.status='queued' " +
      "AND CAST(json_extract(t.value,'$.duration') AS REAL)>0 " +
      "AND CAST(json_extract(t.value,'$.duration') AS REAL)<=240 " +
      "AND json_extract(t.value,'$.sha256') IS NOT NULL ORDER BY j.updated_at,j.id LIMIT 40",
  ).all<{ edition_id: string; track_id: string; audio_sha: string }>();
  const options = rows.results.filter((r) => /^[a-f0-9]{64}$/.test(r.audio_sha));
  // Rotate across short tracks so an unavailable or corrupt recording cannot
  // permanently block progress for every other eligible track.
  if (!options.length) return;
  const origin = "https://cove-persistence.internal";
  const first = Math.floor(Date.now() / 3600000) % options.length;
  for (let offset = 0; offset < Math.min(4, options.length); offset++) {
    const row = options[(first + offset) % options.length];
    const key = `biosync/transcripts/cloudflare-whisper-v1/${row.audio_sha}.json`;
    if (await env.BUCKET?.head?.(key)) continue;
    const request = new Request(origin + "/api/fore/pipeline/hosted-transcript", {
      method: "POST",
    });
    const response = await hostedBiosyncTranscript(request, env, row.edition_id, row.track_id);
    if (response.ok) {
      console.info("Cove BioSync short-track transcript cached", row.edition_id, row.track_id);
      return;
    }
    console.warn(
      "BioSync short-track ASR warm-up skipped",
      row.edition_id,
      row.track_id,
      response.status,
    );
  }
}

async function runScheduled(cron: string, env: BackendEnv) {
  if (await d1QuotaBlocked()) {
    console.warn("Cove ingestion paused briefly after a D1 quota limit.");
    return;
  }
  try {
    if (cron === "* * * * *") {
      // EPUB preparation shares the Worker's memory with asset ingestion.
      // Keep these bounded jobs sequential while isolating individual failures.
      // Opt-in externalization only after both dedicated Workers have been
      // deployed and verified. Defaults to today's inline scheduling.
      const external = env.FORE_CONTENT_PIPELINE_EXTERNAL === "1";
      const allowLegacyLiterary = env.FORE_LEGACY_LITERARY_CRON_ENABLED !== "0";
      // All code paths read the same primary-D1 owner as external Workers.
      // During a drain neither side may start fresh work. The environment
      // switch alone is deliberately insufficient to claim ownership.
      const [assetOwner, literaryOwner] = await Promise.all([
        contentPipelineOwner(env.DB, "assets"),
        contentPipelineOwner(env.DB, "literary"),
      ]);
      const work = [
        ...(!external && assetOwner === "legacy" ? [() => runStoredAssetTick(env)] : []),
        () => verifyAudioStorage(env),
        ...(!external && allowLegacyLiterary && literaryOwner === "legacy"
          ? [() => runLiteraryProfileTick(env)]
          : []),
        () => seedMusicProfiles(env),
      ];
      for (const run of work) {
        try {
          await run();
        } catch (error) {
          console.warn("Cove minute maintenance failed", String(error).slice(0, 200));
        }
      }
      return;
    }
    if (cron === "*/5 * * * *") {
      // Customer health evidence must not wait for, or depend on, ingestion.
      await refreshPublicStatus(env).catch((error) =>
        console.warn("Public service status refresh failed", error),
      );
      await prunePublicCache(env).catch((error) =>
        console.warn("Public cache cleanup failed", error),
      );
      if (!(await audioComputeAdmission(env)).allowed) {
        await scheduledCatalog(env);
        return;
      }
      // This is the reliable primary cron, so it must make forward progress
      // even if a secondary alignment trigger is delayed or never fires.
      // Reserve alternating 15-minute windows for independent BioSync
      // alignment and track acquisition. Never start a track while an
      // alignment lease is active: both need significant transient storage.
      const alignmentState = await audioAlignmentTriggerSlots(env);
      // Bootstrap one short real timing map before returning to alternating
      // acquisition windows. Keeps early BioSync health failures visible without
      // starving the long-running track backlog indefinitely.
      const firstMapPending = await env.DB.prepare("SELECT 1 FROM audio_timing LIMIT 1").first();
      const shortBootstrap = firstMapPending
        ? null
        : await env.DB.prepare(
            "SELECT j.id FROM audio_jobs j JOIN audio_editions e ON e.id=json_extract(j.payload_json,'$.editionId') JOIN json_each(e.tracks_json) t ON json_extract(t.value,'$.id')=json_extract(j.payload_json,'$.trackId') WHERE j.kind='align' AND j.status='queued' AND j.attempts<3 AND j.next_attempt_at<=? AND CAST(json_extract(t.value,'$.duration') AS REAL)<=120 LIMIT 1",
          )
            .bind(new Date().toISOString())
            .first();
      const alignmentWindow = new Date().getUTCMinutes() % 30 < 15 || Boolean(shortBootstrap);
      if (alignmentState.running > 0 || (alignmentWindow && alignmentState.queued > 0)) {
        const work: Promise<unknown>[] = [scheduledCatalog(env)];
        if (alignmentState.slots > 0) {
          work.push(triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-align"));
        }
        const [catalogResult, ...audioResults] = await Promise.allSettled(work);
        for (const result of audioResults) {
          if (result.status === "rejected") {
            console.error("Cove scheduled BioSync trigger failed", result.reason);
          }
        }
        if (catalogResult.status === "rejected") throw catalogResult.reason;
        return;
      }
      const trackState = await audioTrackTriggerSlots(env);
      const work: Promise<unknown>[] = [scheduledCatalog(env)];
      for (let index = 0; index < trackState.slots; index += 1) {
        work.push(triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-track"));
      }
      const [catalogResult, ...audioResults] = await Promise.allSettled(work);
      for (const result of audioResults) {
        if (result.status === "rejected") {
          console.error("Cove scheduled audio trigger failed", result.reason);
        }
      }
      if (trackState.slots > 1) {
        console.info(
          `Cove track backlog ${trackState.queued}; filling ${trackState.slots} of 2 preparation slots.`,
        );
      }
      if (catalogResult.status === "rejected") {
        throw catalogResult.reason;
      }
      return;
    }
    if (cron === "2-59/5 * * * *") {
      const alignmentState = await audioAlignmentTriggerSlots(env);
      if (alignmentState.slots > 0) {
        await triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-align");
      }
      return;
    }
    if (cron === "*/10 * * * *") {
      // Small metadata-only Commons batch every ten minutes. This is independent
      // of the public storefront and never copies an unreviewed sound recording.
      await discoverSoundtrackCandidates(env).catch((error) =>
        console.warn("Soundtrack discovery failed", String(error).slice(0, 160)),
      );
      // Bound imports to two verified originals per tick (12/hour). This exceeds
      // the curator's hourly maximum of eight and prevents an accumulating
      // approved-but-not-playable backlog without unbounded Worker work.
      for (let index = 0; index < 2; index++) {
        try {
          const result = await importOneReviewedSoundtrack(env);
          if ("stored" in result || "failed" in result || "invalidated" in result) {
            console.info("Cove soundtrack R2 import", JSON.stringify(result));
          }
          if ("skipped" in result || "canceled" in result) break;
        } catch (error) {
          console.warn("Soundtrack import failed", String(error).slice(0, 160));
          break;
        }
      }
      // Auditing two already-published originals per tick rechecks approximately
      // 288 recordings/day. A verified license/master mismatch removes access
      // before R2 deletion; temporary Commons failures are retried later.
      for (let index = 0; index < 2; index++) {
        try {
          const rights = await recheckOnePublishedSoundtrack(env);
          if ("revoked" in rights || "held" in rights) {
            console.warn("Cove published soundtrack rights audit", JSON.stringify(rights));
          }
          if ("skipped" in rights) break;
        } catch (error) {
          console.warn("Published soundtrack rights audit failed", String(error).slice(0, 160));
          break;
        }
      }
      const backlog = await env.DB.prepare(
        "SELECT COUNT(*) count FROM audio_jobs WHERE kind='track' AND status IN ('queued','running')",
      ).first<{ count?: number }>();
      const pendingTracks = Number(backlog?.count || 0);
      if (pendingTracks >= 96) {
        console.info(`Cove audio discovery paused with ${pendingTracks} pending track jobs.`);
        return;
      }
      await triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-discover");
      return;
    }
    if (cron === "23 * * * *") {
      await Promise.allSettled([
        warmOneShortBiosyncTranscript(env),
        triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-align"),
      ]);
      return;
    }
    if (cron === "17 3 * * *") {
      await triggerVercelAudio(env, "/api/fore/internal/ingestion/audio-scan");
      return;
    }
    if (cron === "41 4 * * *") {
      await scheduledMaintenance(env);
      return;
    }
    console.warn("Unknown Cove scheduled trigger", cron);
  } catch (error) {
    if (isD1QuotaError(error)) {
      await markD1QuotaBlocked();
      console.warn("Cove ingestion hit a D1 quota limit; backing off for 15 minutes.");
      return;
    }
    throw error;
  }
}

/**
 * Server-to-server BioSync speech recognition. R2 is authoritative for the
 * prepared audio. Nothing here fabricates per-word confidence: Cloudflare's
 * Whisper API returns actual word timestamps, but not probability values.
 * The Python alignment verifier still demands independently matching EPUB
 * words before it can publish a map.
 */
/* eslint-disable prettier/prettier -- isolated hosted-ASR adapter; behavioral CI remains enforced */
async function hostedBiosyncTranscript(
  request: Request,
  env: BackendEnv,
  editionId: string,
  trackId: string,
) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!env.AI || !env.BUCKET)
    return json({ error: "BioSync hosted ASR binding unavailable.", retryable: true }, 503);
  if (!/^pg-[1-9][0-9]{0,8}$/.test(editionId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(trackId)) {
    return json({ error: "Invalid audio identity." }, 400);
  }
  const row = await env.DB.prepare("SELECT language,tracks_json FROM audio_editions WHERE id=?")
    .bind(editionId)
    .first<{ language: string; tracks_json: string }>();
  if (!row) return json({ error: "Unknown audio edition." }, 404);
  let tracks: Array<{ id: string; sha256?: string; duration?: number; url: string }>;
  try {
    tracks = JSON.parse(row.tracks_json);
  } catch {
    return json({ error: "Invalid edition metadata." }, 409);
  }
  const track = tracks.find((t) => t.id === trackId);
  if (!track || !track.sha256 || !/^[a-f0-9]{64}$/.test(track.sha256) || !track.duration) {
    return json({ error: "Prepared audio is required." }, 409);
  }
  const cacheKey = `biosync/transcripts/cloudflare-whisper-v1/${track.sha256}.json`;
  const cached = await env.BUCKET.get(cacheKey);
  if (cached) return json(await cached.json());
  const audioKey = `audio/${editionId}/${track.id}-${track.sha256}`;
  const object = await env.BUCKET.get(audioKey);
  if (!object) return json({ error: "Prepared audio object is missing.", retryable: true }, 503);
  // This model is for bounded short recordings. Don't load long MP3s into
  // the Worker heap; large tracks require a separate chunked ASR pathway.
  if (object.size > 8 * 1024 * 1024 || track.duration > 240) {
    return json(
      {
        error: "Hosted Whisper chunking required for this track.",
        retryable: true,
        reason: "track_exceeds_single_inference_limit",
      },
      422,
    );
  }
  const audio = new Uint8Array(await object.arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", audio))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== track.sha256) return json({ error: "Prepared audio digest mismatch." }, 409);
  let result: { words?: Array<{ word?: string; start?: number; end?: number }>; text?: string };
  try {
    result = (await env.AI.run("@cf/openai/whisper", {
      audio: Array.from(audio),
    })) as typeof result;
  } catch (error) {
    console.error("Hosted BioSync transcription failed", editionId, trackId, error);
    return json({ error: "Hosted transcription unavailable.", retryable: true }, 503);
  }
  if (!Array.isArray(result?.words)) {
    return json({ error: "Speech engine did not return word timestamps.", retryable: true }, 503);
  }
  const words = result.words
    .filter(
      (w) =>
        w &&
        typeof w.word === "string" &&
        w.word.trim().length > 0 &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end) &&
        (w.start as number) >= 0 &&
        (w.end as number) > (w.start as number) &&
        (w.end as number) <= (track.duration as number) + 1,
    )
    .map((w) => ({
      text: (w.word as string).trim(),
      start: w.start,
      end: w.end,
      probability: null,
    }));
  if (words.length < 30) {
    return json(
      {
        error: "Speech transcript has fewer than thirty timed words.",
        retryable: true,
        timedWords: words.length,
      },
      503,
    );
  }
  const transcript = {
    identity: { audioSha256: track.sha256, model: "cloudflare-whisper-v1", language: row.language },
    engine: "cloudflare-workers-ai-whisper",
    confidenceMode: "unreported",
    language: row.language,
    duration: track.duration,
    words,
  };
  await env.BUCKET.put(cacheKey, JSON.stringify(transcript), {
    httpMetadata: { contentType: "application/json" },
  });
  return json(transcript);
}

/* eslint-enable prettier/prettier */

export default {
  async scheduled(controller: { cron: string }, env: BackendEnv, ctx: ExecutionContextLike) {
    env = scopePublicationOwnerEnv(env);
    if (
      controller.cron === "*/10 * * * *" ||
      controller.cron === "23 * * * *" ||
      controller.cron === "41 4 * * *"
    )
      ctx.waitUntil?.(runCommercialQueues(controller.cron, env));

    if (controller.cron === "23 * * * *")
      ctx.waitUntil?.(
        processAccountDeletionQueue(env, 5)
          .then((result) =>
            console.info(JSON.stringify({ event: "account_erasure_tick", ...result })),
          )
          .catch(() =>
            console.error("Account erasure tick failed; queued requests will be retried."),
          ),
      );
    ctx.waitUntil?.(
      runScheduled(controller.cron, env).catch((error) => {
        console.error("Cove scheduled ingestion failed", controller.cron, error);
        throw error;
      }),
    );
  },

  async fetch(request: Request, env: BackendEnv, ctx: ExecutionContextLike) {
    if (!(await authorized(request, env))) {
      return json({ error: "Persistence gateway authorization required." }, 401);
    }
    env = scopePublicationOwnerEnv(env);

    const path = new URL(request.url).pathname;
    // This endpoint runs only AFTER persistence gateway authentication.
    // It cannot enable the owner or authorize a commercial action: the
    // disabled production DO must echo a fresh, secret-authenticated nonce.
    if (path === DISABLED_OWNER_ATTEST_ROUTE) {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      try {
        const verdict = await attestDisabledOwnerFromBackend(env);
        return json(verdict);
      } catch {
        return json({ attested: false, ownerEnabled: false, authorizing: false }, 503);
      }
    }
    if (isPublicSeoDocumentPath(path)) {
      if (!["GET", "HEAD"].includes(request.method))
        return json({ error: "Method not allowed." }, 405);
      if (new URL(request.url).search) return json({ error: "Not found." }, 404);
      const document = await handleSeoDocumentRequest(request, env.DB, env.FORE_PUBLIC_URL);
      if (!document) return json({ error: "Not found." }, 404);
      if (request.method === "HEAD")
        return new Response(null, { status: document.status, headers: document.headers });
      return document;
    }
    const chunkTranscript = path.match(
      /^\/api\/fore\/pipeline\/hosted-transcript\/(pg-[1-9][0-9]{0,8})\/([a-zA-Z0-9_-]{1,100})\/chunks(?:\/([0-9]{1,3}))?$/,
    );
    if (chunkTranscript)
      return hostedBiosyncChunks(
        request,
        env,
        chunkTranscript[1],
        chunkTranscript[2],
        chunkTranscript[3] === undefined ? undefined : Number(chunkTranscript[3]),
      );
    const hostedTranscript = path.match(
      /^\/api\/fore\/pipeline\/hosted-transcript\/(pg-[1-9][0-9]{0,8})\/([a-zA-Z0-9_-]{1,100})$/,
    );
    if (hostedTranscript)
      return hostedBiosyncTranscript(request, env, hostedTranscript[1], hostedTranscript[2]);
    if (path === "/__cove/health" && request.method === "GET") {
      try {
        const row = await env.DB.prepare("SELECT 1 ok").first<{ ok?: number }>();
        return json({
          ok: row?.ok === 1,
          database: true,
          objectStorage: Boolean(env.BUCKET),
        });
      } catch {
        return json(
          {
            ok: false,
            database: false,
            objectStorage: Boolean(env.BUCKET),
          },
          503,
        );
      }
    }

    // Separate disabled private intake. Even successful handoff never authorizes
    // customer audio, updates soundtrack tables or creates playback URLs.
    if (path === "/__cove/ingestion/music-supply-handoff" && request.method === "POST")
      return handleCanonicalMusicHandoff(request, env, () =>
        admitCatalogBatch(
          env.DB,
          catalogAdmissionBudget(env.FORE_MUSIC_CANONICAL_HANDOFF_PROBE_MS),
        ),
      );
    if (path === "/__cove/ingestion/catalog" && request.method === "POST") {
      return catalogBatch(request, env);
    }
    // Operator-only repair is disabled in every environment by default.
    // The gateway authorization is checked above; a separate explicit
    // activation is still required before this can touch catalog metadata.
    if (path === "/__cove/ingestion/repair-regional-epubs" && request.method === "POST") {
      if (env.FORE_REGIONAL_EPUB_REPAIR_ENABLED !== "1")
        return json({ error: "Regional EPUB repair is disabled." }, 403);
      const input = await request.json().catch(() => null);
      if (!input || typeof input !== "object" || Array.isArray(input))
        return json({ error: "Invalid repair cursor or batch limit." }, 400);
      const { after, limit } = input as Record<string, unknown>;
      if (after !== undefined && typeof after !== "string")
        return json({ error: "Invalid repair cursor or batch limit." }, 400);
      const validLimit =
        limit === undefined ||
        (Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 16);
      if (!validLimit) return json({ error: "Invalid repair cursor or batch limit." }, 400);
      // A bulk repair is deferrable: never initiate it while the shared
      // primary D1 is unavailable or already showing substantial queue delay.
      const admission = await admitCatalogBatch(
        env.DB,
        catalogAdmissionBudget(env.FORE_REGIONAL_EPUB_REPAIR_PROBE_MS),
      );
      if (!admission.allowed)
        return json({ skipped: admission.reason, probeMs: admission.probeMs }, 503);
      try {
        const result = await repairRegionalEpubAssets(env, {
          after: after as string | undefined,
          limit: limit as number | undefined,
        });
        return json(result);
      } catch (error) {
        console.error("Regional EPUB repair failed", String(error).slice(0, 180));
        return json({ error: "Regional EPUB repair failed." }, 503);
      }
    }
    if (path === "/__cove/ingestion/audio-admission" && request.method === "POST") {
      const input = (await request.json().catch(() => null)) as { reserve?: unknown } | null;
      return json(await audioComputeAdmission(env, input?.reserve === true));
    }
    if (path === "/__cove/ingestion/maintenance" && request.method === "POST") {
      return maintenance(env);
    }
    if (!path.startsWith("/api/fore/")) {
      return json({ error: "Not found." }, 404);
    }

    const logical = logicalRequest(request, env);
    const response = await cachedPublicApi(logical, request, env, ctx, (request, bindings) =>
      handleCoveApi(request, bindings, ctx),
    );
    if (!response) return json({ error: "Not found." }, 404);

    return response;
  },
};
