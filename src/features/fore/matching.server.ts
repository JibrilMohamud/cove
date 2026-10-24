import { z } from "zod/v3";
import type { CoveEnv } from "./api.server";
import type { CoveIdentity } from "./auth.server";
import type { LiteraryProfile } from "./literary-profile";
import { ApiError, json, readBody, rateLimit } from "./service";
import { requireStaffPermission } from "./moderation.server";
import { requireServiceScope } from "./privileged-access.server";
import { loadMatchingRecordings, presentMatchingRecording } from "./matching-catalog.server";
import {
  MATCHING_POLICY,
  modes,
  matchQuerySchema,
  rankerSchema,
  scoreRecording,
  sequencePlaylist,
  readingDuration,
  sumReadingDurations,
  listeningTarget,
  canonicalJson,
  evaluateRanker,
  rankerReleaseEvidence,
  evaluationExampleSchema,
  type ArcSection,
  type MatchOptions,
  type PersonalFeedback,
} from "./matching-engine";

const recordingId = z.string().regex(/^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/);
const preferencesSchema = z
  .object({
    mode: z.enum(modes).default("atmosphere"),
    vocals: z.enum(["none", "limited", "any"]).default("none"),
    avoidRecordingIds: z.array(recordingId).max(100).default([]),
    preferredInstruments: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
    intensityCeiling: z.number().finite().min(0).max(1).default(1),
  })
  .strict();
const feedbackReason = z.enum([
  "good_fit",
  "poor_fit",
  "too_intense",
  "distracting_vocals",
  "too_repetitive",
]);
export type MatchingContext = {
  productId: string;
  fingerprint: string;
  status: string;
  profile: LiteraryProfile;
  readingTime: unknown;
  chapterFallback: boolean;
  trainingEligible?: boolean;
  sections: { section_id: string; profile_json: string | null; reading_time_json: string | null }[];
};
const hashText = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const hash = (value: unknown) => hashText(JSON.stringify(value));
type EvaluationRow = {
  id: number;
  policy: string;
  actor: string;
  product_id: string;
  book_fingerprint: string;
  spine: string;
  mode: string;
  book_family: string;
  a_json: string;
  b_json: string;
  preferred: string;
  created_at: string;
};
function presentEvaluation({ a_json, b_json, ...row }: EvaluationRow) {
  return { ...row, a: JSON.parse(a_json), b: JSON.parse(b_json) };
}
async function evaluationBatch(env: CoveEnv, after: number, through = Number.MAX_SAFE_INTEGER) {
  return (
    await env.DB.prepare(
      "SELECT id,policy,actor,product_id,book_fingerprint,spine,mode,book_family,a_json,b_json,preferred,created_at FROM matching_evaluations WHERE id>? AND id<=? AND policy=? ORDER BY id LIMIT 200",
    )
      .bind(after, through, MATCHING_POLICY)
      .all<EvaluationRow>()
  ).results;
}
async function personalSettings(env: CoveEnv, identity?: CoveIdentity | null) {
  if (!identity?.registered) return preferencesSchema.parse({});
  const row = await env.DB.prepare(
    "SELECT preferences_json FROM matching_preferences WHERE user_id=?",
  )
    .bind(identity.id)
    .first<{ preferences_json: string }>();
  if (!row) return preferencesSchema.parse({});
  const p = preferencesSchema.safeParse(JSON.parse(row.preferences_json));
  return p.success ? p.data : preferencesSchema.parse({});
}
export async function activeMatchingRanker(env: CoveEnv) {
  const row = await env.DB.prepare(
    "SELECT artifact_json FROM matching_rankers WHERE active=1",
  ).first<{ artifact_json: string }>();
  if (!row) return undefined;
  const parsed = rankerSchema.safeParse(JSON.parse(row.artifact_json));
  if (!parsed.success) {
    console.warn("matching_ranker_invalid");
    return undefined;
  }
  return parsed.data;
}
function scopedDuration(context: MatchingContext, spine: string | null) {
  const sectionTimes = context.sections.map((s) =>
    readingDuration(s.reading_time_json ? JSON.parse(s.reading_time_json) : null),
  );
  if (spine !== null && sectionTimes.length && sectionTimes.every((v) => v !== null))
    return sumReadingDurations(sectionTimes.filter((v) => v !== null));
  return readingDuration(context.readingTime);
}
function arcSections(context: MatchingContext): ArcSection[] {
  return context.sections
    .map((s) => ({
      sectionId: s.section_id,
      seconds:
        readingDuration(s.reading_time_json ? JSON.parse(s.reading_time_json) : null)
          ?.estimatedSeconds ?? 0,
      profile: s.profile_json ? (JSON.parse(s.profile_json) as LiteraryProfile) : context.profile,
    }))
    .filter((s) => s.seconds > 0);
}
export async function buildMatchingPlaylist(
  request: Request,
  env: CoveEnv,
  territory: string,
  context: MatchingContext,
  identity?: CoveIdentity | null,
) {
  const actor = identity?.id || request.headers.get("cf-connecting-ip");
  if (actor) await rateLimit(env, "matching-read:" + (await hash(actor)), 60);
  const url = new URL(request.url),
    spine =
      url.searchParams.get("spine") === null ? null : String(Number(url.searchParams.get("spine")));
  const preferences = await personalSettings(env, identity);
  const parsed = matchQuerySchema.safeParse(
    Object.fromEntries(
      [...url.searchParams].filter(([k]) =>
        ["mode", "vocals", "progress", "sessionSeconds", "maxTracks"].includes(k),
      ),
    ),
  );
  if (!parsed.success) throw new ApiError(400, "Invalid playlist options");
  const options: MatchOptions = {
    ...parsed.data,
    preferredInstruments: preferences.preferredInstruments,
    intensityCeiling: preferences.intensityCeiling,
    mode: url.searchParams.has("mode") ? parsed.data.mode : preferences.mode,
    vocals:
      parsed.data.vocals ??
      (identity?.registered ? preferences.vocals : context.profile.listening.vocals),
  };
  const effective = structuredClone(context.profile);
  effective.listening.maxEnergy = Math.min(
    effective.listening.maxEnergy,
    preferences.intensityCeiling,
  );

  const duration = scopedDuration(context, spine);
  const ranker = await activeMatchingRanker(env);
  const model = {
    id: ranker?.id ?? "transparent_baseline_v1",
    method: ranker?.method ?? "versioned_heuristic",
    calibrated: false,
  };
  const target = listeningTarget(effective, options.mode, options.intensityCeiling);
  if (!duration || context.status === "provisional" || target.evidence < 0.15)
    return {
      matchingPolicy: MATCHING_POLICY,
      model,
      matches: [],
      playlist: null,
      provisional: true,
      reason: !duration
        ? "reading_duration_unavailable"
        : context.status === "provisional"
          ? "literary_analysis_pending"
          : "insufficient_literary_evidence",
      options,
    };
  const [catalog, feedbackRows] = await Promise.all([
    loadMatchingRecordings(env, territory, effective, options.mode),
    identity?.registered
      ? env.DB.prepare(
          "SELECT recording_id,music_fingerprint,reason FROM matching_feedback WHERE user_id=? AND product_id=? AND book_fingerprint=? AND spine=? AND mode=? ORDER BY recording_id",
        )
          .bind(identity.id, context.productId, context.fingerprint, spine ?? "", options.mode)
          .all<{ recording_id: string; music_fingerprint: string; reason: PersonalFeedback }>()
      : Promise.resolve({ results: [] }),
  ]);
  const feedback = new Map(feedbackRows.results.map((v) => [v.recording_id, v]));
  const excluded: Record<string, number> = {};
  const rankingDuration = {
    ...duration,
    estimatedSeconds: Math.min(
      7200,
      duration.estimatedSeconds * (1 - options.progress),
      options.sessionSeconds ?? Infinity,
    ),
  };
  const scored = catalog.recordings
    .flatMap((r) => {
      if (preferences.avoidRecordingIds.includes(r.id)) {
        excluded.reader_avoidance = (excluded.reader_avoidance ?? 0) + 1;
        return [];
      }
      const f = feedback.get(r.id);
      const result = scoreRecording(
        effective,
        r,
        options,
        rankingDuration,
        f?.music_fingerprint === r.fingerprint ? f.reason : undefined,
        ranker,
      );
      if (result.excluded !== undefined) {
        excluded[result.excluded] = (excluded[result.excluded] ?? 0) + 1;
        return [];
      }
      return [result];
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const playlist = sequencePlaylist(
    scored,
    effective,
    options,
    duration,
    arcSections(context),
    ranker,
  );
  const snapshot = await hash({
    policy: MATCHING_POLICY,
    book: context.fingerprint,
    literaryAnalysis: effective,
    readingDuration: duration,
    sections: context.sections.map((s) => [s.section_id, s.profile_json, s.reading_time_json]),
    scope: spine,
    model,
    options,
    preferences,
    feedback: feedbackRows.results,
    recordings: catalog.recordings.map((r) => [r.id, r.fingerprint, r.audio]),
  });
  return {
    target: target.description,
    matchingPolicy: MATCHING_POLICY,
    inputFingerprint: snapshot,
    model,
    options,
    scope: {
      requested: spine === null ? "book" : "chapter",
      spine: spine === null ? null : Number(spine),
      duration: spine !== null && duration.method === "section_sum" ? "chapter" : "book",
      effective: context.chapterFallback ? "book_fallback" : spine === null ? "book" : "chapter",
    },
    readingTime: duration,
    retrieval: catalog.retrieval,
    excluded,
    matches: scored.slice(0, 30).map(({ recording, ...score }) => ({
      ...score,
      recording: presentMatchingRecording(recording),
    })),
    playlist: {
      ...playlist,
      tracks: playlist.tracks.map((t) => ({
        ...t,
        recording: presentMatchingRecording(t.recording),
      })),
    },
    provisional: false,
    limitations: [
      "Compatibility scores and evidence confidence are not calibrated probabilities.",
      "Semantic audio analysis is sampled and may miss voices or changes in mood.",
      "Reading time and narrative alignment are estimates; music plays at natural recording boundaries.",
      ranker
        ? "The active ranker passed recorded family holdouts; live reading outcomes remain unevaluated."
        : "The default ranker has not been trained or accuracy-certified by human evaluations.",
    ],
  };
}
type ContextResolver = (productId: string, spine: number | null) => Promise<MatchingContext>;
const contextInput = z.object({
  productId: z.string().min(1).max(150),
  spine: z.number().int().min(0).max(99999).nullable().default(null),
  mode: z.enum(modes).default("atmosphere"),
});
async function staff(request: Request, env: CoveEnv, identity?: CoveIdentity | null) {
  if (identity) {
    await requireStaffPermission(env.DB, identity, "storefront.manage", request);
    return "staff:" + identity.id;
  }
  const p = await requireServiceScope(env.DB, request, "literary.profiles.manage");
  return "service:" + p.principalId;
}
function registered(identity?: CoveIdentity | null) {
  if (!identity?.registered) throw new ApiError(401, "Sign in to personalize matching");
  return identity.id;
}
export async function handleMatchingAdministration(
  request: Request,
  env: CoveEnv,
  path: string,
  territory: string,
  identity: CoveIdentity | null | undefined,
  resolve: ContextResolver,
) {
  if (
    ![
      "/matching/preferences",
      "/matching/feedback",
      "/admin/matching/evaluations",
      "/admin/matching/models",
    ].includes(path)
  )
    return null;
  if (path === "/matching/preferences") {
    const user = registered(identity);
    if (request.method === "GET")
      return json({ preferences: await personalSettings(env, identity) });
    if (request.method === "PUT") {
      await rateLimit(env, "matching-preferences:" + user, 20);
      const parsed = preferencesSchema.safeParse(await readBody(request, 12000));
      if (!parsed.success) throw new ApiError(400, "Invalid listening preferences");
      await env.DB.prepare(
        "INSERT INTO matching_preferences(user_id,preferences_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET preferences_json=excluded.preferences_json,updated_at=excluded.updated_at",
      )
        .bind(user, JSON.stringify(parsed.data), new Date().toISOString())
        .run();
      return json({ saved: true });
    }
  }
  if (path === "/matching/feedback") {
    const user = registered(identity);
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM matching_feedback WHERE user_id=?").bind(user).run();
      return json({ deleted: true });
    }
    if (request.method === "POST") {
      await rateLimit(env, "matching-feedback:" + user, 30);
      const parsed = contextInput
        .extend({ recordingId, reason: feedbackReason })
        .strict()
        .safeParse(await readBody(request, 2000));
      if (!parsed.success) throw new ApiError(400, "Invalid matching feedback");
      const input = parsed.data,
        context = await resolve(input.productId, input.spine);
      const catalog = await loadMatchingRecordings(env, territory, context.profile, input.mode, [
        input.recordingId,
      ]);
      const recording = catalog.recordings[0];
      if (!recording) throw new ApiError(404, "Current audio profile unavailable");
      await env.DB.prepare(
        "INSERT INTO matching_feedback(user_id,product_id,book_fingerprint,spine,mode,recording_id,music_fingerprint,reason,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,product_id,book_fingerprint,spine,mode,recording_id) DO UPDATE SET music_fingerprint=excluded.music_fingerprint,reason=excluded.reason,updated_at=excluded.updated_at",
      )
        .bind(
          user,
          context.productId,
          context.fingerprint,
          input.spine === null ? "" : String(input.spine),
          input.mode,
          recording.id,
          recording.fingerprint,
          input.reason,
          new Date().toISOString(),
        )
        .run();
      return json({ saved: true, trainingUse: "personalization_only" });
    }
  }
  if (path.startsWith("/admin/matching/")) {
    const actor = await staff(request, env, identity);
    if (path.endsWith("/models")) {
      if (request.method === "GET")
        return json({ policy: MATCHING_POLICY, active: (await activeMatchingRanker(env)) ?? null });
      if (request.method === "POST") {
        await rateLimit(env, "matching-model:" + actor, 5);
        const parsed = z
          .object({ artifact: rankerSchema, activate: z.boolean().default(false) })
          .strict()
          .safeParse(await readBody(request, 12000));
        if (!parsed.success) throw new ApiError(400, "Invalid or insufficiently evaluated ranker");
        if (
          await env.DB.prepare("SELECT id FROM matching_rankers WHERE id=?")
            .bind(parsed.data.artifact.id)
            .first()
        )
          throw new ApiError(409, "Ranker ID already exists");
        const artifact = parsed.data.artifact;
        const examples = [];
        let cursor = 0;
        for (;;) {
          const rows = await evaluationBatch(env, cursor, artifact.evaluation.throughId);
          examples.push(...rows.map(presentEvaluation));
          if (examples.length > 10000)
            throw new ApiError(409, "Evaluation export exceeds this release's bound");
          if (rows.length < 200) break;
          cursor = rows.at(-1)!.id;
        }
        if (
          examples.length !== artifact.evaluation.exportCount ||
          (await hashText(canonicalJson(examples))) !== artifact.datasetSha256
        )
          throw new ApiError(
            409,
            "Ranker dataset does not match authoritative editorial judgments",
          );
        const actual = evaluateRanker(
          examples.map((row) => evaluationExampleSchema.parse(row)),
          artifact.weights,
        );
        const claimed = artifact.evaluation;
        if (
          actual.trainPairs !== claimed.trainPairs ||
          ["bookHoldout", "musicHoldout"].some((name) => {
            const key = name as "bookHoldout" | "musicHoldout";
            return (
              actual[key].pairs !== claimed[key].pairs ||
              Math.abs(actual[key].accuracy - claimed[key].accuracy) > 1e-8 ||
              Math.abs(actual[key].baselineAccuracy - claimed[key].baselineAccuracy) > 1e-8
            );
          })
        )
          throw new ApiError(409, "Ranker holdout results do not reproduce");
        // Family accuracy alone does not prove independent listening review.
        // Enforce real authenticated staff diversity on the authoritative
        // dataset before allowing the model to replace the baseline.
        if (parsed.data.activate) {
          const evidence = rankerReleaseEvidence(
            examples.map((row) => evaluationExampleSchema.parse(row)),
            artifact.weights,
          );
          if (!evidence.deployable)
            throw new ApiError(
              409,
              "Independent human review or family holdout coverage is insufficient",
            );
        }
        const statements = [];
        if (parsed.data.activate)
          statements.push(env.DB.prepare("UPDATE matching_rankers SET active=0 WHERE active=1"));
        statements.push(
          env.DB.prepare(
            "INSERT INTO matching_rankers(id,artifact_json,active,approved_by,created_at) VALUES(?,?,?,?,?)",
          ).bind(
            parsed.data.artifact.id,
            JSON.stringify(parsed.data.artifact),
            parsed.data.activate ? 1 : 0,
            actor,
            new Date().toISOString(),
          ),
        );
        await env.DB.batch(statements);
        return json({ saved: true, active: parsed.data.activate });
      }
      if (request.method === "DELETE") {
        await env.DB.prepare("UPDATE matching_rankers SET active=0 WHERE active=1").run();
        return json({ active: "transparent_baseline_v1" });
      }
    }
    if (path.endsWith("/evaluations")) {
      if (request.method === "GET") {
        const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0)
          throw new ApiError(400, "Invalid evaluation cursor");
        const rows = await evaluationBatch(env, after);
        return json({
          source: "independent_human_judgments",
          evaluations: rows.map(presentEvaluation),
          nextCursor: rows.length === 200 ? rows.at(-1)!.id : null,
        });
      }
      if (request.method === "POST") {
        await rateLimit(env, "matching-evaluation:" + actor, 60);
        const family = z.string().trim().min(1).max(120);
        const parsed = contextInput
          .extend({
            a: recordingId,
            b: recordingId,
            preferred: z.enum(["a", "b", "tie"]),
            bookFamily: family,
            workFamilyA: family,
            workFamilyB: family,
            assessorKind: z.literal("human"),
            judgmentId: z.string().uuid(),
          })
          .strict()
          .safeParse(await readBody(request, 4000));
        if (!parsed.success || parsed.data.a === parsed.data.b)
          throw new ApiError(400, "Invalid independent listening judgment");
        const input = parsed.data;
        const requestHash = await hash({ actor, input });
        const previous = await env.DB.prepare(
          "SELECT request_sha256 FROM matching_evaluations WHERE judgment_key=?",
        )
          .bind(input.judgmentId)
          .first<{ request_sha256: string }>();
        if (previous) {
          if (previous.request_sha256 !== requestHash)
            throw new ApiError(409, "Judgment ID already describes a different evaluation");
          return json({ saved: true, deduplicated: true, automaticallyActivated: false });
        }
        const context = await resolve(input.productId, input.spine);
        if (context.trainingEligible !== true)
          throw new ApiError(403, "Private imports cannot enter editorial training datasets");
        const duration = scopedDuration(context, input.spine === null ? null : String(input.spine));
        if (!duration || context.status === "provisional")
          throw new ApiError(409, "Literary analysis is not ready");
        const catalog = await loadMatchingRecordings(env, territory, context.profile, input.mode, [
          input.a,
          input.b,
        ]);
        const snapshot = (id: string, workFamily: string) => {
          const r = catalog.recordings.find((r) => r.id === id);
          if (!r) throw new ApiError(404, "Current recording profile unavailable");
          const result = scoreRecording(
            context.profile,
            r,
            {
              mode: input.mode,
              vocals: context.profile.listening.vocals,
              progress: 0,
              maxTracks: 24,
            },
            duration,
          );
          if (result.excluded !== undefined)
            throw new ApiError(409, "Evaluate eligible recording pairs only");
          return {
            recordingId: r.id,
            fingerprint: r.fingerprint,
            sourceSha1: r.audio.sourceSha1,
            workFamily,
            features: result.features,
            baselineScore: result.baselineScore,
          };
        };
        const a = snapshot(input.a, input.workFamilyA),
          b = snapshot(input.b, input.workFamilyB);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO matching_evaluations(policy,actor,product_id,book_fingerprint,spine,mode,book_family,a_json,b_json,preferred,created_at,judgment_key,request_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            MATCHING_POLICY,
            actor,
            context.productId,
            context.fingerprint,
            input.spine === null ? "" : String(input.spine),
            input.mode,
            input.bookFamily,
            JSON.stringify(a),
            JSON.stringify(b),
            input.preferred,
            new Date().toISOString(),
            input.judgmentId,
            requestHash,
          )
          .run();
        const committed = await env.DB.prepare(
          "SELECT request_sha256 FROM matching_evaluations WHERE judgment_key=?",
        )
          .bind(input.judgmentId)
          .first<{ request_sha256: string }>();
        if (committed?.request_sha256 !== requestHash)
          throw new ApiError(409, "Judgment ID already describes a different evaluation");
        return json({
          saved: true,
          trainingUse: "editorial_pairwise_evaluation",
          automaticallyActivated: false,
        });
      }
    }
  }
  throw new ApiError(405, "Matching operation unavailable");
}
