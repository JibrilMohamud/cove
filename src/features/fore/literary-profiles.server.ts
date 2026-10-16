import { z } from "zod";
import { countReadingUnits, estimateReadingTime } from "./reading-time";
import { resolveProductRights } from "./rights.server";
import type { CoveEnv } from "./api.server";
import type { CoveIdentity } from "./auth.server";
import { ApiError, json, readBody } from "./service";
import { requireStaffPermission } from "./moderation.server";
import { requireServiceScope } from "./privileged-access.server";
import {
  buildMatchingPlaylist,
  handleMatchingAdministration,
  type MatchingContext,
} from "./matching.server";
import { resolveProduct } from "./catalog-model.server";
import { extractLiterarySections } from "./literary-extract.server";
import {
  emptyLiteraryProfile,
  literaryPrompt,
  literaryJsonSchema,
  literaryProfileSchema,
  validateLiteraryProfile,
  PROFILE_POLICY,
  PROFILE_MODEL,
  type LiteraryProfile,
  type ProfileEvidence,
} from "./literary-profile";

export type LiteraryEnv = CoveEnv & {
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
};
type BookInput = {
  id: string;
  title: string;
  description: string;
  language: string;
  source_name: string;
  source_external_id: string;
  object_key: string | null;
  sha256: string | null;
  metadata: string;
  text_allowed: number;
  extra_sources: string;
  bibliography: string;
  word_count: number | null;
  page_estimate: number | null;
};
type CurrentProfile = {
  product_id: string;
  fingerprint: string;
  profile_json: string;
  status: string;
  coverage: string;
  revision: number;
  updated_at: string;
  reading_time_json: string | null;
  policy_version: string;
};
type Job = {
  id: string;
  product_id: string;
  fingerprint: string;
  kind: string;
  section_id: string;
  source_key: string;
  attempts: number;
};
type SourceBundle = {
  sources: ProfileEvidence[];
  coverage: string;
  truncated?: boolean;
  totalSections?: number;
};
// The published inference outputs currently average ~1.2 kB. A bounded
// 2,400-token response still leaves substantial headroom for long, unusual
// literary analyses, while a 12k output-work reservation avoids repeatedly
// charging the 2M-unit daily cap for unneeded maximum-length generation.
export const LITERARY_GENERATION_LIMITS = {
  maxOutputTokens: 2400,
  reservedOutputCharacters: 12000,
} as const;
const at = () => new Date().toISOString();
const hash = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const inputSql = `SELECT p.id,e.title,e.description,e.language,e.word_count,e.page_estimate,p.source_name,p.source_external_id,av.object_key,av.sha256,
  json_object('edition publication date',e.publication_date,'original publication date',(SELECT w.original_publication_date FROM works w WHERE w.id=e.work_id),'authors',json(COALESCE((SELECT json_group_array(name) FROM (SELECT c.name FROM edition_contributors ec JOIN contributors c ON c.id=ec.contributor_id WHERE ec.edition_id=e.id AND ec.role='author' ORDER BY ec.position LIMIT 20)),'[]'))) bibliography,
  COALESCE((SELECT json_object('subjects',json(c.subjects_json),'shelves',json(c.bookshelves_json),'authors',json(c.authors_json)) FROM gutenberg_source_cache c WHERE c.id=p.source_external_id),'{}') metadata,
  COALESCE((SELECT json_group_array(json_object('id',s.id,'kind',s.kind,'text',s.text,'locator',s.locator,'hash',s.content_sha256)) FROM literary_profile_sources s WHERE s.product_id=p.id AND s.active=1 ORDER BY s.id),'[]') extra_sources,
  CASE WHEN p.source_name='gutenberg' AND e.canonical_public_domain=1 AND EXISTS(SELECT 1 FROM gutenberg_source_cache c WHERE c.id=p.source_external_id AND c.copyright=0 AND c.commercial_use_status='approved') THEN 1 ELSE 0 END text_allowed
  FROM products p JOIN editions e ON e.id=p.edition_id
  LEFT JOIN digital_assets da ON da.edition_id=e.id AND da.kind='epub'
  LEFT JOIN asset_versions av ON av.id=da.current_version_id`;
async function config(env: CoveEnv, name: string, fallback: number) {
  const value = await env.DB.prepare("SELECT value FROM cove_runtime_config WHERE key=?")
    .bind("literary_" + name)
    .first<{ value: string }>();
  const number = Number(value?.value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}
const metadataSources = (book: BookInput): ProfileEvidence[] => [
  {
    id: "catalog",
    kind: "metadata",
    text: JSON.stringify({
      title: book.title,
      language: book.language,
      bibliography: JSON.parse(book.bibliography),
      metadata: JSON.parse(book.metadata),
    }).slice(0, 12000),
    locator: "catalog:" + book.id,
  },
  ...JSON.parse(book.extra_sources || "[]").map((s: ProfileEvidence) => ({
    id: s.id,
    kind: s.kind,
    text: s.text,
    locator: s.locator,
  })),
  ...(book.description?.trim()
    ? [
        {
          id: "description",
          kind: "description" as const,
          text: book.description.slice(0, 12000),
          locator: "catalog:" + book.id + ":description",
        },
      ]
    : []),
];
async function addJob(
  env: CoveEnv,
  product: string,
  fingerprint: string,
  kind: "prepare" | "analyze",
  section = "",
  sourceKey = "",
) {
  const time = at();
  return env.DB.prepare(
    `INSERT OR IGNORE INTO literary_profile_jobs(id,product_id,fingerprint,kind,section_id,source_key,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      await hash([product, fingerprint, kind, section].join(":")),
      product,
      fingerprint,
      kind,
      section,
      sourceKey,
      time,
      time,
      time,
    )
    .run();
}
async function enqueueBook(env: LiteraryEnv, book: BookInput, queuePreparation = true) {
  const time = at();
  const fingerprint = await hash(
    JSON.stringify({ policy: PROFILE_POLICY, model: PROFILE_MODEL, book }),
  );
  const current = await env.DB.prepare(
    "SELECT fingerprint,coverage FROM literary_profiles WHERE product_id=?",
  )
    .bind(book.id)
    .first<{ fingerprint: string; coverage: string }>();
  if (current?.fingerprint === fingerprint) {
    if (queuePreparation && current.coverage === "metadata_deferred") {
      await addJob(env, book.id, fingerprint, "prepare", "", "");
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE literary_profile_jobs SET status='queued',attempts=0,available_at=?,lease_until='',updated_at=? WHERE product_id=? AND fingerprint=? AND kind='prepare' AND status IN ('done','failed','superseded')",
        ).bind(time, time, book.id, fingerprint),
        env.DB.prepare(
          "UPDATE literary_profiles SET coverage='metadata' WHERE product_id=? AND fingerprint=? AND coverage='metadata_deferred'",
        ).bind(book.id, fingerprint),
      ]);
    }
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO literary_profiles(product_id,fingerprint,profile_json,status,coverage,updated_at,reading_time_json,policy_version) VALUES(?,?,?,'provisional',?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET fingerprint=excluded.fingerprint,profile_json=excluded.profile_json,status='provisional',coverage=excluded.coverage,revision=literary_profiles.revision+1,updated_at=excluded.updated_at,reading_time_json=excluded.reading_time_json,policy_version=excluded.policy_version`,
    ).bind(
      book.id,
      fingerprint,
      JSON.stringify(emptyLiteraryProfile()),
      queuePreparation ? "metadata" : "metadata_deferred",
      time,
      JSON.stringify(
        estimateReadingTime({
          language: book.language,
          wordCount: book.word_count,
          pageEstimate: book.page_estimate,
        }),
      ),
      PROFILE_POLICY,
    ),
    env.DB.prepare(
      "UPDATE literary_profile_jobs SET status='superseded',updated_at=? WHERE product_id=? AND fingerprint<>? AND status IN ('queued','running')",
    ).bind(time, book.id, fingerprint),
    ...(queuePreparation
      ? [
          env.DB.prepare(
            "INSERT OR IGNORE INTO literary_profile_jobs(id,product_id,fingerprint,kind,available_at,created_at,updated_at) VALUES(?,?,?,'prepare',?,?,?)",
          ).bind(
            await hash([book.id, fingerprint, "prepare", ""].join(":")),
            book.id,
            fingerprint,
            time,
            time,
            time,
          ),
          // Reverted sources must revive their old pinned jobs only when
          // preparation capacity exists.
          env.DB.prepare(
            "UPDATE literary_profile_jobs SET status='queued',attempts=0,available_at=?,lease_until='',updated_at=? WHERE product_id=? AND fingerprint=? AND status IN ('done','failed','superseded')",
          ).bind(time, time, book.id, fingerprint),
        ]
      : []),
  ]);
}
/** Keyset sweep is bounded independently of catalog size. No OFFSET or per-visitor AI. */
export async function seedLiteraryProfiles(env: LiteraryEnv, limit = 50, queuePreparation = true) {
  const token = crypto.randomUUID(),
    time = at();
  const state = await env.DB.prepare(
    `UPDATE literary_profile_state SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING cursor`,
  )
    .bind(token, new Date(Date.now() + 120000).toISOString(), time)
    .first<{ cursor: string }>();
  if (!state) return { seeded: 0, skipped: "seed_lease" };
  try {
    const books = (
      await env.DB.prepare(
        inputSql +
          " WHERE p.id>? AND p.storefront_status='active' AND p.format='ebook' AND p.source_name<>'upload' ORDER BY p.id LIMIT ?",
      )
        .bind(state.cursor, Math.max(1, Math.min(100, limit)))
        .all<BookInput>()
    ).results;
    for (const book of books) {
      await enqueueBook(env, book, queuePreparation);
    }
    await env.DB.prepare(
      "UPDATE literary_profile_state SET cursor=?,last_run_at=? WHERE id=1 AND lease_token=?",
    )
      .bind(books.at(-1)?.id || "", time, token)
      .run();
    return { scanned: books.length, preparationsDeferred: !queuePreparation };
  } finally {
    await env.DB.prepare(
      "UPDATE literary_profile_state SET lease_until='' WHERE id=1 AND lease_token=?",
    )
      .bind(token)
      .run();
  }
}
async function putBundle(env: LiteraryEnv, key: string, bundle: SourceBundle) {
  if (!env.BUCKET) throw new Error("Profile evidence storage unavailable");
  // Keep full-text chunks intact while bounding surrounding metadata/excerpts.
  // This avoids context overflow for long descriptions or non-Latin sources.
  let remaining = 12000;
  const sources = [...bundle.sources]
    .sort(
      (a, b) =>
        Number(b.kind === "full_text" || b.kind === "excerpt") -
        Number(a.kind === "full_text" || a.kind === "excerpt"),
    )
    .flatMap((source) => {
      const limit = Math.min(remaining, source.kind === "full_text" ? 8000 : 4000);
      const text = source.text.slice(0, limit);
      remaining -= text.length;
      return text ? [{ ...source, text }] : [];
    });
  const text = JSON.stringify({ ...bundle, sources });
  await env.BUCKET.put(key, new TextEncoder().encode(text), {
    sha256: await hash(text),
    httpMetadata: { contentType: "application/json" },
  });
}
async function currentBookForJob(env: LiteraryEnv, job: Job) {
  const book = await env.DB.prepare(inputSql + " WHERE p.id=? AND p.storefront_status='active'")
    .bind(job.product_id)
    .first<BookInput>();
  if (!book) throw new Error("Inactive or missing product");
  const actualFingerprint = await hash(
    JSON.stringify({ policy: PROFILE_POLICY, model: PROFILE_MODEL, book }),
  );
  if (actualFingerprint !== job.fingerprint) {
    // Catalog ingestion can change an edition between its sweep and preparation.
    // Replace the stale claim now instead of retrying it until the next full sweep.
    await enqueueBook(env, book);
    throw new Error("source_changed_requeued");
  }
  return book;
}
async function prepareBook(env: LiteraryEnv, job: Job, token: string) {
  const book = await currentBookForJob(env, job);
  const prefix = `literary/v1/${job.product_id}/${job.fingerprint}`;
  const sources = metadataSources(book);
  let coverage = "metadata",
    truncated = false,
    totalSections = 0;
  let readingTime = estimateReadingTime({
    language: book.language,
    wordCount: book.word_count,
    pageEstimate: book.page_estimate,
  });
  if (book.text_allowed && book.object_key && env.BUCKET?.head) {
    const head = await env.BUCKET.head(book.object_key);
    if (head && head.size <= 16 * 1024 * 1024) {
      try {
        const object = await env.BUCKET.get(book.object_key);
        const bytes = new Uint8Array(await object.arrayBuffer());
        const measured = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (book.sha256 && measured !== book.sha256) throw new Error("EPUB content changed");
        const extracted = await extractLiterarySections(bytes);
        truncated = extracted.truncated;
        totalSections = extracted.sections.length;
        const bySpine = new Map<number, string>();
        for (const section of extracted.sections)
          bySpine.set(section.spineIndex, (bySpine.get(section.spineIndex) || "") + section.text);
        const units = [...bySpine.values()].reduce(
          (n, text) => n + countReadingUnits(text, book.language),
          0,
        );
        if (units)
          readingTime = estimateReadingTime({
            language: book.language,
            textUnits: units,
            truncated,
          });
        // Overview samples the beginning, middle and end; never treats samples as complete text.
        const samples = [...new Set([0, Math.floor(totalSections / 2), totalSections - 1])]
          .map((i) => extracted.sections[i])
          .filter(Boolean);
        for (const sample of samples)
          sources.push({
            id: sample.id,
            kind: "excerpt",
            text: sample.text.slice(0, 2200),
            locator: `${book.object_key}#${sample.href}:${sample.charStart}-${sample.charStart + Math.min(2200, sample.text.length)}`,
          });
        coverage = totalSections ? "full_text_pending" : "metadata";
        for (const section of extracted.sections) {
          const lease = await env.DB.prepare(
            "UPDATE literary_profile_jobs SET lease_until=? WHERE id=? AND lease_token=? AND status='running' AND EXISTS(SELECT 1 FROM literary_profiles p WHERE p.product_id=literary_profile_jobs.product_id AND p.fingerprint=literary_profile_jobs.fingerprint) RETURNING id",
          )
            .bind(new Date(Date.now() + 300000).toISOString(), job.id, token)
            .first();
          if (!lease) throw new Error("literary_prepare_lease_lost");
          const sourceKey = `${prefix}/${section.id}.json`;
          await putBundle(env, sourceKey, {
            sources: [
              ...metadataSources(book),
              {
                id: section.id,
                kind: "full_text",
                text: section.text,
                locator: `${book.object_key}#${section.href}:${section.charStart}-${section.charEnd}`,
              },
            ],
            coverage: "section",
          });
          await env.DB.prepare(
            `INSERT INTO literary_profile_sections(product_id,fingerprint,section_id,spine_index,href,title,chunk_index,char_start,char_end,source_key,updated_at,reading_time_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id,fingerprint,section_id) DO UPDATE SET reading_time_json=excluded.reading_time_json`,
          )
            .bind(
              job.product_id,
              job.fingerprint,
              section.id,
              section.spineIndex,
              section.href,
              section.title,
              section.chunkIndex,
              section.charStart,
              section.charEnd,
              sourceKey,
              at(),
              JSON.stringify(
                estimateReadingTime({
                  language: book.language,
                  textUnits: countReadingUnits(section.text, book.language),
                }),
              ),
            )
            .run();
          await addJob(env, job.product_id, job.fingerprint, "analyze", section.id, sourceKey);
        }
      } catch (error) {
        if (/D1_|lease_lost|network|connection lost/i.test(String(error))) throw error;
        // Invalid/unsupported full text must not prevent a metadata profile.
        coverage = "metadata_text_unavailable";
        console.warn("literary_text_unavailable", job.product_id, String(error).slice(0, 160));
      }
    } else if (head) coverage = "metadata_text_oversized";
  }
  await env.DB.prepare(
    "UPDATE literary_profiles SET reading_time_json=? WHERE product_id=? AND fingerprint=?",
  )
    .bind(JSON.stringify(readingTime), job.product_id, job.fingerprint)
    .run();
  const key = `${prefix}/book.json`;
  await putBundle(env, key, { sources, coverage, truncated, totalSections });
  await addJob(env, job.product_id, job.fingerprint, "analyze", "", key);
}

async function analyze(env: LiteraryEnv, job: Job, leaseToken: string) {
  await currentBookForJob(env, job);
  if (!env.AI || !env.BUCKET) throw new Error("Literary inference binding unavailable");
  const head = await env.BUCKET.head?.(job.source_key);
  if (!head || head.size > 100000) throw new Error("Invalid literary source bundle");
  const bundle = JSON.parse(await (await env.BUCKET.get(job.source_key)).text()) as SourceBundle;
  const prompt = literaryPrompt(bundle.sources);
  const cacheKey = `literary/inference/${PROFILE_POLICY}/${await hash(JSON.stringify({ model: PROFILE_MODEL, system: prompt.system, sources: bundle.sources.map(({ id, kind, text }) => ({ id, kind, text })) }))}.json`;
  const cacheHead = await env.BUCKET.head?.(cacheKey);
  const cached = cacheHead && cacheHead.size < 100000 ? await env.BUCKET.get(cacheKey) : null;
  // A conservative character reservation includes the entire prompt and maximum
  // generated output. This is a work budget, not a currency/token estimate.
  const reservedOutput = LITERARY_GENERATION_LIMITS.reservedOutputCharacters;
  const units = prompt.system.length + prompt.user.length + reservedOutput;
  const day = at().slice(0, 10),
    budget = Math.max(0, Math.min(100_000_000, await config(env, "daily_units", 2_000_000)));
  const reserved = cached
    ? true
    : await env.DB.prepare(
        `INSERT INTO literary_profile_budget(day,reserved_units,calls) SELECT ?,?,1 WHERE ?<=? ON CONFLICT(day) DO UPDATE SET reserved_units=reserved_units+excluded.reserved_units,calls=calls+1 WHERE reserved_units+excluded.reserved_units<=? RETURNING calls`,
      )
        .bind(day, units, units, budget, budget)
        .first();
  if (!reserved) throw new Error("daily_budget_exhausted");
  const raw = cached
    ? { response: await cached.text() }
    : await env.AI.run(PROFILE_MODEL, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: LITERARY_GENERATION_LIMITS.maxOutputTokens,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: literaryJsonSchema(bundle.sources) },
      });
  const response = raw && typeof raw === "object" && "response" in raw ? raw.response : null;
  const profile = validateLiteraryProfile(
    typeof response === "string" ? JSON.parse(response) : response,
    bundle.sources,
  );
  if (!cached)
    await env.BUCKET.put(cacheKey, JSON.stringify(profile), {
      httpMetadata: { contentType: "application/json" },
    });
  const encoded = JSON.stringify(profile),
    time = at();
  const guard = `EXISTS(SELECT 1 FROM literary_profile_jobs j JOIN literary_profiles p ON p.product_id=j.product_id AND p.fingerprint=j.fingerprint WHERE j.id=? AND j.lease_token=? AND j.status='running' AND j.lease_until>?)`;
  if (job.section_id) {
    await env.DB.prepare(
      `UPDATE literary_profile_sections SET profile_json=?,updated_at=? WHERE product_id=? AND fingerprint=? AND section_id=? AND ${guard}`,
    )
      .bind(
        encoded,
        time,
        job.product_id,
        job.fingerprint,
        job.section_id,
        job.id,
        leaseToken,
        time,
      )
      .run();
  } else {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE literary_profiles SET profile_json=?,status='analyzed',coverage=?,revision=revision+1,updated_at=? WHERE product_id=? AND fingerprint=? AND ${guard}`,
      ).bind(
        encoded,
        JSON.stringify({
          mode: bundle.coverage,
          truncated: !!bundle.truncated,
          totalSections: bundle.totalSections || 0,
        }),
        time,
        job.product_id,
        job.fingerprint,
        job.id,
        leaseToken,
        time,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO literary_profile_revisions(product_id,revision,fingerprint,profile_json,model,policy_version,created_at) SELECT product_id,revision,fingerprint,profile_json,?,?,? FROM literary_profiles WHERE product_id=? AND fingerprint=? AND ${guard}`,
      ).bind(
        PROFILE_MODEL,
        PROFILE_POLICY,
        time,
        job.product_id,
        job.fingerprint,
        job.id,
        leaseToken,
        time,
      ),
    ]);
  }
}
/** Atomic leases and pinned fingerprints let independent bounded consumers scale safely. */
export async function processLiteraryJob(
  env: LiteraryEnv,
  preferSections = false,
  lane: "prepare" | "analyze" | "any" = "any",
) {
  const time = at(),
    token = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE literary_profile_jobs SET status='failed',last_error='lease_expired_max_attempts',updated_at=? WHERE status='running' AND lease_until<? AND attempts>=5",
  )
    .bind(time, time)
    .run();
  // Compute each current book's section footprint ONCE per claim. The old
  // created_at-only order spent a day's calls on one long work, leaving
  // thousands of books with no chapter-level evidence. Favor compact,
  // multi-spine books and finish them before investing in giant volumes.
  // Chapter evidence and book overviews still receive distinct turns.
  const withCoverage =
    lane === "prepare"
      ? ""
      : `WITH section_coverage AS (
        SELECT s.product_id,s.fingerprint,COUNT(*) total,
          COUNT(DISTINCT s.spine_index) spines,
          SUM(s.profile_json IS NOT NULL) analyzed
        FROM literary_profile_sections s
        JOIN literary_profiles p ON p.product_id=s.product_id AND p.fingerprint=s.fingerprint
        GROUP BY s.product_id,s.fingerprint
      ) `;
  const coverageJoin =
    lane === "prepare"
      ? ""
      : " LEFT JOIN section_coverage c ON c.product_id=j.product_id AND c.fingerprint=j.fingerprint";
  const analysisPriority =
    lane === "prepare"
      ? ""
      : `,CASE WHEN j.kind='analyze' AND j.section_id='' AND COALESCE(c.analyzed,0)>0 THEN 0 ELSE 1 END,
          CASE WHEN j.kind='analyze' AND j.section_id<>'' AND COALESCE(c.spines,0)>=2 THEN 0 ELSE 1 END,
          CASE WHEN j.kind='analyze' THEN COALESCE(c.total,99999) ELSE 0 END`;
  const job = await env.DB.prepare(
    `${withCoverage}UPDATE literary_profile_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=(SELECT j.id FROM literary_profile_jobs j JOIN literary_profiles p ON p.product_id=j.product_id AND p.fingerprint=j.fingerprint${coverageJoin} WHERE (?='any' OR j.kind=?) AND ((j.status='queued' AND j.available_at<=?) OR (j.status='running' AND j.lease_until<?)) AND j.attempts<5 ORDER BY CASE WHEN (j.section_id<>'')=? THEN 0 ELSE 1 END${analysisPriority},j.created_at,j.id LIMIT 1) RETURNING *`,
  )
    .bind(
      token,
      new Date(Date.now() + 300000).toISOString(),
      time,
      lane,
      lane,
      time,
      time,
      preferSections ? 1 : 0,
    )
    .first<Job>();
  if (!job) return { skipped: "no_jobs" };
  try {
    if (job.kind === "prepare") await prepareBook(env, job, token);
    else await analyze(env, job, token);
    await env.DB.prepare(
      "UPDATE literary_profile_jobs SET status='done',lease_until='',updated_at=? WHERE id=? AND lease_token=? AND status='running'",
    )
      .bind(at(), job.id, token)
      .run();
    return { done: job.id, kind: job.kind, section: job.section_id };
  } catch (error) {
    const message = String(error).slice(0, 200);
    const budget = message.includes("daily_budget_exhausted");
    const next = budget
      ? new Date(new Date().setUTCHours(24, 0, 0, 0))
      : new Date(Date.now() + Math.min(21600000, 60000 * 2 ** job.attempts));
    await env.DB.prepare(
      "UPDATE literary_profile_jobs SET status=?,attempts=attempts-?,available_at=?,lease_until='',last_error=?,updated_at=? WHERE id=? AND lease_token=? AND status='running'",
    )
      .bind(
        !budget && job.attempts >= 5 ? "failed" : "queued",
        budget ? 1 : 0,
        next.toISOString(),
        message,
        at(),
        job.id,
        token,
      )
      .run();
    if (!budget && job.attempts >= 5 && !job.section_id) {
      await env.DB.prepare(
        "UPDATE literary_profiles SET status='failed',updated_at=? WHERE product_id=? AND fingerprint=?",
      )
        .bind(at(), job.product_id, job.fingerprint)
        .run();
    }
    return { failed: job.id, reason: message };
  }
}
/** Keep prepared-but-unanalyzed sections bounded without changing inference quotas. */
export function literaryPreparationCapacity(
  configured: number,
  waitingAnalysis: number,
  maxPendingAnalysis = 512,
) {
  if (![configured, waitingAnalysis, maxPendingAnalysis].every(Number.isFinite)) return 0;
  return Math.max(
    0,
    Math.min(
      4,
      Math.floor(configured),
      Math.floor(maxPendingAnalysis) - Math.max(0, Math.floor(waitingAnalysis)),
    ),
  );
}
/** Three chapter turns for every book-overview turn; never a hidden model call. */
export function preferLiterarySection(turn: number) {
  return Number.isSafeInteger(turn) && ((turn % 4) + 4) % 4 !== 0;
}
export async function runLiteraryProfileTick(env: LiteraryEnv) {
  if (!(await config(env, "enabled", 1))) return { skipped: "disabled" };
  // A catalog sweep can generate 50 new durable preparation jobs each minute.
  // Stop enumerating once that backlog is saturated; the already-seeded titles
  // retain their provisional reading times, rights and durable claims.
  const queuedPrepares =
    (
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM literary_profile_jobs WHERE kind='prepare' AND status='queued'",
      ).first<{ count: number }>()
    )?.count ?? 0;
  const maxQueuedPrepares = Math.max(
    128,
    Math.min(20000, await config(env, "max_queued_prepares", 2048)),
  );
  // Always maintain provisional metadata profiles and estimated reading
  // times for new editions. Suppress ONLY costly preparation claims while
  // overloaded, then enqueue deferred books on the next keyset sweep.
  const seeded = await seedLiteraryProfiles(env, 50, queuedPrepares < maxQueuedPrepares);
  const jobs = [];
  // Source preparation writes extracted EPUB sections and queues many costly
  // inference jobs. Respect the backlog instead of endlessly creating more
  // bundles once inference reaches its independent daily budget.
  const waitingAnalysis =
    (
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM literary_profile_jobs WHERE kind='analyze' AND status IN ('queued','running')",
      ).first<{ count: number }>()
    )?.count ?? 0;
  const maxPendingAnalysis = Math.max(
    64,
    Math.min(4096, await config(env, "max_pending_analysis", 512)),
  );
  const prepares = literaryPreparationCapacity(
    await config(env, "prepares_per_tick", 2),
    waitingAnalysis,
    maxPendingAnalysis,
  );
  for (let n = 0; n < prepares; n++) jobs.push(await processLiteraryJob(env, false, "prepare"));
  if (!env.AI) return { seeded, jobs, skipped: "missing_ai" };
  const limit = Math.max(0, Math.min(4, await config(env, "jobs_per_tick", 2)));
  // Persistent alternation also works when configured to one inference per tick.
  const turn = await env.DB.prepare(
    "UPDATE literary_profile_state SET inference_turn=inference_turn+? WHERE id=1 RETURNING inference_turn",
  )
    .bind(limit)
    .first<{ inference_turn: number }>();
  for (let n = 0; n < limit; n++) {
    const result = await processLiteraryJob(
      env,
      preferLiterarySection((turn?.inference_turn || 0) - limit + n),
      "analyze",
    );
    jobs.push(result);
    if ("reason" in result && result.reason?.includes("daily_budget_exhausted")) break;
  }
  return { seeded, jobs };
}

function mergeSections(
  base: LiteraryProfile,
  profiles: LiteraryProfile[],
  weights: number[] = profiles.map(() => 1),
): LiteraryProfile {
  const weight = (p: LiteraryProfile) => weights[profiles.indexOf(p)] || 1;
  const totalWeight = profiles.reduce((n, p) => n + weight(p), 0);
  if (!profiles.length) return base;
  const merged = structuredClone(base);
  for (const key of [
    "moods",
    "themes",
    "sensoryAtmosphere",
    "literaryStyle",
    "geography",
  ] as const) {
    const supported = profiles.filter((p) => p[key].confidence > 0);
    if (supported.length)
      merged[key] = {
        value: [...new Set(supported.flatMap((p) => p[key].value))].slice(0, 16),
        confidence: supported.reduce((n, p) => n + p[key].confidence * weight(p), 0) / totalWeight,
        evidence: [...new Set(supported.flatMap((p) => p[key].evidence))].slice(0, 12),
      };
  }
  for (const key of ["energy", "tension", "valence"] as const) {
    const supported = profiles.filter((p) => p[key].value !== null && p[key].confidence > 0);
    const known = supported.map((p) => p[key]);
    const measuredWeight = supported.reduce((n, p) => n + weight(p) * p[key].confidence, 0);
    if (known.length)
      merged[key] = {
        value:
          supported.reduce((n, p) => n + p[key].value! * weight(p) * p[key].confidence, 0) /
          measuredWeight,
        confidence: Math.min(...known.map((f) => f.confidence)),
        evidence: [...new Set(known.flatMap((f) => f.evidence))].slice(0, 12),
      };
  }
  for (const key of ["settingPeriod", "writtenPeriod", "publicationPeriod"] as const) {
    const supported = profiles
      .map((p) => p[key])
      .filter((f) => f.confidence > 0 && f.evidence.length);
    const first = supported[0];
    if (
      first &&
      supported.every((f) => JSON.stringify(f.value) === JSON.stringify(first.value)) &&
      first.confidence > merged[key].confidence
    )
      merged[key] = first;
  }
  // Section recommendations override the static book recommendation only when supported.
  const music = profiles.filter((p) => p.musicalAffinity.confidence > 0);
  if (music.length) {
    const strongest = [...music].sort(
      (a, b) => b.musicalAffinity.confidence * weight(b) - a.musicalAffinity.confidence * weight(a),
    )[0];
    const collect = (key: "instruments" | "textures" | "preferredPeriods") => {
      const scores = new Map<string, number>();
      for (const p of music)
        for (const tag of p.musicalAffinity.value[key])
          scores.set(tag, (scores.get(tag) || 0) + weight(p) * p.musicalAffinity.confidence);
      return [...scores]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 16)
        .map((x) => x[0]);
    };
    merged.musicalAffinity = {
      value: {
        ...strongest.musicalAffinity.value,
        instruments: collect("instruments"),
        textures: collect("textures"),
        preferredPeriods: collect("preferredPeriods"),
      },
      confidence:
        music.reduce((n, p) => n + weight(p) * p.musicalAffinity.confidence, 0) / totalWeight,
      evidence: [...new Set(music.flatMap((p) => p.musicalAffinity.evidence))].slice(0, 12),
    };
  }
  return merged;
}
export async function handleLiteraryProfiles(
  request: Request,
  env: LiteraryEnv,
  path: string,
  territory: string,
  identity: CoveIdentity | null = null,
): Promise<Response | null> {
  const matching = await handleMatchingAdministration(
    request,
    env,
    path,
    territory,
    identity,
    async (productId, spine) => {
      const resource = `/books/${encodeURIComponent(productId)}/literary-profile`;
      const target = new URL("/api/fore" + resource, request.url);
      if (spine !== null) target.searchParams.set("spine", String(spine));
      const response = await handleLiteraryProfiles(
        new Request(target),
        env,
        resource,
        territory,
        identity,
      );
      if (!response) throw new ApiError(404, "Book profile unavailable");
      const data = (await response.json()) as {
        productId: string;
        fingerprint?: string;
        status: string;
        profile: LiteraryProfile;
        readingTime: unknown;
        chapterFallback?: boolean;
      };
      if (!data.fingerprint || data.status === "pending")
        throw new ApiError(409, "Current literary profile unavailable");
      const sections = (
        await env.DB.prepare(
          "SELECT section_id,profile_json,reading_time_json FROM literary_profile_sections WHERE product_id=? AND fingerprint=? AND (? IS NULL OR spine_index=?) ORDER BY spine_index,chunk_index LIMIT 256",
        )
          .bind(data.productId, data.fingerprint, spine, spine)
          .all<{
            section_id: string;
            profile_json: string | null;
            reading_time_json: string | null;
          }>()
      ).results;
      const book = await env.DB.prepare("SELECT source_name FROM products WHERE id=?")
        .bind(data.productId)
        .first<{ source_name: string }>();
      return {
        ...data,
        fingerprint: data.fingerprint,
        chapterFallback: !!data.chapterFallback,
        sections,
        trainingEligible: !!book && book.source_name !== "upload",
      };
    },
  );
  if (matching) return matching;
  if (path.startsWith("/admin/literary-profiles")) {
    let actor: string;
    if (identity) {
      await requireStaffPermission(env.DB, identity, "storefront.manage", request);
      actor = "staff:" + identity.id;
    } else {
      const principal = await requireServiceScope(env.DB, request, "literary.profiles.manage");
      actor = "service:" + principal.principalId;
    }
    if (path === "/admin/literary-profiles/status" && request.method === "GET") {
      return json({
        policy: PROFILE_POLICY,
        limits: {
          preparesPerTick: await config(env, "prepares_per_tick", 2),
          maxPendingAnalysis: await config(env, "max_pending_analysis", 512),
          maxQueuedPrepares: await config(env, "max_queued_prepares", 2048),
          inferencePerTick: await config(env, "jobs_per_tick", 2),
          dailyUnits: await config(env, "daily_units", 2_000_000),
        },
        catalog: await env.DB.prepare(
          "SELECT COUNT(*) activeTitles FROM products WHERE storefront_status='active' AND format='ebook' AND source_name<>'upload'",
        ).first(),
        readingTime: (
          await env.DB.prepare(
            "SELECT COALESCE(json_extract(reading_time_json,'$.method'),'pending') method,COUNT(*) count FROM literary_profiles WHERE policy_version=? GROUP BY method",
          )
            .bind(PROFILE_POLICY)
            .all()
        ).results,
        chapters: await env.DB.prepare(
          "SELECT COUNT(*) total,COALESCE(SUM(s.profile_json IS NOT NULL),0) analyzed,COUNT(DISTINCT CASE WHEN s.profile_json IS NOT NULL THEN s.product_id END) booksWithChapterEvidence,COUNT(DISTINCT CASE WHEN s.profile_json IS NOT NULL THEN s.product_id||':'||s.spine_index END) spinesWithChapterEvidence FROM literary_profile_sections s JOIN literary_profiles p ON p.product_id=s.product_id AND p.fingerprint=s.fingerprint WHERE p.policy_version=?",
        )
          .bind(PROFILE_POLICY)
          .first(),
        chapterCoverage: await env.DB.prepare(
          `SELECT COALESCE(SUM(CASE WHEN analyzedSections=totalSections THEN 1 ELSE 0 END),0) fullyCoveredPreparedBooks,
            COALESCE(SUM(CASE WHEN distinctSpines>=2 AND analyzedSpines>=2 THEN 1 ELSE 0 END),0) booksWithMultiSpineEvidence
            FROM (SELECT s.product_id,COUNT(*) totalSections,
              SUM(s.profile_json IS NOT NULL) analyzedSections,
              COUNT(DISTINCT s.spine_index) distinctSpines,
              COUNT(DISTINCT CASE WHEN s.profile_json IS NOT NULL THEN s.spine_index END) analyzedSpines
            FROM literary_profile_sections s JOIN literary_profiles p ON p.product_id=s.product_id AND p.fingerprint=s.fingerprint
            WHERE p.policy_version=? GROUP BY s.product_id)`,
        )
          .bind(PROFILE_POLICY)
          .first(),
        profiles: (
          await env.DB.prepare(
            "SELECT status,COUNT(*) count FROM literary_profiles GROUP BY status",
          ).all()
        ).results,
        jobs: (
          await env.DB.prepare(
            "SELECT status,kind,COUNT(*) count FROM literary_profile_jobs GROUP BY status,kind",
          ).all()
        ).results,
        budget: await env.DB.prepare("SELECT * FROM literary_profile_budget WHERE day=?")
          .bind(at().slice(0, 10))
          .first(),
        sweep: await env.DB.prepare(
          "SELECT cursor,last_run_at FROM literary_profile_state WHERE id=1",
        ).first(),
      });
    }
    if (path === "/admin/literary-profiles/music-context" && request.method === "POST") {
      const year = z.number().int().min(-10000).max(10000).nullable();
      const input = z
        .object({
          recordingId: z.string().max(180),
          compositionStartYear: year,
          compositionEndYear: year,
          recordingStartYear: year,
          recordingEndYear: year,
          reconstruction: z.boolean().nullable(),
          evokedEras: z.array(z.string().min(1).max(80)).max(16),
          geography: z.array(z.string().min(1).max(80)).max(16),
          evidenceUrls: z
            .array(
              z
                .string()
                .url()
                .max(1000)
                .refine((v) => new URL(v).protocol === "https:"),
            )
            .min(1)
            .max(8),
          basis: z.string().min(40).max(2000),
        })
        .strict()
        .parse(await readBody(request, 12000));
      for (const [start, end] of [
        [input.compositionStartYear, input.compositionEndYear],
        [input.recordingStartYear, input.recordingEndYear],
      ])
        if (start !== null && end !== null && start > end)
          throw new ApiError(422, "Invalid music date interval");
      const exists = await env.DB.prepare(
        "SELECT id FROM soundtrack_recordings WHERE id=? UNION ALL SELECT id FROM soundtrack_external_recordings WHERE id=?",
      )
        .bind(input.recordingId, input.recordingId)
        .first();
      if (!exists) throw new ApiError(404, "Recording unavailable");
      await env.DB.prepare(
        `INSERT INTO soundtrack_context(recording_id,composition_start_year,composition_end_year,recording_start_year,recording_end_year,reconstruction,evoked_eras_json,geography_json,evidence_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(recording_id) DO UPDATE SET composition_start_year=excluded.composition_start_year,composition_end_year=excluded.composition_end_year,recording_start_year=excluded.recording_start_year,recording_end_year=excluded.recording_end_year,reconstruction=excluded.reconstruction,evoked_eras_json=excluded.evoked_eras_json,geography_json=excluded.geography_json,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`,
      )
        .bind(
          input.recordingId,
          input.compositionStartYear,
          input.compositionEndYear,
          input.recordingStartYear,
          input.recordingEndYear,
          input.reconstruction === null ? null : input.reconstruction ? 1 : 0,
          JSON.stringify(input.evokedEras),
          JSON.stringify(input.geography),
          JSON.stringify({ urls: input.evidenceUrls, basis: input.basis, actor }),
          at(),
        )
        .run();
      return json({ saved: true });
    }
    if (path === "/admin/literary-profiles/sources" && request.method === "POST") {
      const input = z
        .object({
          productId: z.string().min(1).max(180),
          id: z
            .string()
            .regex(/^[a-z][a-z0-9_-]{0,79}$/)
            .refine((id) => !["catalog", "description"].includes(id) && !/^s[0-9]+_/.test(id)),
          kind: z.enum(["description", "excerpt", "review"]),
          locator: z
            .string()
            .url()
            .max(1000)
            .refine((s) => new URL(s).protocol === "https:"),
          text: z.string().trim().min(20).max(12000),
          permissionBasis: z.string().trim().min(40).max(1000),
          active: z.boolean().default(true),
        })
        .strict()
        .parse(await readBody(request, 20000));
      const count = await env.DB.prepare(
        "SELECT COUNT(*) n FROM literary_profile_sources WHERE product_id=? AND id<>? AND active=1",
      )
        .bind(input.productId, input.id)
        .first<{ n: number }>();
      if (input.active && Number(count?.n || 0) >= 3)
        throw new ApiError(422, "At most three supplementary sources per edition");
      const owner = await env.DB.prepare(
        "SELECT product_id FROM literary_profile_sources WHERE id=?",
      )
        .bind(input.id)
        .first<{ product_id: string }>();
      if (owner && owner.product_id !== input.productId)
        throw new ApiError(409, "Source ID belongs to another edition");
      await env.DB.prepare(
        `INSERT INTO literary_profile_sources(id,product_id,kind,locator,text,content_sha256,permission_basis,supplied_by,active,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,locator=excluded.locator,text=excluded.text,content_sha256=excluded.content_sha256,permission_basis=excluded.permission_basis,supplied_by=excluded.supplied_by,active=excluded.active,updated_at=excluded.updated_at`,
      )
        .bind(
          input.id,
          input.productId,
          input.kind,
          input.locator,
          input.text,
          await hash(input.text),
          input.permissionBasis,
          actor,
          input.active ? 1 : 0,
          at(),
        )
        .run();
      const changedBook = await env.DB.prepare(inputSql + " WHERE p.id=?")
        .bind(input.productId)
        .first<BookInput>();
      if (changedBook) await enqueueBook(env, changedBook);
      return json({ saved: true, reanalysis: "queued", priorProfileWithdrawn: true });
    }
  }
  if (path === "/admin/literary-profiles/run" && request.method === "POST") {
    if (identity) await requireStaffPermission(env.DB, identity, "storefront.manage", request);
    else await requireServiceScope(env.DB, request, "literary.profiles.manage");
    await readBody(request, 1000);
    return json(await runLiteraryProfileTick(env));
  }
  const match = /^\/books\/([^/]+)\/literary-profile(?:\/(playlist|chapters))?$/.exec(path);
  if (!match || request.method !== "GET") return null;
  const product = await resolveProduct(env.DB, decodeURIComponent(match[1]), identity?.id);
  if (!product || product.storefront_status !== "active")
    throw new ApiError(404, "Book unavailable");
  if (
    product.source_name !== "upload" &&
    !(await resolveProductRights(env.DB, product.id, territory, { persist: false })).allowed
  )
    throw new ApiError(404, "This edition is unavailable in your storefront");
  const current = await env.DB.prepare("SELECT * FROM literary_profiles WHERE product_id=?")
    .bind(product.id)
    .first<CurrentProfile>();
  const edition = await env.DB.prepare(inputSql + " WHERE p.id=?")
    .bind(product.id)
    .first<BookInput>();
  const liveFingerprint = edition
    ? await hash(JSON.stringify({ policy: PROFILE_POLICY, model: PROFILE_MODEL, book: edition }))
    : null;
  const fallbackTime = estimateReadingTime({
    language: edition?.language || "und",
    wordCount: edition?.word_count,
    pageEstimate: edition?.page_estimate,
  });
  if (
    !current ||
    current.policy_version !== PROFILE_POLICY ||
    current.fingerprint !== liveFingerprint
  ) {
    const common = {
      productId: product.id,
      status: "pending",
      policy: PROFILE_POLICY,
      readingTime: fallbackTime,
    };
    if (match[2] === "playlist")
      return json({
        ...common,
        ...(await buildMatchingPlaylist(
          request,
          env,
          territory,
          {
            productId: product.id,
            fingerprint: liveFingerprint ?? "",
            status: "provisional",
            profile: emptyLiteraryProfile(),
            readingTime: fallbackTime,
            chapterFallback: false,
            sections: [],
          },
          identity,
        )),
      });
    if (match[2] === "chapters") return json({ ...common, chapters: [], nextCursor: null });
    return json({ ...common, profile: emptyLiteraryProfile() });
  }
  const url = new URL(request.url);
  const spine = url.searchParams.get("spine");
  if (spine !== null && !/^\d{1,5}$/.test(spine))
    throw new ApiError(400, "Invalid chapter spine index");
  const after = match[2] === "chapters" ? url.searchParams.get("after") || "" : "";
  if (after.length > 180) throw new ApiError(400, "Invalid cursor");
  const base = literaryProfileSchema.parse(JSON.parse(current.profile_json));
  const sections = (
    await env.DB.prepare(
      `SELECT section_id,spine_index,href,title,chunk_index,char_start,char_end,profile_json,reading_time_json FROM literary_profile_sections WHERE product_id=? AND fingerprint=? AND section_id>? AND (? IS NULL OR spine_index=?) ORDER BY spine_index,chunk_index LIMIT 257`,
    )
      .bind(product.id, current.fingerprint, after, spine, spine === null ? null : Number(spine))
      .all<{
        section_id: string;
        spine_index: number;
        href: string;
        title: string;
        chunk_index: number;
        char_start: number;
        char_end: number;
        profile_json: string | null;
        reading_time_json: string | null;
      }>()
  ).results;
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) total,SUM(profile_json IS NOT NULL) analyzed FROM literary_profile_sections WHERE product_id=? AND fingerprint=?",
  )
    .bind(product.id, current.fingerprint)
    .first<{ total: number; analyzed: number }>();
  const chapterProfiles = sections
    .filter((s) => s.profile_json)
    .map((s) => literaryProfileSchema.parse(JSON.parse(s.profile_json!)));
  const profile = mergeSections(
    base,
    chapterProfiles,
    sections.filter((s) => s.profile_json).map((s) => s.char_end - s.char_start),
  );
  let coverage: { mode?: string; truncated?: boolean; totalSections?: number } = {};
  try {
    coverage = JSON.parse(current.coverage);
  } catch {
    coverage = { mode: current.coverage };
  }
  // Partial sections must not impersonate a fully analyzed whole book.
  const selectedUnits = sections.reduce((n, s) => n + s.char_end - s.char_start, 0);
  const analyzedUnits = sections
    .filter((s) => s.profile_json)
    .reduce((n, s) => n + s.char_end - s.char_start, 0);
  const scopeCoverage = selectedUnits ? analyzedUnits / selectedUnits : 0;
  for (const key of [
    "moods",
    "themes",
    "sensoryAtmosphere",
    "literaryStyle",
    "energy",
    "tension",
    "valence",
    "musicalAffinity",
  ] as const) {
    if (!chapterProfiles.length) break;
    profile[key].confidence *= scopeCoverage;
    if (spine === null && coverage.truncated)
      profile[key].confidence = Math.min(0.45, profile[key].confidence);
    if (spine === null && base[key].confidence > profile[key].confidence)
      Object.assign(profile[key], base[key]);
  }
  const completeText =
    !!counts?.total &&
    counts.total === counts.analyzed &&
    !coverage.truncated &&
    coverage.mode === "full_text_pending";
  const common = {
    productId: product.id,
    status: counts?.total && !completeText ? "partial" : current.status,
    readingTime: current.reading_time_json ? JSON.parse(current.reading_time_json) : fallbackTime,
    revision: current.revision,
    fingerprint: current.fingerprint,
    policy: PROFILE_POLICY,
    model: PROFILE_MODEL,
    updatedAt: current.updated_at,
    coverage: {
      ...coverage,
      mode: completeText ? "full_text" : coverage.mode,
      analyzedSections: counts?.analyzed || 0,
      totalSections: counts?.total || 0,
    },
    sections: counts,
    chapterFallback: spine !== null && !chapterProfiles.length,
    evidence: [
      { id: "catalog", kind: "metadata", locator: "catalog:" + product.id },
      { id: "description", kind: "description", locator: "catalog:" + product.id + ":description" },
      ...sections.map((s) => ({
        id: s.section_id,
        kind: "full_text",
        href: s.href,
        charStart: s.char_start,
        charEnd: s.char_end,
      })),
      ...(
        await env.DB.prepare(
          "SELECT id,kind,locator,content_sha256 FROM literary_profile_sources WHERE product_id=? AND active=1",
        )
          .bind(product.id)
          .all()
      ).results,
    ],
  };
  if (match[2] === "chapters")
    return json({
      ...common,
      chapters: sections.map((s) => ({
        ...s,
        profile_json: undefined,
        reading_time_json: undefined,
        readingTime: s.reading_time_json ? JSON.parse(s.reading_time_json) : null,
        profile: s.profile_json ? JSON.parse(s.profile_json) : null,
      })),
      nextCursor: null,
    });
  if (match[2] === "playlist") {
    const context: MatchingContext = {
      productId: product.id,
      fingerprint: current.fingerprint,
      status:
        current.status === "provisional" && !chapterProfiles.length ? "provisional" : common.status,
      profile,
      readingTime: common.readingTime,
      chapterFallback: common.chapterFallback,
      sections,
    };
    const matched = await buildMatchingPlaylist(request, env, territory, context, identity);
    return json({ ...common, ...matched });
  }

  return json({ ...common, profile });
}
