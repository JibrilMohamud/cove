import { mirrorUrl } from "./gutenberg-source";
import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { ApiError, json, now, readBody, requireIdentity, rateLimit } from "./service";
import { requireServiceScope } from "./privileged-access.server";
import type { AudioEdition, AudioTrack } from "./domain";
import { listCommercialAudiobooks } from "./commercial-audio.server";
import { resolveProduct } from "./catalog-model.server";
import { recordReadingProgress } from "./social.server";
import audioSeed from "./audio-seed.json";
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const sourceSchema = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      u.protocol === "https:" &&
      ["www.gutenberg.org", "gutenberg.org"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.port
    );
  }, "Only Project Gutenberg sources are accepted.");
const trackSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(300),
  url: sourceSchema,
  duration: z.number().positive().max(86400).optional(),
  bytes: z.number().int().positive().max(1073741824).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  mime: z.enum(["audio/mpeg", "audio/mp4", "audio/ogg"]),
});
const cueSchema = z.object({
  trackId: idSchema,
  start: z.number().min(0),
  end: z.number().positive(),
  href: z
    .string()
    .min(1)
    .max(2000)
    .refine((s) => !s.includes("..") && !/^\w+:|^\/\//.test(s)),
  cfi: z
    .string()
    .max(3000)
    .regex(/^epubcfi\(.+\)$/),
  endCfi: z
    .string()
    .max(3000)
    .regex(/^epubcfi\(.+\)$/),
  progress: z.number().min(0).max(1),
  endProgress: z.number().min(0).max(1),
  label: z.string().max(300),
});
export const audioSchema = z
  .object({
    id: idSchema,
    gutenbergId: z.string().regex(/^[1-9][0-9]{0,8}$/),
    bookId: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .nullable(),
    title: z.string().min(1).max(500),
    authors: z.array(z.object({ name: z.string().min(1).max(300) })).max(30),
    language: z.string().min(2).max(10),
    narration: z.enum(["human", "computer", "unknown"]),
    narrator: z.string().max(500).default(""),
    sourceUrl: sourceSchema,
    rights: z.literal("Public domain in the USA."),
    tracks: z.array(trackSchema).min(1).max(500),
    alignment: z
      .object({
        version: z.literal(1),
        precision: z.enum(["chapter", "sentence"]),
        verified: z.literal(true),
        cues: z.array(cueSchema).min(1).max(25000),
      })
      .nullable()
      .default(null),
    epubSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
  })
  .superRefine((e, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (new Set(e.tracks.map((t) => t.id)).size !== e.tracks.length) issue("Duplicate tracks.");
    if (!new URL(e.sourceUrl).pathname.endsWith("/" + e.gutenbergId))
      issue("Source edition does not match.");
    for (const t of e.tracks)
      if (!new URL(t.url).pathname.split("/").includes(e.gutenbergId))
        issue("Track source must belong to this Gutenberg edition.");
    if (e.alignment) {
      if (!e.bookId || !e.epubSha256)
        issue("Alignment requires a linked text edition and its SHA-256.");
      let previous = -1;
      const ends = new Map<string, number>();
      for (const c of e.alignment.cues) {
        const t = e.tracks.find((t) => t.id === c.trackId);
        if (!t || !t.sha256 || !t.duration) issue("Aligned tracks need checksum and duration.");
        if (
          c.end <= c.start ||
          c.end > (t?.duration || 0) ||
          !(c.progress < c.endProgress) ||
          c.progress < previous ||
          c.start < (ends.get(c.trackId) || 0)
        )
          issue("Cue ranges must be ordered, positive, and non-overlapping.");
        previous = c.endProgress;
        ends.set(c.trackId, c.end);
      }
    }
  });
export function rowEdition(r: any): AudioEdition {
  return {
    id: r.id,
    gutenbergId: r.gutenberg_id,
    bookId: r.book_id,
    title: r.title,
    authors: JSON.parse(r.authors_json),
    language: r.language,
    narration: r.narration,
    narrator: r.narrator,
    sourceUrl: r.source_url,
    rights: r.rights,
    tracks: JSON.parse(r.tracks_json),
    alignment: r.alignment_json ? JSON.parse(r.alignment_json) : null,
    epubSha256: r.epub_sha256,
  };
}
export function insertEdition(env: CoveEnv, e: AudioEdition, seed = false) {
  return env.DB.prepare(
    `INSERT ${seed ? "OR IGNORE " : ""}INTO audio_editions(id,gutenberg_id,book_id,title,authors_json,language,narration,narrator,source_url,rights,tracks_json,alignment_json,epub_sha256,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ${seed ? "" : "ON CONFLICT(id) DO UPDATE SET gutenberg_id=excluded.gutenberg_id,book_id=excluded.book_id,title=excluded.title,authors_json=excluded.authors_json,language=excluded.language,narration=excluded.narration,narrator=excluded.narrator,source_url=excluded.source_url,rights=excluded.rights,tracks_json=excluded.tracks_json,alignment_json=excluded.alignment_json,epub_sha256=excluded.epub_sha256,updated_at=excluded.updated_at"}`,
  ).bind(
    e.id,
    e.gutenbergId,
    e.bookId,
    e.title,
    JSON.stringify(e.authors),
    e.language,
    e.narration,
    e.narrator,
    e.sourceUrl,
    e.rights,
    JSON.stringify(e.tracks),
    e.alignment ? JSON.stringify(e.alignment) : null,
    e.epubSha256,
    now(),
  );
}
async function hydrateEdition(env:CoveEnv,e:AudioEdition){
  const rows=await env.DB.prepare('SELECT * FROM audio_timing WHERE edition_id=? AND epub_sha256=?').bind(e.id,e.epubSha256||'').all<any>();
  const maps=rows.results.filter(r=>e.tracks.some(t=>t.id===r.track_id&&t.sha256===r.audio_sha256)).map(r=>JSON.parse(r.summary_json));
  maps.sort((a,b)=>e.tracks.findIndex(t=>t.id===a.trackId)-e.tracks.findIndex(t=>t.id===b.trackId));
  if(maps.length)e.alignment={version:2,precision:'word',verified:true,cues:[],maps};return e;
}
async function seedAudio(env: CoveEnv) {
  const missing = await env.DB.prepare("SELECT id FROM audio_editions LIMIT 1").first();
  if (!missing && audioSeed.length)
    await env.DB.batch((audioSeed as AudioEdition[]).map((e) => insertEdition(env, e, true)));
}
export async function getEdition(env: CoveEnv, id: string) {
  idSchema.parse(id);
  await seedAudio(env);
  const row = await env.DB.prepare("SELECT * FROM audio_editions WHERE id=?").bind(id).first<any>();
  if (!row || row.rights!=="Public domain in the USA.") throw new ApiError(404,"This audiobook is unavailable.");
  return hydrateEdition(env,rowEdition(row));
}
export function objectKey(e: AudioEdition, t: AudioTrack) {
  return `audio/${e.id}/${t.id}-${t.sha256 || encodeURIComponent(t.url)}`;
}
export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size <= 0) throw new ApiError(416, "Invalid byte range.");
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new ApiError(416, "This byte range is unavailable.");
  return { offset: start, length: end - start + 1 };
}
async function cacheTrack(env: CoveEnv, e: AudioEdition, t: AudioTrack) {
  if (!env.BUCKET) throw new ApiError(503, "Audio storage is unavailable.");
  const key = objectKey(e, t);
  let meta = await env.BUCKET.head?.(key);
  if (meta) return { key, size: meta.size };
  // Fetch original media through a listed Gutenberg mirror, then serve from R2.
  const upstream = mirrorUrl(t.url, env.GUTENBERG_MIRROR_BASE_URL);
  const response = await fetch(upstream, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body)
    throw new ApiError(502, "The audio mirror could not provide this track.");
  const size = Number(response.headers.get("content-length"));
  if (!size || size > 1024 * 1024 * 1024)
    throw new ApiError(502, "The audio source has an unsupported track size.");
  // R2 verifies the supplied checksum as it receives the stream; never buffer
  // an entire recording in Worker memory just to verify its identity.
  try {
    await env.BUCKET.put(key, response.body, {
      httpMetadata: { contentType: t.mime },
      ...(t.sha256 ? { sha256: t.sha256 } : {}),
    });
  } catch (error) {
    console.warn(
      "Audio preparation failed",
      error instanceof Error ? error.message : String(error),
    );
    throw new ApiError(
      502,
      "The recording could not be stored or failed its integrity check. Try again or ask for this edition to be verified.",
    );
  }
  return { key, size };
}
export async function handleAudio(
  request: Request,
  env: CoveEnv,
  path: string,
  userId: string | null,
  storefrontTerritory = "US",
): Promise<Response | null> {
  const method = request.method,
    url = new URL(request.url),
    db = env.DB;
  if (path === "/admin/audio" && method === "PUT") {
    await requireServiceScope(env.DB as any, request, "audio.ingest");
    const e = audioSchema.parse(await readBody(request, 4 * 1024 * 1024)) as AudioEdition;
    if (!e.alignment && url.searchParams.get("clearAlignment") !== "true") {
      const old = await db
        .prepare("SELECT alignment_json FROM audio_editions WHERE id=?")
        .bind(e.id)
        .first<any>();
      if (old?.alignment_json)
        throw new ApiError(
          409,
          "This import would remove a verified alignment. Supply its verified replacement or explicitly use clearAlignment=true.",
        );
    }
    await insertEdition(env, e).run();
    return json({ saved: true, id: e.id });
  }
  // This legacy Gutenberg audiobook source asserts only U.S. public-domain status. Until an
  // audiobook is normalized as a commercial product with its own format-specific grant, never
  // infer rights from the linked ebook or expose media outside that territory.
  if (storefrontTerritory !== "US" && path.startsWith("/audio/") && !path.startsWith("/audio/ca_"))
    throw new ApiError(404,"This audiobook is not available in your storefront.");
  if (path === "/audiobooks" && method === "GET") {
    await seedAudio(env);
    const q = (url.searchParams.get("search") || "").trim().slice(0, 160),
      kind = z
        .enum(["all", "human", "computer", "unknown"])
        .parse(url.searchParams.get("narration") || "all"),
      page = z.coerce
        .number()
        .int()
        .min(1)
        .max(10000)
        .parse(url.searchParams.get("page") || 1),
      sort = z.enum(["title", "new"]).parse(url.searchParams.get("sort") || "title");
    const where = ["rights='Public domain in the USA.'"],
      args: any[] = [];
    if (q) {
      where.push("(title LIKE ? OR authors_json LIKE ? OR narrator LIKE ?)");
      args.push("%" + q + "%", "%" + q + "%", "%" + q + "%");
    }
    if (kind !== "all") {
      where.push("narration=?");
      args.push(kind);
    }
    if (url.searchParams.get("bookId")) {
      const requestedBookId=String(url.searchParams.get("bookId"));
      const product=await db.prepare(`SELECT source_external_id FROM products WHERE public_id=? OR id=?
        UNION SELECT p.source_external_id FROM catalog_public_aliases a JOIN products p ON p.id=a.entity_id WHERE a.entity_type='product' AND a.alias=? LIMIT 1`).bind(requestedBookId,requestedBookId,requestedBookId).first<any>();
      where.push("book_id=?");
      args.push(String(product?.source_external_id||requestedBookId));
    }
    const clause = where.join(" AND ");
    const [rows, total] = await Promise.all([
      db
        .prepare(
          "SELECT * FROM audio_editions WHERE " +
            clause +
            " ORDER BY " +
            (sort === "new" ? "updated_at DESC,id" : "title,id") +
            " LIMIT 24 OFFSET ?",
        )
        .bind(...args, (page - 1) * 24)
        .all<any>(),
      db
        .prepare("SELECT COUNT(*) count FROM audio_editions WHERE " + clause)
        .bind(...args)
        .first<any>(),
    ]);
    const legacyResults = storefrontTerritory === "US"
      ? await Promise.all(rows.results.map(row=>hydrateEdition(env,rowEdition(row))))
      : [];
    const commercial = await listCommercialAudiobooks(db,userId,storefrontTerritory,{
      search:q,page,sort,bookId:url.searchParams.get("bookId")||undefined,narration:kind==='human'?'human':kind==='computer'?'computer':undefined,
    });
    const combined = [...commercial.results, ...legacyResults].slice(0,24);
    const count = Number(commercial.count||0) + (storefrontTerritory === "US" ? Number(total.count||0) : 0);
    return json({results:combined,count,page,pages:Math.max(1,Math.ceil(count/24))});
  }
  const match = path.match(/^\/audio\/([^/]+)(?:\/(tracks|playback|prepare)(?:\/([^/]+))?)?$/);
  if (!match) return null;
  const e = await getEdition(env, match[1]);
  if (method === "GET" && !match[2]) return json(e);
  if (match[2] === "tracks" && ["GET", "HEAD"].includes(method)) {
    const t = e.tracks.find((t) => t.id === match[3]);
    if (!t) throw new ApiError(404, "This audio track was not found.");
    // Unprepared, unaligned recordings can start progressively. Waiting for a
    // whole 30-minute track to cache before sending its first byte stalls players.
    // Aligned media still goes through checksum-verified storage before playback.
    const existing = await env.BUCKET?.head?.(objectKey(e, t));
    if (!existing && !t.sha256) {
      let range = request.headers.get("range");
      if (range && !/^bytes=(\d*)-(\d*)$/.test(range))
        throw new ApiError(416, "Invalid byte range.");
      const openRange = range?.match(/^bytes=(\d+)-(\d*)$/);
      if (openRange) {
        const start = Number(openRange[1]);
        if (!Number.isSafeInteger(start)) throw new ApiError(416, "Invalid byte range.");
        // Small partial responses let players start promptly even through
        // buffering proxies. The returned Content-Range advertises the segment.
        const end = Math.min(
          openRange[2] ? Number(openRange[2]) : Infinity,
          start + 1024 * 1024 - 1,
        );
        range = `bytes=${start}-${end}`;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let upstream: Response;
      try {
        upstream = await fetch(mirrorUrl(t.url, env.GUTENBERG_MIRROR_BASE_URL), {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: range ? { Range: range } : {},
        });
      } finally {
        clearTimeout(timeout);
      }
      if (![200, 206, 416].includes(upstream.status))
        throw new ApiError(502, "The audio mirror could not provide this track.");
      const headers = new Headers({
        "Content-Type": t.mime,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      for (const name of ["Content-Length", "Content-Range"])
        if (upstream.headers.has(name)) headers.set(name, upstream.headers.get(name)!);
      return new Response(method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        headers,
      });
    }
    const meta = await cacheTrack(env, e, t);
    let range;
    try {
      range = parseRange(request.headers.get("range"), meta.size);
    } catch (error) {
      if (error instanceof ApiError && error.status === 416)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${meta.size}`, "Accept-Ranges": "bytes" },
        });
      throw error;
    }
    const object =
      method === "HEAD" ? null : await env.BUCKET!.get(meta.key, range ? { range } : undefined);
    const headers: Record<string, string> = {
      "Content-Type": t.mime,
      "Content-Length": String(range?.length || meta.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (range)
      headers["Content-Range"] =
        `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`;
    return new Response(object?.body || null, { status: range ? 206 : 200, headers });
  }
  if (match[2] === "prepare" && method === "POST") {
    await requireServiceScope(env.DB as any, request, "audio.prepare");
    const t = e.tracks.find((t) => t.id === match[3]);
    if (!t) throw new ApiError(404, "Track not found.");
    await cacheTrack(env, e, t);
    return json({ cached: true });
  }
  if (match[2] === "playback") {
    const uid = requireIdentity(userId);
    if (method === "GET") {
      const p = await db
        .prepare("SELECT * FROM playback WHERE user_id=? AND edition_id=?")
        .bind(uid, e.id)
        .first<any>();
      return json(
        p
          ? {
              trackId: p.track_id,
              seconds: p.seconds,
              speed: p.speed,
              version: p.version,
              updatedAt: p.updated_at,
            }
          : null,
      );
    }
    if (method === "PUT") {
      await rateLimit(env, "playback:" + uid, 60);
      const input = z
        .object({
          trackId: idSchema,
          seconds: z.number().min(0).max(86400),
          speed: z.number().min(0.5).max(3),
          version: z.number().int().min(0),
        })
        .parse(await readBody(request));
      const track = e.tracks.find((t) => t.id === input.trackId);
      if (!track || (track.duration && input.seconds > track.duration + 1))
        throw new ApiError(400, "This audio position is invalid.");
      let row: any;
      if (input.version === 0)
        row = await db
          .prepare(
            "INSERT INTO playback(user_id,edition_id,track_id,seconds,speed,version,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(user_id,edition_id) DO NOTHING RETURNING version,updated_at",
          )
          .bind(uid, e.id, input.trackId, input.seconds, input.speed, now())
          .first<any>();
      else
        row = await db
          .prepare(
            "UPDATE playback SET track_id=?,seconds=?,speed=?,version=version+1,updated_at=? WHERE user_id=? AND edition_id=? AND version=? RETURNING version,updated_at",
          )
          .bind(input.trackId, input.seconds, input.speed, now(), uid, e.id, input.version)
          .first<any>();
      if (!row)
        throw new ApiError(
          409,
          "Your listening position changed on another device. Reload to choose the latest position.",
        );
      try{const product=await resolveProduct(db,String(e.bookId||e.gutenbergId),uid),idx=e.tracks.findIndex(t=>t.id===input.trackId),total=e.tracks.reduce((n,t)=>n+Number(t.duration||0),0),prior=idx>0?e.tracks.slice(0,idx).reduce((n,t)=>n+Number(t.duration||0),0):0;if(total>0)await recordReadingProgress(db,uid,String(product.id),{source:"audiobook",progress:Math.max(0,Math.min(1,(prior+input.seconds)/total)),chapter:String(track.title||""),at:String(row.updated_at),dedupeKey:`gutenberg-audio-progress:${uid}:${e.id}:${row.version}`});}catch(err){console.error("Reading Journey audio progress snapshot failed",err);}
      return json({ version: row.version, updatedAt: row.updated_at });
    }
  }
  return null;
}
