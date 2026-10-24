import { z } from "zod/v3";
import type { CoveEnv } from "./api.server";
import { ApiError, now } from "./service";

const COMPONENTS = ["storefront", "downloads", "catalog_ingestion", "biosync"] as const;
type Component = (typeof COMPONENTS)[number];
type Health = "operational" | "limited" | "unavailable" | "unknown";
type Snapshot = {
  checkedAt: string;
  components: Array<{ id: Component; label: string; status: Health; detail: string }>;
};
type Notice = {
  id: string;
  title: string;
  body: string;
  status: string;
  severity: string;
  components_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};
const projectNotice = (row: Notice) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  status: row.status,
  severity: row.severity,
  components: JSON.parse(row.components_json),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Compute bounded public evidence on the scheduled worker, not per visitor.
 * Never publish raw exception details, account records, credential state, or
 * an internal operational incident that has not been explicitly authored here.
 */
export async function refreshPublicStatus(env: CoveEnv) {
  const at = now();
  const [market, catalog, sample, audio, assets] = await Promise.all([
    env.DB.prepare(
      "SELECT 1 ready FROM storefront_markets WHERE market_status='active' LIMIT 1",
    ).first(),
    env.DB.prepare("SELECT last_success_at,status FROM catalog_state WHERE id=1").first<{
      last_success_at: string | null;
      status: string;
    }>(),
    env.DB.prepare(
      "SELECT id FROM gutenberg_source_cache WHERE epub_status='completed' LIMIT 1",
    ).first<{ id: string }>(),
    env.DB.prepare(
      `WITH tracks AS (
        SELECT e.id edition_id,json_extract(t.value,'$.id') track_id,
          CASE WHEN m.audio_present=1 AND CAST(json_extract(t.value,'$.duration') AS REAL)>0 THEN 1 ELSE 0 END prepared,
          CASE WHEN a.map_sha256 IS NOT NULL AND m.audio_present=1 AND m.timing_present=1 AND m.timing_sha256=a.map_sha256 AND m.epub_sha256=e.epub_sha256 THEN 1 ELSE 0 END checked
        FROM audio_editions e,json_each(e.tracks_json) t
        LEFT JOIN audio_timing a ON a.edition_id=e.id AND a.track_id=json_extract(t.value,'$.id')
          AND a.audio_sha256=json_extract(t.value,'$.sha256') AND a.epub_sha256=e.epub_sha256
        LEFT JOIN audio_media_checks m ON m.edition_id=e.id AND m.track_id=json_extract(t.value,'$.id')
          AND m.audio_sha256=json_extract(t.value,'$.sha256') AND m.checked_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
      ), editions AS (SELECT edition_id,count(*) total,sum(prepared) prepared,sum(checked) checked FROM tracks GROUP BY edition_id)
      SELECT COALESCE(sum(total),0) tracks,COALESCE(sum(prepared),0) prepared,COALESCE(sum(checked),0) maps,
        count(*) editions,COALESCE(sum(CASE WHEN total=prepared THEN 1 ELSE 0 END),0) complete_recordings,
        COALESCE(sum(CASE WHEN total=checked THEN 1 ELSE 0 END),0) fully_timed FROM editions`,
    ).first<{
      maps: number;
      tracks: number;
      prepared: number;
      editions: number;
      complete_recordings: number;
      fully_timed: number;
    }>(),
    env.DB.prepare(
      "SELECT epub_status,count(*) count FROM gutenberg_source_cache GROUP BY epub_status",
    ).all<{ epub_status: string; count: number }>(),
  ]);
  let storage: Health = "unknown";
  if (sample && env.BUCKET?.head) {
    try {
      storage = (await env.BUCKET.head(`epubs/${sample.id}.epub`)) ? "operational" : "limited";
    } catch {
      storage = "unavailable";
    }
  }
  const catalogFresh =
    catalog?.last_success_at && Date.now() - Date.parse(catalog.last_success_at) < 6 * 3600000;
  const snapshot: Snapshot = {
    checkedAt: at,
    components: [
      {
        id: "storefront",
        label: "Bookstore backend",
        status: market ? "operational" : "unavailable",
        detail: market
          ? "The catalog database and storefront configuration responded."
          : "The storefront is not ready to serve catalog requests.",
      },
      {
        id: "downloads",
        label: "Stored ebook downloads",
        status:
          storage === "operational" &&
          assets.results.some(
            (r) =>
              ["pending", "retry", "failed", "downloading"].includes(r.epub_status) && r.count > 0,
          )
            ? "limited"
            : storage,
        detail:
          storage === "operational"
            ? `${assets.results.find((r) => r.epub_status === "completed")?.count || 0} EPUBs have stored records; ${assets.results.filter((r) => ["pending", "retry", "downloading"].includes(r.epub_status)).reduce((n, r) => n + r.count, 0)} await storage. A sample storage lookup passed; this is not a full-file integrity audit.`
            : "Stored-media availability could not be confirmed.",
      },
      {
        id: "catalog_ingestion",
        label: "Catalog updates",
        status: catalogFresh ? "operational" : "limited",
        detail: catalogFresh
          ? "The background catalog job has made recent progress."
          : "Background updates are delayed. Existing indexed titles may still be available.",
      },
      {
        id: "biosync",
        label: "BioSync timing coverage",
        status: "limited",
        detail: `${audio?.prepared || 0}/${audio?.tracks || 0} tracks passed recent storage checks; ${audio?.complete_recordings || 0}/${audio?.editions || 0} recordings have all tracks prepared. ${audio?.maps || 0} tracks have timing pinned to the current files; ${audio?.fully_timed || 0} recordings have all tracks timed. Whole-book text coverage has not been verified. Playback does not require timing.`,
      },
    ],
  };
  await env.DB.prepare(
    "INSERT INTO cove_runtime_config(key,value,updated_at) VALUES('public_service_status',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  )
    .bind(JSON.stringify(snapshot), at)
    .run();
  return snapshot;
}

export async function publicServiceStatus(env: CoveEnv) {
  const [row, noticeRows] = await Promise.all([
    env.DB.prepare(
      "SELECT value FROM cove_runtime_config WHERE key='public_service_status'",
    ).first<{ value: string }>(),
    env.DB.prepare(
      "SELECT id,title,body,status,severity,components_json,version,created_at,updated_at FROM public_service_notices ORDER BY CASE WHEN status='resolved' THEN 1 ELSE 0 END,updated_at DESC LIMIT 25",
    ).all<Notice>(),
  ]);
  let snapshot: Snapshot | null = null;
  try {
    snapshot = row ? JSON.parse(row.value) : null;
  } catch {
    /* Unknown is safer than a green fallback. */
  }
  const stale =
    !snapshot?.checkedAt ||
    !Number.isFinite(Date.parse(snapshot.checkedAt)) ||
    Date.now() - Date.parse(snapshot.checkedAt) > 15 * 60000;
  const notices = noticeRows.results.map(projectNotice);
  const components = COMPONENTS.map((id) => {
    const evidence = snapshot?.components?.find((item) => item.id === id);
    const affecting = notices.filter(
      (item) => item.status !== "resolved" && item.components.includes(id),
    );
    const status: Health = affecting.some((item) => item.severity === "outage")
      ? "unavailable"
      : affecting.length
        ? "limited"
        : stale
          ? "unknown"
          : evidence?.status || "unknown";
    return {
      id,
      label:
        evidence?.label ||
        {
          storefront: "Bookstore backend",
          downloads: "Stored ebook downloads",
          catalog_ingestion: "Catalog updates",
          biosync: "BioSync timing coverage",
        }[id],
      status,
      detail: affecting.length
        ? "See the published service update below."
        : stale
          ? "A recent background health check is not available."
          : evidence?.detail || "No health evidence is available.",
    };
  });
  return {
    at: now(),
    checkedAt: snapshot?.checkedAt || null,
    stale,
    components,
    notices,
    overall: components.some((item) => item.status === "unavailable")
      ? "unavailable"
      : components.some((item) => item.status === "unknown")
        ? "unknown"
        : components.some((item) => item.status === "limited")
          ? "limited"
          : "operational",
  };
}

export async function publishServiceNotice(env: CoveEnv, staffId: string, raw: unknown) {
  const x = z
    .object({
      id: z.string().uuid(),
      expectedVersion: z.number().int().positive().optional(),
      title: z.string().trim().min(3).max(180),
      body: z.string().trim().min(1).max(3000),
      status: z.enum(["investigating", "identified", "monitoring", "resolved"]),
      severity: z.enum(["degraded", "outage"]),
      components: z.array(z.enum(COMPONENTS)).min(1).max(4),
      publish: z.literal(true),
    })
    .strict()
    .parse(raw);
  const id = x.id,
    at = now(),
    components = JSON.stringify([...new Set(x.components)]);
  const fingerprint = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({
            title: x.title,
            body: x.body,
            status: x.status,
            severity: x.severity,
            components,
            staffId,
          }),
        ),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const old = x.id
    ? await env.DB.prepare("SELECT version FROM public_service_notices WHERE id=?")
        .bind(id)
        .first<{ version: number }>()
    : null;
  if (old && x.expectedVersion === undefined) {
    const previous = await env.DB.prepare(
      "SELECT creation_sha256 FROM public_service_notices WHERE id=?",
    )
      .bind(id)
      .first<{ creation_sha256: string }>();
    if (previous?.creation_sha256 === fingerprint) return { id, version: old.version };
    throw new ApiError(
      409,
      "This notice was already published. Refresh and edit the existing update.",
    );
  }
  if (x.expectedVersion !== undefined && (!old || old.version !== x.expectedVersion))
    throw new ApiError(409, "This service update changed. Refresh before publishing.");
  const version = (old?.version || 0) + 1;
  const history = env.DB.prepare(
    "INSERT INTO public_service_notice_history(id,notice_id,version,title,body,status,severity,components_json,published_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    crypto.randomUUID(),
    id,
    version,
    x.title,
    x.body,
    x.status,
    x.severity,
    components,
    staffId,
    at,
  );
  try {
    if (old)
      await env.DB.batch([
        history,
        env.DB.prepare(
          "UPDATE public_service_notices SET title=?,body=?,status=?,severity=?,components_json=?,published_by=?,version=?,updated_at=? WHERE id=? AND version=?",
        ).bind(
          x.title,
          x.body,
          x.status,
          x.severity,
          components,
          staffId,
          version,
          at,
          id,
          old.version,
        ),
      ]);
    else
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO public_service_notices(id,title,body,status,severity,components_json,published_by,created_at,updated_at,creation_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).bind(id, x.title, x.body, x.status, x.severity, components, staffId, at, at, fingerprint),
        history,
      ]);
  } catch (error) {
    if (x.expectedVersion === undefined) {
      const winner = await env.DB.prepare(
        "SELECT creation_sha256,version FROM public_service_notices WHERE id=?",
      )
        .bind(id)
        .first<{ creation_sha256: string; version: number }>();
      if (winner?.creation_sha256 === fingerprint) return { id, version: winner.version };
    }
    if (String(error).includes("public notice") || String(error).includes("UNIQUE constraint"))
      throw new ApiError(409, "This service update changed. Refresh before publishing.");
    throw error;
  }
  return { id, version };
}
