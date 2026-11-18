import {
  SEO_COUNT_GENERATION_KEYS,
  SEO_COUNT_KINDS,
  SEO_COUNT_MAX_AGE_MS,
  SEO_COUNT_PROJECTION_SCHEMA,
  verifiedSeoCounts,
  type SeoCountKind,
  type SeoCounts,
} from "./seo-count-projection";

/**
 * Non-shipping, owner-only *contract*. The protected owner adapter MUST
 * guarantee that compareAndPublish atomically compares all generation keys,
 * checks the current dirty/pending flags, and writes the snapshot in the SAME
 * primary D1 transaction. It must reject a displaced/out-of-order publisher.
 *
 * This source has no D1, HTTP, token, R2, cron or deployment imports; it is
 * not called by any production code until exclusive owner audit is complete.
 */
export type SeoCountBuildPort = {
  readPrimaryFence: () => Promise<unknown>;
  countAuthoritative: (kind: SeoCountKind) => Promise<number>;
  compareAndPublish: (expectedFence: unknown, snapshot: unknown) => Promise<boolean>;
  nowMs?: () => number;
};

export type SeoCountBuildResult = {
  published: boolean;
  reason:
    | "published"
    | "unsafe-start"
    | "invalid-count"
    | "changed-during-count"
    | "publish-lost-race"
    | "unavailable";
};

function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}

function createSnapshot(fence: Record<string, unknown>, counts: SeoCounts, now: number) {
  return {
    schema: SEO_COUNT_PROJECTION_SCHEMA,
    ...Object.fromEntries(SEO_COUNT_GENERATION_KEYS.map((key) => [key, fence[key]])),
    createdAtMs: now,
    expiresAtMs: now + SEO_COUNT_MAX_AGE_MS,
    counts,
  };
}

function validTime(ms: number): boolean {
  return Number.isSafeInteger(ms) && ms >= 0 && ms < Number.MAX_SAFE_INTEGER - SEO_COUNT_MAX_AGE_MS;
}

/**
 * Serialize the expensive aggregations off the customer path. Never publish
 * if any catalog, legal, withdrawal, taxonomy or contributor write occurred
 * between the first/second primary-fence reads. Atomic CAS remains essential:
 * a mutation may race AFTER the second read and BEFORE publication.
 */
export async function buildSeoCountProjection(
  port: SeoCountBuildPort,
): Promise<SeoCountBuildResult> {
  const nowMs = port.nowMs || Date.now;
  try {
    const begin = await port.readPrimaryFence();
    const beginAt = nowMs();
    if (!record(begin) || !validTime(beginAt)) {
      return { published: false, reason: "unsafe-start" };
    }
    const empty = Object.fromEntries(SEO_COUNT_KINDS.map((kind) => [kind, 0])) as SeoCounts;
    if (
      !verifiedSeoCounts({ snapshot: createSnapshot(begin, empty, beginAt), fence: begin }, beginAt)
    ) {
      return { published: false, reason: "unsafe-start" };
    }

    const counts = {} as SeoCounts;
    for (const kind of SEO_COUNT_KINDS) {
      const value = await port.countAuthoritative(kind);
      if (!Number.isSafeInteger(value) || value < 0) {
        return { published: false, reason: "invalid-count" };
      }
      counts[kind] = value;
    }

    const after = await port.readPrimaryFence();
    const completedAt = nowMs();
    if (!record(after) || !validTime(completedAt) || completedAt < beginAt) {
      return { published: false, reason: "changed-during-count" };
    }
    const snapshot = createSnapshot(begin, counts, completedAt);
    if (!verifiedSeoCounts({ snapshot, fence: after }, completedAt)) {
      return { published: false, reason: "changed-during-count" };
    }

    // The authority adapter must CAS the immutable generation and dirty flags
    // in one primary-D1 transaction. A later writer must never be overwritten
    // by an older producer, even if both saw the same generation.
    if (!(await port.compareAndPublish(begin, snapshot))) {
      return { published: false, reason: "publish-lost-race" };
    }
    return { published: true, reason: "published" };
  } catch {
    // Never leak SQL, underlying account info or token material to logs.
    return { published: false, reason: "unavailable" };
  }
}
