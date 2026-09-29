import { z } from "zod";
import type { CoveEnv } from "./api.server";
import type { CatalogBook } from "./client";
import {
  ApiError,
  bookIdSchema,
  json,
  now,
  rateLimit,
  readBody,
  requireIdentity,
} from "./service";
import { countWords } from "./domain";
import { getCanonicalBook, resolveProduct } from "./catalog-model.server";
import { refreshSearchQualitySignals } from "./search.server";
import { createModerationCase } from "./moderation.server";
import { deriveReviewProvenance, evaluateReviewHeart, evaluateReviewIntegrity, recordRetailEvent } from "./retail-intelligence.server";
import { recordSyncProjection } from "./sync.server";
import { recordSocialEvent } from "./social.server";
type GetBook = (env: CoveEnv, id: string, userId?: string) => Promise<CatalogBook>;
async function syncShelfProjection(db:CoveEnv["DB"],userId:string,shelfId:string,tombstone=false,explicitVersion?:number){
  const shelf=await db.prepare("SELECT id,name,visibility,version FROM shelves WHERE id=? AND user_id=?").bind(shelfId,userId).first<any>();
  const items=tombstone?[]:(await db.prepare("SELECT product_id FROM shelf_items WHERE shelf_id=? ORDER BY position,added_at").bind(shelfId).all<any>()).results;
  await recordSyncProjection(db,{userId,entityType:"shelf",entityId:shelfId,payload:{name:String(shelf?.name||""),visibility:String(shelf?.visibility||"private"),productIds:items.map((x:any)=>String(x.product_id))},tombstone,explicitVersion:explicitVersion??Number(shelf?.version||1)});
}
const visibility = z.enum(["public", "private"]);
const reviewInput = z.object({
  rating: z.number().min(0.5).max(5).multipleOf(0.5),
  body: z.string().trim().max(20000).default(""),
  visibility: visibility.default("private"),
  spoiler: z.boolean().default(false),
});
const shelfInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(""),
  visibility: visibility.default("private"),
});
const toReview = (r: any, userId?: string | null) => ({
  id: r.id,
  bookId: r.book_id,
  name: r.name || "Reader",
  rating: r.rating_steps === null ? null : r.rating_steps / 2,
  body: r.body,
  visibility: r.visibility,
  spoiler: !!r.spoiler,
  wordCount: r.word_count,
  hearts: r.hearts || 0,
  hearted: !!r.hearted,
  mine: r.user_id === userId,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  provenance: { type: r.provenance_type || "sideloaded_unverified", verified: ["verified_purchase","subscription_reader"].includes(String(r.provenance_type || "")) },
});
const toShelf = (r: any) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  visibility: r.visibility,
  count: r.count || 0,
  updatedAt: r.updated_at,
  version: Number(r.version || 1),
});
const reviewSelect = `SELECT r.*,p.name,
  (SELECT COUNT(*) FROM review_hearts h WHERE h.review_id=r.id AND NOT EXISTS(SELECT 1 FROM review_vote_signals vs WHERE vs.review_id=h.review_id AND vs.voter_user_id=h.user_id AND vs.score>=60 AND vs.disposition IN ('open','confirmed'))) hearts,
  (SELECT COUNT(*) FROM review_hearts h WHERE h.review_id=r.id AND h.user_id=?) hearted,
  CASE WHEN r.ranking_status='excluded' THEN 0 ELSE (0.5 + r.trust_score*r.provenance_weight) * (1 + (SELECT COUNT(*) FROM review_hearts h WHERE h.review_id=r.id AND NOT EXISTS(SELECT 1 FROM review_vote_signals vs WHERE vs.review_id=h.review_id AND vs.voter_user_id=h.user_id AND vs.score>=60 AND vs.disposition IN ('open','confirmed')))) END review_rank_score
  FROM reviews r LEFT JOIN profiles p ON p.user_id=r.user_id`;
export async function migrateLegacy(env: CoveEnv, userId: string) {
  const rows = await env.DB.prepare("SELECT * FROM reading_states WHERE user_id=? AND review_migrated=0")
    .bind(userId)
    .all<any>();
  for (const row of rows.results) {
    const at = now();
    const statements = [];
    if (row.legacy_rating || row.legacy_review)
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO reviews(id,user_id,book_id,rating_steps,body,visibility,word_count,created_at,updated_at) VALUES(?,?,?,?,?,'private',?,?,?)",
        ).bind(
          crypto.randomUUID(),
          userId,
          row.external_book_id,
          row.legacy_rating ? Math.round(row.legacy_rating * 2) : null,
          row.legacy_review || "",
          countWords(row.legacy_review || ""),
          row.updated_at,
          at,
        ),
      );
    const names = JSON.parse(row.legacy_shelves_json || "[]") as string[];
    for (const name of [...new Set(names)]) {
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO shelves(id,user_id,name,visibility,created_at,updated_at) VALUES(?,?,?,'private',?,?)",
        ).bind(crypto.randomUUID(), userId, name, at, at),
      );
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO shelf_items(shelf_id,product_id,external_book_id,position,added_at) SELECT id,?,?,0,? FROM shelves WHERE user_id=? AND name=?",
        ).bind(row.product_id, row.external_book_id, at, userId, name),
      );
    }
    if (row.status === "finished")
      statements.push(
        env.DB.prepare(
          "INSERT INTO completion_events(id,user_id,product_id,external_book_id,finished_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM completion_events WHERE user_id=? AND product_id=?)",
        ).bind(crypto.randomUUID(), userId, row.product_id, row.external_book_id, row.updated_at, userId, row.product_id),
      );
    statements.push(
      env.DB.prepare("UPDATE reading_states SET review_migrated=1 WHERE user_id=? AND product_id=?").bind(
        userId,
        row.product_id,
      ),
    );
    await env.DB.batch(statements);
  }
}

export async function handleCommunity(
  request: Request,
  env: CoveEnv,
  path: string,
  userId: string | null,
  getBook: GetBook,
): Promise<Response | null> {
  const url = new URL(request.url),
    db = env.DB,
    method = request.method;
  const reviewBook = path.match(/^\/books\/([^/]+)\/reviews$/);
  if (reviewBook) {
    const id = bookIdSchema.parse(reviewBook[1]);
    const resolvedBook = await getBook(env, id, userId || undefined);
    // Reviews remain linked to the normalized product_id; book_id is a compatibility/source alias
    // so legacy Gutenberg reviews and canonical /books/prd_... URLs share one discussion thread.
    const reviewKey = String((resolvedBook as any).sourceExternalId || (resolvedBook as any).id || id);
    if (method === "GET") {
      const rating = url.searchParams.get("rating");
      if (rating !== null) z.coerce.number().min(0.5).max(5).multipleOf(0.5).parse(rating);
      const page = z.coerce
          .number()
          .int()
          .min(1)
          .max(10000)
          .parse(url.searchParams.get("page") || 1),
        sort = z
          .enum(["popular", "trending", "new", "longest", "shortest"])
          .parse(url.searchParams.get("sort") || "popular");
      const where = ["r.book_id=?", "r.visibility='public'", "r.moderation='visible'"],
        binds: any[] = [reviewKey];
      if (rating !== null) {
        where.push("r.rating_steps=?");
        binds.push(Number(rating) * 2);
      }
      if (url.searchParams.get("textOnly") === "true") where.push("r.body<>''");
      const order = {
        popular: "review_rank_score DESC,r.created_at DESC",
        trending:
          "CASE WHEN r.ranking_status='excluded' THEN 0 ELSE (0.5+r.trust_score*r.provenance_weight)*(SELECT COUNT(*) FROM review_hearts th WHERE th.review_id=r.id AND julianday(th.created_at)>=julianday('now','-7 days') AND NOT EXISTS(SELECT 1 FROM review_vote_signals vs WHERE vs.review_id=th.review_id AND vs.voter_user_id=th.user_id AND vs.score>=60 AND vs.disposition IN ('open','confirmed'))) END DESC,r.created_at DESC",
        new: "r.created_at DESC",
        longest: "r.word_count DESC,r.created_at DESC",
        shortest: "r.word_count ASC,r.created_at DESC",
      }[sort];
      const [rows, total, distribution, mine] = await Promise.all([
        db
          .prepare(
            reviewSelect +
              " WHERE " +
              where.join(" AND ") +
              " ORDER BY " +
              order +
              ",r.id LIMIT 20 OFFSET ?",
          )
          .bind(userId || "", ...binds, (page - 1) * 20)
          .all<any>(),
        db
          .prepare("SELECT COUNT(*) count FROM reviews r WHERE " + where.join(" AND "))
          .bind(...binds)
          .first<any>(),
        db
          .prepare(
            "SELECT rating_steps,COUNT(*) count FROM reviews WHERE book_id=? AND visibility='public' AND moderation='visible' AND rating_steps IS NOT NULL GROUP BY rating_steps",
          )
          .bind(reviewKey)
          .all<any>(),
        userId
          ? db
              .prepare(reviewSelect + " WHERE r.user_id=? AND r.book_id=?")
              .bind(userId, userId, reviewKey)
              .first<any>()
          : null,
      ]);
      const n = distribution.results.reduce((s, r) => s + r.count, 0),
        sum = distribution.results.reduce((s, r) => s + (r.rating_steps * r.count) / 2, 0);
      return json({
        reviews: rows.results.map((r) => toReview(r, userId)),
        mine: mine ? toReview(mine, userId) : null,
        count: total.count,
        page,
        pages: Math.ceil(total.count / 20),
        summary: {
          count: n,
          average: n ? sum / n : null,
          distribution: distribution.results.map((r) => ({
            rating: r.rating_steps / 2,
            count: r.count,
          })),
        },
      });
    }
    const uid = requireIdentity(userId);
    await rateLimit(env, "review:" + uid, 15);
    if (method === "PUT") {
      const input = reviewInput.parse(await readBody(request));
      if ((resolvedBook as any).uploaded && input.visibility === "public")
        throw new ApiError(400, "Reviews of personal imports stay private.");
      const at = now(), provenance = await deriveReviewProvenance(db, uid, id), proposedId = crypto.randomUUID();
      await db.batch([
        db
          .prepare(
            "INSERT INTO reviews(id,user_id,book_id,rating_steps,body,visibility,spoiler,word_count,created_at,updated_at,provenance_type,provenance_weight,trust_score,ranking_status,product_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'eligible',?) ON CONFLICT(user_id,book_id) DO UPDATE SET rating_steps=excluded.rating_steps,body=excluded.body,visibility=excluded.visibility,spoiler=excluded.spoiler,word_count=excluded.word_count,updated_at=excluded.updated_at",
          )
          .bind(
            proposedId,
            uid,
            reviewKey,
            input.rating * 2,
            input.body,
            input.visibility,
            input.spoiler ? 1 : 0,
            countWords(input.body),
            at,
            at,
            provenance.type,
            provenance.weight,
            provenance.productId,
          ),
        db
          .prepare("UPDATE reading_states SET review_migrated=1 WHERE user_id=? AND external_book_id=?")
          .bind(uid, reviewKey),
      ]);
      const savedReview = await db.prepare("SELECT id,provenance_type,provenance_weight,product_id FROM reviews WHERE user_id=? AND book_id=?").bind(uid,reviewKey).first<any>();
      await db.prepare("INSERT OR IGNORE INTO review_provenance_snapshots(review_id,provenance_type,product_id,entitlement_id,order_item_id,evidence_json,captured_at) VALUES(?,?,?,?,?,?,?)")
        .bind(savedReview.id,provenance.type,provenance.productId,provenance.entitlementId,provenance.orderItemId,JSON.stringify(provenance.evidence),at).run();
      await db.prepare("DELETE FROM review_abuse_signals WHERE review_id=? AND disposition='open' AND model_version='fore-review-integrity-v1'").bind(savedReview.id).run();
      const integrity = await evaluateReviewIntegrity(db,savedReview.id,uid,savedReview.product_id?String(savedReview.product_id):provenance.productId,input.body,input.rating*2,String(savedReview.provenance_type||provenance.type));
      if (savedReview.product_id || provenance.productId) await recordRetailEvent(db,uid,{eventType:"review_submitted",productId:String(savedReview.product_id||provenance.productId),externalBookId:reviewKey,sourceSurface:"reviews",territory:"US",properties:{rating:input.rating,provenanceType:String(savedReview.provenance_type||provenance.type),weight:Number(savedReview.provenance_weight||provenance.weight)*integrity.trustScore},dedupeKey:`review:${savedReview.id}:${at}`});
      if(input.visibility==="public"&&(savedReview.product_id||provenance.productId)){
        const productId=String(savedReview.product_id||provenance.productId), work=await db.prepare("SELECT e.work_id FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.id=?").bind(productId).first<any>(), sp=await db.prepare("SELECT activity_visibility FROM social_profiles WHERE user_id=?").bind(uid).first<any>();
        await recordSocialEvent(db,{userId:uid,type:"review_published",entityType:"review",entityId:String(savedReview.id),productId,workId:work?.work_id?String(work.work_id):null,visibility:String(sp?.activity_visibility||"followers"),payload:{rating:input.rating,excerpt:input.body.slice(0,300)},dedupeKey:`review-social:${savedReview.id}:${at}`});
      }
      await refreshSearchQualitySignals(db, reviewKey);
      return json({ saved: true, provenance: String(savedReview.provenance_type||provenance.type) });
    }
    if (method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM reviews WHERE user_id=? AND book_id=?").bind(uid, reviewKey),
        db
          .prepare(
            "UPDATE reading_states SET legacy_rating=NULL,legacy_review='',review_migrated=1 WHERE user_id=? AND external_book_id=?",
          )
          .bind(uid, reviewKey),
      ]);
      await refreshSearchQualitySignals(db, reviewKey);
      return json({ deleted: true });
    }
  }
  const reviewAction = path.match(/^\/reviews\/([^/]+)\/(heart|report)$/);
  if (reviewAction) {
    const uid = requireIdentity(userId),
      id = z.string().uuid().parse(reviewAction[1]);
    const r = await db
      .prepare("SELECT * FROM reviews WHERE id=? AND visibility='public' AND moderation='visible'")
      .bind(id)
      .first<any>();
    if (!r) throw new ApiError(404, "This review is unavailable.");
    if (r.user_id === uid) throw new ApiError(400, "You cannot react to your own review.");
    await rateLimit(env, "reaction:" + uid, 60);
    if (reviewAction[2] === "heart" && method === "PUT") {
      const heartAt=now();
      await db
        .prepare("INSERT OR IGNORE INTO review_hearts(review_id,user_id,created_at) VALUES(?,?,?)")
        .bind(id, uid, heartAt)
        .run();
      await evaluateReviewHeart(db,id,uid);
      if(r.product_id) await recordRetailEvent(db,uid,{eventType:"review_hearted",productId:String(r.product_id),externalBookId:String(r.book_id),sourceSurface:"reviews",territory:"US",dedupeKey:`review-heart:${id}:${uid}`});
      return json({ hearted: true });
    }
    if (reviewAction[2] === "heart" && method === "DELETE") {
      await db
        .prepare("DELETE FROM review_hearts WHERE review_id=? AND user_id=?")
        .bind(id, uid)
        .run();
      return json({ hearted: false });
    }
    if (reviewAction[2] === "report" && method === "POST") {
      const { reason } = z
        .object({ reason: z.enum(["spam", "harassment", "spoilers", "other"]) })
        .parse(await readBody(request));
      const reportedAt=now(),inserted=await db
        .prepare(
          "INSERT INTO review_reports(review_id,user_id,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(review_id,user_id) DO NOTHING RETURNING review_id",
        )
        .bind(id, uid, reason, reportedAt)
        .first<any>();
      if(inserted) await createModerationCase(db as any,{subjectType:"review",subjectId:id,category:reason,queue:"reviews",priority:"normal",sourceType:"user_report",riskScore:20,summary:`${reason} report for reader review ${id}`,reporterUserId:uid,reasonCode:reason,details:"Reader-submitted review report."});
      return json({ reported: true });
    }
  }
  if (path === "/admin/reports") {
    throw new ApiError(410, "The legacy operator-token moderation endpoint has been retired. Use the identity-bound staff moderation console.");
  }
  if (path === "/shelves") {
    const uid = requireIdentity(userId);
    await migrateLegacy(env, uid);
    if (method === "GET")
      return json({
        shelves: (
          await db
            .prepare(
              "SELECT s.*,(SELECT COUNT(*) FROM shelf_items b WHERE b.shelf_id=s.id) count FROM shelves s WHERE s.user_id=? ORDER BY s.updated_at DESC",
            )
            .bind(uid)
            .all<any>()
        ).results.map(toShelf),
      });
    if (method === "POST") {
      await rateLimit(env, "shelf:" + uid, 20);
      const input = shelfInput.parse(await readBody(request));
      if (
        await db
          .prepare("SELECT id FROM shelves WHERE user_id=? AND lower(name)=lower(?)")
          .bind(uid, input.name)
          .first()
      )
        throw new ApiError(409, "You already have a shelf with this name.");
      const id = crypto.randomUUID(),
        at = now();
      await db
        .prepare(
          "INSERT INTO shelves(id,user_id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(id, uid, input.name, input.description, input.visibility, at, at)
        .run();
      await syncShelfProjection(db,uid,id);
      return json({ id, version: 1 }, 201);
    }
  }
  const shelfRoute = path.match(/^\/shelves\/([^/]+)(?:\/(books|order)(?:\/([^/]+))?)?$/);
  if (shelfRoute) {
    const id = z.string().uuid().parse(shelfRoute[1]);
    const s = await db
      .prepare(
        "SELECT s.*,p.name owner_name FROM shelves s LEFT JOIN profiles p ON p.user_id=s.user_id WHERE s.id=?",
      )
      .bind(id)
      .first<any>();
    if (!s || (s.user_id !== userId && s.visibility !== "public"))
      throw new ApiError(404, "This shelf is unavailable.");
    const mine = s.user_id === userId;
    if (method === "GET" && !shelfRoute[2]) {
      const rows = await db
        .prepare("SELECT * FROM shelf_items WHERE shelf_id=? ORDER BY position,added_at,external_book_id")
        .bind(id)
        .all<any>();
      const books = [];
      for (const r of rows.results.filter((r) => mine || !r.external_book_id.startsWith("upload_"))) {
        const book = await getBook(env, r.external_book_id, mine ? userId! : undefined);
        books.push({ bookId: r.external_book_id, book, position: r.position, note: r.note });
      }
      return json({
        shelf: {
          ...toShelf(s),
          count: rows.results.length,
          mine,
          ownerName: s.owner_name || "Reader",
        },
        books,
      });
    }
    requireIdentity(userId);
    if (!mine) throw new ApiError(404, "This shelf is unavailable.");
    await rateLimit(env, "shelf:" + userId, 60);
    if (method === "PATCH" && !shelfRoute[2]) {
      const input = shelfInput.extend({expectedVersion:z.number().int().min(1)}).parse(await readBody(request));
      if(Number(s.version)!==input.expectedVersion) throw new ApiError(409,"This shelf changed on another device. Refresh before editing it.");
      if (
        input.visibility === "public" &&
        (await db
          .prepare(
            "SELECT external_book_id FROM shelf_items WHERE shelf_id=? AND external_book_id LIKE 'upload_%' LIMIT 1",
          )
          .bind(id)
          .first())
      )
        throw new ApiError(400, "Remove personal imports before making this shelf public.");
      if (
        await db
          .prepare("SELECT id FROM shelves WHERE user_id=? AND lower(name)=lower(?) AND id<>?")
          .bind(userId, input.name, id)
          .first()
      )
        throw new ApiError(409, "You already have a shelf with this name.");
      const changed=await db
        .prepare("UPDATE shelves SET name=?,description=?,visibility=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=? RETURNING version")
        .bind(input.name, input.description, input.visibility, now(), id, userId, input.expectedVersion)
        .first<any>();
      if(!changed) throw new ApiError(409,"This shelf changed on another device. Refresh before editing it.");
      await syncShelfProjection(db,userId!,id,false,Number(changed.version));
      return json({ saved: true, version:Number(changed.version) });
    }
    if (method === "DELETE" && !shelfRoute[2]) {
      const input=z.object({expectedVersion:z.number().int().min(1)}).parse(await readBody(request));
      if(Number(s.version)!==input.expectedVersion) throw new ApiError(409,"This shelf changed on another device. Refresh before deleting it.");
      const items=(await db.prepare("SELECT product_id FROM shelf_items WHERE shelf_id=? ORDER BY position,added_at").bind(id).all<any>()).results;
      const removed=await db.prepare("DELETE FROM shelves WHERE id=? AND user_id=? AND version=? RETURNING id").bind(id,userId,input.expectedVersion).first<any>();
      if(!removed) throw new ApiError(409,"This shelf changed on another device. Refresh before deleting it.");
      await recordSyncProjection(db,{userId:userId!,entityType:"shelf",entityId:id,payload:{name:String(s.name||""),visibility:String(s.visibility||"private"),productIds:items.map((x:any)=>String(x.product_id))},tombstone:true,explicitVersion:input.expectedVersion+1});
      return json({ deleted: true, version:input.expectedVersion+1 });
    }
    if (method === "PUT" && shelfRoute[2] === "books") {
      const input = z
        .object({ bookId: bookIdSchema, note: z.string().max(2000).default(""), expectedVersion:z.number().int().min(1) })
        .parse(await readBody(request));
      if(Number(s.version)!==input.expectedVersion) throw new ApiError(409,"This shelf changed on another device. Refresh before adding a book.");
      const b = await getBook(env, input.bookId, userId!);
      if (b.uploaded && s.visibility === "public")
        throw new ApiError(400, "Personal imports can only be added to private shelves.");
      const product = await resolveProduct(db, input.bookId, userId!);
      await db.batch([
        db
          .prepare(
            "INSERT INTO shelf_items(shelf_id,product_id,external_book_id,position,note,added_at) VALUES(?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM shelf_items WHERE shelf_id=?),?,?) ON CONFLICT(shelf_id,product_id) DO UPDATE SET note=excluded.note",
          )
          .bind(id, product.id, input.bookId, id, input.note, now()),
        db.prepare("UPDATE shelves SET updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?").bind(now(), id, userId, input.expectedVersion),
      ]);
      await syncShelfProjection(db,userId!,id,false,input.expectedVersion+1);
      return json({ saved: true, version:input.expectedVersion+1 });
    }
    if (method === "DELETE" && shelfRoute[2] === "books") {
      const input=z.object({expectedVersion:z.number().int().min(1)}).parse(await readBody(request));
      if(Number(s.version)!==input.expectedVersion) throw new ApiError(409,"This shelf changed on another device. Refresh before removing a book.");
      const bookId = bookIdSchema.parse(shelfRoute[3]);
      await db
        .prepare("DELETE FROM shelf_items WHERE shelf_id=? AND external_book_id=?")
        .bind(id, bookId)
        .run();
      const changed=await db.prepare("UPDATE shelves SET updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=? RETURNING version").bind(now(),id,userId,input.expectedVersion).first<any>();
      if(!changed) throw new ApiError(409,"This shelf changed on another device. Refresh before removing a book.");
      await syncShelfProjection(db,userId!,id,false,Number(changed.version));
      return json({ deleted: true, version:Number(changed.version) });
    }
    if (method === "PUT" && shelfRoute[2] === "order") {
      const { bookIds, expectedVersion } = z
        .object({ bookIds: z.array(bookIdSchema).max(1000), expectedVersion:z.number().int().min(1) })
.parse(await readBody(request));
      if(Number(s.version)!==expectedVersion) throw new ApiError(409,"This shelf changed on another device. Refresh before reordering.");
      const rows = (
        await db.prepare("SELECT external_book_id FROM shelf_items WHERE shelf_id=?").bind(id).all<any>()
      ).results.map((r) => r.external_book_id);
      if (
        new Set(bookIds).size !== rows.length ||
        bookIds.length !== rows.length ||
        bookIds.some((b) => !rows.includes(b))
      )
        throw new ApiError(409, "The shelf changed. Refresh before reordering.");
      if (bookIds.length)
        await db.batch(
          bookIds.map((b, i) =>
            db
              .prepare("UPDATE shelf_items SET position=? WHERE shelf_id=? AND external_book_id=?")
              .bind(i, id, b),
          ),
        );
      const changed=await db.prepare("UPDATE shelves SET updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=? RETURNING version").bind(now(),id,userId,expectedVersion).first<any>();
      if(!changed) throw new ApiError(409,"This shelf changed on another device. Refresh before reordering.");
      await syncShelfProjection(db,userId!,id,false,Number(changed.version));
      return json({ saved: true, version:Number(changed.version) });
    }
  }
  if (path === "/sessions" && method === "PUT") {
    const uid = requireIdentity(userId);
    await rateLimit(env, "session:" + uid, 30);
    const input = z
      .object({
        id: z.string().uuid(),
        bookId: bookIdSchema,
        mode: z.enum(["read", "listen"]),
        startedAt: z.string().datetime(),
        endedAt: z.string().datetime(),
        activeSeconds: z.number().int().min(0).max(21600),
        wordsRead: z.number().int().min(0).max(250000),
      })
      .parse(await readBody(request));
    const start = Date.parse(input.startedAt),
      end = Date.parse(input.endedAt);
    if (
      start > end ||
      end > Date.now() + 60000 ||
      Date.now() - start > 30 * 86400000 ||
      input.activeSeconds > (end - start) / 1000 + 2 ||
      input.wordsRead > input.activeSeconds * 25 + 100
    )
      throw new ApiError(400, "Session timing is invalid.");
    let sessionBookId=input.bookId;
    if(input.mode === "read") {
      const resolved=await getBook(env,input.bookId,uid);
      sessionBookId=String((resolved as any).sourceExternalId||(resolved as any).id||input.bookId);
    }
    const existing = await db
      .prepare("SELECT book_id,mode,started_at FROM reading_sessions WHERE user_id=? AND id=?")
      .bind(uid, input.id)
      .first<any>();
    if (
      existing &&
      (existing.book_id !== sessionBookId ||
        existing.mode !== input.mode ||
        existing.started_at !== input.startedAt)
    )
      throw new ApiError(409, "This session identity is already in use.");
    if (input.mode === "listen") {
      const exists = await db
        .prepare("SELECT id FROM audio_editions WHERE gutenberg_id=? OR book_id=? LIMIT 1")
        .bind(input.bookId, input.bookId)
        .first();
      if (!exists) throw new ApiError(404, "Audiobook not found.");
    }
    await db
      .prepare(
        "INSERT INTO reading_sessions(id,user_id,book_id,mode,started_at,ended_at,active_seconds,words_read) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET ended_at=MAX(reading_sessions.ended_at,excluded.ended_at),active_seconds=MAX(reading_sessions.active_seconds,excluded.active_seconds),words_read=MAX(reading_sessions.words_read,excluded.words_read)",
      )
      .bind(
        input.id,
        uid,
        sessionBookId,
        input.mode,
        input.startedAt,
        input.endedAt,
        input.activeSeconds,
        input.mode === "read" ? input.wordsRead : 0,
      )
      .run();
    if (!existing) {
      try {
        const product = await resolveProduct(db, input.bookId, uid);
        await recordRetailEvent(db, uid, { eventType: "book_opened", productId: String(product.id), externalBookId: String(product.source_external_id||sessionBookId), sessionId: input.id, sourceSurface: input.mode === "listen" ? "audiobook-player" : "reader", occurredAt: input.startedAt, properties: { mode: input.mode }, dedupeKey: `book-open:${uid}:${input.id}` });
      } catch { /* personal/imported sessions may not resolve to a retail product */ }
    }
    return json({ saved: true });
  }
  if (path === "/metrics" && method === "PUT") {
    const uid = requireIdentity(userId);
    await rateLimit(env, "metric:" + uid, 10);
    const input = z
      .object({
        bookId: bookIdSchema,
        wordCount: z.number().int().min(0).max(20000000),
        readingLevel: z.number().min(-20).max(100).nullable(),
        language: z.string().min(2).max(10),
      })
      .parse(await readBody(request));
    await getBook(env, input.bookId, uid);
    await db
      .prepare(
        "INSERT INTO book_metrics(user_id,book_id,word_count,reading_level,language,method,updated_at) VALUES(?,?,?,?,?,'epub-spine-fk-estimate-v1',?) ON CONFLICT(user_id,book_id) DO UPDATE SET word_count=excluded.word_count,reading_level=excluded.reading_level,language=excluded.language,updated_at=excluded.updated_at",
      )
      .bind(
        uid,
        input.bookId,
        input.wordCount,
        input.language === "en" ? input.readingLevel : null,
        input.language,
        now(),
      )
      .run();
    return json({ saved: true });
  }
  if (path === "/stats" && method === "GET")
    return json(await readingStats(env, requireIdentity(userId), url));
  if (path === "/goals" && method === "PUT") {
    const uid = requireIdentity(userId);
    const input = z
      .object({
        year: z.number().int().min(2000).max(2200),
        books: z.number().int().min(1).max(1000),
      })
      .parse(await readBody(request));
    await db
      .prepare(
        "INSERT INTO reading_goals(user_id,year,books) VALUES(?,?,?) ON CONFLICT(user_id,year) DO UPDATE SET books=excluded.books",
      )
      .bind(uid, input.year, input.books)
      .run();
    return json({ saved: true });
  }
  if (path === "/export" && method === "GET") {
    const uid = requireIdentity(userId);
    const tables = [
      "reading_states",
      "entitlements",
      "personal_imports",
      "annotations",
      "definitions",
      "reviews",
      "shelves",
      "reading_sessions",
      "book_metrics",
      "completion_events",
      "reading_goals",
      "playback",
    ];
    const result: Record<string, unknown> = {
      format: "fore-personal-data",
      version: 2,
      exportedAt: now(),
    };
    for (const table of tables)
      result[table] = (
        await db.prepare(`SELECT * FROM ${table} WHERE user_id=?`).bind(uid).all()
      ).results;
    result.shelf_items = (
      await db
        .prepare(
          "SELECT b.* FROM shelf_items b JOIN shelves s ON s.id=b.shelf_id WHERE s.user_id=?",
        )
        .bind(uid)
        .all()
    ).results;
    return json(result);
  }
  return null;
}
async function readingStats(env: CoveEnv, userId: string, url: URL) {
  await migrateLegacy(env, userId);
  const days = z.enum(["7", "30", "90", "365", "all"]).parse(url.searchParams.get("days") || "30");
  const until = now(),
    since =
      days === "all"
        ? "1970-01-01T00:00:00.000Z"
        : new Date(Date.now() - Number(days) * 86400000).toISOString();
  const db = env.DB;
  const [totals, daily, sessions, completed, words, goal, yearCompleted, ratings] =
    await Promise.all([
      db
        .prepare(
          "SELECT COUNT(*) sessions,COALESCE(SUM(CASE WHEN mode='read' THEN active_seconds ELSE 0 END),0) read_seconds,COALESCE(SUM(CASE WHEN mode='listen' THEN active_seconds ELSE 0 END),0) listen_seconds,COALESCE(SUM(words_read),0) words,COALESCE(AVG(active_seconds),0) average_session FROM reading_sessions WHERE user_id=? AND started_at>=? AND started_at<=?",
        )
        .bind(userId, since, until)
        .first<any>(),
      db
        .prepare(
          "SELECT substr(started_at,1,10) date,SUM(CASE WHEN mode='read' THEN active_seconds ELSE 0 END) read_seconds,SUM(CASE WHEN mode='listen' THEN active_seconds ELSE 0 END) listen_seconds,COUNT(*) sessions FROM reading_sessions WHERE user_id=? AND started_at>=? AND started_at<=? GROUP BY date ORDER BY date",
        )
        .bind(userId, since, until)
        .all<any>(),
      db
        .prepare(
          "SELECT s.*,d.title book_title FROM reading_sessions s LEFT JOIN catalog_search_documents d ON d.external_book_id=s.book_id WHERE s.user_id=? AND s.started_at>=? ORDER BY s.started_at DESC LIMIT 50",
        )
        .bind(userId, since)
        .all<any>(),
      db
        .prepare(
          "SELECT c.*,m.word_count,m.reading_level FROM completion_events c LEFT JOIN book_metrics m ON m.user_id=c.user_id AND m.book_id=c.external_book_id WHERE c.user_id=? AND c.finished_at>=? AND c.finished_at<=? ORDER BY c.finished_at DESC",
        )
        .bind(userId, since, until)
        .all<any>(),
      db
        .prepare(
          "SELECT lower(word) word,COUNT(*) lookups,COUNT(DISTINCT book_id) books,MAX(created_at) last_seen FROM definitions WHERE user_id=? AND created_at>=? GROUP BY lower(word) ORDER BY lookups DESC,word LIMIT 100",
        )
        .bind(userId, since)
        .all<any>(),
      db
        .prepare("SELECT books FROM reading_goals WHERE user_id=? AND year=?")
        .bind(userId, new Date().getUTCFullYear())
        .first<any>(),
      db
        .prepare(
          "SELECT COUNT(*) count FROM completion_events WHERE user_id=? AND finished_at>=? AND finished_at<?",
        )
        .bind(
          userId,
          `${new Date().getUTCFullYear()}-01-01`,
          `${new Date().getUTCFullYear() + 1}-01-01`,
        )
        .first<any>(),
      db
        .prepare(
          "SELECT rating_steps,COUNT(*) count FROM reviews WHERE user_id=? AND updated_at>=? AND rating_steps IS NOT NULL GROUP BY rating_steps",
        )
        .bind(userId, since)
        .all<any>(),
    ]);
  const completedBooks = await Promise.all(
    completed.results.map((c) => getCanonicalBook(db, c.external_book_id, userId)),
  );
  const genre: Record<string, number> = {},
    subgenre: Record<string, number> = {};
  for (const b of completedBooks.filter(Boolean) as CatalogBook[]) {
    for (const g of new Set<string>(
      (b.bookshelves || [])
        .filter((s: string) => s.startsWith("Browsing: "))
        .map((s: string) => s.replace("Browsing: ", "")),
    ))
      genre[g] = (genre[g] || 0) + 1;
    for (const g of new Set<string>((b.subjects || []).slice(0, 8)))
      subgenre[g] = (subgenre[g] || 0) + 1;
  }
  const measured = completed.results.filter((c) => c.word_count !== null),
    leveled = completed.results.filter((c) => c.reading_level !== null);
  const buckets = (v: Record<string, number>) =>
    Object.entries(v)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));
  return {
    range: { days, since, until, timeZone: "UTC" },
    totals: {
      sessions: totals.sessions,
      readSeconds: totals.read_seconds,
      listenSeconds: totals.listen_seconds,
      wordsRead: totals.words,
      averageSessionSeconds: totals.average_session,
      wpm: totals.read_seconds ? Math.round((totals.words * 60) / totals.read_seconds) : null,
      finished: completed.results.length,
      averageBookWords: measured.length
        ? Math.round(measured.reduce((s, c) => s + c.word_count, 0) / measured.length)
        : null,
      averageReadingLevel: leveled.length
        ? leveled.reduce((s, c) => s + c.reading_level, 0) / leveled.length
        : null,
      measuredBooks: measured.length,
      leveledBooks: leveled.length,
    },
    daily: daily.results,
    sessions: sessions.results.map((s) => ({
      id: s.id,
      bookId: s.book_id,
      title: s.book_title || `Book ${s.book_id}`,
      mode: s.mode,
      startedAt: s.started_at,
      seconds: s.active_seconds,
      words: s.words_read,
    })),
    vocabulary: words.results,
    genres: buckets(genre),
    subgenres: buckets(subgenre),
    ratings: ratings.results.map((r) => ({ rating: r.rating_steps / 2, count: r.count })),
    goal: {
      year: new Date().getUTCFullYear(),
      target: goal?.books || null,
      finished: yearCompleted.count,
    },
    completed: completed.results.map((c, i) => ({
      id: c.id,
      book: completedBooks[i],
      finishedAt: c.finished_at,
      wordCount: c.word_count,
      readingLevel: c.reading_level,
    })).filter((c) => c.book),
  };
}
